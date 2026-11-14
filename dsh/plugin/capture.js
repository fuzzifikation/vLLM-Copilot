/**
 * Harness-side system-prompt recording: the consent gate and the recording
 * target, plus the module-shared write queue.
 *
 * Consent is the on-disk marker beside the snapshot, re-read at EVERY capture
 * boundary and again inside the queue at task start and before the atomic
 * rename (core CaptureQueue `gate`). Only the exact content `on` records:
 * absent, `off`, malformed and unreadable all fail closed, and no prompt text
 * is ever logged - flag state and counts only.
 *
 * The recording target is NOT derived from anything this process guesses: it
 * is the snapshot's `captureFile` field, an absolute path the extension
 * window named - `<workspace>/.vllm/dsh-system-messages.json`, deliberately
 * distinct from Copilot's own `system-messages.json` in the same folder. It
 * is re-read at every capture and again at every commit gate, so a workspace
 * switch or a rebinding prepare takes effect with the next request - no
 * restart and no environment editing. No `captureFile` (no folder open when
 * the snapshot was prepared, or a malformed value) means NO recording and
 * one honest log line - never a fallback into the harness home, /tmp or a
 * pid-named file.
 *
 * Cross-process honesty: one queue serializes this process; a second dsh
 * process (another editor product) pointed at the SAME workspace file is an
 * independent writer, so every write takes an exclusive lock file beside the
 * target (core CaptureQueue `lockFile`): contention waits, and a lock that
 * cannot be taken means the capture is SKIPPED with a named warning - never
 * forced over another writer's records, never stolen from a crashed one
 * (the warning says to delete the stale file by hand).
 *
 * No static 'vllm-copilot-core' import: the core arrives through index.js's
 * dynamic import, whose polite "refusing to register" path must not be turned
 * into an anonymous module-load crash.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const CAPTURE_FLAG_FILENAME = 'capture.flag'

/** The consent marker lives in harness storage beside the snapshot. */
export function flagFileFrom(snapshotFile) {
  return path.join(path.dirname(snapshotFile), CAPTURE_FLAG_FILENAME)
}

/** The exclusive write lock for a recording target: a dotted sibling in the
 *  user's .vllm folder. Named by the target, so two workspaces never share
 *  one lock and every writer aiming at one file agrees on the same gate. */
export function lockFileFor(target) {
  return path.join(path.dirname(target), `.${path.basename(target)}.lock`)
}

/**
 * The workspace recording target named by the CURRENT snapshot bytes, or
 * undefined. Deliberately lenient to read and strict to accept: a snapshot
 * this cannot open, or that names nothing absolute, is a no-destination
 * verdict (fail closed), never an error that could touch the request path.
 */
export function readCaptureTarget(snapshotFile) {
  let data
  try {
    data = JSON.parse(readFileSync(snapshotFile, 'utf8'))
  } catch {
    return undefined
  }
  const candidate = data?.captureFile
  if (typeof candidate !== 'string') return undefined
  const trimmed = candidate.trim()
  return trimmed && path.isAbsolute(trimmed) ? trimmed : undefined
}

/**
 * The write queue for THIS plugin module instance. Module-level on purpose:
 * every recorder built by this loaded module shares one serializer, so even
 * adapter reloads that rebuild the recorder do not get a private queue.
 * Cross-PROCESS writers do not share it - the per-target lock file does that
 * job (queue sharing is an optimization; the lock is the guarantee).
 */
let sharedQueue

/**
 * Build the capture function the adapter calls per request. `core` supplies
 * CaptureQueue and readCaptureConsent; `log` receives state and counts,
 * never prompt bytes.
 */
export function createRecorder({ core, flagFile, snapshotFile, log }) {
  if (typeof core.readCaptureConsent !== 'function' || typeof core.CaptureQueue !== 'function') {
    // A staged core older than the recording contract: say so loudly at boot
    // and record nothing, rather than half-recording with hand-rolled I/O.
    log.appendLine('system prompt capture unavailable: the staged vLLM-Copilot core lacks the capture contract')
    return async () => {}
  }
  let lastNotice = ''
  return async function captureSystemMessages(entries) {
    if (!entries || entries.length === 0) return
    sharedQueue ??= new core.CaptureQueue()
    const flag = core.readCaptureConsent(flagFile)
    if (!flag.enabled) {
      // absent/off are ordinary silences; a malformed or unreadable marker is
      // a real problem the user should hear about once, not per request.
      if ((flag.reason === 'malformed' || flag.reason === 'unreadable') && lastNotice !== flag.reason) {
        lastNotice = flag.reason
        log.appendLine(`system prompt capture not recording: consent marker ${flag.reason} (${flagFile}) - only the exact text "on" records`)
      }
      return
    }
    const target = readCaptureTarget(snapshotFile)
    if (!target) {
      // Consent says record, the snapshot says nowhere. That contradiction
      // gets said once, loudly enough to act on - and nothing is written to
      // any other location to keep the ON looking honest.
      if (lastNotice !== 'no-target') {
        lastNotice = 'no-target'
        log.appendLine('system prompt recording is ON but no workspace recording file is set (no folder open in the window that prepared the harness): open a workspace folder and run DeepSeek Harness: Restart (a plain Start adopts this survivor and rebinds nothing) - nothing is recorded to any other location')
      }
      return
    }
    lastNotice = ''
    // The gate re-runs at task start, on every lock-contention poll and
    // again before the rename: consent OFF drops the write, and a target
    // that got rebound (another window prepared the shared harness onto ITS
    // workspace) drops it too - window B's prompts never sneak into window
    // A's file after the snapshot moved on.
    await sharedQueue.enqueueWrite(target, entries, log, {
      gate: () => core.readCaptureConsent(flagFile).enabled && readCaptureTarget(snapshotFile) === target,
      mode: 0o600,
      lockFile: lockFileFor(target),
    })
  }
}