/**
 * External usage ingest: completed requests that finished in ANOTHER runtime
 * (today the DeepSeek Harness bridge) and must fold into this package owner's
 * ledger. The owner decides what happens to every record — the caller never
 * decides by writing the ledger itself — and this module is where those
 * decisions live: idempotence by caller-generated `recordId`, the reset
 * barriers, and payload accountability. Pure plan, zero I/O: the host
 * (`vscode/state/externalUsage.ts`) owns the seen-id file, the live ledger
 * application and the persist scheduling, and a companion's own tests can
 * wrap THIS function instead of mirroring the contract.
 *
 * Two decisions worth their salt (unchanged since the handoff shipped):
 *   - Idempotence by caller-generated `recordId`. A caller that dies between
 *     "ledger accepted" and "my queue file deleted" must be able to retry
 *     without the user's totals doubling. Seen ids persist.
 *   - A reset is a barrier, not just a deletion. Traffic completed before the
 *     user cleared their dashboard stays gone, otherwise offline traffic from
 *     a harness that kept running would resurrect numbers the user threw away.
 */
import type { LastRequestData } from './record.js';
import type { RequestLog } from '../shared/trace.js';

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

/** The owner's durable ingest state: ids already settled, and reset barriers
 *  as epoch ms per scope ('all' or a server URL). */
export interface ExternalUsageState {
  seenIds: readonly string[];
  barriers: Readonly<Record<string, number>>;
}

export interface ExternalIngestPlan {
  /** Every submitted id appears in exactly one bucket, so the caller can
   *  settle its queue with no guessing: accepted/duplicate/preReset/rejected
   *  all mean "delete it", an absent id means "keep it and try again". */
  outcome: ExternalRequestOutcome;
  /** Validated payloads of the accepted records, in input order — what the
   *  host folds into its live ledger. */
  requests: LastRequestData[];
  /** The state's seen ids after this pass, ring-evicted. The host persists it. */
  nextSeenIds: string[];
}

/** Seen ids are a ring, not a growing archive: the queue a caller replays from
 *  is bounded by its own retry window, so a year of ids buys nothing. */
const MAX_SEEN_IDS = 20000;

function finiteOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Convert an untrusted record into the ledger's vocabulary, or null when the
 * record cannot be accounted for at all. Nothing here clamps a nonsense value
 * into range: a caller that sent `promptTokens: -5` sent a bug, and quietly
 * folding that in would corrupt totals the user cannot audit.
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
function refusedByReset(record: ExternalRequestRecord, barriers: ExternalUsageState['barriers']): boolean {
  const when = completedAt(record);
  const serverBarrier = barriers[record.request.serverUrl];
  const allBarrier = barriers.all;
  if (serverBarrier !== undefined && when < serverBarrier) return true;
  if (allBarrier !== undefined && when < allBarrier) return true;
  return false;
}

/**
 * Decide the fate of a batch of externally completed requests. Synchronous
 * and pure: it neither writes the ledger nor touches storage — it returns the
 * validated payloads the host must apply and the next seen-id state the host
 * must persist. Duplicate ids WITHIN one batch count once (the first sighting
 * is accepted, later ones are duplicates), exactly like a replay across runs.
 */
export function ingestExternalUsage(
  records: readonly ExternalRequestRecord[],
  state: ExternalUsageState,
  log?: RequestLog,
): ExternalIngestPlan {
  const outcome: ExternalRequestOutcome = { accepted: [], duplicate: [], preReset: [], rejected: [] };
  const requests: LastRequestData[] = [];
  const seen = new Set(state.seenIds);
  // Rebuilt from the Set, not copied: a hand-mangled store file carrying a
  // duplicate id is deduped on the next persist instead of festering.
  const nextSeenIds = [...seen];
  const settle = (recordId: string): void => {
    seen.add(recordId);
    nextSeenIds.push(recordId);
  };

  for (const record of records) {
    if (typeof record?.recordId !== 'string' || !record.recordId || !record.request) {
      outcome.rejected.push(record?.recordId ?? '<missing id>');
      continue;
    }
    if (seen.has(record.recordId)) {
      outcome.duplicate.push(record.recordId);
      continue;
    }
    if (refusedByReset(record, state.barriers)) {
      // Settled, not stored: deleting it is what makes the user's reset stick.
      settle(record.recordId);
      outcome.preReset.push(record.recordId);
      continue;
    }
    const data = toRequest(record);
    if (!data) {
      log?.appendLine(`refused an external usage record ${record.recordId}: payload is not accountable`);
      outcome.rejected.push(record.recordId);
      continue;
    }
    settle(record.recordId);
    requests.push(data);
    outcome.accepted.push(record.recordId);
  }

  if (nextSeenIds.length > MAX_SEEN_IDS) {
    nextSeenIds.splice(0, nextSeenIds.length - MAX_SEEN_IDS);
  }
  return { outcome, requests, nextSeenIds };
}
