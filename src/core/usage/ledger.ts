/**
 * The usage ledger: canonical accounting state for completed requests.
 *
 * An INSTANCE, not a package-global singleton: the editor extension binds it
 * to its canonical `usage.json` + the legacy globalState mirror + its own
 * change event; a standalone Node consumer instantiates its own ledger at an
 * explicitly selected path. Separate installations — no promise of one global
 * ledger across processes (the accepted cross-window merge race is not a
 * license to promise stronger multi-process guarantees).
 *
 * The canonical cumulative blob is `usage.json` — the only storage surface
 * every window genuinely re-reads. The memento mirror exists solely for
 * downgrade recovery: the ext-host Memento is a per-window cache, so
 * whole-snapshot writes there silently destroyed another window's counters.
 * Persists MERGE against the file (delta replay, see mergePersisted).
 *
 * State is instance-owned: last requests, count/cost/day planes, first-record
 * timestamps, the last-successful-write baseline, and the serialized write
 * queue. {@link UsageLedger.flush} exposes the queue for standalone shutdown;
 * the editor path keeps firing changes synchronously and never awaits.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { findModelConfig, type ModelConfig } from '../config/config.js';
import type { ServerEntry } from '../config/serverRegistry.js';
import type { RequestLog } from '../shared/trace.js';
import type { LastRequestData } from './record.js';
import type { CostRates } from './money.js';

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

/** Persisted shape (`usage.json`, mirrored to the downgrade mirror; versioned for forward migration). */
export interface PersistedUsage {
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

const RETENTION_DAYS = 90;

/** Host inputs the ledger needs — explicit storage, mirror, log sink, change callback. */
export interface UsageLedgerHost {
  /** Canonical usage file. Undefined = memory-only (no persistence), as in tests. */
  filePath?: string;
  /** Legacy downgrade mirror (VS Code globalState): sync read, async write. Absent = no mirror. */
  mirror?: { read(): unknown; write(value: PersistedUsage): PromiseLike<void> };
  /** Sink for persist-failure diagnostics (the `[ERROR] [usage] ...` lines). */
  log?: RequestLog;
  /** Fired synchronously after any mutation (record or reset), after the
   *  persist has been SCHEDULED — exactly as the store's event fired before. */
  onChange(): void;
}

/**
 * Locate a model's cost rates by `(serverUrl, wire modelId)`, registry
 * supplied — no ambient settings read. The wire id is what the tracker keys
 * on; returns undefined when the model has no `cost` config.
 */
export function findModelCost(
  models: ModelConfig[],
  servers: ServerEntry[],
  serverUrl: string,
  modelId: string,
): CostRates | undefined {
  // The (serverUrl, wire id) match itself lives in findModelConfig (config.ts);
  // the registry is passed in so callers keep holding the plain URL.
  return findModelConfig(models, servers, serverUrl, modelId)?.cost;
}

// ─── Date / count helpers ────────────────────────────────────────────────

/** `YYYY-MM-DD` local-time bucket key. */
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

// ─── Persistence format ───────────────────────────────────────────────────

/**
 * Parse a persisted blob (file OR mirror — unknown external value, loose
 * shape). `version` is a plain number so v1/v2/v3 are all comparable
 * (PersistedUsage's literal `version: 3` would reject `=== 2`). v1 upgrades in
 * place (startedAt defaults to {}); v2 → v3 is additive — the cost planes
 * default to {} so old token records migrate unchanged with no fabricated
 * actual cost. Field guards check SHAPE (not just presence): a corrupt blob
 * with a truthy primitive allTime would otherwise crash the first
 * recordRequest with a strict-mode TypeError. Unrecognizable → undefined
 * (corrupt means start fresh, never crash).
 */
export function parsePersisted(raw: unknown): PersistedUsage | undefined {
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

/** startedAt plane: earliest stamp wins; a key this instance dropped via reset
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
 * instance's memory at its last successful persist, so the replayed delta is
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
export function mergePersisted(
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

// ─── The ledger ───────────────────────────────────────────────────────────

export class UsageLedger {
  private readonly lastRequest = new Map<string, LastRequestData>();
  private allTime: UsageServerMap = {};
  private days: Record<string, UsageServerMap> = {};
  private startedAt: Record<string, Record<string, number>> = {};
  private allTimeCost: UsageCostMap = {};
  private daysCost: Record<string, UsageCostMap> = {};
  /** This instance's memory at its last SUCCESSFUL persist — the basis for the
   *  next persist's delta. Left stale on a failed write, which makes the next
   *  persist an implicit retry of the lost delta. */
  private lastWritten: PersistedUsage | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly host: UsageLedgerHost) {}

