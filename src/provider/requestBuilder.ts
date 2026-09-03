import * as vscode from 'vscode';
import { convertMessages } from './messageConverter.js';
import {
  resolveVllmModelId,
  resolveOverrideForModel,
  resolveServerConfig,
  resolveModelSettings,
  resolveRequestParams,
  resolveServerType,
  resolveMaxTokensForRequest,
  readPickerSelection,
  type VllmConfig,
  type ServerType,
} from '../state/config.js';
import type { OpenAIChatMessage } from '../types.js';

/**
 * Per-model server config resolved by {@link buildRequest} for the client call.
 * Single shared declaration (also used by `ProviderClient` and `VllmClient`) —
 * never re-declare inline elsewhere.
 */
export interface ServerConfig {
  serverUrl: string;
  requestHeaders: Record<string, string>;
  streamInactivityTimeout: number;
  /** Budget for the initial chat POST to receive response headers, in ms. 0 = disabled. */
  initialResponseTimeoutMs: number;
  /** Which backend's protocol to speak. Missing → 'vllm'. */
  serverType: ServerType;
}

/** Result of request assembly: everything the stream call needs. */
export interface BuildRequestResult {
  /** Wire id SENT in the request — may carry an OpenRouter routing suffix (`:nitro`/`:exacto`). */
  vllmModelId: string;
  /** Canonical wire id (base slug, no suffix) — the key usage/cost tracking uses. */
  wireModelId: string;
  openaiMessages: OpenAIChatMessage[];
  mergedOptions: Record<string, unknown>;
  serverConfig: ServerConfig;
}

/**
 * Phase 1 — assemble the vLLM chat request.
 *
 * Converts VS Code messages to OpenAI format, merges config defaults with
 * Copilot's `modelOptions` and the selected model-mode parameters, and resolves
 * the vLLM server model id to call.
 *
 * Collaborators are explicit: the config (for overrides/params) and an output
 * channel for diagnostics. The provider instance is never passed in.
 */
