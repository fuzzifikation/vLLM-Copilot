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
 *
 * Identity ruling (complexity audit P14-1, 2026-09-03): usage is keyed by
 * normalized server URL BY DESIGN: counters follow the machine, not the
 * credential. Two registry entries that share one serverUrl (e.g. different
 * API keys) get separate metrics engines and dashboard nodes but share these
 * token/cost counters and the Last Request capture. Re-keying by registry
 * entry id would rewrite historical totals; the config shape that would
 * notice is rare and the merged view ("what this box burned") is the useful
 * one.
 *
 * Storage: the canonical cumulative blob is `usage.json` in the profile-wide
 * globalStorage directory — the only storage surface every window genuinely
 * re-reads. `globalState` is NOT cross-window live: the ext-host Memento is a
 * per-window cache (VS Code delivers `$acceptValue` updates only for
 * settings-sync-registered keys), so whole-snapshot writes there silently
 * destroyed another window's counters. Persists now MERGE against the file
 * (delta replay, see mergePersisted) and keep the memento as a downgrade
 * mirror only.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { WireMetrics } from '../types.js';
import { findModelConfig, type ModelConfig } from '../state/config.js';
import { readServers } from '../state/configStore.js';

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

/** Persisted shape (`usage.json`, mirrored to `globalState`; versioned for forward migration). */
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
/** Profile-wide canonical usage file (globalStorage/usage.json). Undefined
 *  when no globalStorageUri exists (test fakes) — then the store degrades to
 *  the legacy memento-only behavior. */
let usageFilePath: string | undefined;
/** This window's memory at its last SUCCESSFUL persist — the basis for the
 *  next persist's delta. Left stale on a failed write, which makes the next
 *  persist an implicit retry of the lost delta. */
let lastWritten: PersistedUsage | undefined;
let writeQueue: Promise<void> = Promise.resolve();
let logError: (msg: string) => void = () => {};
const emitter = new vscode.EventEmitter<void>();

/** Fired after any store mutation (record or reset) — the dashboard re-renders. */
export const onUsageStoreDidChange: vscode.Event<void> = emitter.event;

// ─── Date / count helpers ────────────────────────────────────────────────

/** `YYYY-MM-DD` local-time bucket key. File-private: every user lives in this module. */
function dayKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function emptyCounts(): UsageCounts {
  return { prompt: 0, completion: 0, cached: 0, reasoning: 0 };
}

function accumulate(map: UsageServerMap, serverUrl: string, modelId: string, counts: UsageCounts): void {
  const server = map[serverUrl] ?? (map[serverUrl] = {});
  const prev = server[modelId] ?? emptyCounts();
  server[modelId] = {
    prompt: prev.prompt + counts.prompt,
    completion: prev.completion + counts.completion,
    cached: prev.cached + counts.cached,
    reasoning: prev.reasoning + counts.reasoning,
  };
}

/** Sum actual reported cost into a cost map (all-time or per-day plane). */
function accumulateCost(map: UsageCostMap, serverUrl: string, modelId: string, cost: number): void {
  const server = map[serverUrl] ?? (map[serverUrl] = {});
  server[modelId] = (server[modelId] ?? 0) + cost;
}

// ─── Init / load / persist ────────────────────────────────────────────────

/**
 * Parse a persisted blob (file OR memento — unknown external value, loose
 * shape). `version` is a plain number so v1/v2/v3 are all comparable
 * (PersistedUsage's literal `version: 3` would reject `=== 2`). v1 upgrades in
 * place (startedAt defaults to {}); v2 → v3 is additive — the cost planes
 * default to {} so old token records migrate unchanged with no fabricated
 * actual cost. Field guards check SHAPE (not just presence): a corrupt blob
 * with a truthy primitive allTime would otherwise crash the first
 * recordRequest with a strict-mode TypeError. Unrecognizable → undefined
 * (corrupt means start fresh, never crash).
 */
