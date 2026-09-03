/**
 * Combined usage store: last-request capture + cumulative token/cost tracking.
 *
 * Single ingestion point (`recordRequest`) for everything the dashboard shows
 * under a server: the "Last Request" node (ephemeral, per server) and the
 * "Token Usage" node (cumulative counts + derived cost). Both publish to the
 * same UI through one change event (`onUsageStoreDidChange`), so the dashboard
 * renders live — it no longer waits for the metrics poll interval.
 *
 * Data planes:
 *   - Last request: in-memory `Map<serverUrl, LastRequestData>` (replace per
 *     server — only the most recent prompt is kept).
 *   - Cumulative: per `(serverUrl, modelId)` token counts, in two planes:
 *       allTime — persisted, since last reset (exact "Total")
 *       days    — persisted, keyed by `YYYY-MM-DD`, pruned after 90 days
 *
 * Summation semantics: `cached` ⊆ `prompt` (cache-read input tokens) and
 * `reasoning` ⊆ `completion`. Components are summed independently; totals are
 * always Σprompt + Σcompletion — never `total + cached`.
 *
 * Estimated cost is NEVER stored. It is derived at render time from each model's
 * `cost` config and the stored token counts (`computeCost`), so editing a rate
 * re-prices all history without any migration. ACTUAL reported cost (OpenRouter
 * `usage.cost`) IS stored — it is server truth, not derivable from rates — in
 * separate all-time/day planes (`allTimeCost`/`daysCost`). Actual and estimated
 * cost are never summed: the dashboard prefers actual when a model has any,
 * else falls back to the per-1M estimate.
 *
 * Auto-continue retries are counted per HTTP request: a continuation request
 * genuinely re-sends the context and generates new tokens, so each completion
 * that carries a usage payload is recorded.
 */

import * as vscode from 'vscode';
import type { WireMetrics } from './types.js';
import { findModelConfig, type ModelConfig } from './config.js';
import { readServers } from './configStore.js';

// ─── Last request ─────────────────────────────────────────────────────────

/** Data captured from a single completed request. */
export interface LastRequestData {
  /** Server URL this request was sent to (normalized). */
  serverUrl: string;
  /** Model ID used for the request (wire id). */
  modelId: string;
  /** Timestamp when the request completed. */
  timestamp: number;
  /** Token counts from vLLM usage block. */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Cached tokens (requires `--enable-prompt-tokens-details`). */
  cachedTokens?: number;
  /** Cache creation tokens (requires `--enable-prompt-tokens-details`). */
  createdCacheTokens?: number;
  /** Reasoning tokens, if applicable. */
  reasoningTokens?: number;
  /** Actual reported cost in USD (OpenRouter `usage.cost`). Absent on vLLM/local. */
  actualCost?: number;
  /** OpenRouter: served with the user's own upstream key (`usage.is_byok`). */
  usedByok?: boolean;
  /** Per-request timing (requires `--enable-per-request-metrics`). */
  metrics?: WireMetrics;
  /** Whether --enable-per-request-metrics is available (true if metrics were received). */
  hasMetrics: boolean;
  /** Whether --enable-prompt-tokens-details is available (true if cache details were received). */
  hasCacheDetails: boolean;
  /** Context window (max_model_len from server). */
  maxModelLen: number;
  /** Output budget (max_output_tokens from settings). */
  maxOutputTokens: number;
  /** Time-to-first-token in ms, measured by the provider. Always available. */
  firstTokenTimeMs: number | null;
  /** Total wall-clock request time in ms, measured by the provider. Always available. */
  totalTimeMs: number | null;
}

// ─── Cumulative usage ─────────────────────────────────────────────────────

/** Per-model cumulative token counts. `cached` ⊆ `prompt`, `reasoning` ⊆ `completion`. */
export interface UsageCounts {
  prompt: number;
  completion: number;
  cached: number;
  reasoning: number;
}

/** serverUrl → modelId → counts. */
export type UsageServerMap = Record<string, Record<string, UsageCounts>>;

