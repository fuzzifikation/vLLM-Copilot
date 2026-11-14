/**
 * System-message capture (host-neutral core half): the entry vocabulary and
 * the serialized, merging, atomic write queue for `system-messages.json`.
 *
 * The consumer (the Copilot pipeline) decides WHICH texts to capture, resolves
 * the target path from its own workspace, and owns the log sink; this module
 * just persists correctly. The write queue is instance-owned (not
 * module-global) so concurrent writes from one queue are serialized and
 * different consumers never share mutable module state. It serializes writes
 * within ONE queue; writers from INDEPENDENT queues or processes against one
 * fixed shared target serialize on the optional lockFile (an atomic
 * exclusive-create lock - see {@link acquireCaptureLock}). There is no
 * optimistic replay: two readers that both merge stale bytes and both rename
 * do NOT converge, they clobber, and no post-hoc read can tell a real CAS
 * from a race wearing a lab coat.
 */
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { RequestLog } from '../shared/trace.js';

/**
 * Capture entry for a single system message, written to system-messages.json.
 */
export interface CaptureEntry {
  receivedContent: string;
  deliveredContent: string;
  rulesApplied: string[];
}

/**
 * Shape guard for entries read back from the capture file. The file is
 * user-editable and written by earlier versions, so members must be validated
 * before any `.receivedContent` access — a malformed member (null, {}, partial)
 * would otherwise throw in the merge or silently persist.
 */
export function isCaptureEntry(e: unknown): e is CaptureEntry {
  if (typeof e !== 'object' || e === null) return false;
  const entry = e as Record<string, unknown>;
  return (
    typeof entry.receivedContent === 'string' &&
    typeof entry.deliveredContent === 'string' &&
    Array.isArray(entry.rulesApplied) &&
    entry.rulesApplied.every(r => typeof r === 'string')
  );
}

/**
 * Persistence boundary for captured system messages. {@link CaptureQueue}
 * collects nothing — each call hands it entries and an explicit target path.
 */
export type CaptureWriter = (entries: CaptureEntry[]) => Promise<void>;

/** Options for {@link CaptureQueue.enqueueWrite}. Both are re-checked by the
 *  queue itself (not by the caller) so a consent flip that lands while a write
 *  is QUEUED still takes effect before any bytes are touched. */
export interface CaptureWriteOptions {
  /**
   * Re-checked at task start AND immediately before the atomic rename. False
   * at either check abandons the write (and unlinks any temp file already
   * written). A write that renamed BEFORE the flip already committed and is
   * not undone — atomic writes do not take consent letters. Omitted (the
   * Copilot pipeline) means always-write, the historical behavior.
   */
  gate?: () => boolean;
  /** File mode for the capture file and its temp, e.g. 0o600 for raw prompt
   *  text. Passed straight to fs.writeFile; ignored on platforms without
   *  POSIX modes. Omitted keeps the process default (Copilot unchanged). */
  mode?: number;
  /** Independent-writer safety for one fixed shared target: the harness's
   *  workspace recording may be written by several dsh processes (separate
   *  editor products), and two queues cannot serialize across a process
   *  boundary. When set, the whole read-merge-commit runs ONLY while this
   *  operation holds an exclusive lock file created atomically (`wx`) at
   *  this path: contention waits (the gate is re-checked while waiting),
   *  an unavailable or timed-out lock SKIPS the write with a named warning,
   *  and the lock is released in a finally. It is never stolen - a crashed
   *  writer leaves it behind and the warning says to delete it manually,
   *  because speculative lease theft deletes LIVE locks. Omitted (the
   *  Copilot pipeline): the historical single attempt, no lock, unchanged. */
  lockFile?: string;
  /** How long {@code lockFile} contention may wait before the write is
   *  skipped (default 4000ms; the gate is re-checked every poll). */
  lockWaitMs?: number;
}

/** Poll spacing while waiting for a capture lock. Coarse on purpose: this
 *  path is background recording, not a hot loop. */
const CAPTURE_LOCK_POLL_MS = 25;
/** Default contention budget before a locked capture is skipped. */
const CAPTURE_LOCK_WAIT_MS = 4000;

