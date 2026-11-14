/**
 * Outbox ingestion: move completed harness requests from the adapter's outbox
 * into the main extension's ledger.
 *
 * Durability rule: a record file is deleted only AFTER the ledger owner has
 * acknowledged it. If the bridge dies in between, the same `recordId` is
 * replayed and the owner reports it as a duplicate, so the worst case is a
 * redundant call, never a lost or double-counted request.
 *
 * Nothing here imports `vscode`, so the whole thing is testable in plain node.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { parseOutboxRecord, type ExternalRequestRecord, type LedgerPort } from './api.js'

export interface IngestLog {
  info(message: string): void
  warn(message: string): void
}

export interface IngestOutcome {
  accepted: number
  duplicate: number
  preReset: number
  /** Unparseable or structurally invalid files, moved aside for inspection. */
  malformed: number
  /** Records left in place because the ledger rejected or dropped the batch. */
  deferred: number
  /** Records the owner refused for good; deleted after one warning. */
  rejected: number
}

const BATCH_SIZE = 50

export function emptyOutcome(): IngestOutcome {
  return { accepted: 0, duplicate: 0, preReset: 0, malformed: 0, deferred: 0, rejected: 0 }
}

interface Pending {
  file: string
  record?: ExternalRequestRecord
  problem?: string
}

/** Read candidate files. `.tmp` leftovers from a crashed write are ignored. */
function readPending(outboxDir: string): Pending[] {
  let names: string[]
  try {
    names = readdirSync(outboxDir)
  } catch {
    return [] // no outbox yet = nothing ingested, not an error
  }
  const pending: Pending[] = []
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const file = path.join(outboxDir, name)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      // Vanishing between readdir and read means another pass (or a restart
      // sweep) already took it. Anything else is worth a line in the log.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') pending.push({ file, problem: `read failed: ${(err as Error).message}` })
      continue
    }
    try {
      const record = parseOutboxRecord(JSON.parse(text))
      if (record) pending.push({ file, record })
      else pending.push({ file, problem: 'record is missing recordId or required counters' })
    } catch (err) {
      pending.push({ file, problem: `not valid JSON: ${(err as Error).message}` })
    }
  }
  // Oldest first, so a backlog drains in request order.
  return pending.sort((a, b) => (a.record?.recordedAt ?? '').localeCompare(b.record?.recordedAt ?? ''))
}

/**
 * Park an unreadable record in `quarantineDir` instead of deleting it. A record
 * we cannot parse is evidence about a bug; silently dropping it would also
 * silently drop the user's tokens.
 */
function quarantine(file: string, quarantineDir: string, reason: string, log: IngestLog): void {
  try {
    mkdirSync(quarantineDir, { recursive: true })
    // Quarantine holds evidence, and a rename silently replaces on Windows,
    // so a name collision gets a suffix instead of destroying the older
    // artifact of a previous bug.
    const name = path.basename(file)
    let target = path.join(quarantineDir, name)
    for (let i = 0; existsSync(target); i++) {
      target = path.join(quarantineDir, `${name.replace(/\.json$/, '')}.${Date.now()}-${i}.rejected`)
    }
    renameSync(file, target)
    log.warn(`outbox record quarantined (${reason}): ${path.basename(file)}`)
  } catch (err) {
    // Leave the file alone rather than lose it; it will be retried next pass.
    log.warn(`could not quarantine ${path.basename(file)} (${reason}): ${(err as Error).message}`)
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * One ingestion pass. Returns counters for the status bar and the boot rail.
 * A rejected batch leaves its files in place for the next pass: the ledger may
 * still be activating, and that is a reason to wait, not a reason to discard.
 */
export async function ingestOutbox(
  opts: { outboxDir: string; quarantineDir: string; port: LedgerPort | undefined; log?: IngestLog },
): Promise<IngestOutcome> {
  const log = opts.log ?? { info() {}, warn() {} }
  const outcome = emptyOutcome()
  const pending = readPending(opts.outboxDir)
  if (pending.length === 0) return outcome

  for (const item of pending) {
    if (item.problem) {
      quarantine(item.file, opts.quarantineDir, item.problem, log)
      outcome.malformed++
    }
  }

  const valid = pending.filter((p): p is Pending & { record: ExternalRequestRecord } => p.record !== undefined)
  if (valid.length === 0) return outcome

  if (!opts.port) {
    outcome.deferred = valid.length
    return outcome
  }

  for (const batch of chunk(valid, BATCH_SIZE)) {
    let result
    try {
      result = await opts.port.recordExternalRequests(batch.map((b) => b.record))
    } catch (err) {
      log.warn(`ledger handoff failed, keeping ${batch.length} record(s) for retry: ${(err as Error).message}`)
      outcome.deferred += batch.length
      continue
    }
    // A cross-extension call can return anything. Parsing a nonsense answer
    // must not throw out of the whole pass: unreadable verdict means "nothing
    // settled", keep the records, retry later.
    let settled: Set<string>
    try {
      if (typeof result !== 'object' || result === null) throw new Error('the ledger returned no result object')
      settled = new Set([
        ...(result.accepted ?? []),
        ...(result.duplicate ?? []),
        ...(result.preReset ?? []),
        ...(result.rejected ?? []),
      ])
      outcome.accepted += result.accepted?.length ?? 0
      outcome.duplicate += result.duplicate?.length ?? 0
      outcome.preReset += result.preReset?.length ?? 0
      outcome.rejected += result.rejected?.length ?? 0
    } catch (err) {
      log.warn(`ledger returned an unusable answer, keeping ${batch.length} record(s) for retry: ${(err as Error).message}`)
      outcome.deferred += batch.length
      continue
    }
    if (result.rejected?.length) {
      log.warn(`ledger refused ${result.rejected.length} usage record(s) as unaccountable: ${result.rejected.join(', ')}`)
    }
    for (const item of batch) {
      if (!settled.has(item.record.recordId)) {
        // The owner did not account for this id: keep it, do not guess.
        outcome.deferred++
        continue
      }
      try {
        rmSync(item.file, { force: true })
      } catch (err) {
        log.warn(`record acknowledged but not deleted (will dedup next pass): ${(err as Error).message}`)
      }
    }
  }
  return outcome
}

/**
 * Count in-flight markers for the drain decision. Unreadable marker files
 * count as active: a restart that waits one extra beat is cheap, a restart
 * that truncates a live request is not.
 */
export function countActiveRequests(activeDir: string): number {
  try {
    return readdirSync(activeDir).filter((n) => n.endsWith('.json')).length
  } catch {
    return 0
  }
}

/**
 * Wait for in-flight harness requests to finish, up to `timeoutMs`. Returns
 * whether the queue actually drained; the caller decides whether to restart
 * anyway, and must say so out loud rather than truncating turns in silence.
 */
export async function drainActiveRequests(
  activeDir: string,
  timeoutMs: number,
  opts: { intervalMs?: number; onProgress?(remaining: number): void } = {},
): Promise<{ drained: boolean; remaining: number }> {
  const interval = opts.intervalMs ?? 500
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    const remaining = countActiveRequests(activeDir)
    if (remaining === 0) return { drained: true, remaining: 0 }
    opts.onProgress?.(remaining)
    if (Date.now() >= deadline) return { drained: false, remaining }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}
