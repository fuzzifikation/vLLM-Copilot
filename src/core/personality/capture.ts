/**
 * System-message capture (host-neutral core half): the entry vocabulary and
 * the serialized, merging, atomic write queue for `system-messages.json`.
 *
 * The consumer (the Copilot pipeline) decides WHICH texts to capture, resolves
 * the target path from its own workspace, and owns the log sink; this module
 * just persists correctly. The write queue is instance-owned (not
 * module-global) so concurrent writes from one queue are serialized and
 * different consumers never share mutable module state. It serializes writes
 * within ONE queue only — it does not coordinate two queues writing the same
 * file (production creates a single pipeline, so that never occurs today).
 */
import * as fs from 'fs/promises';
import * as path from 'path';
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

export class CaptureQueue {
  /** Promise chain that serializes concurrent writes to the capture file. Always resolves. */
  #writeQueue: Promise<void> = Promise.resolve();

  /**
   * Read existing capture file, merge new entries, write back.
   * Serialized via the promise queue so concurrent writes never race.
   */
  async enqueueWrite(
    targetPath: string,
    newEntries: CaptureEntry[],
    log: RequestLog
  ): Promise<void> {
    // Chain this write after the previous one, then await it so the caller (and
    // tests) observe completion. The queue always resolves — errors are logged.
    const previous = this.#writeQueue;
    this.#writeQueue = previous.then(async () => {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });

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
          log.appendLine(`[WARN] Failed to read ${targetPath}, starting fresh: ${err instanceof Error ? err.message : String(err)}`);
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

      // Write atomically: write to a temp file, then rename over the target so a
      // crash or disk failure mid-write can't leave truncated JSON in place. The
      // previous file survives until the rename completes.
      const tmpPath = `${targetPath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(allEntries, null, 2), 'utf-8');
      await fs.rename(tmpPath, targetPath);
      log.appendLine(`[DIAG] Captured ${newCount} new, updated ${updatedCount} existing system message(s) → ${targetPath}`);
    }).catch(err => {
      // Swallow errors so the queue always resolves — a write failure shouldn't block future writes
      log.appendLine(`[WARN] Failed to write capture file: ${err instanceof Error ? err.message : String(err)}`);
    });
    await this.#writeQueue;
  }
}
