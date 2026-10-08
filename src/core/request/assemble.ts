/**
 * Neutral request assembly — the core half of the former requestBuilder
 * monolith. Converts tool definitions to the wire format, merges config
 * defaults with the caller's runtime options and the selected model-mode
 * parameters, applies backend-specific body edits, and resolves the server
 * model id to call.
 *
 * No vscode chat types cross this boundary: each entry point (the Copilot
 * adapter in provider/requestBuilder.ts, future harness adapters) resolves
 * its own framework types into {@link AssembleRequestInput} first. `log` is
 * the only diagnostic sink.
 */
import {
  resolveVllmModelId,
  resolveOverrideForModel,
  resolveServerConfig,
  resolveModelSettings,
  resolveRequestParams,
  resolveServerType,
  resolveMaxTokensForRequest,
  type VllmConfig,
} from '../config/config.js';
import type { ServerType } from '../config/serverCore.js';
import type { RequestLog } from '../shared/trace.js';
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

/** A tool in entry-independent shape. VS Code's `LanguageModelChatTool` satisfies this structurally. */
export interface RequestTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Entry-independent input for request assembly (dsh-vllm-bridge repo,
 * docs/dsh-bridge-plan.md, Unit 2 "neutral core extraction"). Each entry point — the Copilot adapter below, the
 * harness gateway — resolves its own framework types into this plain struct.
 * The core never sees vscode chat types.
 */
export interface AssembleRequestInput {
  /** Canonical model id as configured in the registry (no routing suffix). */
  modelId: string;
  /** Selected model-mode id, if any (Copilot picker pick or gateway `<id>--<mode>` variant). */
  selectedMode?: string;
  /** Output-length picker tokens, Copilot path only — the harness has no picker equivalent. */
  pickerTokens?: number;
  /** Messages already converted to the OpenAI wire format. */
  openaiMessages: OpenAIChatMessage[];
  /** Runtime sampling options from the caller, WITHOUT the private `_conversationId` key. */
  runtimeOptions: Record<string, unknown>;
  /** Stable chat identity (Copilot's `_conversationId`); forwarded only as OpenRouter `session_id`. */
  conversationId?: unknown;
  /** Tools offered by the caller, in entry-independent shape. */
  tools?: readonly RequestTool[];
  /** True when the caller requires a tool call (Copilot `toolMode === Required`). */
  toolModeRequired: boolean;
  /** The `fixEmptyToolParameters` setting, read by the entry adapter that owns the settings source. */
  fixEmptyToolParameters: boolean;
  /** Advertised output-budget clamp: `model.maxOutputTokens` on the Copilot path. */
  advertisedMaxOutputTokens: number;
}

/**
 * The neutral request-assembly core. Converts tool definitions to the wire
 * format, merges config defaults with the caller's runtime options and the
 * selected model-mode parameters, applies backend-specific body edits, and
 * resolves the server model id to call.
 *
 * Extracted verbatim from the former `buildRequest` monolith (dsh bridge plan,
 * gate 1: a type-shed, not a rewrite). No vscode chat types cross this
 * boundary; `log` is the only diagnostic sink.
 */
