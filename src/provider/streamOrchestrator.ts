import * as vscode from 'vscode';
import { resolveOverrideForModel, resolveModelSettings, type VllmConfig } from '../config.js';
import type { FileLogger } from '../logger.js';
import type { OpenAIChatMessage } from '../types.js';
import type { ProviderClient } from './contracts.js';
import { buildRequest } from './requestBuilder.js';
import { consumeStream } from './consumeStream.js';
import { createOutcome, resetOutcome } from './outcome.js';
import { reportPostStreamDiagnostics, handleResponseError } from './postStream.js';
import type { SystemMessagePipeline } from './systemMessagePipeline.js';

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
export async function runChatResponse(
  deps: ChatDeps,
  model: vscode.LanguageModelChatInformation,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken
): Promise<void> {
  const { client, output, fileLogger, systemMessages, contextWindow } = deps;
  const startTime = Date.now();
  const outcome = createOutcome();

  try {
    // Load config + run the system-message pipeline INSIDE the try so a rejected
    // config read routes through handleResponseError below instead of escaping
    // runChatResponse unhandled (skipping the [ERROR] log and the user-facing
    // error part). The pipeline is self-catching — it logs [WARN] and returns the
    // original messages, so getConfigCached is the added rejection surface here;
    // stream/loop failures were already routed through handleResponseError.
    const config: VllmConfig = await client.getConfigCached();

    // System message pipeline: apply replacements, capture to disk, return processed messages.
    // Replacements are applied to a clone — VS Code's original messages are never mutated.
    const processedMessages = await systemMessages.processSystemMessages(model, messages, config);

    const streamOverride = resolveOverrideForModel(config.models || [], model.id);
    const maxRetries = resolveModelSettings(streamOverride).autoContinueRetries;

    const { vllmModelId, wireModelId, openaiMessages, mergedOptions, serverConfig } =
      buildRequest(model, processedMessages, options, config, output);

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
      // Per-attempt timing: consumeStream computes TTFT and total time relative to
      // this timestamp. A retried request must record only the FINAL attempt's
      // duration (the one whose output the user actually saw) — using the request-wide
      // startTime would make totalTimeMs span all attempts while firstTokenTime was the
      // last attempt's, producing a garbage "Generation (measured)" row. The
      // request-wide `startTime` still drives overall post-stream diagnostics.
      const attemptStartTime = Date.now();
      // Continuation mode (continue_final_message) is a vLLM-only feature. For
      // secondary backends' chat protocol strips those flags but KEEPS the assistant
      // prefill — so a colon-continuation would send the partial text as a COMPLETE
      // assistant turn and the server would regenerate from scratch, making the user see
      // the partial text twice. Non-vLLM backends always retry in nudge mode.
      const continuing = assistantPrefill.length > 0 && serverConfig.serverType === 'vllm';
      const requestOptions = continuing
        ? { ...mergedOptions, continue_final_message: true, add_generation_prompt: false }
        : mergedOptions;

      const stream = client.chatCompletionStream(
        vllmModelId,
        openaiMessages,
        requestOptions,
        token,
        serverConfig
      );
      await consumeStream(
        stream,
        model,
        progress,
        token,
        attemptStartTime,
        outcome,
        serverConfig.serverUrl,
        wireModelId,
        output,
        fileLogger,
        contextWindow,
      );

      // Retry when the model stopped (finish_reason: stop) either with no content at all,
      // or mid-sentence on a trailing colon. Use the full buffer (not the last chunk) so a
      // trailing whitespace-only chunk can't hide the colon.
      //
      // `!outcome.hadToolCalls` guards the empty branch: a pure tool-call turn
      // (no text content, but a finalized tool call) is a COMPLETE turn, not a
      // failed one — `finish_reason: 'stop'` after a tool call is the OpenAI/vLLM
      // convention for "done, here's my tool call." Retrying would re-ask the
      // model after it already took a valid action. The colon branch is already
      // gated by `hadContent`, so `hadToolCalls` only matters for the empty case.
      if (token.isCancellationRequested) break;
      const endsWithColon = !!outcome.contentBuffer && outcome.contentBuffer.trimEnd().endsWith(':');
      // Colon-continuation retries are vLLM-only. Without vLLM's
      // continue_final_message the server cannot resume an open assistant turn —
      // for secondary backends a colon retry would drop the already-streamed text,
      // nudge with an empty assistant message, and produce a disjoint fresh answer
      // (or a reject). Empty-response nudges are backend-agnostic and stay.
      const shouldRetry = (!outcome.hadContent || (endsWithColon && serverConfig.serverType === 'vllm'))
        && !outcome.hadToolCalls
        && outcome.finishReason === 'stop'
        && attempt < maxRetries;
      if (!shouldRetry) break;

      // Grow the prefill: a colon-truncated reply continues from everything streamed so far.
      // Only for vLLM (true continuation mode). For secondary backends the partial text
      // must NOT be replayed as a completed assistant turn — the chat protocol strips the
      // continuation flags there, so the server would regenerate and duplicate output.
      // An empty response contributes nothing, keeping assistantPrefill empty (nudge mode).
      if (outcome.hadContent && serverConfig.serverType === 'vllm') {
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
      resetOutcome(outcome);
      output.appendLine(
        `[INFO] ${model.id}: ${reason} — retrying with assistant ${mode} (attempt ${attempt + 1}/${maxRetries + 1})`
      );
    }

    // A user cancellation is a quiet stop (Copilot already shows the stopped
    // state) — do NOT run post-stream diagnostics. Without this gate, cancelling
    // before the first content token would fire the spurious "model returned no
    // output" warning, contradicting handleResponseError's quiet-cancel contract.
    if (!token.isCancellationRequested) {
      reportPostStreamDiagnostics(model, options, outcome, startTime, progress, attemptCount, output);
    }
  } catch (err) {
    handleResponseError(err, model, outcome, token, progress, output);
  }
}
