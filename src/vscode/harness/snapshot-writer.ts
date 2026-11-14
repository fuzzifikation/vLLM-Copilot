/**
 * Writing the snapshot the plugin reads.
 *
 * The staged plugin is the contract, so nothing is written until the staged
 * `parseSnapshot` has accepted the exact bytes the harness will load. That
 * turns a writer/loader disagreement from "the harness silently drives the
 * wrong config" into "the bridge refuses to restart and says why".
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { snapshotFingerprint, type SnapshotPayload } from './snapshot.js'
import type { PluginSnapshotModule } from './shared-modules.js'

export interface SnapshotWriteResult {
  written: boolean
  version: number
  /** Warnings produced while building, for the status bar and the log. */
  warnings: string[]
}

/**
 * Compose, validate, and atomically replace `snapshot.json`. Returns
 * `written: false` when the content is unchanged, because rewriting a file the
 * harness just read would trigger a restart for no reason.
 */
export function writeSnapshot(opts: {
  snapshotFile: string
  payload: SnapshotPayload
  plugin: PluginSnapshotModule
}): SnapshotWriteResult {
  const document = { version: opts.plugin.SNAPSHOT_VERSION, ...opts.payload }
  const text = `${JSON.stringify(document, null, 2)}\n`
  // Throws on any contract violation; the caller surfaces it instead of
  // handing the harness a snapshot it would reject mid-session.
  opts.plugin.parseSnapshot(text, 'bridge snapshot')

  const fingerprint = snapshotFingerprint(document)
  let current: string | undefined
  try {
    current = readFileSync(opts.snapshotFile, 'utf8')
  } catch {
    current = undefined
  }
  if (current !== undefined) {
    // A corrupt existing snapshot is exactly the situation the atomic write
    // repairs, so a parse failure here must not kill prepare: an
    // unparseable file simply counts as "changed" and gets replaced.
    let unchanged = false
    try {
      unchanged = snapshotFingerprint(JSON.parse(current)) === fingerprint
    } catch {
      unchanged = false
    }
    if (unchanged) return { written: false, version: document.version, warnings: opts.payload.warnings }
  }

  mkdirSync(path.dirname(opts.snapshotFile), { recursive: true })
  // tmp + rename, same discipline as the ledger file: a reader sees either the
  // old snapshot or the new one, never half of both. The snapshot carries your
  // server request headers, so on POSIX it is written owner-only (Windows
  // inherits the storage directory's ACL).
  writeFileSync(`${opts.snapshotFile}.tmp`, text, { mode: 0o600 })
  renameSync(`${opts.snapshotFile}.tmp`, opts.snapshotFile)
  return { written: true, version: document.version, warnings: opts.payload.warnings }
}