/** serverUrl → modelId → accumulated actual cost (USD, from OpenRouter usage.cost). */
export type UsageCostMap = Record<string, Record<string, number>>;

/** Persisted shape under `globalState` (versioned for forward migration). */
interface PersistedUsage {
  version: 3;
  allTime: UsageServerMap;
  /** `YYYY-MM-DD` → server map. */
  days: Record<string, UsageServerMap>;
  /** First-recorded timestamp (epoch ms) per (serverUrl, modelId) — backs the
   *  "started X ago" label on a model's Overall row. */
  startedAt: Record<string, Record<string, number>>;
  /** Actual reported cost (USD) per (serverUrl, modelId), all-time. */
  allTimeCost: UsageCostMap;
  /** `YYYY-MM-DD` → server → model → actual cost. */
  daysCost: Record<string, UsageCostMap>;
}

/** Per-model cumulative counts for one server across all-time and today. */
export interface ServerUsage {
  allTime: Record<string, UsageCounts>;
  today: Record<string, UsageCounts>;
}

/** Per-model actual reported cost (USD) for one server across all-time and today. */
export interface ServerCost {
  allTime: Record<string, number>;
  today: Record<string, number>;
}

// ─── Cost rates ───────────────────────────────────────────────────────────

/** Per-1M-token cost rates. All values are interpreted in `currency` units. */
export interface CostRates {
  input?: number;
  output?: number;
  cachedInput?: number;
  currency?: string;
}

const STORAGE_KEY = 'vllm-copilot.usage.v1';
const RETENTION_DAYS = 90;

// Module state (singleton — mirrors lastRequestStore's module-level store).
const lastRequest = new Map<string, LastRequestData>();
let allTime: UsageServerMap = {};
let days: Record<string, UsageServerMap> = {};
let startedAt: Record<string, Record<string, number>> = {};
let allTimeCost: UsageCostMap = {};
let daysCost: Record<string, UsageCostMap> = {};
let globalState: vscode.Memento | undefined;
let writeQueue: Promise<void> = Promise.resolve();
let logError: (msg: string) => void = () => {};
const emitter = new vscode.EventEmitter<void>();

/** Fired after any store mutation (record or reset) — the dashboard re-renders. */
export const onUsageStoreDidChange: vscode.Event<void> = emitter.event;

// ─── Date / count helpers ────────────────────────────────────────────────

/** `YYYY-MM-DD` local-time bucket key. */
export function dayKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function emptyCounts(): UsageCounts {
  return { prompt: 0, completion: 0, cached: 0, reasoning: 0 };
}

function addCounts(a: UsageCounts, b: UsageCounts): UsageCounts {
  return {
    prompt: a.prompt + b.prompt,
    completion: a.completion + b.completion,
    cached: a.cached + b.cached,
    reasoning: a.reasoning + b.reasoning,
  };
}

function accumulate(map: UsageServerMap, serverUrl: string, modelId: string, counts: UsageCounts): void {
  const server = map[serverUrl] ?? (map[serverUrl] = {});
  server[modelId] = addCounts(server[modelId] ?? emptyCounts(), counts);
}

/** Sum actual reported cost into a cost map (all-time or per-day plane). */
function accumulateCost(map: UsageCostMap, serverUrl: string, modelId: string, cost: number): void {
  const server = map[serverUrl] ?? (map[serverUrl] = {});
  server[modelId] = (server[modelId] ?? 0) + cost;
}

// ─── Init / load / persist ────────────────────────────────────────────────