function parsePersisted(raw: unknown): PersistedUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as {
    version?: number;
    allTime?: UsageServerMap;
    days?: Record<string, UsageServerMap>;
    startedAt?: Record<string, Record<string, number>>;
    allTimeCost?: UsageCostMap;
    daysCost?: Record<string, UsageCostMap>;
  };
  const isPlainObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if ((p.version === 1 || p.version === 2 || p.version === 3)
    && isPlainObj(p.allTime) && isPlainObj(p.days)) {
    return {
      version: 3,
      allTime: p.allTime,
      days: p.days,
      startedAt: isPlainObj(p.startedAt) ? p.startedAt : {},
      allTimeCost: isPlainObj(p.allTimeCost) ? p.allTimeCost : {},
      daysCost: isPlainObj(p.daysCost) ? p.daysCost : {},
    };
  }
  return undefined;
}

/** Install a persisted snapshot into memory and prune expired day buckets.
 *  Cost buckets use the same window — otherwise the blob grows one bucket per
 *  day indefinitely. */
function adoptPersisted(p: PersistedUsage | undefined): void {
  if (!p) return;
  allTime = p.allTime;
  days = p.days;
  startedAt = p.startedAt;
  allTimeCost = p.allTimeCost;
  daysCost = p.daysCost;
  const cutoff = dayKey(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  for (const key of Object.keys(days)) {
    if (key < cutoff) delete days[key];
  }
  for (const key of Object.keys(daysCost)) {
    if (key < cutoff) delete daysCost[key];
  }
}

// ─── Cross-window merge ────────────────────────────────────────────

type LeafPlane<T> = Record<string, Record<string, T>>;

/** Delta-merge one server→model plane: disk + (memory − ours), clamped at 0
 *  (cross-window reset races must not mint negative totals). Fully-zero
 *  count leaves drop out — absent ≡ zero for tokens. */
function mergeCountsPlane(disk: UsageServerMap, memory: UsageServerMap, ours: UsageServerMap): UsageServerMap {
  const out: UsageServerMap = {};
  for (const srv of new Set([...Object.keys(disk), ...Object.keys(memory)])) {
    const d = disk[srv] ?? {}, m = memory[srv] ?? {}, o = ours[srv] ?? {};
    const entry: Record<string, UsageCounts> = {};
    for (const id of new Set([...Object.keys(d), ...Object.keys(m)])) {
      const dv = { ...emptyCounts(), ...d[id] };
      const mv = { ...emptyCounts(), ...m[id] };
      const ov = { ...emptyCounts(), ...o[id] };
      const v: UsageCounts = {
        prompt: Math.max(0, dv.prompt + mv.prompt - ov.prompt),
        completion: Math.max(0, dv.completion + mv.completion - ov.completion),
        cached: Math.max(0, dv.cached + mv.cached - ov.cached),
        reasoning: Math.max(0, dv.reasoning + mv.reasoning - ov.reasoning),
      };
      if (v.prompt || v.completion || v.cached || v.reasoning) entry[id] = v;
    }
    if (Object.keys(entry).length > 0) out[srv] = entry;
  }
  return out;
}

/** Delta-merge one actual-cost plane. Leaves merging to ≤ 0 drop out: a
 *  cost erased by a reset must not linger masquerading as a reported-zero
 *  (free-model) entry — a genuinely free model re-reports usage.cost 0 on its
 *  next request anyway. */
function mergeCostPlane(disk: UsageCostMap, memory: UsageCostMap, ours: UsageCostMap): UsageCostMap {
  const out: UsageCostMap = {};
  for (const srv of new Set([...Object.keys(disk), ...Object.keys(memory)])) {
    const d = disk[srv] ?? {}, m = memory[srv] ?? {}, o = ours[srv] ?? {};
    const entry: Record<string, number> = {};
    for (const id of new Set([...Object.keys(d), ...Object.keys(m)])) {
      const v = (d[id] ?? 0) + (m[id] ?? 0) - (o[id] ?? 0);
      if (v > 0) entry[id] = v;
    }
    if (Object.keys(entry).length > 0) out[srv] = entry;
  }
  return out;
}

/** startedAt plane: earliest stamp wins; a key this window dropped via reset
 *  (present in `ours`, absent from `memory`) is dropped from the merge too. */
function mergeStartedAt(
  disk: LeafPlane<number>, memory: LeafPlane<number>, ours: LeafPlane<number>,
): LeafPlane<number> {
  const out: LeafPlane<number> = {};
  for (const srv of new Set([...Object.keys(disk), ...Object.keys(memory), ...Object.keys(ours)])) {
    const d = disk[srv] ?? {}, m = memory[srv] ?? {}, o = ours[srv] ?? {};
    const entry: Record<string, number> = {};
    for (const id of new Set([...Object.keys(d), ...Object.keys(m), ...Object.keys(o)])) {
      if (o[id] !== undefined && m[id] === undefined) continue; // reset by this window
      const stamps = [d[id], m[id]].filter((x): x is number => x !== undefined);
      if (stamps.length > 0) entry[id] = Math.min(...stamps);
    }
    if (Object.keys(entry).length > 0) out[srv] = entry;
  }
  return out;
}

/** Merge one day-keyed plane via a leaf merger. */
function mergeDayPlane<T>(
  disk: Record<string, LeafPlane<T>>,
  memory: Record<string, LeafPlane<T>>,
  ours: Record<string, LeafPlane<T>>,
  merge: (d: LeafPlane<T>, m: LeafPlane<T>, o: LeafPlane<T>) => LeafPlane<T>,
): Record<string, LeafPlane<T>> {
  const out: Record<string, LeafPlane<T>> = {};
  for (const k of new Set([...Object.keys(disk), ...Object.keys(memory)])) {
    const m = merge(disk[k] ?? {}, memory[k] ?? {}, ours[k] ?? {});
    if (Object.keys(m).length > 0) out[k] = m;
  }
  return out;
}

/**
 * The merge rule: `disk + (memory − lastWritten)`. `lastWritten` is this
 * window's memory at its last successful persist, so the replayed delta is
 * exactly what this window ADDED (or erased, via reset) since then — never
 * the whole baseline, which would double-count everything another window
 * already persisted (lineage safety). No disk snapshot (fresh file) → memory
 * is the truth. After merging, expired day buckets are pruned on the DISK
 * side too: the file may hold buckets this window never loaded, and merging
 * would otherwise resurrect them forever.
 *
 * Residual race (documented, accepted): two windows whose read/write
 * interleave within the same few milliseconds can still lose one delta — a
 * window-sized data loss becomes a millisecond-sized one, which is the best
 * the public storage APIs allow.
 */
function mergePersisted(
  disk: PersistedUsage | undefined, memory: PersistedUsage, ours: PersistedUsage,
): PersistedUsage {
  if (!disk) return memory;
  const merged: PersistedUsage = {
    version: 3,
    allTime: mergeCountsPlane(disk.allTime, memory.allTime, ours.allTime),
    days: mergeDayPlane(disk.days, memory.days, ours.days, mergeCountsPlane),
    startedAt: mergeStartedAt(disk.startedAt, memory.startedAt, ours.startedAt),
    allTimeCost: mergeCostPlane(disk.allTimeCost, memory.allTimeCost, ours.allTimeCost),
    daysCost: mergeDayPlane(disk.daysCost, memory.daysCost, ours.daysCost, mergeCostPlane),
  };
  const cutoff = dayKey(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  for (const k of Object.keys(merged.days)) {
    if (k < cutoff) delete merged.days[k];
  }
  for (const k of Object.keys(merged.daysCost)) {
    if (k < cutoff) delete merged.daysCost[k];
  }
  return merged;
}

/** Deep clone of the current cumulative memory — what the next persist replays. */
function snapshotMemory(): PersistedUsage {
  return JSON.parse(JSON.stringify({
    version: 3, allTime, days, startedAt, allTimeCost, daysCost,
  })) as PersistedUsage;
}

/** FRESH disk read — the entire point of the file backend: unlike the memento
 *  cache, this sees another window's last write. Missing/corrupt → undefined
 *  (the next persist recreates the file from memory; self-healing). */
async function readUsageFile(p: string): Promise<PersistedUsage | undefined> {
  try {
    return parsePersisted(JSON.parse(await fs.readFile(p, 'utf8')));
  } catch {
    return undefined;
  }
}

/** Temp-file + rename: the replace is atomic (Windows included), so a window
 *  reading mid-write sees either the old or the new blob, never a half file.
 *  The tmp name carries the pid so two windows never share a scratch file. */
async function writeUsageFile(p: string, data: PersistedUsage): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, p);
}

