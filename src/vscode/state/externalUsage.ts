/**
 * The published handoff for usage that completed somewhere other than this
 * extension's own provider path, today the DeepSeek Harness bridge.
 *
 * Why the owner does the accounting instead of the caller: this extension owns
 * `usage.json`, its delta merge, its reset semantics and its cost derivation.
 * A second writer would have to reproduce all three and would still lose
 * races. So callers hand over completed requests and this module decides what
 * happens to each one, which is also the only place a truthful answer about
 * duplicates and resets can come from.
 *
 * Two decisions worth their salt:
 *   - Idempotence by caller-generated `recordId`. A caller that dies between
 *     "ledger accepted" and "my queue file deleted" must be able to retry
 *     without the user's totals doubling. Seen ids persist.
 *   - A reset is a barrier, not just a deletion. Traffic completed before the
 *     user cleared their dashboard stays gone, otherwise offline traffic from a
 *     harness that kept running would resurrect numbers the user threw away.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ExtensionContext } from 'vscode';
import { onUsageDidReset, recordExternalRequest } from './usageStore.js';
import type { LastRequestData } from '../../core/usage/record.js';

/** Version of the handoff, matched against the caller's expectation. */
export const EXTERNAL_USAGE_API_VERSION = 1;

/** One completed request as its origin describes it. Untrusted input. */
export interface ExternalRequestRecord {
  recordId: string;
  recordedAt: string;
  request: {
    serverUrl: string;
    modelId: string;
    timestamp: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
    createdCacheTokens?: number;
    reasoningTokens?: number;
    actualCost?: number;
    maxModelLen?: number;
    maxOutputTokens?: number;
    firstTokenTimeMs?: number | null;
    totalTimeMs?: number | null;
  };
}

export interface ExternalRequestOutcome {
  accepted: string[];
  duplicate: string[];
  preReset: string[];
  /** Record ids refused for good because the payload is unusable. */
  rejected: string[];
}

const STORE_FILE = 'external-usage.json';
/** Seen ids are a ring, not a growing archive: the queue a caller replays from
 *  is bounded by its own retry window, so a year of ids buys nothing. */
const MAX_SEEN_IDS = 20000;

interface PersistedExternal {
  version: 1;
  ids: string[];
  /** Epoch ms per reset scope ('all' or a server URL). */
  barriers: Record<string, number>;
}

let filePath: string | undefined;
let log: { info(message: string): void; warn(message: string): void } = {
  info: () => undefined,
  warn: () => undefined,
};
let state: PersistedExternal = { version: 1, ids: [], barriers: {} };
const seen = new Set<string>();
let writeChain: Promise<void> = Promise.resolve();

/** Bind the storage file and load the seen-id set. Called from `activate()`. */
export async function initExternalUsage(
  context: ExtensionContext,
  sink?: { info(message: string): void; warn(message: string): void },
): Promise<void> {
  if (sink) log = sink;
  if (!context.globalStorageUri) return;
  filePath = path.join(context.globalStorageUri.fsPath, STORE_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<PersistedExternal>;
    if (Array.isArray(parsed.ids)) {
      for (const id of parsed.ids) if (typeof id === 'string') seen.add(id);
      state.ids = [...seen];
    }
    if (parsed.barriers && typeof parsed.barriers === 'object') {
      for (const [key, value] of Object.entries(parsed.barriers)) {
        if (typeof value === 'number' && Number.isFinite(value)) state.barriers[key] = value;
      }
    }
  } catch {
    // Absent or unreadable starts empty: an empty set can only ever accept a
    // record again, which the caller treats as a duplicate-free first pass.
  }
}

function persist(): void {
  if (!filePath) return;
  const snapshot = JSON.stringify({ version: 1, ids: state.ids, barriers: state.barriers } satisfies PersistedExternal);
  const target = filePath;
  writeChain = writeChain.then(async () => {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // tmp + rename: a torn file would forget ids, and forgotten ids are double
      // counted totals, the one failure mode this module exists to prevent.
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, snapshot);
      fs.renameSync(tmp, target);
    } catch (err) {
      log.warn(`could not persist external usage ids: ${(err as Error).message}`);
    }
  });
}

function finiteOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Convert untrusted input into the ledger's vocabulary, or null when the record
 * cannot be accounted for at all. Nothing here clamps a nonsense value into
 * range: a caller that sent `promptTokens: -5` sent a bug, and quietly folding
 * that in would corrupt totals the user cannot audit.
 */
