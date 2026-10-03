import * as vscode from 'vscode';
import type { FileLogger } from '../shared/logger.js';
import { reportTokenUsage, logTokenUsage } from '../usage/usageReporting.js';
import { recordRequest } from '../usage/usageStore.js';
import { parseToolCallArgs } from '../core/request/sseParser.js';
import { isAttemptCompletionEvent, type ExecutionEvent } from '../core/request/execute.js';
import type { StreamOutcome } from './contracts.js';

/**
 * Copilot consumer of the execution core's events (`executeChatRequest`).
 * The core owns the retry loop and the neutral observations (timing, content
 * buffer, think-tag detection, tool-call id dedup) — this file owns the
 * editor vocabulary: reporting response parts, presenting tool-argument
 * repair, and handing attempt-completion data to usage reporting/recording in
 * the established order: report usage, log stream finish, log tokens, record
 * the request.
 *
 * Cancellation is the core's job (it stops pulling from the transport and
 * still completes the record for a quiet cancel after usage was seen), so
 * there is no token check in this loop — events keep flowing until the
 * executor finishes.
 *
 * `outcome` is the core-shared accumulator, passed for the finish-reason
 * lookup in the stream-finish log; the provider's error handler and
 * post-stream diagnostics read the same object. Mutated in place so a
 * mid-stream throw still leaves the caller's error handler an accurate
 * picture of what reached the user.
 */
export async function consumeStream(
  events: AsyncIterable<ExecutionEvent>,
  model: vscode.LanguageModelChatInformation,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  outcome: StreamOutcome,
  output: vscode.OutputChannel,
  fileLogger?: FileLogger,
): Promise<void> {
  // Look up LanguageModelThinkingPart once before the loop, not on every chunk.
  // It is proposal-only in TYPES (absent from stable @types/vscode), so it is
  // reached via `any`. VS Code 1.137 exposes the class ungated at runtime; the
  // undefined-guard covers builds/forks that strip it, where reasoning would
  // otherwise throw on the first token — degrade to plain text instead.
  // When the proposal graduates, replace `(vscode as any)` with `vscode`.
  const ThinkingPart = (vscode as any).LanguageModelThinkingPart as
    | (new (value: string) => vscode.LanguageModelResponsePart)
    | undefined;
  if (!ThinkingPart) {
    output.appendLine('[WARN] LanguageModelThinkingPart unavailable in this VS Code build - reasoning content will be shown as plain text');
  }

  for await (const event of events) {
    if (isAttemptCompletionEvent(event)) {
      // Usage is reported exactly once per attempt with the final cumulative
      // stats (the core collapsed any per-chunk usage to its last sighting).
      const { usage, lastRequest, elapsedMs } = event.attemptCompletion;
      reportTokenUsage(progress, usage);
      fileLogger?.logStreamFinish(outcome.finishReason || 'unknown', usage);
      logTokenUsage(output, model.id, usage, elapsedMs, outcome.firstTokenTime);

      // Record last request + accumulate cumulative usage for the dashboard.
      // `recordRequest` both stores the server's last request AND sums it into
      // the all-time/today counters, then fires the change event so the
      // dashboard re-renders immediately (no poll-interval lag). The core
      // built the record; the id in it is the CANONICAL wire id (base slug,
      // no OpenRouter routing suffix) — what the usage/cost lookups key on.
      recordRequest(lastRequest);
      continue;
    }

    // Handle reasoning/thinking tokens (deep thinking models like QwQ, DeepSeek R1)
    if (event.reasoning_content) {
      if (ThinkingPart) {
        progress.report(new ThinkingPart(event.reasoning_content));
      } else {
        // A thinking part renders as a collapsible block Copilot can throw
        // away, so replaying the turn stays invisible. This fallback is the
        // opposite: it is ordinary answer content, already on screen, and a
        // replay would print the same reasoning twice. The retry gate has to
        // tell those apart, and only this branch can.
        outcome.hadVisibleReasoning = true;
        progress.report(new vscode.LanguageModelTextPart(event.reasoning_content));
      }
    }

    // Handle text content
    if (event.content) {
      progress.report(new vscode.LanguageModelTextPart(event.content));
    }

    // Handle finalized tool calls (deduplicated by the executor)
    for (const tc of event.finishedToolCalls) {
      const parsedArgs = parseToolCallArgs(tc);
      // If args couldn't be repaired, fall back to {} — matching VS Code BYOK's
      // behavior. Dropping the call entirely makes it look like the model stopped
      // without doing anything (the "stream just stopped" symptom). Surfacing it
      // with {} lets Copilot invoke the tool, which fails downstream with a clear
      // error rather than vanishing silently.
      const args = parsedArgs ?? {};
      if (parsedArgs === null) {
        output.appendLine(
          `[WARN] Tool call ${tc.id} (${tc.name}): args unparseable, falling back to {} - raw: ${tc.arguments.substring(0, 200)}`
        );
      }
      progress.report(
        new vscode.LanguageModelToolCallPart(tc.id, tc.name, args)
      );
    }
  }
}
