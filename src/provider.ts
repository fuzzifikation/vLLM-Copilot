import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { VllmClient } from './vllmClient.js';
import { resolveVllmModelId, resolveOverrideForModel, resolveServerConfig, resolveModelSettings, resolveRequestParams, type VllmConfig } from './config.js';
import { FileLogger } from './logger.js';
import { buildModelInfo } from './modelInfo.js';
import { reportTokenUsage, logTokenUsage } from './usageReporting.js';
import { setLastRequest, type LastRequestData } from './lastRequestStore.js';
import type { WireMetrics } from './types.js';
import {
  messageToText,
  convertMessages,
  parseToolCallArgs,
  formatError,
  serializeError,
  describeError,
  isGracefulTermination,
} from './messageConverter.js';
import { loadPromptReplacements, applyPromptReplacements, type PromptReplacement } from './promptReplacer.js';
import type { StreamEvent, OpenAIChatMessage, WireUsage } from './types.js';

/**
 * Matches raw reasoning tags (`</thinking>`, `<thinking>`, etc.) that
 * leak into the content stream when vLLM has no matching `--reasoning-parser`.
 */
const RAW_THINK_TAG = /<\/?think(?:ing)?>/i;

/**
 * Mutable accounting for a single streamed response, shared across the four phases
 * of {@link VllmChatModelProvider.provideLanguageModelChatResponse}. `consumeStream`
 * updates it as chunks arrive so that the post-stream diagnostics and the error
 * handler can both reason about exactly what reached the user — even when the
 * stream throws partway through.
 */
interface StreamOutcome {
  /** At least one text content part was reported to the user. */
  hadContent: boolean;
  /** At least one tool call was reported to the user. */
  hadToolCalls: boolean;
  /** At least one reasoning/thinking part was reported. */
  hadReasoning: boolean;
  /** Raw `.githubusercontent` tags leaked into content (server is missing a `--reasoning-parser`). */
  sawRawThinkTags: boolean;
  /** The server's `finish_reason` for the turn, once known. */
  finishReason?: string;
  /** Time-to-first-token, in ms since the request started. */
  firstTokenTime?: number;
  /** Full accumulated text content for this turn (used as assistant prefill/continuation on retry). */
  contentBuffer?: string;
}

/**
 * Capture entry for a single system message, written to .vllm/system-messages.json.
 */
interface CaptureEntry {
  receivedContent: string;
  deliveredContent: string;
  rulesApplied: string[];
}