function pruneDays(): void {
  const cutoff = dayKey(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  for (const key of Object.keys(days)) {
    if (key < cutoff) delete days[key];
  }
  // Cost day buckets must be pruned with the same window — otherwise the
  // persisted blob grows one bucket per day indefinitely.
  for (const key of Object.keys(daysCost)) {
    if (key < cutoff) delete daysCost[key];
  }
}

/** Load persisted usage from globalState (best-effort; corrupt/missing → fresh). */
function load(): void {
  const raw = globalState?.get<unknown>(STORAGE_KEY);
  if (raw && typeof raw === 'object') {
    // Loose shape — the blob is an unknown external value, not a typed
    // PersistedUsage. `version` is a plain number here so v1/v2/v3 are all
    // comparable (PersistedUsage's literal `version: 3` would reject `=== 2`).
    const p = raw as {
      version?: number;
      allTime?: UsageServerMap;
      days?: Record<string, UsageServerMap>;
      startedAt?: Record<string, Record<string, number>>;
      allTimeCost?: UsageCostMap;
      daysCost?: Record<string, UsageCostMap>;
    };
    // version 1 is upgraded in place (startedAt defaults to {}); v2 → v3 is
    // additive — the cost planes default to {} so old token records migrate
    // unchanged with no fabricated actual cost. The field guard checks SHAPE
    // (not just presence): a corrupt blob with a truthy primitive allTime would
    // otherwise crash the first recordRequest with a strict-mode TypeError.
    const isPlainObj = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v);
    if ((p.version === 1 || p.version === 2 || p.version === 3)
      && isPlainObj(p.allTime) && isPlainObj(p.days)) {
      allTime = p.allTime;
      days = p.days;
      startedAt = p.startedAt ?? {};
      allTimeCost = p.allTimeCost ?? {};
      daysCost = p.daysCost ?? {};
    }
  }
  pruneDays();
}

/**
 * Persist the full snapshot, serialized through a write queue. `globalState.update`
 * is async, so two rapid `recordRequest` calls could otherwise interleave
 * read-modify-write and lose an update. Chaining guarantees writes land in order.
 * The snapshot is deep-copied at schedule time so later mutations cannot bleed
 * into an in-flight write.
 */
function schedulePersist(): void {
  if (!globalState) return;
  const snapshot: PersistedUsage = JSON.parse(JSON.stringify({
    version: 3, allTime, days, startedAt, allTimeCost, daysCost,
  })) as PersistedUsage;
  writeQueue = writeQueue
    .then(() => globalState!.update(STORAGE_KEY, snapshot))
    .catch(err => logError(`[usage] persist failed: ${err instanceof Error ? err.message : String(err)}`));
}

/**
 * Initialize the store. Called once from `activate()` before any request can
 * complete. Returns a Disposable that releases the change event.
 */
export function initUsageStore(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): { dispose(): void } {
  globalState = context.globalState;
  logError = msg => outputChannel.appendLine(`[ERROR] ${msg}`);
  load();
  return { dispose: () => emitter.dispose() };
}

// ─── Record / read / reset ────────────────────────────────────────────────

/**
 * Record a completed request. Stores it as the server's last request AND
 * accumulates it into the all-time and today counters, then persists and
 * fires the change event (the dashboard re-renders immediately).
 */
export function recordRequest(data: LastRequestData): void {
  lastRequest.set(data.serverUrl, data);

  const counts: UsageCounts = {
    prompt: data.promptTokens,
    completion: data.completionTokens,
    cached: data.cachedTokens ?? 0,
    reasoning: data.reasoningTokens ?? 0,
  };
  accumulate(allTime, data.serverUrl, data.modelId, counts);
  const todayKey = dayKey();
  if (!days[todayKey]) days[todayKey] = {};
  accumulate(days[todayKey], data.serverUrl, data.modelId, counts);

  // Actual reported cost (OpenRouter usage.cost) accumulates separately from the
  // derived estimates — never summed together. Only recorded when the server
  // actually reports it; vLLM/local requests contribute nothing. A negative
  // value is invalid server data and would silently subtract from totals, so it
  // is rejected too.
  if (data.actualCost !== undefined && Number.isFinite(data.actualCost) && data.actualCost >= 0) {
    accumulateCost(allTimeCost, data.serverUrl, data.modelId, data.actualCost);
    if (!daysCost[todayKey]) daysCost[todayKey] = {};
    accumulateCost(daysCost[todayKey], data.serverUrl, data.modelId, data.actualCost);
  }

  // Stamp the first-record timestamp for this (server, model) — backs the
  // "started X ago" label on the model's Overall row. Reset clears the entry,
  // so the next record re-stamps it (recording "restarted").
  const srvStarted = startedAt[data.serverUrl] ?? (startedAt[data.serverUrl] = {});
  if (srvStarted[data.modelId] === undefined) srvStarted[data.modelId] = Date.now();

  schedulePersist();
  emitter.fire();
}