/**
 * Persist through the serialized write queue. `globalState.update` and the
 * file write are async, so two rapid `recordRequest` calls could otherwise
 * interleave read-modify-write and lose an update; chaining guarantees writes
 * land in order. The snapshot is taken AT WRITE TIME (the queue serializes
 * them, so the next persist simply replays this window's delta since the last
 * successful write). Both surfaces get the SAME merged blob: the file is
 * canonical (freshly read), the memento a downgrade mirror. Failure semantics
 * follow CANONICALITY, not sequence: in file mode the baseline advances as soon
 * as the FILE write succeeds (a mirror failure never vetoes the file's
 * arithmetic, CR-40); in memento-only mode, or before the file write, a failure
 * leaves `lastWritten` stale so the next persist retries the lost delta.
 */
function schedulePersist(): void {
  if (!globalState && !usageFilePath) return;
  writeQueue = writeQueue
    .then(async () => {
      const memory = snapshotMemory();
      const disk = usageFilePath ? await readUsageFile(usageFilePath) : undefined;
      const merged = mergePersisted(disk, memory, lastWritten ?? memory);
      if (usageFilePath) {
        await writeUsageFile(usageFilePath, merged);
        // Advance the baseline the moment the CANONICAL surface is written
        // (CR-40): the memento below is a downgrade mirror — if ITS write
        // rejects, replaying this delta into the already-updated file would
        // double-count it into every window, permanently.
        lastWritten = memory;
        if (globalState) {
          try {
            await globalState.update(STORAGE_KEY, merged);
          } catch (err) {
            logError(`[usage] memento mirror update failed (usage.json is canonical, counters unaffected): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else if (globalState) {
        // Memento-only mode: the mirror IS canonical here, so a failed write
        // must leave lastWritten stale and let the next persist retry the
        // delta (the retry semantics the docstring promises).
        await globalState.update(STORAGE_KEY, merged);
        lastWritten = memory;
      }
    })
    .catch(err => logError(`[usage] persist failed: ${err instanceof Error ? err.message : String(err)}`));
}

/**
 * Initialize the store. Called once from `activate()` (awaited) before any
 * request can complete. Load order: the shared `usage.json` wins; when it is
 * absent OR unreadable (corrupt counts too — `readUsageFile` returns
 * undefined for both) the legacy `globalState` blob is adopted as the
 * recovery source (one-time migration — the next persist writes it back as
 * the file). Returns a Disposable that releases the change event.
 */
export async function initUsageStore(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<{ dispose(): void }> {
  globalState = context.globalState;
  logError = msg => outputChannel.appendLine(`[ERROR] ${msg}`);
  usageFilePath = context.globalStorageUri
    ? path.join(context.globalStorageUri.fsPath, 'usage.json')
    : undefined;
  const fromFile = usageFilePath ? await readUsageFile(usageFilePath) : undefined;
  adoptPersisted(fromFile ?? parsePersisted(context.globalState.get(STORAGE_KEY)));
  lastWritten = snapshotMemory();
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
 *
 * Cross-window note: the persist merge replays this window's DELETION (the
 * delta goes negative), so a live second window's counters survive in its own
 * memory and reappear on its next persist. In the single-window case — the
 * normal case — this is a full reset.
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