  /**
   * Load persisted state. Call once before serving reads. Load order: the
   * shared file wins; when it is absent OR unreadable (corrupt counts too —
   * readUsageFile returns undefined for both) the downgrade mirror blob is
   * adopted as the recovery source (one-time migration — the next persist
   * writes it back as the file).
   */
  async load(): Promise<void> {
    const fromFile = this.host.filePath ? await readUsageFile(this.host.filePath) : undefined;
    this.adopt(fromFile ?? parsePersisted(this.host.mirror?.read()));
    this.lastWritten = this.snapshotMemory();
  }

  /** Install a persisted snapshot into memory and prune expired day buckets.
   *  Cost buckets use the same window — otherwise the blob grows one bucket per
   *  day indefinitely. */
  private adopt(p: PersistedUsage | undefined): void {
    if (!p) return;
    this.allTime = p.allTime;
    this.days = p.days;
    this.startedAt = p.startedAt;
    this.allTimeCost = p.allTimeCost;
    this.daysCost = p.daysCost;
    const cutoff = dayKey(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    for (const key of Object.keys(this.days)) {
      if (key < cutoff) delete this.days[key];
    }
    for (const key of Object.keys(this.daysCost)) {
      if (key < cutoff) delete this.daysCost[key];
    }
  }

  /**
   * Record a completed request. Stores it as the server's last request AND
   * accumulates it into the all-time and today counters, then persists and
   * fires the change event (the dashboard re-renders immediately).
   */
  recordRequest(data: LastRequestData): void {
    this.lastRequest.set(data.serverUrl, data);

    const counts: UsageCounts = {
      prompt: data.promptTokens,
      completion: data.completionTokens,
      cached: data.cachedTokens ?? 0,
      reasoning: data.reasoningTokens ?? 0,
    };
    accumulate(this.allTime, data.serverUrl, data.modelId, counts);
    const todayKey = dayKey();
    if (!this.days[todayKey]) this.days[todayKey] = {};
    accumulate(this.days[todayKey], data.serverUrl, data.modelId, counts);

    // Actual reported cost (OpenRouter usage.cost) accumulates separately from
    // the derived estimates — never summed together. Absent = nothing to record
    // (vLLM/local). Validity is NOT re-checked here: sanitizeUsage at the wire
    // boundary is the single clamp point (finite, >= 0, or undefined) and it
    // also covers the lastRequest/log paths this accumulation never sees.
    if (data.actualCost !== undefined) {
      accumulateCost(this.allTimeCost, data.serverUrl, data.modelId, data.actualCost);
      if (!this.daysCost[todayKey]) this.daysCost[todayKey] = {};
      accumulateCost(this.daysCost[todayKey], data.serverUrl, data.modelId, data.actualCost);
    }

    // Stamp the first-record timestamp for this (server, model) — backs the
    // "started X ago" label on the model's Overall row. Reset clears the entry,
    // so the next record re-stamps it (recording "restarted").
    const srvStarted = this.startedAt[data.serverUrl] ?? (this.startedAt[data.serverUrl] = {});
    if (srvStarted[data.modelId] === undefined) srvStarted[data.modelId] = Date.now();

    this.schedulePersist();
    this.host.onChange();
  }

  /** Last request for a server, or undefined if none recorded this activation. */
  getLastRequest(serverUrl: string): LastRequestData | undefined {
    return this.lastRequest.get(serverUrl);
  }

  /**
   * The freshest last-request record across all servers, or undefined while
   * nothing has been captured this activation. Backs the status bar chip,
   * which shows whichever server served the most recent run. Ephemeral like
   * the per-server getter: `reset` deliberately keeps the map, a reload
   * empties it.
   */
  getLatestRequest(): LastRequestData | undefined {
    let latest: LastRequestData | undefined;
    for (const data of this.lastRequest.values()) {
      if (!latest || data.timestamp > latest.timestamp) latest = data;
    }
    return latest;
  }

  /** Cumulative per-model counts for a server across all-time and today. */
  getServerUsage(serverUrl: string): ServerUsage {
    return {
      allTime: this.allTime[serverUrl] ?? {},
      today: this.days[dayKey()]?.[serverUrl] ?? {},
    };
  }

  /** Cumulative actual reported cost (USD) per model for a server, all-time and today. */
  getServerCost(serverUrl: string): ServerCost {
    return {
      allTime: this.allTimeCost[serverUrl] ?? {},
      today: this.daysCost[dayKey()]?.[serverUrl] ?? {},
    };
  }

  /** True when a server has any recorded usage (all-time). */
  hasServerUsage(serverUrl: string): boolean {
    return Object.keys(this.allTime[serverUrl] ?? {}).length > 0;
  }

  /** Server URLs that have any recorded usage (all-time). */
  getServersWithUsage(): string[] {
    return Object.keys(this.allTime);
  }

  /** Epoch ms of the first recorded request for (serverUrl, modelId), or undefined. */
  getModelStartedAt(serverUrl: string, modelId: string): number | undefined {
    return this.startedAt[serverUrl]?.[modelId];
  }

  /**
   * Clear accumulated usage for a scope. `'all'` clears every server; an
   * object clears one server only. Last Request is deliberately NOT cleared
   * (it remains the useful last prompt). Persists and fires the change event.
   *
   * Cross-window note: the persist merge replays this window's DELETION (the
   * delta goes negative), so a live second window's counters survive in its own
   * memory and reappear on its next persist. In the single-window case — the
   * normal case — this is a full reset.
   */
  reset(scope: 'all' | { serverUrl: string }): void {
    if (scope === 'all') {
      this.allTime = {};
      this.days = {};
      this.startedAt = {};
      this.allTimeCost = {};
      this.daysCost = {};
    } else {
      const url = scope.serverUrl;
      delete this.allTime[url];
      for (const key of Object.keys(this.days)) delete this.days[key][url];
      delete this.startedAt[url];
      delete this.allTimeCost[url];
      for (const key of Object.keys(this.daysCost)) delete this.daysCost[key][url];
    }
    this.schedulePersist();
    this.host.onChange();
  }

  /** Await every scheduled persist (standalone shutdown / proof checks). The
   *  editor path never needs this — disposal does not await persistence. */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  /** Deep clone of the current cumulative memory — what the next persist replays. */
  private snapshotMemory(): PersistedUsage {
    return JSON.parse(JSON.stringify({
      version: 3,
      allTime: this.allTime,
      days: this.days,
      startedAt: this.startedAt,
      allTimeCost: this.allTimeCost,
      daysCost: this.daysCost,
    })) as PersistedUsage;
  }

  /**
   * Persist through the serialized write queue. The mirror update and the
   * file write are async, so two rapid `recordRequest` calls could otherwise
   * interleave read-modify-write and lose an update; chaining guarantees
   * writes land in order. The snapshot is taken AT WRITE TIME (the queue
   * serializes them, so the next persist simply replays this window's delta
   * since the last successful write). Both surfaces get the SAME merged blob:
   * the file is canonical (freshly read), the mirror a downgrade mirror.
   * Failure semantics follow CANONICALITY, not sequence: in file mode the
   * baseline advances as soon as the FILE write succeeds (a mirror failure
   * never vetoes the file's arithmetic, CR-40); in mirror-only mode, or
   * before the file write, a failure leaves `lastWritten` stale so the next
   * persist retries the lost delta.
   */
  private schedulePersist(): void {
    const { filePath, mirror } = this.host;
    if (!mirror && !filePath) return;
    this.writeQueue = this.writeQueue
      .then(async () => {
        const memory = this.snapshotMemory();
        const disk = filePath ? await readUsageFile(filePath) : undefined;
        const merged = mergePersisted(disk, memory, this.lastWritten ?? memory);
        if (filePath) {
          await writeUsageFile(filePath, merged);
          // Advance the baseline the moment the CANONICAL surface is written
          // (CR-40): the mirror below is a downgrade mirror — if ITS write
          // rejects, replaying this delta into the already-updated file would
          // double-count it into every window, permanently.
          this.lastWritten = memory;
          if (mirror) {
            try {
              await mirror.write(merged);
            } catch (err) {
              this.logError(`[usage] memento mirror update failed (usage.json is canonical, counters unaffected): ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else if (mirror) {
          // Mirror-only mode: the mirror IS canonical here, so a failed write
          // must leave lastWritten stale and let the next persist retry the
          // delta (the retry semantics the docstring promises).
          await mirror.write(merged);
          this.lastWritten = memory;
        }
      })
      .catch(err => this.logError(`[usage] persist failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private logError(msg: string): void {
    this.host.log?.appendLine(`[ERROR] ${msg}`);
  }
}