/** Last request for a server, or undefined if none recorded this activation. */
export function getLastRequest(serverUrl: string): LastRequestData | undefined {
  return lastRequest.get(serverUrl);
}

/** Cumulative per-model counts for a server across all-time and today. */
export function getServerUsage(serverUrl: string): ServerUsage {
  return {
    allTime: allTime[serverUrl] ?? {},
    today: days[dayKey()]?.[serverUrl] ?? {},
  };
}

/** Cumulative actual reported cost (USD) per model for a server, all-time and today. */
export function getServerCost(serverUrl: string): ServerCost {
  return {
    allTime: allTimeCost[serverUrl] ?? {},
    today: daysCost[dayKey()]?.[serverUrl] ?? {},
  };
}

/** True when a server has any recorded usage (all-time). */
export function hasServerUsage(serverUrl: string): boolean {
  return Object.keys(allTime[serverUrl] ?? {}).length > 0;
}

/** Server URLs that have any recorded usage (all-time). */
export function getServersWithUsage(): string[] {
  return Object.keys(allTime);
}

/** Epoch ms of the first recorded request for (serverUrl, modelId), or undefined. */
export function getModelStartedAt(serverUrl: string, modelId: string): number | undefined {
  return startedAt[serverUrl]?.[modelId];
}

/**
 * Clear accumulated usage for a scope. `'all'` clears every server; an object
 * clears one server only. Last Request is deliberately NOT cleared (it remains
 * the useful last prompt). Persists and fires the change event.
 */
export function resetUsage(scope: 'all' | { serverUrl: string }): void {
  if (scope === 'all') {
    allTime = {};
    days = {};
    startedAt = {};
    allTimeCost = {};
    daysCost = {};
  } else {
    const url = scope.serverUrl;
    delete allTime[url];
    for (const key of Object.keys(days)) delete days[key][url];
    delete startedAt[url];
    delete allTimeCost[url];
    for (const key of Object.keys(daysCost)) delete daysCost[key][url];
  }
  schedulePersist();
  emitter.fire();
}

// ─── Cost derivation (render-time, never stored) ──────────────────────────

/**
 * Cost in the configured unit for the given counts, from per-1M rates.
 * Fresh input = prompt − cached (cache-read tokens are priced at the cached
 * rate, not the input rate). Undefined when no rates are configured.
 */
export function computeCost(counts: UsageCounts, rates: CostRates | undefined): number | undefined {
  if (!rates) return undefined;
  const input = rates.input ?? 0;
  const output = rates.output ?? 0;
  const cachedInput = rates.cachedInput ?? 0;
  if (input === 0 && output === 0 && cachedInput === 0) return undefined;
  const freshInput = Math.max(0, counts.prompt - counts.cached);
  return (freshInput / 1e6) * input
    + (counts.cached / 1e6) * cachedInput
    + (counts.completion / 1e6) * output;
}

/**
 * Locate a model's cost rates by `(serverUrl, wire modelId)`.
 * The wire id (`vllmModelId` or legacy `id`) is what the tracker keys on.
 * Returns undefined when the model has no `cost` config.
 */
export function findModelCost(
  models: ModelConfig[],
  serverUrl: string,
  modelId: string,
): CostRates | undefined {
  // The (serverUrl, wire id) match itself lives in findModelConfig (config.ts);
  // the registry is read here so callers keep passing the plain URL.
  return findModelConfig(models, readServers(), serverUrl, modelId)?.cost;
}

/** Precision-aware amount formatting (no currency decoration). */
function formatAmount(value: number): string {
  // Money convention for >= $1 (keep 2 decimals); extended precision with
  // trailing-zero stripping below $1 so per-request costs survive rounding.
  if (value >= 100) return value.toFixed(0);
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4).replace(/\.?0+$/, '');
  return value.toFixed(6).replace(/\.?0+$/, '');
}