export function assembleRequest(
  input: AssembleRequestInput,
  config: VllmConfig,
  log: RequestLog,
): BuildRequestResult {
  const {
    modelId,
    selectedMode,
    pickerTokens,
    openaiMessages,
    runtimeOptions,
    conversationId,
    toolModeRequired,
    fixEmptyToolParameters,
    advertisedMaxOutputTokens,
  } = input;

  // Build tools array if requested. Callers may omit `parameters` entirely for
  // zero-argument tools — some upstream providers reject those definitions with
  // a 502 (VS Code Copilot does exactly this). When `fixEmptyToolParameters` is
  // enabled (default), inject a minimal empty JSON Schema so every tool has a
  // `parameters` field.
  let tools: any[] | undefined;
  const availableTools = input.tools || [];
  if (availableTools.length > 0) {
    tools = availableTools.map(tool => {
      const fn: Record<string, unknown> = {
        name: tool.name,
        description: tool.description,
      };
      if (tool.inputSchema) {
        fn.parameters = tool.inputSchema;
      } else if (fixEmptyToolParameters) {
        fn.parameters = { type: 'object', properties: {} };
      }
      return { type: 'function', function: fn };
    });
  }

  // Resolve the effective request params via the layering chain (highest wins):
  //   DEFAULT_REQUEST_PARAMS ← (max_tokens + caller modelOptions) ← model defaultParams ← selected mode.
  // max_tokens = output budget only; vLLM enforces prompt+output <= max_model_len server-side.
  const modelOverrides = config.models;
  const servers = config.servers;
  const override = resolveOverrideForModel(modelOverrides, modelId);

  const modeParams = selectedMode && override?.modelModes?.[selectedMode]
    ? override.modelModes[selectedMode]
    : undefined;

  const mergedOptions: Record<string, unknown> = {
    // Layered params: defaults ← caller modelOptions ← defaultParams ← mode.
    // No max_tokens is seeded into this layering (audit P1-2): the output
    // budget is re-asserted after the spread, so nothing layered before it —
    // the caller's UI value included — can reach the wire unclamped.
    ...resolveRequestParams(override, selectedMode, runtimeOptions),
    // NOTE: tools/tool_choice come last so the caller's tool definitions always win.
    tools,
    // Enforce tool_choice when the caller requires the model to call a tool.
    ...(toolModeRequired && tools
      ? { tool_choice: 'required' as const }
      : {}),
  };

  // The output budget is decided here and only here: the configured value
  // (mode > defaultParams, resolved inside resolveMaxTokensForRequest, picker
  // pick outranking both) clamped to the ADVERTISED model.maxOutputTokens, which
  // already embeds the context-window reservation and the server-reported
  // ceiling via deriveTokenBudget. The wire never exceeds what the caller was
  // advertised. Option A: an up-switch to a larger mode budget takes effect on the
  // NEXT request once metadata re-registers; down-switches are instant.
  mergedOptions.max_tokens = resolveMaxTokensForRequest(
    override,
    selectedMode,
    advertisedMaxOutputTokens,
    pickerTokens,
  );

  // Backend type for this model's entry, resolved ONCE — every consumer below
  // (provider pinning, routing mode, transport config) asks the same question.
  const serverType = resolveServerType(override, servers);

  // OpenRouter uses session_id for sticky provider routing and cache affinity;
  // the private `_conversationId` key was stripped by the entry adapter and is
  // never sent to other backends.
  if (serverType === 'openrouter' && typeof conversationId === 'string' && conversationId.trim()) {
    mergedOptions.session_id = conversationId.slice(0, 256);
  }

  // OpenRouter provider pinning: when the model is OpenRouter and the user has
  // selected a provider (the exact `tag` from the endpoints API), force routing
  // to that provider with `provider: { only: [tag] }`. The tag is used verbatim —
  // never derived, never guessed. `undefined`/omitted = Auto (no `provider` key).
  const providerTag = serverType === 'openrouter' ? override?.provider : undefined;
  if (providerTag) {
    mergedOptions.provider = { only: [providerTag] };
    log.appendLine(`[INFO] Model "${modelId}" → OpenRouter provider pinned: "${providerTag}" (provider.only)`);
  }
  if (modeParams) {
    log.appendLine(`[INFO] Model mode: "${selectedMode}" → ${JSON.stringify(modeParams)}`);
  } else if (selectedMode) {
    log.appendLine(`[WARN] Selected mode "${selectedMode}" not found in modelModes for ${modelId} - no mode parameters applied`);
  } else if (override?.modelModes && Object.keys(override.modelModes).length > 0) {
    log.appendLine(`[WARN] Model has modelModes configured but none was selected for ${modelId}`);
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
  const wireModelId = resolveVllmModelId(override) || modelId;
  const isOpenRouter = serverType === 'openrouter';
  const routingMode = override?.routingMode;
  let vllmModelId = wireModelId;
  if (isOpenRouter && !providerTag && routingMode && routingMode !== 'standard') {
    vllmModelId = `${wireModelId}:${routingMode}`;
    log.appendLine(`[INFO] Model "${modelId}" → OpenRouter routing mode "${routingMode}" (wire id ${vllmModelId})`);
  }

  // Anthropic prompt caching (OpenRouter): Claude-family models have no
  // implicit caching upstream — without an explicit directive EVERY turn
  // re-bills the whole prompt, and Copilot re-sends the full context each
  // turn. The top-level ephemeral directive makes each repeat a ~0.1x cache
  // read (first turn pays a 1.25x write; the 5-min TTL re-arms free on every
  // hit, so a tight agent loop keeps one warm cache for the whole session).
  // Gated to `anthropic/*`: OpenRouter exposes no machine-readable
  // cache-capability signal (absent from catalog AND endpoint
  // `supported_parameters`, verified 2026-09-09), so the family prefix is the
  // honest gate — every other cacheable family already caches implicitly for
  // free, and marker translation on OpenAI GPT-5.6+ risks explicit-mode
  // write billing. `promptCache: '1h'` pays the 2x write for a 1-hour TTL
  // (gaps > 5 min between turns); 'off' disables. Omitted/'on' = 5-min.
  const promptCache = override?.promptCache;
  if (isOpenRouter && /^~?anthropic\//.test(wireModelId)) {
    if (promptCache === 'off') {
      // "off" means off WITHIN this family: a cache_control inherited from
      // defaultParams, a model mode, or Copilot's runtime options must not
      // survive the switch. Outside the family promptCache is inert in both
      // directions (as the docs promise) - a hand-written cache_control on
      // another family is raw-parameter territory and stays untouched.
      delete mergedOptions.cache_control;
    } else {
      mergedOptions.cache_control =
        promptCache === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
    }
  }

  // Resolve per-model server config (URL + isolated request headers + transport
  // + backend type) via the registry. A model whose `server` ref does not
  // resolve is unreachable — fail loudly rather than send to an empty URL.
  const resolved = resolveServerConfig(override, servers);
  if (!resolved) {
    // Distinguish the two ways this fails (CR-46): `resolveServerConfig`
    // returns undefined both for a dangling `server` ref AND for a missing
    // model entry (deleted in the last picker-TTL, or hand-deleted). Blaming
    // the registry for a deleted model sends the user to fix a server that is
    // perfectly fine.
    if (!override) {
      throw new Error(
        `Model "${modelId}" is no longer configured - its model entry was removed from settings. Re-add the model to use it.`
      );
    }
    throw new Error(
      `Model "${modelId}" references an unknown server - no registry entry matches its "server" ref. Fix the reference or re-add the server.`
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
    log.appendLine(
      `[INFO] Model "${modelId}" → requestHeaders sent: ${headerKeys.join(', ')}`
    );
  }

  return { vllmModelId, wireModelId, openaiMessages, mergedOptions, serverConfig };
}
