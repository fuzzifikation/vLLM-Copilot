/**
 * Last-request status bar chip (issue #10): the usage store's second render
 * surface next to the Dashboard tree.
 *
 * Shows the glyph of the model that served the latest request (the model
 * picker's contributed icons: OpenRouter mark for OpenRouter servers, the
 * vLLM mark for everything else) plus that run's generation speed. Hover
 * expands the chip into a Markdown panel for the single request: cost, token
 * split, generation and prompt-processing speed, TTFT, timing and context
 * usage, on which server - framed as the LAST reply only, since that is all
 * the chip ever shows. Click focuses the Dashboard view container.
 *
 * Data comes exclusively from the in-memory last-request capture in
 * `usage/usageStore` (fed by consumeStream on the request path). No endpoint
 * is ever queried here, no polling: updates arrive via
 * `onUsageStoreDidChange`. The capture is ephemeral, so the chip stays
 * hidden until the first completed request of the session - after a reload
 * there honestly is no "last run" to display.
 *
 * Besides the single reply, the tooltip keeps a session odometer: the best
 * output length, total size, generation speed and prompt-processing speed
 * seen since VS Code started (module state, in-memory, never persisted),
 * shown as a third "Max" column in the stats table. Useful for sizing the
 * output budget; a Reset link zeroes it and re-folds the displayed reply as
 * the new baseline.
 *
 * Formatting and the cost derivation are imported from the Dashboard module:
 * both surfaces must render the same numbers with the same rules, one place
 * to fix.
 */

import * as vscode from 'vscode';
import { findModelConfig, normalizeServerUrl, type ModelConfig } from '../state/config.js';
import { isOpenRouterUrl } from '../state/serverCore.js';
import { readModels, readServers } from '../state/configStore.js';
import {
  findModelCost, formatCostFine, getLatestRequest, onUsageStoreDidChange,
  type LastRequestData, type UsageCounts,
} from '../usage/usageStore.js';
import { computeCost, fmtCount, fmtMs, fmtTokPerSec, shortUrl, timeAgo } from './dashboard.js';

/** Toggle key; the module renders nothing while it is off. */
const SETTING = 'vllm-copilot.statusBar.enabled';
/** Auto-registered focus command for the contributed tree view: reveals the
 *  Dashboard when hidden and moves keyboard focus to it when visible (the
 *  generic container-reveal command is a no-op while already open). */
const FOCUS_DASHBOARD = 'vllm-copilot.dashboard.focus';
/** Tooltip link that zeroes the session odometer. Not in the palette: the
 *  reset belongs where the numbers are read. */
const RESET_PEAKS = 'vllm-copilot.statusBar.resetPeaks';

/**
 * Session odometer: per-request maxima since activation, module state, in
 * memory only, dies with the window like the last-request capture itself.
 * Context usage is deliberately absent (it only ever grows, so its max is
 * just the latest value). Zero means "no sample yet", which also reads as
 * "omit the entry": token counts are >= 1 for any real request and rates
 * are floored well above zero.
 */
const peaks = { outputTokens: 0, totalTokens: 0, genTokPerSec: 0, promptTokPerSec: 0 };

/**
 * Create the chip and keep it in sync with the usage store. Registration is
 * unconditional: visibility is decided per render from the setting and
 * whether any request has been captured yet.
 */
export function registerStatusBar(): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('vllm-copilot.lastRequest', vscode.StatusBarAlignment.Right, 90);
  item.name = 'vLLM-Copilot last request';
  item.command = { command: FOCUS_DASHBOARD, title: 'Show vLLM-Copilot Dashboard' };
  const render = () => renderStatusBar(item);
  return vscode.Disposable.from(
    item,
    vscode.commands.registerCommand(RESET_PEAKS, () => {
      peaks.outputTokens = 0;
      peaks.totalTokens = 0;
      peaks.genTokPerSec = 0;
      peaks.promptTokPerSec = 0;
      // Re-render folds the displayed reply back in: the odometer restarts
      // from "now", and the reply on screen is part of "now".
      render();
    }),
    onUsageStoreDidChange(render),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(SETTING)) render();
    }),
  );
}

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(SETTING, true);
}

