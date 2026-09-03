/**
 * Token-usage reporting: turning vLLM's authoritative usage payload into the VS
 * Code data part Copilot expects, and into human-readable Output channel logs.
 *
 * Free functions (not provider methods) so the wire-format details — which were
 * discovered by trial and error — can be unit-tested in isolation.
 */

import * as vscode from 'vscode';
import type { WireUsage } from '../types.js';
import { formatCostFine } from './usageStore.js';

/**
 * Report token usage to VS Code via LanguageModelDataPart with MIME type 'usage'.
 * VS Code consumes this to display token counts in the chat UI.
 *
 * The payload must have the exact shape VS Code's isApiUsage() guard expects
 * (discovered through trial & error, see docs/copilot-integration.md):
 *   - Keys MUST be snake_case (`prompt_tokens`, not `promptTokens`)
 *   - MIME type MUST be `'usage'` (not `'application/json'`)
 *   - Must include `prompt_tokens_details`
 * The former standalone part-builder was absorbed here (audit P14-2): the
 * progress sink was its only customer, tests drive this function directly.
 */
export function reportTokenUsage(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens?: number; prompt_tokens_details?: Record<string, number> },
): void {
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0;
  const usageData = {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    prompt_tokens_details: { cached_tokens: cachedTokens },
  };
  const usageBytes = new TextEncoder().encode(JSON.stringify(usageData));
  progress.report(new vscode.LanguageModelDataPart(usageBytes, 'usage'));
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
  out.push(`  input: ${usage.prompt_tokens.toLocaleString('en-US')} (cached: ${cached.toLocaleString('en-US')}${cached > 0 && cacheHitPct ? ` = ${cacheHitPct}%` : ''}${inputTokPerSec ? `, ${inputTokPerSec} tok/s` : ''})`);
  // One balanced paren group: spec figures and tok/s live INSIDE it. The old
  // shape closed with an unconditional ')' while the opening '(' existed only
  // inside optional segments — every branch printed unbalanced parentheses.
  const outDetails: string[] = [];
  if (specAcceptPct) outDetails.push(`spec: ${accepted}/${specTotal} = ${specAcceptPct}%`);
  if (outputTokPerSec) outDetails.push(`${outputTokPerSec} tok/s`);
  out.push(`  output: ${usage.completion_tokens.toLocaleString('en-US')}${outDetails.length > 0 ? ` (${outDetails.join(', ')})` : ''}`);
  out.push(`  total: ${usage.total_tokens.toLocaleString('en-US')}`);
  if (usage.cost !== undefined && usage.cost !== null) {
    // One money formatter, one convention (matches the dashboard's fine cost).
    out.push(`  cost: ${formatCostFine(usage.cost, 'USD')}${usage.usedByok ? ' (BYOK)' : ''}`);
  }
  if (totalElapsedMs !== undefined) {
    out.push(`  elapsed: ${(totalElapsedMs / 1000).toFixed(2)}s${firstTokenMs !== undefined ? ` (TTFT: ${(firstTokenMs / 1000).toFixed(2)}s)` : ''}`);
  }
  output.appendLine(out.join(' '));
}
