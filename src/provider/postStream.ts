import * as vscode from 'vscode';
import { isGracefulTermination, serializeError, formatError } from '../messageConverter.js';
import type { StreamOutcome } from './outcome.js';

/** Emit a diagnostic to the Output channel only. */
function diag(output: vscode.OutputChannel, level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  output.appendLine(`[${level}] ${msg}`);
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
export function reportPostStreamDiagnostics(
  model: vscode.LanguageModelChatInformation,
  options: vscode.ProvideLanguageModelChatResponseOptions,
  outcome: StreamOutcome,
  startTime: number,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  actualAttempts: number,
  output: vscode.OutputChannel,
): void {
  const { hadContent, hadToolCalls, hadReasoning, sawRawThinkTags, finishReason } = outcome;

  // Raw <thinking> tags in content (and no separated reasoning) means the server is
  // missing a matching --reasoning-parser. Log it so the cause is visible — this is
  // a server-config issue the user can fix, not something we can repair silently.
  if (sawRawThinkTags && !hadReasoning) {
    diag(
      output,
      'WARN',
      `${model.id}: raw <thinking> tags detected in content — vLLM is likely missing a matching ` +
      `--reasoning-parser (e.g. qwen3, deepseek_r1). Reasoning is being rendered as plain text and ` +
      `may be stripped by the chat view. Start vLLM with the correct --reasoning-parser to separate it.`
    );
  }

  // Warn if tool calls were truncated by token limit
  if (finishReason === 'length' && hadToolCalls) {
    diag(
      output,
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
    diag(
      output,
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
      } else if (finishReason) {
        // Other server-reported terminal reasons (unusual finish values).
        hint = actualAttempts > 1
          ? `The model produced only reasoning/thinking tokens after ${actualAttempts} attempt(s) (finish_reason: ${finishReason}) — try again or adjust the model mode.`
          : `The model produced only reasoning/thinking tokens and no answer (finish_reason: ${finishReason}) — try again or adjust the model mode.`;
      } else {
        // No finish_reason at all: the stream was cut before the server's final
        // summary chunk. That's a transport-layer kill, not a model decision.
        hint = 'The stream ended before the server reported a finish reason — the connection was likely ' +
          'dropped mid-generation by a gateway, reverse proxy, or the server itself. ' +
          'If this recurs at a similar duration, check for a proxy/gateway response timeout.';
      }
    } else {
      hint = actualAttempts > 1
        ? `Empty response after ${actualAttempts} attempt(s) — check model configuration and server logs.`
        : 'Check the model configuration and server logs (Output → vLLM-Copilot).';
    }

    // maxOutputTokens is only relevant when the model hit its token ceiling.
    const extraCtx = finishReason === 'length' ? `, maxOutputTokens=${model.maxOutputTokens}` : '';

    if (actualAttempts > 1) {
      diag(
        output,
        'WARN',
        `${model.id}: empty response after ${actualAttempts} attempt(s) (${reason}) — giving up after ${elapsed}s${extraCtx}`
      );
    } else {
      diag(
        output,
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
    diag(output, 'WARN', `${model.id}: response truncated at max output tokens (finish_reason: length).`);
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
export function handleResponseError(
  err: unknown,
  model: vscode.LanguageModelChatInformation,
  outcome: StreamOutcome,
  token: vscode.CancellationToken,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  output: vscode.OutputChannel,
): void {
  // User-initiated cancellation isn't a failure: log it quietly and don't
  // surface a scary error message — Copilot already shows the stopped state.
  if (token.isCancellationRequested) {
    diag(output, 'INFO', `${model.id}: request cancelled by user.`);
    return;
  }

  // VS Code may terminate the connection internally (e.g., after reading files
  // during tool orchestration) without firing the cancellation token. These
  // graceful terminations should be treated like user cancellations — no error
  // message to the user, just a quiet log entry.
  if (isGracefulTermination(err)) {
    diag(output, 'INFO', `${model.id}: request terminated (connection reset).`);
    // If no content was produced, report a minimal part so VS Code doesn't
    // show "no response was returned" in the chat.
    if (!outcome.hadContent && !outcome.hadToolCalls) {
      progress.report(new vscode.LanguageModelTextPart('\n'));
    }
    return;
  }

  const detail = serializeError(err);
  output.appendLine(`[ERROR] Chat response failed for ${model.id}:\n${detail}`);
  // Report error to user via text part — don't re-throw, VS Code swallows it anyway
  const errorMsg = formatError(err);
  progress.report(new vscode.LanguageModelTextPart(`⚠️ ${errorMsg}`));
}