export function buildRequest(
  model: vscode.LanguageModelChatInformation,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  config: VllmConfig,
  output: vscode.OutputChannel,
): BuildRequestResult {
  // Build tools array if requested
  let tools: any[] | undefined;
  const availableTools = options.tools || [];
  if (availableTools.length > 0) {
    tools = availableTools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  // Convert VS Code messages to OpenAI format.
  // NOTE: VS Code Copilot injects all user-authored instruction files into the
  // system message — .github/copilot-instructions.md, AGENTS.md, and CLAUDE.md
  // (when their respective settings are enabled). No need to re-read or prepend
  // them here; the system message arrives complete from VS Code.
  // NOTE: System message replacements were applied before this method was called,
  // so the messages parameter already contains transformed system messages.
  const openaiMessages = convertMessages(messages);

  // Resolve the effective request params via the layering chain (highest wins):
  //   DEFAULT_REQUEST_PARAMS ← (max_tokens + Copilot modelOptions) ← model defaultParams ← selected mode.
  // max_tokens = output budget only; vLLM enforces prompt+output <= max_model_len server-side.
  const modelOverrides = config.models || [];
  const servers = config.servers || [];
  const override = resolveOverrideForModel(modelOverrides, model.id);

  // Mode + output-length pick, read through the same shared reader the provider
  // uses for tracking (single parse, audit P1-1). The pick already outranks
  // mode/defaultParams max_tokens inside resolveMaxTokensForRequest, where the
  // ceiling clamp also lives: a stale cached schema can never push max_tokens
  // above what Copilot was told the model can do.
  const { selectedMode, pickerTokens } = readPickerSelection(options);

  const modeParams = selectedMode && override?.modelModes?.[selectedMode]
    ? override.modelModes[selectedMode]
    : undefined;

  const mergedOptions: Record<string, unknown> = {
    // Layered params: defaults ← Copilot modelOptions ← defaultParams ← mode.
    // No max_tokens is seeded into this layering (audit P1-2): the output
    // budget is re-asserted after the spread, so nothing layered before it —
    // Copilot's UI value included — can reach the wire unclamped.
    ...resolveRequestParams(override, selectedMode, { ...options.modelOptions }),
    // NOTE: tools/tool_choice come last so Copilot's tool definitions always win.
    tools,
    // Enforce tool_choice when Copilot requires the model to call a tool.
    ...(options.toolMode === vscode.LanguageModelChatToolMode.Required && tools
      ? { tool_choice: 'required' as const }
      : {}),
  };

  // The output budget is decided here and only here: the configured value
  // (mode > defaultParams, resolved inside resolveMaxTokensForRequest, picker
  // pick outranking both) clamped to the ADVERTISED model.maxOutputTokens, which
  // already embeds the context-window reservation and the server-reported
  // ceiling via deriveTokenBudget. The wire never exceeds what Copilot was
  // told. Option A: an up-switch to a larger mode budget takes effect on the
  // NEXT request once metadata re-registers; down-switches are instant.
  mergedOptions.max_tokens = resolveMaxTokensForRequest(
    override,
    selectedMode,
    model.maxOutputTokens,
    (model.maxInputTokens || 0) + (model.maxOutputTokens || 0),
    pickerTokens,
  );

  // Backend type for this model's entry, resolved ONCE — every consumer below
  // (provider pinning, routing mode, transport config) asks the same question.
  const serverType = resolveServerType(override, servers);

  // OpenRouter provider pinning: when the model is OpenRouter and the user has
  // selected a provider (the exact `tag` from the endpoints API), force routing
  // to that provider with `provider: { only: [tag] }`. The tag is used verbatim —
  // never derived, never guessed. `undefined`/omitted = Auto (no `provider` key).
  const providerTag = serverType === 'openrouter' ? override?.provider : undefined;
  if (providerTag) {
    mergedOptions.provider = { only: [providerTag] };
    output.appendLine(`[INFO] Model "${model.id}" → OpenRouter provider pinned: "${providerTag}" (provider.only)`);
  }
  if (modeParams) {
    output.appendLine(`[INFO] Model mode: "${selectedMode}" → ${JSON.stringify(modeParams)}`);
  } else if (selectedMode) {
    output.appendLine(`[WARN] Selected mode "${selectedMode}" not found in modelModes for ${model.id} — no mode parameters applied`);
  } else if (override?.modelModes && Object.keys(override.modelModes).length > 0) {
    output.appendLine(`[WARN] Model has modelModes configured but none was selected for ${model.id}`);
  }

  // Resolve the vLLM server model ID: use vllmModelId from override if set, otherwise fall back to preset id.
  // OpenRouter routing mode: when the model is OpenRouter, routing is Auto (no
  // pinned provider), and a non-standard routing mode is set, append the mode's
  // variant suffix (`:nitro` / `:exacto`) to the WIRE id. This is how OpenRouter
  // requests the routing-mode sort. The base id stays canonical — `wireModelId`
  // is the base slug, and `vllmModelId` (returned for the request) is the only
  // id that carries the suffix. Usage/cost tracking keys on `wireModelId` so a
  // routing mode never fragments the dashboard's counters. A pinned provider
  // disables the mode (sorting a single provider is meaningless), so no suffix.
  const wireModelId = resolveVllmModelId(override) || model.id;
  const isOpenRouter = serverType === 'openrouter';
  const routingMode = override?.routingMode;
  let vllmModelId = wireModelId;
  if (isOpenRouter && !providerTag && routingMode && routingMode !== 'standard') {
    vllmModelId = `${wireModelId}:${routingMode}`;
    output.appendLine(`[INFO] Model "${model.id}" → OpenRouter routing mode "${routingMode}" (wire id ${vllmModelId})`);
  }

  // Resolve per-model server config (URL + isolated request headers + transport
  // + backend type) via the registry. A model whose `server` ref does not
  // resolve is unreachable — fail loudly rather than send to an empty URL.
  const resolved = resolveServerConfig(override, servers);
  if (!resolved) {
    throw new Error(
      `Model "${model.id}" references an unknown server — no registry entry matches its "server" ref. Fix the reference or re-add the server.`
    );
  }
  const settings = resolveModelSettings(override);
  const serverConfig: ServerConfig = {
    ...resolved,
    streamInactivityTimeout: settings.streamInactivityTimeout,
    initialResponseTimeoutMs: settings.initialResponseTimeoutMs,
    serverType,
  };

  // Log which headers are being sent (keys only, not values) for diagnostics
  const headerKeys = Object.keys(resolved.requestHeaders);
  if (headerKeys.length > 0) {
    output.appendLine(
      `[INFO] Model "${model.id}" → requestHeaders sent: ${headerKeys.join(', ')}`
    );
  }

  return { vllmModelId, wireModelId, openaiMessages, mergedOptions, serverConfig };
}
