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
 *   - Cumulative: per `(serverUrl, modelId)` token counts, in three planes:
 *       allTime — persisted, since last reset (exact "Total")
 *       days    — persisted, keyed by `YYYY-MM-DD`, pruned after 90 days
 *       session — in-memory, since this extension activation
 *
 * Summation semantics: `cached` ⊆ `prompt` (cache-read input tokens) and
 * `reasoning` ⊆ `completion`. Components are summed independently; totals are
 * always Σprompt + Σcompletion — never `total + cached`.
 *
 * Cost is NEVER stored. It is derived at render time from each model's `cost`
 * config and the stored token counts (`computeCost`), so editing a rate
 * re-prices all history without any migration.
 *
 * Auto-continue retries are counted per HTTP request: a continuation request
 * genuinely re-sends the context and generates new tokens, so each completion
 * that carries a usage payload is recorded.
 */

import * as vscode from 'vscode';
import type { WireMetrics } from './types.js';
import { normalizeServerUrl, resolveVllmModelId, type ModelConfig } from './config.js';

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

/** Persisted shape under `globalState` (versioned for forward migration). */
interface PersistedUsage {
  version: 1;
  allTime: UsageServerMap;
  /** `YYYY-MM-DD` → server map. */
  days: Record<string, UsageServerMap>;
}

/** Per-model cumulative counts for one server across all three planes. */
export interface ServerUsage {
  allTime: Record<string, UsageCounts>;
  today: Record<string, UsageCounts>;
  session: Record<string, UsageCounts>;
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
let session: UsageServerMap = {};
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

function emptyCounts(): UsageCounts {
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

/** Sum the counts across every model on a server. */
export function sumCounts(map: Record<string, UsageCounts>): UsageCounts {
  let out = emptyCounts();
  for (const counts of Object.values(map)) out = addCounts(out, counts);
  return out;
}

// ─── Init / load / persist ────────────────────────────────────────────────

function pruneDays(): void {
  const cutoff = dayKey(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  for (const key of Object.keys(days)) {
    if (key < cutoff) delete days[key];
  }
}

/** Load persisted usage from globalState (best-effort; corrupt/missing → fresh). */
function load(): void {
  const raw = globalState?.get<unknown>(STORAGE_KEY);
  if (raw && typeof raw === 'object') {
    const p = raw as PersistedUsage;
    if (p.version === 1 && p.allTime && p.days) {
      allTime = p.allTime;
      days = p.days;
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
  const snapshot: PersistedUsage = JSON.parse(JSON.stringify({ version: 1, allTime, days })) as PersistedUsage;
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
 * accumulates it into all-time, today, and session counters, then persists and
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
  accumulate(session, data.serverUrl, data.modelId, counts);

  schedulePersist();
  emitter.fire();
}

/** Last request for a server, or undefined if none recorded this activation. */
export function getLastRequest(serverUrl: string): LastRequestData | undefined {
  return lastRequest.get(serverUrl);
}

/** Cumulative per-model counts for a server across all three planes. */
export function getServerUsage(serverUrl: string): ServerUsage {
  return {
    allTime: allTime[serverUrl] ?? {},
    today: days[dayKey()]?.[serverUrl] ?? {},
    session: session[serverUrl] ?? {},
  };
}

/** True when a server has any recorded usage (all-time or this session). */
export function hasServerUsage(serverUrl: string): boolean {
  return Object.keys(allTime[serverUrl] ?? {}).length > 0
    || Object.keys(session[serverUrl] ?? {}).length > 0;
}

/** Server URLs that have any recorded usage (all-time or session). */
export function getServersWithUsage(): string[] {
  const urls = new Set<string>([...Object.keys(allTime), ...Object.keys(session)]);
  return [...urls];
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
    session = {};
  } else {
    const url = scope.serverUrl;
    delete allTime[url];
    for (const key of Object.keys(days)) delete days[key][url];
    delete session[url];
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
  const normalized = normalizeServerUrl(serverUrl);
  const entry = models.find(m =>
    resolveVllmModelId(m) === modelId
    && normalizeServerUrl(m.serverUrl ?? '') === normalized
  );
  return entry?.cost;
}

/**
 * Format a derived cost value with its currency label. `"AI Credits"` (case-
 * insensitive) renders a credits suffix (1 credit = $0.01, per Copilot's
 * convention); anything else renders a `$` prefix. Precision adapts to magnitude
 * so a per-request cost of $0.000019 never collapses to `$0.0000`.
 */
export function formatCost(value: number, currency?: string): string {
  const isCredits = (currency ?? 'USD').toLowerCase() === 'ai credits';
  // Money convention for >= $1 (keep 2 decimals); extended precision with
  // trailing-zero stripping below $1 so per-request costs survive rounding.
  let amount: string;
  if (value >= 100) amount = value.toFixed(0);
  else if (value >= 1) amount = value.toFixed(2);
  else if (value >= 0.01) amount = value.toFixed(4).replace(/\.?0+$/, '');
  else amount = value.toFixed(6).replace(/\.?0+$/, '');
  return isCredits ? `${amount} credits` : `$${amount}`;
}

/** Test-only: reset module state between tests. */
export function resetUsageStoreForTests(): void {
  lastRequest.clear();
  allTime = {};
  days = {};
  session = {};
  globalState = undefined;
  writeQueue = Promise.resolve();
  logError = () => {};
}