/**
 * Static currency-prefix map — deliberately NOT an i18n toolbox. Common
 * currencies render their symbol; anything else falls back to the raw currency
 * string (e.g. `EUR 12.35`) so a non-USD setting never displays a wrong `$`.
 * AI Credits are handled separately (suffix, not prefix).
 */
const CURRENCY_PREFIX: Record<string, string> = {
  usd: '$', eur: '€', gbp: '£', jpy: '¥', cny: '¥',
};
function currencyPrefix(currency?: string): string {
  const sym = CURRENCY_PREFIX[(currency ?? 'USD').toLowerCase()];
  return sym ?? `${currency ?? 'USD'} `;
}

/**
 * Format a cost with its currency label, rounded to 2 decimals — the standard
 * money display (model summary, etc.). `"AI Credits"` (case-insensitive)
 * renders a credits suffix; common currencies render their symbol ($ € £ ¥);
 * anything else falls back to the raw currency string. Per-request costs use
 * {@link formatCostFine} (fine precision) instead.
 */
export function formatCost(value: number, currency?: string): string {
  const amount = value.toFixed(2);
  return (currency ?? 'USD').toLowerCase() === 'ai credits'
    ? `${amount} credits`
    : `${currencyPrefix(currency)}${amount}`;
}

/**
 * Fine-precision variant for the per-request Cost row, where numbers are tiny
 * (a request can cost $0.000019) — 2 decimals would collapse it to $0.00.
 * Keeps the adaptive precision (up to 6 decimals, trailing zeros stripped).
 */
export function formatCostFine(value: number, currency?: string): string {
  return (currency ?? 'USD').toLowerCase() === 'ai credits'
    ? `${formatAmount(value)} credits`
    : `${currencyPrefix(currency)}${formatAmount(value)}`;
}

/**
 * Compact cost summary: `$11.51 today and $31.13 total` — shows exactly what
 * the API/store reports. "Today" only when a today figure exists, "Total" only
 * when an all-time figure exists, both joined when both exist. NO fabricated
 * window math (the old "in N days" phrasing divided total spend by an invented
 * recording window — a rate, not a fact). `undefined` when neither figure
 * exists. Sub-cent costs use fine precision so they never collapse to $0.00.
 */
export function formatCostSummary(
  todayCost: number | undefined,
  overallCost: number | undefined,
  currency: string | undefined,
): string | undefined {
  if (todayCost === undefined && overallCost === undefined) return undefined;
  const isCredits = (currency ?? 'USD').toLowerCase() === 'ai credits';
  const fmt = (v: number) => isCredits ? formatCost(v, currency) : formatCostFine(v, currency);
  const parts: string[] = [];
  if (todayCost !== undefined) parts.push(`${fmt(todayCost)} today`);
  if (overallCost !== undefined) parts.push(`${fmt(overallCost)} total`);
  return parts.join(' and ');
}

/**
 * Abbreviate large token counts for compact dashboard rows: 3883588 → "3.88M",
 * 836350 → "836k", 999 → "999". Thousands are rounded to whole k (sub-1000
 * precision is noise); millions keep 2 decimals, trailing zeros stripped.
 * No space between the number and the unit. Presentation ONLY — the stored
 * counts are never rounded; this runs at render time on already-accumulated
 * integers.
 */
export function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1e3) {
    const k = Math.round(n / 1e3);
    if (k >= 1000) { // 999,500 → 1000k → "1M"
      const m = k / 1000;
      return `${m.toFixed(2).replace(/\.?0+$/, '')}M`;
    }
    return `${k}k`;
  }
  return String(n);
}

/** Test-only: reset module state between tests. */
export function resetUsageStoreForTests(): void {
  lastRequest.clear();
  allTime = {};
  days = {};
  startedAt = {};
  allTimeCost = {};
  daysCost = {};
  globalState = undefined;
  writeQueue = Promise.resolve();
  logError = () => {};
}