function renderStatusBar(item: vscode.StatusBarItem): void {
  const data = isEnabled() ? getLatestRequest() : undefined;
  if (!data) {
    item.hide();
    return;
  }
  const server = resolveServer(data);
  const icon = server.openRouter ? 'vllm-copilot-openrouter' : 'vllm-copilot-model';
  const rate = decodeTokPerSec(data);
  const ingest = promptTokPerSec(data);
  // Fold into the session odometer. Every recordRequest fires the store
  // event synchronously and this render reads the record just written, so
  // each request is folded exactly once; re-renders (config changes) are
  // idempotent maxes.
  peaks.outputTokens = Math.max(peaks.outputTokens, data.completionTokens);
  peaks.totalTokens = Math.max(peaks.totalTokens, data.totalTokens);
  if (rate != null) peaks.genTokPerSec = Math.max(peaks.genTokPerSec, rate);
  if (ingest != null) peaks.promptTokPerSec = Math.max(peaks.promptTokPerSec, ingest);
  item.text = rate != null ? `$(${icon}) ${fmtTokPerSec(rate)}` : `$(${icon})`;
  item.tooltip = buildTooltip(data, server, icon, rate, ingest);
  item.show();
}

/**
 * Registry identity of a captured request: display label plus the OpenRouter
 * verdict that picks the glyph. Registry entries may share one normalized
 * URL (the documented "identity N" case); first match wins, mirroring the
 * dashboard's first-wins-per-id rule. A server removed after the request
 * still renders: fall back to URL sniffing and the short URL.
 */
function resolveServer(data: LastRequestData): { label: string; openRouter: boolean } {
  const entry = readServers().find(s => normalizeServerUrl(s.serverUrl) === data.serverUrl);
  const url = entry?.serverUrl ?? data.serverUrl;
  return {
    label: entry?.displayName?.trim() || shortUrl(url),
    openRouter: entry?.serverType === 'openrouter' || isOpenRouterUrl(url),
  };
}

/**
 * Decode throughput of the captured run. Server-reported when
 * --enable-per-request-metrics is on (generation time covers all output
 * tokens); otherwise measured client-side over [firstTokenTimeMs,
 * totalTimeMs], which spans tokens 2..N only (same accounting as the
 * dashboard's Generation row). A one-token or unmeasurable run yields null
 * instead of an invented rate.
 */
function decodeTokPerSec(d: LastRequestData): number | null {
  const genMs = d.metrics?.generation_time_ms;
  if (d.hasMetrics && genMs != null && genMs > 0 && d.completionTokens > 0) {
    return (d.completionTokens / genMs) * 1000;
  }
  if (
    d.completionTokens > 1
    && d.firstTokenTimeMs != null
    && d.totalTimeMs != null
    && d.totalTimeMs > d.firstTokenTimeMs
  ) {
    const decodeMs = d.totalTimeMs - d.firstTokenTimeMs;
    return ((d.completionTokens - 1) / decodeMs) * 1000;
  }
  return null;
}

/**
 * Prompt-processing (ingestion) throughput, from captured data only: TTFT
 * minus the server-reported queue time is the window in which the prompt was
 * processed, so promptTokens over that window estimates the prefill rate.
 * Sound because vLLM's queue time is pure scheduling wait and excludes
 * prefill (TTFT ~= queue + prefill). Server-reported TTFT preferred (on the
 * server it spans queue + prefill exactly), but only when the window reads
 * sane: a hot prefix cache makes prefill genuinely sub-100ms, and some
 * builds measure TTFT from scheduling admission, so `ttft - queue` can go
 * small or negative. An implausible server window falls back to the
 * client-measured TTFT, which always exists and additionally contains queue
 * and network (a floor). Below 50ms either way the timer resolution makes
 * any rate noise and the row is omitted. Always marked approximate.
 */
function promptTokPerSec(d: LastRequestData): number | null {
  if (d.promptTokens <= 0) return null;
  const serverWindow = d.metrics?.time_to_first_token_ms != null
    ? d.metrics.time_to_first_token_ms - (d.metrics.queue_time_ms ?? 0)
    : null;
  const window = serverWindow != null && serverWindow >= 50
    ? serverWindow
    : d.firstTokenTimeMs;
  return window != null && window >= 50 ? (d.promptTokens / window) * 1000 : null;
}

/**
 * Money for the run: the backend-reported actual cost (OpenRouter) when
 * present, else the estimate from the model's configured per-1M rates.
 * Never both - same either/or rule as the Dashboard tree.
 */
