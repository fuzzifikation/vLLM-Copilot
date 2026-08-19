import * as vscode from 'vscode';
import type { FileLogger } from '../logger.js';
import { reportTokenUsage, logTokenUsage } from '../usageReporting.js';
import { recordRequest, type LastRequestData } from '../usageStore.js';
import type { WireMetrics } from '../types.js';
import { parseToolCallArgs } from '../messageConverter.js';
import type { StreamEvent, WireUsage } from '../types.js';
import type { StreamOutcome } from './outcome.js';

/**
 * Matches raw reasoning tags (`</thinking>`, `<thinking>`, etc.) that
 * leak into the content stream when vLLM has no matching `--reasoning-parser`.
 */
const RAW_THINK_TAG = /<\/?think(?:ing)?>/i;

/**
 * Phase 2 — consume the vLLM stream, reporting parts as they arrive.
 *
 * Mutates `outcome` in place (rather than returning it) so that a mid-stream
 * throw still leaves the caller's error handler with an accurate picture of
 * what was already emitted to the user.
 *
 * Collaborators are explicit: the output channel, the optional file logger, and
 * the outcome accumulator. The provider instance is never passed in.
 */
export async function consumeStream(
  stream: AsyncIterable<StreamEvent>,
  model: vscode.LanguageModelChatInformation,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
  startTime: number,
  outcome: StreamOutcome,
  serverUrl: string,
  vllmModelId: string,
  output: vscode.OutputChannel,
  fileLogger?: FileLogger,
): Promise<void> {
  // Track reported tool calls to avoid duplicates
  const reportedToolCallIds = new Set<string>();

  // Look up LanguageModelThinkingPart once before the loop, not on every chunk.
  // It is proposal-gated (`enabledApiProposals: ["languageModelThinkingPart"]`),
  // so it is absent from stable @types/vscode and must be reached via `any`.
  // If/when the proposal graduates, replace `(vscode as any)` with `vscode`.
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
            output.appendLine(
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
    fileLogger?.logStreamFinish(outcome.finishReason || 'unknown', pendingUsage);
    logTokenUsage(output, model.id, pendingUsage, totalElapsedMs, outcome.firstTokenTime);

    // Record last request + accumulate cumulative usage for the dashboard.
    // `recordRequest` both stores the server's last request AND sums it into
    // the all-time/today counters, then fires the change event so the
    // dashboard re-renders immediately (no poll-interval lag).
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
      actualCost: pendingUsage.cost ?? undefined,
      usedByok: pendingUsage.usedByok === true ? true : undefined,
      metrics: pendingMetrics,
      hasMetrics,
      hasCacheDetails,
      maxModelLen: (model.maxInputTokens || 0) + (model.maxOutputTokens || 0),
      maxOutputTokens: model.maxOutputTokens || 0,
      firstTokenTimeMs: outcome.firstTokenTime ?? null,
      totalTimeMs: totalElapsedMs,
    };
    recordRequest(lastRequestData);
  }
}
