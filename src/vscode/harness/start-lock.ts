/**
 * Cross-window serialization for harness startup.
 *
 * On editor start VS Code restores every window, and every window runs its
 * own Start at the same moment. Without a lock they all see an empty pid
 * file, all run prepare (concurrent npm installs into one runtime tree corrupt
 * it), and all spawn: the last pid wins the file and the earlier harnesses
 * become orphans holding their ports. The lock exists so exactly one window
 * prepares and spawns while the others wait and then adopt.
 *
 * A lock is `start.lock` holding the holder's pid. Two steal rules, because
 * one is not enough: the holder's process is gone (instant steal), or the
 * lock is older than `staleMs` (steal a wedged holder). The mtime rule must
 * be generous: a cold prepare legitimately takes minutes (npm install over
 * the network, plugin add, --dump-config), and the holder never refreshes
 * the lock while it works, so the budget must exceed the worst real prepare
 * or a slow mirror gets its healthy holder's lock stolen. No `vscode`
 * import, and every wait is an option.
 */
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isProcessAlive, probeHarness, readPidRecord, type PidRecord } from './supervisor.js'

export interface StartLockHandle {
  release(): void
}

export interface StartLockOptions {
  lockFile: string
  pidFile: string
  holderPid?: number
  log?: { info(message: string): void; warn(message: string): void }
  /** Total patience with a live holder. Default 10 min, then refuse to pile on. */
  waitMs?: number
  /** Poll period while waiting. Default 250 ms. */
  pollMs?: number
  /** A lock with a live holder older than this is presumed wedged. Default 15 min. */
  staleMs?: number
  /**
   * Gate on mid-wait adoption: a pid record answering the probe is only worth
   * adopting when the caller accepts its composition. Pass the bridge's
   * staleness check so the waiting path enforces the same law as the
   * pre-lock path: a harness prepared by an older build is drained and
   * replaced, never borrowed through the side door.
   */
  isAdoptable?: (record: PidRecord) => boolean | Promise<boolean>
}

export type StartLockOutcome =
  | { kind: 'acquired'; lock: StartLockHandle }
  | { kind: 'adopt'; record: PidRecord }
  | { kind: 'busy' }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait for the right to start a harness. Returns 'adopt' when a harness worth
 * taking over appeared while waiting, and 'busy' when a healthy holder never
 * finished in the budget: the caller must say so honestly, not spawn anyway
 * onto a half-prepared tree.
 */
export async function acquireStartLock(opts: StartLockOptions): Promise<StartLockOutcome> {
  const holderPid = opts.holderPid ?? process.pid
  const waitMs = opts.waitMs ?? 600_000
  const pollMs = opts.pollMs ?? 250
  const staleMs = opts.staleMs ?? 900_000
  const deadline = Date.now() + waitMs

  for (;;) {
    let fd: number | undefined
    try {
      // 'wx' is the exclusive create: the race answer comes from the OS.
      fd = openSync(opts.lockFile, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    if (fd !== undefined) {
      try {
        writeFileSync(fd, `${holderPid}\n`)
      } catch {
        /* content is only the fast steal path */
      }
      return {
        kind: 'acquired',
        lock: {
          release(): void {
            try {
              closeSync(fd)
            } catch {
              /* already closed */
            }
            // Ownership guard: a holder slower than staleMs has its lock stolen,
            // and a blind unlink here would then release the STEALER's live lock
            // for a third window, re-enabling the concurrent prepare this whole
            // file exists to prevent. Unlink only while the file still names us.
            try {
              const raw = Number.parseInt(readFileSync(opts.lockFile, 'utf8').trim(), 10)
              if (raw === holderPid) unlinkSync(opts.lockFile)
            } catch {
              /* already gone */
            }
          },
        },
      }
    }

    // Someone else holds it. Dead holder: steal now. Live but ancient: the
    // holder is wedged past even the generous cold-prepare budget, steal too.
    let mtime = 0
    let holderAlive = true
    try {
      mtime = statSync(opts.lockFile).mtimeMs
      const raw = Number.parseInt(readFileSync(opts.lockFile, 'utf8').trim(), 10)
      holderAlive = Number.isInteger(raw) && isProcessAlive(raw)
    } catch {
      continue // the holder released between our failed create and the stat
    }
    if (!holderAlive || Date.now() - mtime > staleMs) {
      try {
        // Claim the unlink atomically: a rename has exactly one winner, while
        // two windows unlinking "the dead lock they saw" can each delete a
        // lock the other just created, and both then 'wx'-create their own -
        // two holders entering prepare over one runtime tree.
        const claimed = `${opts.lockFile}.claimed-${holderPid}`
        renameSync(opts.lockFile, claimed)
        try {
          unlinkSync(claimed)
        } catch {
          /* debris is harmless: the loop only ever creates the real name with 'wx' */
        }
        opts.log?.info(`cleared the start lock of ${holderAlive ? 'a wedged' : 'a dead'} window`)
      } catch {
        /* lost the steal race, retry */
      }
      continue
    }

    // A live holder is doing real work; adopt if its harness announced itself
    // AND the caller accepts the composition (see isAdoptable).
    const record = readPidRecord(opts.pidFile)
    if (record && isProcessAlive(record.pid) && (await probeHarness(record.url)) && (!opts.isAdoptable || (await opts.isAdoptable(record)))) {
      return { kind: 'adopt', record }
    }
    if (Date.now() >= deadline) return { kind: 'busy' }
    await sleep(pollMs)
  }
}
