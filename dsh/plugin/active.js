import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * In-flight request markers. Before a turn hits the network the adapter drops a
 * marker file; on completion (success, error, or abort) it removes it. The
 * bridge's restart policy waits for this directory to empty (up to a grace
 * budget) so editing the registry mid-turn never truncates an in-flight
 * request. One file per active stream, named by a process-unique id so two
 * harnesses sharing a DSH_HOME do not collide.
 *
 * Best-effort by design: if the marker cannot be written the request still
 * proceeds (the drain check then just sees fewer active turns, never more), so
 * a read-only or racing filesystem can never wedge the harness.
 */
export function activeTracker(dir, log = { appendLine() {} }) {
  return {
    begin(info) {
      // A uuid, not a timestamp: a pid can be recycled into a second harness
      // sharing this DSH_HOME, and "same millisecond after pid reuse" is a
      // collision two markers can actually hit. The uuid cannot.
      const id = `${Date.now()}-${process.pid}-${randomUUID()}`
      const target = path.join(dir, `${id}.json`)
      try {
        mkdirSync(dir, { recursive: true })
        // tmp + rename keeps a partial file from being read as an active turn.
        writeFileSync(`${target}.tmp`, JSON.stringify({ id, startedAt: new Date().toISOString(), ...info }))
        renameSync(`${target}.tmp`, target)
      } catch (err) {
        log.appendLine(`active marker begin failed (drain may under-count): ${err.message}`)
      }
      return () => {
        try {
          rmSync(target, { force: true })
        } catch (err) {
          log.appendLine(`active marker clear failed (a stale marker may delay one restart): ${err.message}`)
        }
      }
    },
  }
}