function costLabel(d: LastRequestData, models: ModelConfig[]): string | undefined {
  if (d.actualCost !== undefined) return formatCostFine(d.actualCost, 'USD');
  const rates = findModelCost(models, d.serverUrl, d.modelId);
  const counts: UsageCounts = {
    prompt: d.promptTokens,
    completion: d.completionTokens,
    cached: d.cachedTokens ?? 0,
    reasoning: d.reasoningTokens ?? 0,
  };
  const cost = computeCost(counts, rates);
  return cost !== undefined ? formatCostFine(cost, rates?.currency) : undefined;
}

/** Markdown hover panel for one captured request. The rates are computed by
 *  the caller (renderStatusBar folds them into the session odometer too),
 *  so they arrive as parameters instead of being derived twice. */
function buildTooltip(
  d: LastRequestData,
  server: { label: string },
  icon: string,
  rate: number | null,
  ingest: number | null,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  md.isTrusted = { enabledCommands: [FOCUS_DASHBOARD, RESET_PEAKS] };

  const models = readModels();
  const modelLabel = findModelConfig(models, readServers(), d.serverUrl, d.modelId)?.displayName
    || d.modelId;
  const cost = costLabel(d, models);

  const lines: string[] = [];
  lines.push(`$(${icon}) **${modelLabel}** · ${server.label}`);
  // Paragraph break required: a bare newline in a MarkdownString is a soft
  // break and the renderer merges the lines into one paragraph.
  lines.push('');
  lines.push(`_Last reply · ${timeAgo(d.timestamp)}${d.usedByok ? ' · BYOK' : ''}_`);

  if (cost !== undefined) {
    lines.push('');
    lines.push(`**${cost}**`);
  }

  const rows: string[] = [];
  // Third column: the session-max cell for each metric that has an
  // odometer entry; blank elsewhere. Peaks are folded before this render,
  // so a folded metric's peak is >= the value shown in column two.
  const maxCell = (peak: number): string => (peak > 0 ? fmtCount(peak) : '');
  const maxRateCell = (peak: number): string => (peak > 0 ? fmtTokPerSec(peak) : '');
  if (d.cachedTokens != null && d.cachedTokens > 0) {
    const fresh = Math.max(0, d.promptTokens - d.cachedTokens);
    rows.push(`| Prompt | ${fmtCount(fresh)} + ${fmtCount(d.cachedTokens)} cached | |`);
  } else {
    rows.push(`| Prompt | ${fmtCount(d.promptTokens)} | |`);
  }
  const reasoning = d.reasoningTokens != null && d.reasoningTokens > 0
    ? ` (${fmtCount(d.reasoningTokens)} reasoning)`
    : '';
  rows.push(`| Completion | ${fmtCount(d.completionTokens)}${reasoning} | ${maxCell(peaks.outputTokens)} |`);
  if (rate != null) rows.push(`| Generation speed | ${fmtTokPerSec(rate)} | ${maxRateCell(peaks.genTokPerSec)} |`);
  if (ingest != null) rows.push(`| Prompt processing | ~${fmtTokPerSec(ingest)} | ~${maxRateCell(peaks.promptTokPerSec)} |`);
  if (d.firstTokenTimeMs != null) rows.push(`| TTFT | ${fmtMs(d.firstTokenTimeMs)} | |`);
  if (d.totalTimeMs != null) rows.push(`| Total | ${fmtMs(d.totalTimeMs)} | |`);
  if (d.maxModelLen > 0) {
    const pct = ((d.totalTokens / d.maxModelLen) * 100).toFixed(1);
    rows.push(`| Context | ${fmtCount(d.totalTokens)} of ${fmtCount(d.maxModelLen)} (${pct}%) | ${maxCell(peaks.totalTokens)} |`);
  }
  if (rows.length > 0) {
    lines.push('');
    lines.push('| | Last reply | Max |');
    lines.push('| --- | ---: | ---: |');
    lines.push(...rows);
  }

  lines.push('');
  lines.push(
    `[Open Dashboard](command:${FOCUS_DASHBOARD} "Show the vLLM-Copilot dashboard")`
    + ` · [Reset session max](command:${RESET_PEAKS} "Forget the session maxima and start counting from this reply")`,
  );
  lines.push('');
  lines.push('_Last reply and max only. Nothing is stored._');

  md.value = lines.join('\n');
  return md;
}
