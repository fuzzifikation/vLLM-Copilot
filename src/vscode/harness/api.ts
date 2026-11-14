/**
 * The ledger handoff contract with vLLM-Copilot.
 *
 * The main extension owns the canonical usage ledger, so it also owns dedup
 * and resets: it is the only party that knows which `recordId`s it has already
 * folded in and when the user last cleared the totals. The bridge therefore
 * never writes `usage.json` itself (two writers on one cumulative blob is how
 * counters get double counted); it hands records over this interface and
 * deletes its copies only after the owner acknowledges them.
 *
 * `activate()` in vLLM-Copilot returns this object. When it returns nothing
 * (any build before the API existed) `asLedgerPort` yields undefined and the
 * bridge keeps its outbox and shows a reminder rather than inventing its own
 * ledger the dashboard cannot see.
 */

/** Per-request counters as the core records them. Mirrors `LastRequestData`. */
export interface ExternalRequestCounters {
  serverUrl: string
  modelId: string
  timestamp: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens?: number
  createdCacheTokens?: number
  reasoningTokens?: number
  actualCost?: number
  maxModelLen?: number
  maxOutputTokens?: number
  firstTokenTimeMs?: number | null
  totalTimeMs?: number | null
}

export interface ExternalRequestRecord {
  /** Bridge-generated, stable across retries. The owner's dedup key. */
  recordId: string
  /** ISO timestamp of when the harness finished the request. */
  recordedAt: string
  request: ExternalRequestCounters
}

export interface ExternalRequestResult {
  /** RecordIds newly folded into the ledger. */
  accepted: string[]
  /** RecordIds already counted on an earlier pass (safe to discard). */
  duplicate: string[]
  /**
   * RecordIds the owner refused because they predate the user's last ledger
   * reset. Deleting them is what makes a reset stick: without the barrier, a
   * user who clears totals while the harness was offline would watch the old
   * traffic reappear on the next ingest pass.
   */
  preReset: string[]
  /**
   * RecordIds the owner refused for good because the payload cannot be
   * accounted for. Without this bucket a broken record would be retried on
   * every pass forever, since "not mentioned" has to mean "not settled yet".
   * Settled ids are deleted, so a refusal is one warning, not a permanent spam.
   */
  rejected?: string[]
}

export interface LedgerPort {
  readonly apiVersion: number
  recordExternalRequests(records: readonly ExternalRequestRecord[]): Promise<ExternalRequestResult>
}

export const LEDGER_API_VERSION = 1

function isRecord(value: unknown): value is ExternalRequestRecord {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.recordId !== 'string' || v.recordId.length === 0) return false
  const r = v.request
  if (typeof r !== 'object' || r === null) return false
  const req = r as Record<string, unknown>
  // The floor mirrors the core's own accountability check (core/usage/ingest.ts
  // toRequest): non-empty urls, finite non-negative counters, a positive
  // timestamp. A record below this floor would come back `rejected`, and
  // rejected ids are settled, meaning the queue file gets DELETED. Anything
  // we can tell is poison must be quarantined here, not mailed for deletion.
  const counter = (key: string): boolean => typeof req[key] !== 'number' || (Number.isFinite(req[key] as number) && (req[key] as number) >= 0)
  return (
    typeof req.serverUrl === 'string' &&
    req.serverUrl.length > 0 &&
    typeof req.modelId === 'string' &&
    req.modelId.length > 0 &&
    typeof req.timestamp === 'number' &&
    Number.isFinite(req.timestamp) &&
    req.timestamp > 0 &&
    typeof req.promptTokens === 'number' &&
    typeof req.completionTokens === 'number' &&
    counter('promptTokens') &&
    counter('completionTokens') &&
    counter('totalTokens')
  )
}

/** Validate one outbox file's payload before it is handed over. */
export function parseOutboxRecord(raw: unknown): ExternalRequestRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const v = raw as Record<string, unknown>
  const candidate = {
    recordId: typeof v.recordId === 'string' ? v.recordId : '',
    recordedAt: typeof v.recordedAt === 'string' ? v.recordedAt : new Date().toISOString(),
    request: v.lastRequest,
  }
  return isRecord(candidate) ? candidate : undefined
}

/**
 * Accept the main extension's exports and return a usable port, or undefined.
 * Duck-typed on purpose: `activate()` returning a richer object later must not
 * break the bridge, and a wrong shape must degrade to "ledger unavailable"
 * rather than throw inside an ingest timer.
 *
 * The version is enforced, not decorative: the ingest path never inspects it
 * afterwards, so a port advertising any other `apiVersion` is refused here,
 * the outbox keeps its records, and the user-visible warning asks for an
 * update. Handing records to a port with different semantics is how token
 * totals get silently accounted wrong.
 */
export function asLedgerPort(extensionExports: unknown): LedgerPort | undefined {
  if (typeof extensionExports !== 'object' || extensionExports === null) return undefined
  const candidates = [extensionExports, (extensionExports as Record<string, unknown>).dshBridge]
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const api = candidate as Partial<LedgerPort>
    if (typeof api.recordExternalRequests === 'function' && api.apiVersion === LEDGER_API_VERSION) {
      return {
        apiVersion: LEDGER_API_VERSION,
        recordExternalRequests: (records) => api.recordExternalRequests!(records),
      }
    }
  }
  return undefined
}