function toRequest(record: ExternalRequestRecord): LastRequestData | null {
  const r = record.request;
  if (typeof r.serverUrl !== 'string' || !r.serverUrl) return null;
  if (typeof r.modelId !== 'string' || !r.modelId) return null;
  if (typeof r.promptTokens !== 'number' || !Number.isFinite(r.promptTokens) || r.promptTokens < 0) return null;
  if (typeof r.completionTokens !== 'number' || !Number.isFinite(r.completionTokens) || r.completionTokens < 0) return null;
  const timestamp = finiteOr(r.timestamp, 0);
  if (timestamp <= 0) return null;
  return {
    serverUrl: r.serverUrl,
    modelId: r.modelId,
    timestamp,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalTokens: finiteOr(r.totalTokens, r.promptTokens + r.completionTokens),
    cachedTokens: r.cachedTokens === undefined ? undefined : finiteOr(r.cachedTokens),
    createdCacheTokens: r.createdCacheTokens === undefined ? undefined : finiteOr(r.createdCacheTokens),
    reasoningTokens: r.reasoningTokens === undefined ? undefined : finiteOr(r.reasoningTokens),
    actualCost: typeof r.actualCost === 'number' && Number.isFinite(r.actualCost) && r.actualCost >= 0 ? r.actualCost : undefined,
    maxModelLen: finiteOr(r.maxModelLen),
    maxOutputTokens: finiteOr(r.maxOutputTokens),
    firstTokenTimeMs: typeof r.firstTokenTimeMs === 'number' && Number.isFinite(r.firstTokenTimeMs) ? r.firstTokenTimeMs : null,
    totalTimeMs: typeof r.totalTimeMs === 'number' && Number.isFinite(r.totalTimeMs) ? r.totalTimeMs : null,
    hasMetrics: false,
    hasCacheDetails: false,
  };
}

/** When this record completed, per the record itself. */
function completedAt(record: ExternalRequestRecord): number {
  const parsed = Date.parse(record.recordedAt);
  const own = Number.isFinite(record.request?.timestamp) ? record.request.timestamp : 0;
  return Math.max(Number.isFinite(parsed) ? parsed : 0, own);
}

/**
 * Refuse anything a reset already threw away: scope barrier, then all-scope.
 *
 * The comparison is strict on purpose. Within one millisecond there is no way
 * to tell "completed just before the clear" from "just after", and the two
 * errors are not equally bad: counting the ambiguous request adds a rounding
 * error to a total the user just cleared, while discarding it throws away
 * traffic they paid for. Ambiguity goes to the user.
 */
function refusedByReset(record: ExternalRequestRecord): boolean {
  const when = completedAt(record);
  const serverBarrier = state.barriers[record.request.serverUrl];
  const allBarrier = state.barriers.all;
  if (serverBarrier !== undefined && when < serverBarrier) return true;
  if (allBarrier !== undefined && when < allBarrier) return true;
  return false;
}

/**
 * Account for a batch of externally completed requests. Every id the caller
 * sent appears in exactly one bucket, so the caller can settle its queue with
 * no guessing: accepted and duplicate and preReset and rejected all mean
 * "delete it", an absent id means "keep it and try again".
 */
export async function recordExternalRequests(
  records: readonly ExternalRequestRecord[],
): Promise<ExternalRequestOutcome> {
  const outcome: ExternalRequestOutcome = { accepted: [], duplicate: [], preReset: [], rejected: [] };
  for (const record of records) {
    if (typeof record?.recordId !== 'string' || !record.recordId || !record.request) {
      outcome.rejected.push(record?.recordId ?? '<missing id>');
      continue;
    }
    if (seen.has(record.recordId)) {
      outcome.duplicate.push(record.recordId);
      continue;
    }
    if (refusedByReset(record)) {
      // Settled, not stored: deleting it is what makes the user's reset stick.
      seen.add(record.recordId);
      state.ids.push(record.recordId);
      outcome.preReset.push(record.recordId);
      continue;
    }
    const data = toRequest(record);
    if (!data) {
      log.warn(`refused an external usage record ${record.recordId}: payload is not accountable`);
      outcome.rejected.push(record.recordId);
      continue;
    }
    recordExternalRequest(data);
    seen.add(record.recordId);
    state.ids.push(record.recordId);
    outcome.accepted.push(record.recordId);
  }
  if (state.ids.length > MAX_SEEN_IDS) {
    const dropped = state.ids.splice(0, state.ids.length - MAX_SEEN_IDS);
    for (const id of dropped) seen.delete(id);
  }
  if (outcome.accepted.length || outcome.preReset.length) persist();
  return outcome;
}

/** Stamp the barrier for a reset the user just performed. */
export function noteUsageReset(scope: 'all' | { serverUrl: string }): void {
  const key = scope === 'all' ? 'all' : scope.serverUrl;
  state.barriers[key] = Date.now();
  persist();
}

/** Subscribe the barrier to the store's own reset event. Returns a disposable. */
export function watchUsageResets(): { dispose(): void } {
  return onUsageDidReset(noteUsageReset);
}

/** Test seam: forget everything in memory (does not touch the file). */
export function resetExternalUsageStateForTests(): void {
  seen.clear();
  state = { version: 1, ids: [], barriers: {} };
}