export class VllmChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private client: VllmClient;
  private cachedModels: vscode.LanguageModelChatInformation[] | null = null;

  /** Promise chain that serializes concurrent writes to system-messages.json. Always resolves. */
  #systemMessageWriteQueue: Promise<void> = Promise.resolve();

  /** Event fired when model information changes (e.g., after refresh). */
  private _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

  constructor(
    private context: vscode.ExtensionContext,
    private output: vscode.OutputChannel,
    private fileLogger?: FileLogger
  ) {
    this.client = new VllmClient(context, output, fileLogger);
  }

  dispose(): void {
    this._onDidChangeLanguageModelChatInformation.dispose();
  }

  /**
   * Clear cached model list and fire change event so VS Code refreshes.
   * Also invalidates VllmClient's config cache (the single source of truth for
   * config) so settings changes (per-model serverUrl, headers, params) take effect
   * immediately rather than after extension restart.
   */
  clearCache(): void {
    this.cachedModels = null;
    this.client.invalidateConfigCache();
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  /**
   * Discover available models from the vLLM server.
   */
  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // If silent mode, return cached models without recomputing
    if (options.silent && this.cachedModels) {
      return this.cachedModels;
    }

    const config = await this.client.getConfigCached();
    const modelOverrides = config.models || [];

    if (modelOverrides.length === 0) {
      return [];
    }

    // Process each model: fetch context window from server, build info, or record error.
    // All models are queried in parallel so discovery time = max(server latencies), not sum.
    const tasks = modelOverrides.map(async (override) => {
      if (!override.serverUrl) {
        const id = override.id || resolveVllmModelId(override) || '(unnamed model)';
        return {
          model: null,
          error: `[WARN] Model "${id}" has no serverUrl and will be skipped. Add one or run "Add vLLM Server & Model".`,
        };
      }

      const settings = resolveModelSettings(override);
      const vllmModelId = resolveVllmModelId(override) || override.id || '';
      const serverConfig = resolveServerConfig(override);

      try {
        // Fetch context window from vLLM server — this is authoritative and cannot
        // be set in settings. Also serves as a server availability check.
        const maxModelLen = await this.client.getModelContextWindow(
          serverConfig.serverUrl,
          serverConfig.requestHeaders,
          vllmModelId
        );

        if (!maxModelLen) {
          return {
            model: null,
            error: `[WARN] Model "${vllmModelId}" — server did not report max_model_len. Server may be offline or model not loaded.`,
          };
        }

        const serverModel = { id: vllmModelId, max_model_len: maxModelLen };
        return {
          model: buildModelInfo(serverModel, override, settings, (family, modelId) => {
            // Fires only when no preset-declared family was available AND
            // HuggingFace auto-discovery did not provide one — the heuristic
            // fell through to the org-name guess. The family is just a sort key
            // in the model picker so this is non-fatal, but the user should
            // know the discovery path didn't reach HuggingFace.
            this.output.appendLine(
              `[WARN] Model "${modelId}" — family estimated as "${family}" from org-name fallback (no preset/HuggingFace family available). Family is informational only; use a preset or run auto-discovery for authoritative values.`
            );
          }),
          error: null,
        };
      } catch (err) {
        const id = override.id || vllmModelId || '(unnamed model)';
        return {
          model: null,
          error: `[WARN] Model "${id}" — failed to connect to server: ${describeError(err)}`,
        };
      }
    });

    const results = await Promise.allSettled(tasks);
    const models: vscode.LanguageModelChatInformation[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { model, error } = result.value;
        if (model) {
          models.push(model);
        }
        if (error) {
          this.output.appendLine(error);
        }
      } else {
        // Should not happen (errors are caught above), but log defensively
        this.output.appendLine(`[WARN] Discovery task rejected: ${result.reason}`);
      }
    }

    this.cachedModels = models;

    if (models.length > 0) {
      const summary = models.map(m => {
        const ctx = ((m.maxInputTokens || 0) + (m.maxOutputTokens || 0)).toLocaleString();
        return `${m.id} (${ctx} ctx)`;
      }).join(', ');
      this.output.appendLine(`[INFO] Loaded ${models.length} model(s): ${summary}`);
    }

    return models;
  }

  /**
   * Handle chat requests by forwarding to the vLLM server and streaming back.
   *
   * Orchestrates phases for each attempt, with optional auto-retry on empty
   * responses using assistant prefill:
   *   1. {@link buildRequest} — assemble the vLLM request (messages + sampling params)
   *   2. {@link consumeStream} — stream the response, reporting parts as they arrive
   *   3. {@link reportPostStreamDiagnostics} — surface truncation / empty-response issues
   *   4. {@link handleResponseError} — classify and report any failure
   *
   * Auto-continue: when the model stops (finish_reason: stop) with an empty response,
   * we re-ask with an empty assistant prefill (a nudge — vLLM starts a fresh turn, and
   * nothing was streamed so nothing is lost). When it stops mid-sentence on a trailing
   * colon, we CONTINUE the text already streamed using vLLM's continuation mode
   * (continue_final_message=true, add_generation_prompt=false) so the model resumes the
   * open assistant message instead of regenerating it (which would duplicate output).
   * All retries share one progress reporter, so Copilot sees a single seamless stream.
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const startTime = Date.now();

    // Guard: if we're connected to a remote but the extension is running locally,
    // the user almost certainly forgot to install the extension on the remote.
    // Catch this before making a request — the error would be opaque otherwise.
    if (vscode.env.remoteName && this.context.extension.extensionKind === vscode.ExtensionKind.UI) {
      const remoteHost = vscode.env.remoteName;
      this.output.appendLine(
        `[ERROR] vLLM-Copilot is running locally while connected to ${remoteHost}. ` +
        `Install the extension on the remote to enable chat.`
      );
      progress.report(new vscode.LanguageModelTextPart(
        `⚠️ **vLLM-Copilot is not installed on the remote.**\n\n` +
        `You are connected to **${remoteHost}**, but this extension is running on your local machine. ` +
        `LLM requests will fail or behave unexpectedly.\n\n` +
        `**To fix this:**\n` +
        `1. Open the Extensions view: \\\`Ctrl+Shift+X\\\`\n` +
        `2. Click the "..." menu in the extensions toolbar → **Install in ${remoteHost}...** (or look for the 📥 icon)\n` +
        `3. Search for **vLLM-Copilot** and install it on the remote\n` +
        `4. Try your request again`
      ));
      return;
    }

    // Load config first — needed for capture + replace pipeline and request building
    const config = await this.client.getConfigCached();

    // System message pipeline: apply replacements, capture to disk, return processed messages.
    // Replacements are applied to a clone — VS Code's original messages are never mutated.
    const processedMessages = await this.processSystemMessages(model, messages, config);

    const outcome: StreamOutcome = {
      hadContent: false,
      hadToolCalls: false,
      hadReasoning: false,
      sawRawThinkTags: false,
      contentBuffer: undefined,
    };

    try {
      const streamOverride = resolveOverrideForModel(config.models || [], model.id);
      const maxRetries = resolveModelSettings(streamOverride).autoContinueRetries;

      const { vllmModelId, openaiMessages, mergedOptions, serverConfig } =
        await this.buildRequest(model, processedMessages, options, config);

      // Auto-continue retry loop: initial attempt + up to maxRetries retries.
      //
      // Two distinct triggers, each with its OWN request shape:
      //   1. Empty response (model emitted only reasoning, then stopped): re-ask with an
      //      empty assistant prefill under the DEFAULT chat-template flags. vLLM starts a
      //      fresh assistant turn — a harmless "nudge", since nothing reached Copilot yet.
      //   2. Truncated mid-sentence (content ends with ':'): genuinely CONTINUE the text
      //      already streamed. This needs vLLM's continuation mode
      //      (continue_final_message=true, add_generation_prompt=false) so the model resumes
      //      the open assistant message and returns only NEW tokens. Without it, vLLM closes
      //      the prefill as a finished turn and regenerates — duplicating what Copilot saw.
      let prefillIndex = -1;       // index of the trailing assistant prefill message, once added
      let assistantPrefill = '';   // text to continue; empty string keeps us in nudge mode
      let attemptCount = 0;        // actual number of attempts made (for accurate diagnostics)
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        attemptCount++;
        // Continuation mode applies only once we have streamed text to resume.
        const continuing = assistantPrefill.length > 0;
        const requestOptions = continuing
          ? { ...mergedOptions, continue_final_message: true, add_generation_prompt: false }
          : mergedOptions;

        const stream = this.client.chatCompletionStream(
          vllmModelId,
          openaiMessages,
          requestOptions,
          token,
          serverConfig
        );
        await this.consumeStream(stream, model, progress, token, startTime, outcome, serverConfig.serverUrl, vllmModelId);

        // Retry when the model stopped (finish_reason: stop) either with no content at all,
        // or mid-sentence on a trailing colon. Use the full buffer (not the last chunk) so a
        // trailing whitespace-only chunk can't hide the colon.
        if (token.isCancellationRequested) break;
        const endsWithColon = !!outcome.contentBuffer && outcome.contentBuffer.trimEnd().endsWith(':');
        const shouldRetry = (!outcome.hadContent || endsWithColon)
          && outcome.finishReason === 'stop'
          && attempt < maxRetries;
        if (!shouldRetry) break;

        // Grow the prefill: a colon-truncated reply continues from everything streamed so far;
        // an empty response contributes nothing, keeping assistantPrefill empty (nudge mode).
        if (outcome.hadContent) {
          assistantPrefill += outcome.contentBuffer ?? '';
        }
        const prefillMessage: OpenAIChatMessage = { role: 'assistant', content: assistantPrefill };
        if (prefillIndex === -1) {
          openaiMessages.push(prefillMessage);
          prefillIndex = openaiMessages.length - 1;
        } else {
          openaiMessages[prefillIndex] = prefillMessage;
        }

        const reason = outcome.hadContent
          ? 'response ended with colon (incomplete sentence)'
          : 'empty response';
        const mode = assistantPrefill.length > 0 ? 'continuation' : 'prefill';
        this.resetOutcome(outcome);
        this.output.appendLine(
          `[INFO] ${model.id}: ${reason} — retrying with assistant ${mode} (attempt ${attempt + 1}/${maxRetries + 1})`
        );
      }

      this.reportPostStreamDiagnostics(model, messages, options, outcome, startTime, progress, attemptCount);
    } catch (err) {
      this.handleResponseError(err, model, outcome, token, progress);
    }
  }

  /**
   * Reset all mutable fields on the outcome object for a retry attempt.
   */
  private resetOutcome(outcome: StreamOutcome): void {
    outcome.hadContent = false;
    outcome.hadToolCalls = false;
    outcome.hadReasoning = false;
    outcome.sawRawThinkTags = false;
    outcome.finishReason = undefined;
    outcome.firstTokenTime = undefined;
    outcome.contentBuffer = undefined;
  }

  /**
   * Phase 1 — assemble the vLLM chat request.
   *
   * Converts VS Code messages to OpenAI format, merges config defaults with
   * Copilot's `modelOptions` and the selected model-mode parameters, and resolves
   * the vLLM server model id to call.
   */
  private async buildRequest(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    config: VllmConfig
  ): Promise<{
    vllmModelId: string;
    openaiMessages: OpenAIChatMessage[];
    mergedOptions: Record<string, unknown>;
    serverConfig: { serverUrl: string; requestHeaders: Record<string, string>; streamInactivityTimeout: number };
  }> {
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
    const modelConfiguration = (options as any).modelConfiguration as Record<string, unknown> | undefined;
    const modelOverrides = config.models || [];
    const override = resolveOverrideForModel(modelOverrides, model.id);

    const selectedMode = typeof modelConfiguration?.reasoningEffort === 'string'
      ? modelConfiguration.reasoningEffort as string
      : undefined;

    const modeParams = selectedMode && override?.modelModes?.[selectedMode]
      ? override.modelModes[selectedMode]
      : undefined;

    const mergedOptions: Record<string, unknown> = {
      // Layered params: defaults ← (max_tokens + Copilot modelOptions) ← defaultParams ← mode.
      ...resolveRequestParams(override, selectedMode, {
        max_tokens: model.maxOutputTokens,
        ...options.modelOptions,
      }),
      // NOTE: tools/tool_choice come last so Copilot's tool definitions always win.
      tools,
      // Enforce tool_choice when Copilot requires the model to call a tool.
      ...(options.toolMode === vscode.LanguageModelChatToolMode.Required && tools
        ? { tool_choice: 'required' as const }
        : {}),
    };

    // Re-assert max_tokens after layering so a stray `max_tokens` in defaultParams
    // or a mode entry cannot override the safety-critical output budget derived
    // from the server's context window (deriveTokenBudget). Same pattern as
    // tools/tool_choice above — these must always win.
    mergedOptions.max_tokens = model.maxOutputTokens;

    // Log model mode diagnostic info to output channel for debugging
    this.output.appendLine(`[DEBUG] Model ${model.id}: modelConfiguration=${JSON.stringify(modelConfiguration)}, override.modelModes=${override?.modelModes ? Object.keys(override.modelModes).join(', ') : 'none'}, selectedMode=${selectedMode ?? 'none'}`);

    if (modeParams) {
      this.output.appendLine(`[INFO] Model mode: "${selectedMode}" → ${JSON.stringify(modeParams)}`);
    } else if (selectedMode) {
      this.output.appendLine(`[WARN] Selected mode "${selectedMode}" not found in modelModes for ${model.id} — no mode parameters applied`);
    } else if (override?.modelModes && Object.keys(override.modelModes).length > 0) {
      this.output.appendLine(`[WARN] Model has modelModes configured but none was selected for ${model.id}`);
    }

    // Resolve the vLLM server model ID: use vllmModelId from override if set, otherwise fall back to preset id
    const vllmModelId = resolveVllmModelId(override) || model.id;

    // Resolve per-model server config (serverUrl + isolated request headers + transport).
    const resolved = resolveServerConfig(override);
    const serverConfig = {
      ...resolved,
      streamInactivityTimeout: resolveModelSettings(override).streamInactivityTimeout,
    };

    // Log which headers are being sent (keys only, not values) for diagnostics
    const headerKeys = Object.keys(resolved.requestHeaders);
    if (headerKeys.length > 0) {
      this.output.appendLine(
        `[INFO] Model "${model.id}" → requestHeaders sent: ${headerKeys.join(', ')}`
      );
    }

    return { vllmModelId, openaiMessages, mergedOptions, serverConfig };
  }

  /**
   * Phase 2 — consume the vLLM stream, reporting parts as they arrive.
   *
   * Mutates `outcome` in place (rather than returning it) so that a mid-stream
   * throw still leaves the caller's error handler with an accurate picture of
   * what was already emitted to the user.
   */
  private async consumeStream(
    stream: AsyncIterable<StreamEvent>,
    model: vscode.LanguageModelChatInformation,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    startTime: number,
    outcome: StreamOutcome,
    serverUrl: string,
    vllmModelId: string,
  ): Promise<void> {
    // Track reported tool calls to avoid duplicates
    const reportedToolCallIds = new Set<string>();

    // Look up LanguageModelThinkingPart once before the loop, not on every chunk.
    // Once @types/vscode ships the type (engine ≥ 1.120.0), replace (vscode as any) with vscode.
    const ThinkingPart = (vscode as any).LanguageModelThinkingPart;

    // Defer usage reporting to end of stream. Some vLLM servers (e.g. with
    // --enable-force-include-usage) send usage on every chunk, not just the final
    // one. Reporting per-chunk floods the Output channel with thousands of
    // [TOKENS] lines. We store the latest usage and report it exactly once after
    // the loop — the final chunk always has the correct cumulative stats.
    let pendingUsage: WireUsage | undefined;
    let pendingMetrics: WireMetrics | undefined;

    for await (const event of stream) {
      if (token.isCancellationRequested) {
        break;
      }

      // Handle reasoning/thinking tokens (deep thinking models like QwQ, DeepSeek R1)
      if (event.reasoning_content) {
        if (outcome.firstTokenTime === undefined) outcome.firstTokenTime = Date.now() - startTime;
        outcome.hadReasoning = true;
        progress.report(new ThinkingPart(event.reasoning_content));
      }

      // Handle text content
      if (event.content) {
        if (outcome.firstTokenTime === undefined) outcome.firstTokenTime = Date.now() - startTime;
        outcome.hadContent = true;
        outcome.contentBuffer = (outcome.contentBuffer ?? '') + event.content;
        // Detect raw thinking tags leaking into content. When vLLM is started without
        // a matching --reasoning-parser, the model's <thinking>...</thinking> markers arrive
        // as plain content instead of the `reasoning` field, then VS Code strips them.
        if (!outcome.sawRawThinkTags && RAW_THINK_TAG.test(event.content)) {
          outcome.sawRawThinkTags = true;
        }
        progress.report(new vscode.LanguageModelTextPart(event.content));
      }

      // Handle finalized tool calls
      if (event.finishedToolCalls.length > 0) {
        for (const tc of event.finishedToolCalls) {
          if (!reportedToolCallIds.has(tc.id) && tc.name) {
            const parsedArgs = parseToolCallArgs(tc);
            // If args couldn't be repaired, fall back to {} — matching VS Code BYOK's
            // behavior. Dropping the call entirely makes it look like the model stopped
            // without doing anything (the "stream just stopped" symptom). Surfacing it
            // with {} lets Copilot invoke the tool, which fails downstream with a clear
            // error rather than vanishing silently.
            const args = parsedArgs ?? {};
            outcome.hadToolCalls = true;
            if (parsedArgs === null) {
              this.output.appendLine(
                `[WARN] Tool call ${tc.id} (${tc.name}): args unparseable, falling back to {} — raw: ${tc.arguments.substring(0, 200)}`
              );
            }
            progress.report(
              new vscode.LanguageModelToolCallPart(tc.id, tc.name, args)
            );
            reportedToolCallIds.add(tc.id);
          }
        }
      }

      // Defer usage reporting to after the loop — see pendingUsage comment above.
      if (event.usage) {
        pendingUsage = event.usage;
      }
      if (event.metrics) {
        pendingMetrics = event.metrics;
      }

      if (event.finishReason) {
        outcome.finishReason = event.finishReason;
      }
    }

    // Report token usage exactly once with the final cumulative stats.
    if (pendingUsage) {
      const totalElapsedMs = Date.now() - startTime;
      reportTokenUsage(progress, pendingUsage);
      this.fileLogger?.logStreamFinish(outcome.finishReason || 'unknown', pendingUsage);
      logTokenUsage(this.output, model.id, pendingUsage, totalElapsedMs, outcome.firstTokenTime);

      // Store last request data for the dashboard
      const hasCacheDetails = !!pendingUsage.prompt_tokens_details;
      const hasMetrics = !!pendingMetrics;
      const lastRequestData: LastRequestData = {
        serverUrl,
        modelId: vllmModelId,
        timestamp: Date.now(),
        promptTokens: pendingUsage.prompt_tokens,
        completionTokens: pendingUsage.completion_tokens,
        totalTokens: pendingUsage.total_tokens,
        cachedTokens: pendingUsage.prompt_tokens_details?.cached_tokens,
        createdCacheTokens: pendingUsage.prompt_tokens_details?.created_cache_tokens,
        reasoningTokens: pendingUsage.completion_tokens_details?.reasoning_tokens,
        metrics: pendingMetrics,
        hasMetrics,
        hasCacheDetails,
      };
      setLastRequest(lastRequestData);
    }
  }

  /**
   * Phase 3 — surface anything that explains an unexpected or empty result.
   *
   * Every branch writes to the Output channel (via {@link diag}) and may also
   * push a user-visible note into the chat, so a stop with no useful output is
   * never indistinguishable from a hang.
   *
   * @param actualAttempts - The actual number of attempts made (not the maximum possible).
   */
  private reportPostStreamDiagnostics(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    outcome: StreamOutcome,
    startTime: number,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    actualAttempts: number
  ): void {
    const { hadContent, hadToolCalls, hadReasoning, sawRawThinkTags, finishReason } = outcome;

    // Raw <thinking> tags in content (and no separated reasoning) means the server is
    // missing a matching --reasoning-parser. Log it so the cause is visible — this is
    // a server-config issue the user can fix, not something we can repair silently.
    if (sawRawThinkTags && !hadReasoning) {
      this.diag(
        'WARN',
        `${model.id}: raw <thinking> tags detected in content — vLLM is likely missing a matching ` +
        `--reasoning-parser (e.g. qwen3, deepseek_r1). Reasoning is being rendered as plain text and ` +
        `may be stripped by the chat view. Start vLLM with the correct --reasoning-parser to separate it.`
      );
    }

    // Warn if tool calls were truncated by token limit
    if (finishReason === 'length' && hadToolCalls) {
      this.diag(
        'WARN',
        `${model.id}: tool call arguments may be truncated (finish_reason: length). ` +
        `Consider increasing maxOutputTokens in model settings.`
      );
    }

    // Warn if Copilot required a tool call but model returned only text
    if (
      options.tools && options.tools.length > 0 &&
      options.toolMode === vscode.LanguageModelChatToolMode.Required &&
      !hadToolCalls &&
      finishReason === 'stop'
    ) {
      this.diag(
        'WARN',
        `${model.id}: Copilot required a tool call but model returned text only (finish_reason: stop). ` +
        `Verify vLLM server flags: --enable-auto-tool-choice --tool-call-parser <parser>. ` +
        `For Qwen3-Coder models use --tool-call-parser qwen3coder.`
      );
    }

    const producedOutput = hadContent || hadToolCalls;

    // Tell the user when generation stopped without giving them anything useful.
    // An empty (or thinking-only) turn is otherwise indistinguishable from a hang,
    // so always surface the reason — both to the user and to Output.
    if (!producedOutput) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      let reason: string;
      if (finishReason && hadReasoning) {
        reason = `model stopped after only producing reasoning/thinking tokens (finish_reason: ${finishReason})`;
      } else if (finishReason) {
        reason = `finish_reason: ${finishReason}`;
      } else if (hadReasoning) {
        reason = 'only reasoning/thinking tokens were produced (no finish_reason received)';
      } else {
        reason = 'no data received';
      }

      let hint: string;
      if (finishReason === 'length') {
        hint = 'It hit the max output token limit before producing any text — increase maxOutputTokens.';
      } else if (finishReason === 'content_filter') {
        hint = 'The server blocked the response (content filter).';
      } else if (hadReasoning) {
        if (finishReason === 'stop') {
          hint = actualAttempts > 1
            ? `Model stopped on its own after ${actualAttempts} attempt(s), producing only reasoning. Try increasing maxOutputTokens, lowering reasoning_effort, or adjusting the model mode.`
            : 'Model stopped on its own after producing only reasoning tokens. Try increasing maxOutputTokens, lowering reasoning_effort, or adjusting the model mode.';
        } else {
          hint = actualAttempts > 1
            ? `The model produced only reasoning/thinking tokens after ${actualAttempts} attempt(s) — try again or adjust the model mode.`
            : 'The model produced only reasoning/thinking tokens and no answer — try again or adjust the model mode.';
        }
      } else {
        hint = actualAttempts > 1
          ? `Empty response after ${actualAttempts} attempt(s) — check model configuration and server logs.`
          : 'Check the model configuration and server logs (Output → vLLM-Copilot).';
      }

      // maxOutputTokens is only relevant when the model hit its token ceiling.
      const extraCtx = finishReason === 'length' ? `, maxOutputTokens=${model.maxOutputTokens}` : '';

      if (actualAttempts > 1) {
        this.diag(
          'WARN',
          `${model.id}: empty response after ${actualAttempts} attempt(s) (${reason}) — giving up after ${elapsed}s${extraCtx}`
        );
      } else {
        this.diag(
          'WARN',
          `${model.id}: empty response (${reason}) after ${elapsed}s${extraCtx}`
        );
      }

      progress.report(new vscode.LanguageModelTextPart(
        `⚠️ The model returned no output (${reason}) after ${elapsed}s. ${hint}`
      ));
    } else if (finishReason === 'length' && hadContent) {
      // The user got a partial answer — warn that it was cut off so they don't
      // mistake a truncated response for a complete one.
      this.diag('WARN', `${model.id}: response truncated at max output tokens (finish_reason: length).`);
      progress.report(new vscode.LanguageModelTextPart(
        `\n\n⚠️ Response truncated — reached the max output token limit. Increase maxOutputTokens to get the full answer.`
      ));
    }
  }

  /**
   * Phase 4 — classify and report a failure thrown while streaming.
   *
   * User cancellations and graceful connection terminations are logged quietly
   * (Copilot already shows the stopped state); anything else is surfaced to the
   * user as a chat message and recorded in the Output channel and log file.
   */
  private handleResponseError(
    err: unknown,
    model: vscode.LanguageModelChatInformation,
    outcome: StreamOutcome,
    token: vscode.CancellationToken,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): void {
    // User-initiated cancellation isn't a failure: log it quietly and don't
    // surface a scary error message — Copilot already shows the stopped state.
    if (token.isCancellationRequested) {
      this.diag('INFO', `${model.id}: request cancelled by user.`);
      return;
    }

    // VS Code may terminate the connection internally (e.g., after reading files
    // during tool orchestration) without firing the cancellation token. These
    // graceful terminations should be treated like user cancellations — no error
    // message to the user, just a quiet log entry.
    if (isGracefulTermination(err)) {
      this.diag('INFO', `${model.id}: request terminated (connection reset).`);
      // If no content was produced, report a minimal part so VS Code doesn't
      // show "no response was returned" in the chat.
      if (!outcome.hadContent && !outcome.hadToolCalls) {
        progress.report(new vscode.LanguageModelTextPart('\n'));
      }
      return;
    }

    const detail = serializeError(err);
    this.output.appendLine(`[ERROR] Chat response failed for ${model.id}:\n${detail}`);
    // Report error to user via text part — don't re-throw, VS Code swallows it anyway
    const errorMsg = formatError(err);
    progress.report(new vscode.LanguageModelTextPart(`⚠️ ${errorMsg}`));
  }

  /**
   * Count tokens using a fast local estimate.
   * VS Code calls this repeatedly during chat — avoid blocking network calls,
   * otherwise the request never leaves Copilot (it waits on token counts).
   */
  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const prompt = typeof text === 'string' ? text : messageToText(text);

    let charsPerToken = 3.5;
    try {
      const cfg = await this.client.getConfigCached();
      const override = resolveOverrideForModel(cfg.models || [], model.id);
      const estimate = resolveModelSettings(override).estimateCharsPerToken;
      if (estimate > 0) charsPerToken = estimate;
    } catch (err) {
      // Fallback to default on config read failure
      this.output.appendLine(`[WARN] Token count config read failed: ${err instanceof Error ? err.message : String(err)}. Using default estimate.`);
    }

    return Math.max(1, Math.ceil(prompt.length / charsPerToken));
  }

  // ==================== System Message Pipeline ====================

  /**
   * Apply prompt replacements, capture to disk, return processed messages.
   *
   * Replacements are applied to a clone — VS Code's original messages are never mutated
   * (prevents cross-turn corruption). Capture is opt-in via `systemMessageCapture` setting.
   *
   * Flow: read original text → apply rules → create new message objects → capture → return.
   */
  private async processSystemMessages(
    model: vscode.LanguageModelChatInformation,
    originalMessages: readonly vscode.LanguageModelChatRequestMessage[],
    config: VllmConfig
  ): Promise<vscode.LanguageModelChatRequestMessage[]> {
    try {
      const override = resolveOverrideForModel(config.models || [], model.id);
      const replacements = await this.loadReplacements(override);

      if (!replacements.length) return [...originalMessages];

      // Build new message array. Replaced system messages get NEW objects;
      // non-system messages pass through by reference (they're never mutated).
      const replacedMessages: vscode.LanguageModelChatRequestMessage[] = [];
      const captureEntries: CaptureEntry[] = [];

      for (const msg of originalMessages) {
        if (msg.role === vscode.LanguageModelChatMessageRole.User ||
            msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
          replacedMessages.push(msg);
          continue;
        }

        const receivedContent = messageToText(msg);
        if (!receivedContent) {
          replacedMessages.push(msg);
          continue;
        }

        const applied = applyPromptReplacements(receivedContent, replacements);

        // Create a NEW message object — VS Code's original stays pristine
        replacedMessages.push({
          role: msg.role,
          content: [new vscode.LanguageModelTextPart(applied.result)],
          name: (msg as any).name,
        } as vscode.LanguageModelChatRequestMessage);

        captureEntries.push({
          receivedContent,
          deliveredContent: applied.result,
          rulesApplied: applied.matchedRuleNames,
        });
      }

      // Capture to disk (opt-in, fire-and-forget)
      if (captureEntries.length > 0) {
        const cfg = vscode.workspace.getConfiguration('vllm-copilot');
        if (cfg.get<boolean>('systemMessageCapture', false)) {
          this.captureToDisk(originalMessages, captureEntries).catch(err => {
            this.output.appendLine(`[WARN] System message capture failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }

      return replacedMessages;
    } catch (err) {
      this.output.appendLine(`[WARN] System message pipeline failed: ${err instanceof Error ? err.message : String(err)}`);
      return [...originalMessages];
    }
  }

  /**
   * Load replacement rules for a model override. Resolves relative paths against workspace root.
   */
  private async loadReplacements(override: ReturnType<typeof resolveOverrideForModel>): Promise<PromptReplacement[]> {
    if (!override?.systemMessageReplacementsFile) return [];

    try {
      let replacementsFile = override.systemMessageReplacementsFile;
      if (!path.isAbsolute(replacementsFile)) {
        const folders = vscode.workspace.workspaceFolders;
        if (folders?.length) {
          replacementsFile = path.join(folders[0].uri.fsPath, replacementsFile);
        }
      }

      try {
        await fs.access(replacementsFile);
      } catch {
        this.output.appendLine(`[WARN] Replacements file not found: ${replacementsFile}`);
        return [];
      }

      const replacements = await loadPromptReplacements(replacementsFile);
      if (replacements.length > 0) {
        this.output.appendLine(`[INFO] Loaded ${replacements.length} replacement rule(s) from ${replacementsFile}`);
      }
      return replacements;
    } catch (err) {
      this.output.appendLine(`[WARN] Failed to load replacements: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Capture system messages to .vllm/system-messages.json (fire-and-forget, serialized).
   *
   * `originalMessages` are VS Code's pristine objects (never mutated by this module).
   * `captureEntries` contain replaced messages with both original and transformed content.
   * Any system messages NOT in captureEntries are passthroughs (no replacements matched).
   */
  private async captureToDisk(
    originalMessages: readonly vscode.LanguageModelChatRequestMessage[],
    captureEntries: CaptureEntry[]
  ): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return;

    const targetPath = path.join(folders[0].uri.fsPath, '.vllm', 'system-messages.json');

    // Entries from replacements — these have correct receivedContent (original text)
    // and deliveredContent (transformed text).
    const entriesToCapture: CaptureEntry[] = [...captureEntries];

    // Build a set of receivedContent keys we've already captured (from replacements)
    // so we don't double-capture those messages.
    const alreadyCaptured = new Set(captureEntries.map(e => e.receivedContent));

    // Passthrough: capture any system messages in originalMessages that had no replacements
    // applied. These were NOT mutated, so messageToText returns the original text.
    for (const msg of originalMessages) {
      if (msg.role === vscode.LanguageModelChatMessageRole.User ||
          msg.role === vscode.LanguageModelChatMessageRole.Assistant) continue;

      const receivedContent = messageToText(msg);
      if (!receivedContent || alreadyCaptured.has(receivedContent)) continue;

      entriesToCapture.push({
        receivedContent,
        deliveredContent: receivedContent,
        rulesApplied: [],
      });
    }

    if (entriesToCapture.length === 0) return;

    // Deduplicate within this request (shouldn't happen, but guard against it)
    const uniqueEntries = Array.from(
      new Map(entriesToCapture.map(e => [e.receivedContent, e])).values()
    );

    await this.#enqueueWrite(targetPath, uniqueEntries);
  }

  /**
   * Read existing capture file, merge new entries, write back.
   * Serialized via the promise queue so concurrent writes never race.
   */
  async #enqueueWrite(
    targetPath: string,
    newEntries: CaptureEntry[]
  ): Promise<void> {
    // Chain this write after the previous one
    const previous = this.#systemMessageWriteQueue;
    this.#systemMessageWriteQueue = previous.then(async () => {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      // Read existing entries
      let allEntries: CaptureEntry[] = [];
      try {
        const existing = await fs.readFile(targetPath, 'utf-8');
        const parsed = JSON.parse(existing);
        if (Array.isArray(parsed)) {
          allEntries = parsed;
        } else {
          this.output.appendLine(`[WARN] ${targetPath} is not a JSON array, starting fresh`);
        }
      } catch (err) {
        if (!(err instanceof Error && 'code' in err && (err as any).code === 'ENOENT')) {
          this.output.appendLine(`[WARN] Failed to read ${targetPath}, starting fresh: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Merge: new entries overwrite existing ones with the same receivedContent.
      const existingIndex = new Map<string, number>();
      allEntries.forEach((e, i) => existingIndex.set(e.receivedContent, i));

      let newCount = 0;
      let updatedCount = 0;
      for (const entry of newEntries) {
        const idx = existingIndex.get(entry.receivedContent);
        if (idx !== undefined) {
          allEntries[idx] = entry;
          updatedCount++;
        } else {
          allEntries.push(entry);
          newCount++;
        }
      }

      await fs.writeFile(targetPath, JSON.stringify(allEntries, null, 2), 'utf-8');
      this.output.appendLine(`[DIAG] Captured ${newCount} new, updated ${updatedCount} existing system message(s) → ${targetPath}`);
    }).catch(err => {
      // Swallow errors so the queue always resolves — a write failure shouldn't block future writes
      this.output.appendLine(`[WARN] Failed to write capture file: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  

  // ==================== Error Handling ====================

  /**
   * Emit a diagnostic to the Output channel only.
   *
   * Diagnostics (truncation warnings, empty responses, tool-call failures) are
   * human-readable operational status — they belong in the Output channel where
   * users can watch them in real time. The file logger captures wire-level traffic
   * (request/response bodies, headers, SSE chunks) for expert debugging.
   * Do NOT mix the two: diagnostics in the file log would pollute traffic capture,
   * and wire traffic in the Output channel would drown out status updates.
   */
  private diag(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
    this.output.appendLine(`[${level}] ${msg}`);
  }
}
