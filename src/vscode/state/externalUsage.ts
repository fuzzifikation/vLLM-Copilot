/**
 * The published handoff for usage that completed somewhere other than this
 * extension's own provider path, today the DeepSeek Harness bridge.
 *
 * Why the owner does the accounting instead of the caller: this extension owns
 * `usage.json`, its delta merge, its reset semantics and its cost derivation.
 * A second writer would have to reproduce all three and would still lose
 * races. So callers hand over completed requests and the CORE decides what
 * happens to each one (`core/usage/ingest.ts` — idempotence by recordId, the
 * reset barriers, payload accountability); this module is transport glue: the
 * durable seen-id file, application to the live ledger, and the reset
 * subscription that stamps barriers. The split exists so a companion's own
 * tests can wrap the real ingest function instead of mirroring it.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ExtensionContext } from 'vscode';
import { ingestExternalUsage } from '../../core/usage/ingest.js';
import type { ExternalRequestRecord, ExternalRequestOutcome, ExternalUsageState } from '../../core/usage/ingest.js';
import { onUsageDidReset, recordExternalRequest } from './usageStore.js';

export type { ExternalRequestRecord, ExternalRequestOutcome } from '../../core/usage/ingest.js';

/** Version of the handoff, matched against the caller's expectation. */
export const EXTERNAL_USAGE_API_VERSION = 1;

const STORE_FILE = 'external-usage.json';

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
      state.ids = parsed.ids.filter((id): id is string => typeof id === 'string');
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

/**
 * Account for a batch of externally completed requests. The core plans the
 * fate of every record (dedupe, barriers, accountability — see
 * `core/usage/ingest.ts`); this applies the accepted payloads to the live
 * ledger and persists the settled ids. Every id the caller sent appears in
 * exactly one outcome bucket, so the caller can settle its queue with no
 * guessing: accepted and duplicate and preReset and rejected all mean
 * "delete it", an absent id means "keep it and try again".
 */
export async function recordExternalRequests(
  records: readonly ExternalRequestRecord[],
): Promise<ExternalRequestOutcome> {
  const ingestState: ExternalUsageState = { seenIds: state.ids, barriers: state.barriers };
  // The core logs refusals through RequestLog; routing appendLine to warn
  // keeps the [WARN] prefix the output channel has always shown for them.
  const plan = ingestExternalUsage(records, ingestState, { appendLine: (line) => log.warn(line) });
  for (const request of plan.requests) recordExternalRequest(request);
  state.ids = plan.nextSeenIds;
  if (plan.outcome.accepted.length || plan.outcome.preReset.length) persist();
  return plan.outcome;
}

/** Stamp the barrier for a reset the user just performed. */
export function noteUsageReset(scope: 'all' | { serverUrl: string }): void {
  const key = scope === 'all' ? 'all' : scope.serverUrl;
  state.barriers[key] = Date.now();
  persist();
}

/**
 * Await every queued seen-id write. `deactivate()` calls this: a settled id
 * that never reached the file is a forgotten id, and a forgotten id accepts
 * the record again on the next replay — double-counted money, the one
 * failure mode this module exists to prevent. Awaiting an already-drained
 * chain is free.
 */
export async function flushExternalUsageWrites(): Promise<void> {
  await writeChain;
}

/** Subscribe the barrier to the store's own reset event. Returns a disposable. */
export function watchUsageResets(): { dispose(): void } {
  return onUsageDidReset(noteUsageReset);
}

/** Test seam: forget everything in memory (does not touch the file). */
export function resetExternalUsageStateForTests(): void {
  state = { version: 1, ids: [], barriers: {} };
}
