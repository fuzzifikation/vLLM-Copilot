/**
 * Token-usage reporting: turning vLLM's authoritative usage payload into the VS
 * Code data part Copilot expects, and into human-readable Output channel logs.
 *
 * Free functions (not provider methods) so the wire-format details — which were
 * discovered by trial and error — can be unit-tested in isolation.
 */

import * as vscode from 'vscode';
import type { WireUsage } from './types.js';

/**
 * Build a LanguageModelDataPart with the exact shape VS Code's isApiUsage() guard expects.
 *
 * Requirements (discovered through trial & error, see docs/copilot-integration.md):
 *   - Keys MUST be snake_case (`prompt_tokens`, not `promptTokens`)
 *   - MIME type MUST be `'usage'` (not `'application/json'`)
 *   - Must include `prompt_tokens_details`
 */
export function createUsageDataPart(
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens?: number }
): vscode.LanguageModelDataPart {
  const usageData = {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    prompt_tokens_details: { cached_tokens: usage.cached_tokens ?? 0 },
  };
  const usageBytes = new TextEncoder().encode(JSON.stringify(usageData));
  return new vscode.LanguageModelDataPart(usageBytes, 'usage');
}

/**
 * Report token usage to VS Code via LanguageModelDataPart with MIME type 'usage'.
 * VS Code consumes this to display token counts in the chat UI.
 */
export function reportTokenUsage(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): void {
  const dataPart = createUsageDataPart(usage);
  progress.report(dataPart);
}

/**
 * Log authoritative vLLM token usage to the output channel after each request.
 * Includes cached tokens and speculative decoding stats when available.
 */
export function logTokenUsage(
  output: vscode.OutputChannel,
  modelId: string,
  usage: WireUsage,
  totalElapsedMs?: number,
  firstTokenMs?: number,
): void {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const accepted = usage.completion_tokens_details?.accepted_prediction_tokens ?? 0;
  const rejected = usage.completion_tokens_details?.rejected_prediction_tokens ?? 0;
  const specTotal = accepted + rejected;
  const specAcceptPct = specTotal > 0 ? ((accepted / specTotal) * 100).toFixed(0) : undefined;
  const cacheHitPct = usage.prompt_tokens > 0 ? ((cached / usage.prompt_tokens) * 100).toFixed(0) : undefined;

  // Prefer server-side timing if vLLM provides it; otherwise compute client-side tok/s
  const promptTime = usage.prompt_tokens_details?.prompt_time;
  const decodeTime = usage.completion_tokens_details?.decode_time ?? usage.completion_tokens_details?.completion_time;

  // Client-side: decode time ≈ total elapsed - time-to-first-token
  let outputTokPerSec: string | undefined;
  if (decodeTime !== undefined && decodeTime > 0) {
    outputTokPerSec = (usage.completion_tokens / decodeTime).toFixed(1);
  } else if (totalElapsedMs !== undefined && firstTokenMs !== undefined && usage.completion_tokens > 0) {
    const decodeMs = Math.max(totalElapsedMs - firstTokenMs, 1);
    outputTokPerSec = (usage.completion_tokens / (decodeMs / 1000)).toFixed(1);
  }

  let inputTokPerSec: string | undefined;
  if (promptTime !== undefined && promptTime > 0) {
    inputTokPerSec = (usage.prompt_tokens / promptTime).toFixed(1);
  } else if (firstTokenMs !== undefined && firstTokenMs > 0 && usage.prompt_tokens > 0) {
    // TTFT approximates prompt processing time
    inputTokPerSec = (usage.prompt_tokens / (firstTokenMs / 1000)).toFixed(1);
  }

  const out = [];
  out.push(`[TOKENS] ${modelId}`);
  out.push(`  input: ${usage.prompt_tokens.toLocaleString()} (cached: ${cached.toLocaleString()}${cached > 0 && cacheHitPct ? ` = ${cacheHitPct}%` : ''}${inputTokPerSec ? `, ${inputTokPerSec} tok/s` : ''})`);
  out.push(`  output: ${usage.completion_tokens.toLocaleString()}${specAcceptPct ? ` (spec: ${accepted}/${specTotal} = ${specAcceptPct}%)` : ''}${outputTokPerSec ? `, ${outputTokPerSec} tok/s` : ''})`);
  out.push(`  total: ${usage.total_tokens.toLocaleString()}`);
  if (totalElapsedMs !== undefined) {
    out.push(`  elapsed: ${(totalElapsedMs / 1000).toFixed(2)}s${firstTokenMs !== undefined ? ` (TTFT: ${(firstTokenMs / 1000).toFixed(2)}s)` : ''}`);
  }
  output.appendLine(out.join(' '));
}