/** File name of the live capture-consent marker inside the harness home. */
export const CAPTURE_FLAG_FILENAME = 'capture.flag';
/** Legacy file-name prefix of the per-process harness recordings
 *  (`system-messages-<pid>.json`) that lived in the harness home. The harness
 *  now records into the workspace as `dsh-system-messages.json`; the prefix
 *  remains for reading old homes and for {@link captureRecordingFile}. */
export const CAPTURE_FILE_PREFIX = 'system-messages-';

/** Verdict of {@link readCaptureConsent}. `enabled` is true ONLY for the exact
 *  file content `on` — absent, `off`, garbage and unreadable all fail closed. */
export interface CaptureConsent {
  enabled: boolean;
  reason: 'on' | 'off' | 'absent' | 'unreadable' | 'malformed';
}

/** Read the capture-consent marker. Never throws; every non-`on` answer is off.
 *  The comparison is BYTE-EXACT, no trim, no case fold: our writers emit bare
 *  `on`/`off`, so `on\n` or `ON` is not a polite variant but a malformed
 *  marker — a file someone else touched must fail closed, not fail agreeable. */
export function readCaptureConsent(flagFile: string): CaptureConsent {
  let raw: string;
  try {
    raw = fsSync.readFileSync(flagFile, 'utf-8');
  } catch (err) {
    return { enabled: false, reason: err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  if (raw === 'on') return { enabled: true, reason: 'on' };
  if (raw === 'off') return { enabled: false, reason: 'off' };
  return { enabled: false, reason: 'malformed' };
}

/** Write the capture-consent marker atomically (`on`/`off`, mode 0600). Throws
 *  on failure — callers own the reporting; a half-written marker must read as
 *  malformed (off), never as a silent success. The temp name is unique per
 *  writer (pid + random): concurrent windows toggling the same marker must
 *  never rename over each other's half-written temp, and a failed write only
 *  ever removes ITS OWN temp. */
export function writeCaptureConsent(flagFile: string, enabled: boolean): void {
  const tmpPath = `${flagFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fsSync.writeFileSync(tmpPath, enabled ? 'on' : 'off', { encoding: 'utf-8', mode: 0o600 });
    fsSync.renameSync(tmpPath, flagFile);
  } catch (err) {
    try {
      fsSync.rmSync(tmpPath, { force: true });
    } catch (cleanupErr) {
      // An abandoned temp must not be a footnote either: report BOTH the
      // original write failure and the failed cleanup, original first.
      throw new AggregateError(
        [err, cleanupErr],
        `capture-consent marker write failed (${err instanceof Error ? err.message : String(err)}) and its temp ${tmpPath} could not be removed (${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)})`,
      );
    }
    throw err;
  }
}

/** Remove a temp file this operation created; a removal failure OTHER than
 *  "already gone" means abandoned capture bytes sit on disk, and the user
 *  believes recording is off - that is said out loud, never swallowed. */
async function unlinkOrWarn(tmpPath: string, log: RequestLog): Promise<void> {
  try {
    await fs.unlink(tmpPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.appendLine(`[WARN] Could not remove temporary capture file ${tmpPath} - it may hold captured prompt text: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Path of the per-process capture recording for `pid` inside `dir`. */
export function captureRecordingFile(dir: string, pid: number): string {
  return path.join(dir, `${CAPTURE_FILE_PREFIX}${pid}.json`);
}

export class CaptureQueue {
  /** Promise chain that serializes concurrent writes to the capture file. Always resolves. */
  #writeQueue: Promise<void> = Promise.resolve();

  /**
   * Read existing capture file, merge new entries, write back.
   * Serialized via the promise queue so concurrent writes never race; with
   * options.lockFile the same read-merge-commit additionally runs only while
   * the process(es) hold the on-disk exclusive lock, so INDEPENDENT queues
   * (separate dsh processes sharing one workspace file) serialize too.
   */
  async enqueueWrite(
    targetPath: string,
    newEntries: CaptureEntry[],
    log: RequestLog,
    options?: CaptureWriteOptions
  ): Promise<void> {
    // Chain this write after the previous one, then await it so the caller (and
    // tests) observe completion. The queue always resolves - errors are logged.
    const previous = this.#writeQueue;
    this.#writeQueue = previous.then(async () => {
      // Consent first: a flip to off while this write sat queued must not
      // touch the disk at all (the gate is re-checked before the rename).
      if (options?.gate && !options.gate()) {
        log.appendLine(`[DIAG] Capture write skipped (consent off): ${newEntries.length} entry(ies) dropped`);
        return;
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      let locked = false;
      if (options?.lockFile) {
        locked = await acquireCaptureLock(options.lockFile, options, log, newEntries.length);
        if (!locked) return; // contended/timed out/broken - SKIPPED, never forced
      }
      try {
        await this.#mergeAndCommit(targetPath, newEntries, log, options);
      } finally {
        if (locked) await releaseCaptureLock(options!.lockFile!, log);
      }
    }).catch(err => {
      // Swallow errors so the queue always resolves - a write failure shouldn't block future writes
      log.appendLine(`[WARN] Failed to write capture file: ${err instanceof Error ? err.message : String(err)}`);
    });
    await this.#writeQueue;
  }

  /**
   * One read-merge-atomic-commit attempt. With lockFile the caller holds the
   * exclusive lock across the ENTIRE window, so no independent writer can
   * commit between this read and the rename - the merge sees their latest
   * bytes or they wait for ours, which is the only honest serialization a
   * filesystem offers without pretending to be a database. Without a lock
   * (Copilot) this is the historical single attempt, unchanged: one read,
   * merge, unique temp, final consent gate, rename. A write that renamed
   * BEFORE a consent flip already committed and is not undone.
   */
  async #mergeAndCommit(
    targetPath: string,
    newEntries: CaptureEntry[],
    log: RequestLog,
    options: CaptureWriteOptions | undefined
  ): Promise<void> {
    // Read existing entries
    let allEntries: CaptureEntry[] = [];
    try {
      const existing = await fs.readFile(targetPath, 'utf-8');
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed)) {
        // The file is user-editable and best-effort, so a valid JSON array may
        // still contain malformed members (null, {}, partial objects). Accessing
        // .receivedContent on those would throw (wedging every future write) or
        // silently persist an invalid entry, so shape-validate before merging.
        const valid = parsed.filter(isCaptureEntry);
        if (valid.length !== parsed.length) {
          log.appendLine(
            `[WARN] ${targetPath} had ${parsed.length - valid.length} malformed capture entr(y/ies), dropped`
          );
        }
        allEntries = valid;
      } else {
        log.appendLine(`[WARN] ${targetPath} is not a JSON array, starting fresh`);
      }
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && (err as any).code === 'ENOENT')) {
        const cls = err instanceof Error && err.name === 'SyntaxError' ? "corrupt JSON" : ((err as NodeJS.ErrnoException)?.code ?? 'unreadable');
        log.appendLine(`[WARN] Failed to read ${targetPath} (${cls}), starting fresh`);
      }
    }

    // Merge: new entries overwrite existing ones with the same receivedContent.
    const existingIndex = new Map<string, number>();
    allEntries.forEach((e, i) => existingIndex.set(e.receivedContent, i));

    let newCount = 0;
    let updatedCount = 0;
    for (const entry of newEntries) {
      const idx = existingIndex.get(entry.receivedContent);
      if (idx !== undefined) {
        allEntries[idx] = entry;
        updatedCount++;
      } else {
        allEntries.push(entry);
        // Index the appended entry too: without this, two identical texts
        // WITHIN one batch both miss the index and both persist. The
        // Copilot pipeline pre-dedupes its batch, but the core invariant
        // is "one entry per receivedContent" and the core enforces it.
        existingIndex.set(entry.receivedContent, allEntries.length - 1);
        newCount++;
      }
    }

    // Write atomically: a UNIQUELY named temp (pid + random, like the consent
    // marker) renamed over the target. A crash mid-write can never leave
    // truncated JSON, and two independent processes can never stage onto one
    // shared `.tmp` name and rename each other's half-written bytes.
    const tmpPath = `${targetPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const writeMode = options?.mode !== undefined ? { mode: options.mode } : {};
    try {
      await fs.writeFile(tmpPath, JSON.stringify(allEntries, null, 2), { encoding: 'utf-8', ...writeMode });
      // Last gate before the rename: the read+merge awaited I/O, and consent may
      // have flipped while it ran. Abandon - and clean the temp - rather than
      // persist a capture whose consent died during the RMW.
      if (options?.gate && !options.gate()) {
        await unlinkOrWarn(tmpPath, log);
        log.appendLine(`[DIAG] Capture write abandoned before commit (consent off): ${newEntries.length} entry(ies) dropped`);
        return;
      }
      await fs.rename(tmpPath, targetPath);
    } catch (err) {
      // The temp can hold raw prompt text; never leave it behind silently on
      // the way out - a failed cleanup is logged by unlinkOrWarn.
      await unlinkOrWarn(tmpPath, log);
      throw err;
    }
    log.appendLine(`[DIAG] Captured ${newCount} new, updated ${updatedCount} existing system message(s) → ${targetPath}`);
  }
}

/**
 * Take the exclusive capture lock by ATOMICALLY creating `lockFile` (`wx`:
 * exactly one contender wins, the OS decides, nobody asks twice). The content
 * is a pid + timestamp for humans diagnosing a stuck lock - it authorizes
 * nothing. Contention polls (CAPTURE_LOCK_POLL_MS) up to lockWaitMs,
 * re-checking the caller gate on every lap so consent OFF mid-wait drops the
 * write instead of queueing behind a stranger. Every give-up path names the
 * lock path and the count, never prompt text. A lock that exists is ALWAYS
 * treated as a live writer: there is no safe way from here to prove its owner
 * dead (pid reuse makes "it is my pid" a coincidence, not a certificate), so
 * a crashed harness leaves its lock behind and the warning tells the user to
 * delete it - better blocked recording than stolen locks and rewritten
 * records. Any unexpected lock I/O failure fails closed the same way.
 * Returns true only when THIS call owns the lock.
 */
async function acquireCaptureLock(
  lockFile: string,
  options: CaptureWriteOptions,
  log: RequestLog,
  entryCount: number
): Promise<boolean> {
  const deadline = Date.now() + (options.lockWaitMs ?? CAPTURE_LOCK_WAIT_MS);
  let waited = false;
  for (;;) {
    if (options.gate && !options.gate()) {
      log.appendLine(`[DIAG] Capture write skipped (consent off while waiting for the capture lock): ${entryCount} entry(ies) dropped`);
      return false;
    }
    try {
      await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') {
        log.appendLine(`[WARN] Capture skipped: the capture lock ${lockFile} could not be created (${code ?? 'error'}) - nothing was written elsewhere (recording stays exact: only the locked path writes)`);
        return false;
      }
      if (Date.now() + CAPTURE_LOCK_POLL_MS > deadline) {
        log.appendLine(`[WARN] Capture skipped: another recorder holds the capture lock ${lockFile}. If NO harness is running, delete that file to resume recording - queued captures are skipped while it is held, never forced over it: ${entryCount} entry(ies) not recorded`);
        return false;
      }
      if (!waited) {
        waited = true;
        log.appendLine(`[DIAG] Capture waiting on the capture lock ${lockFile}`);
      }
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_LOCK_POLL_MS));
    }
  }
}

/** Give the lock back. A lock file we cannot remove is a stuck recording
 *  switch for EVERY writer, so the failure is said out loud with the exact
 *  path to delete - the file holds only a pid and a timestamp, but hiding a
 *  wedged lock to keep the log pretty is how silent outages are born. */
async function releaseCaptureLock(lockFile: string, log: RequestLog): Promise<void> {
  try {
    await fs.unlink(lockFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.appendLine(`[WARN] Could not remove the capture lock ${lockFile} - recording stays blocked for all writers until it is deleted: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
