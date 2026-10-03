import * as vscode from 'vscode';
import { resolveOverrideForModel, resolveModelSettings, type VllmConfig } from '../core/config/config.js';
import type { FileLogger } from '../shared/logger.js';
import type { ProviderClient } from './contracts.js';
import { buildRequest } from './requestBuilder.js';
import { consumeStream } from './consumeStream.js';
import { createExecutionState, executeChatRequest } from '../core/request/execute.js';
import { reportPostStreamDiagnostics, handleResponseError } from './postStream.js';
import type { SystemMessagePipeline } from './systemMessagePipeline.js';
import { isTransportFailureText, iterateCauses } from '../core/shared/errors.js';

/**
 * True when the request failed at the transport layer: the server never
 * answered (connection refused, DNS failure, undici `fetch failed`). HTTP
 * error responses (the server answered, even with a 5xx) are NOT transport
 * failures, and neither are cancellations, timeouts, or mid-stream resets.
 *
 * A transport failure means the picker was advertising a server that no
 * longer exists, so the owner invalidates its model cache and the next
 * resolve re-probes rather than reusing the stale snapshot.
 */
function isTransportFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false; // a string is never instanceof Error; the old extra disjunct was a subset (CR-93)
  const combined = [err, ...iterateCauses(err)]
    .map(c => (c instanceof Error ? `${c.name} ${c.message}` : String(c)))
    .join(' ');
  return isTransportFailureText(combined);
}

/**
 * Collaborators the chat-response orchestration needs. The provider owns the
 * client, output, logger, and system-message pipeline, and hands them in — the
 * orchestration never touches the provider instance itself.
 */
export interface ChatDeps {
  client: ProviderClient;
  output: vscode.OutputChannel;
  fileLogger?: FileLogger;
  systemMessages: SystemMessagePipeline;
  /** Authoritative server-reported context window captured during discovery. */
  contextWindow?: number;
  /**
   * Called once when the request fails at the transport layer (server
   * unreachable). The picker was advertising a stale snapshot; the owner uses
   * this to invalidate its model cache so the dead model drops out.
   */
  onTransportFailure?: () => void;
}

/**
 * Handle chat requests by forwarding to the vLLM server and streaming back.
 *
 * Orchestrates the Copilot-facing phases:
 *   1. {@link buildRequest} — assemble the vLLM request (messages + sampling params)
 *   2. core {@link executeChatRequest} — bounded retry loop + observations
 *   3. {@link consumeStream} — report parts, hand completion data to usage paths
 *   4. {@link reportPostStreamDiagnostics} — surface truncation / empty-response issues
 *   5. {@link handleResponseError} — classify and report any failure
 *
 * Auto-continue lives in the core: an empty response is re-asked with an empty
 * assistant prefill; a vLLM response ending in a colon continues the text
 * already streamed; and an explicit mid-stream server error before answer text
 * or a tool call reaches Copilot replays the identical request. Retries stop
 * before answer/tool output can be duplicated. All attempts share one progress
 * reporter, so Copilot sees a single seamless stream.
 */
export async function runChatResponse(
  deps: ChatDeps,
  model: vscode.LanguageModelChatInformation,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken
): Promise<void> {
  const { client, output, fileLogger, systemMessages, contextWindow } = deps;
  const state = createExecutionState(Date.now());
  const outcome = state.outcome;

  // Copilot boundary: convert the cancellation token to a plain AbortSignal
  // ONCE per operation (the core loop retries underneath this consumer). The
  // 'User cancelled' abort reason is preserved verbatim (messageConverter
  // error classification pattern-matches it), and an already-cancelled token
  // aborts immediately — VS Code's event fires synchronously on subscribe for
  // cancelled tokens; the explicit `isCancellationRequested` check reproduces
  // that. The token itself still gates the quiet-cancel paths below.
  const controller = new AbortController();
  const cancel = () => controller.abort('User cancelled');
  const subscription = token.onCancellationRequested(cancel);
  if (token.isCancellationRequested) cancel();

  try {
    // Load config + run the system-message pipeline INSIDE the try so a rejected
    // config read routes through handleResponseError below instead of escaping
    // runChatResponse unhandled (skipping the [ERROR] log and the user-facing
    // error part). The pipeline guards every fallible step internally (its own
    // load failures degrade to no-replacements); this try is the backstop for
    // the config read and anything unforeseen. stream/loop failures were
    // already routed through handleResponseError.
    const config: VllmConfig = await client.getConfigCached();

    // System message pipeline: apply replacements, capture to disk, return processed messages.
    // Replacements are applied to a clone — VS Code's original messages are never mutated.
    const processedMessages = await systemMessages.processSystemMessages(model, messages, config);

    const streamOverride = resolveOverrideForModel(config.models, model.id);
    const maxRetries = resolveModelSettings(streamOverride).autoContinueRetries;

    const { vllmModelId, wireModelId, openaiMessages, mergedOptions, serverConfig } =
      buildRequest(model, processedMessages, options, config, output);

    // Execution (retry loop + observations) lives in the neutral core; this
    // consumer only reports what the core hands over. `openaiMessages` stays
    // caller-owned — the core mutates a trailing assistant prefill slot in
    // place, exactly as the old in-place loop did.
    const events = executeChatRequest(
      {
        transport: client,
        modelId: model.id,
        vllmModelId,
        openaiMessages,
        mergedOptions,
        serverConfig,
        maxRetries,
        signal: controller.signal,
        log: output,
        limits: {
          wireModelId,
          contextWindow,
          maxInputTokens: model.maxInputTokens || 0,
          maxOutputTokens: model.maxOutputTokens || 0,
        },
      },
      state,
    );
    await consumeStream(events, model, progress, outcome, output, fileLogger);

    // A user cancellation is a quiet stop (Copilot already shows the stopped
    // state) — do NOT run post-stream diagnostics. Without this gate, cancelling
    // before the first content token would fire the spurious "model returned no
    // output" warning, contradicting handleResponseError's quiet-cancel contract.
    if (!token.isCancellationRequested) {
      reportPostStreamDiagnostics(model, options, outcome, state.requestStartTime, progress, state.attemptCount, output);
    }
  } catch (err) {
    handleResponseError(err, model, outcome, token, progress, output);
    if (!token.isCancellationRequested && isTransportFailure(err)) {
      // The advertised server refused the connection: the picker snapshot is
      // stale. Tell the owner to invalidate so the next resolve drops this
      // model (and siblings on the same dead server) until it is back.
      deps.onTransportFailure?.();
    }
  } finally {
    subscription.dispose();
  }
}
