/**
 * Tripwires for the external usage handoff (the DeepSeek Harness bridge's
 * entry point into the ledger). Named for the breakage each one catches:
 * double-counted money, a dashboard that refuses to stay reset, and a corrupt
 * record being folded into totals as a negative number.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const fold = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock('../src/vscode/state/usageStore.js', () => ({
  recordExternalRequest: (data: unknown) => fold.calls.push(data),
  onUsageDidReset: () => ({ dispose: () => undefined }),
}));

import {
  EXTERNAL_USAGE_API_VERSION,
  initExternalUsage,
  noteUsageReset,
  recordExternalRequests,
  resetExternalUsageStateForTests,
} from '../src/vscode/state/externalUsage.js';
import type { ExternalRequestRecord } from '../src/vscode/state/externalUsage.js';

const NO_STORAGE = { globalStorageUri: undefined } as never;

function record(
  recordId: string,
  overrides: Partial<ExternalRequestRecord['request']> = {},
  recordedAt?: string,
): ExternalRequestRecord {
  const timestamp = overrides.timestamp ?? Date.parse('2026-01-02T00:00:00Z');
  return {
    recordId,
    // Coherent by construction: a real record reports when it finished, which
    // is the same moment its own timestamp carries. Incoherent fixtures here
    // would only test the fixture.
    recordedAt: recordedAt ?? new Date(timestamp).toISOString(),
    request: {
      serverUrl: 'http://127.0.0.1:8123/v1',
      modelId: 'wire-one',
      timestamp,
      promptTokens: 1000,
      completionTokens: 50,
      totalTokens: 1050,
      ...overrides,
    },
  };
}

beforeEach(async () => {
  fold.calls.length = 0;
  resetExternalUsageStateForTests();
  await initExternalUsage(NO_STORAGE);
});

describe('external usage handoff', () => {
  it('publishes the api version the companion expects', () => {
    expect(EXTERNAL_USAGE_API_VERSION).toBe(1);
  });

  it('counts a replayed record once, so a caller may retry safely', async () => {
    const first = await recordExternalRequests([record('r-1')]);
    expect(first.accepted).toEqual(['r-1']);
    const replay = await recordExternalRequests([record('r-1')]);
    expect(replay.duplicate).toEqual(['r-1']);
    expect(replay.accepted).toEqual([]);
    // The whole point: totals move once per completed request, however often
    // the caller's queue is replayed after a crash.
    expect(fold.calls).toHaveLength(1);
  });

  it('keeps a cleared dashboard cleared when older traffic arrives late', async () => {
    noteUsageReset('all');
    const outcome = await recordExternalRequests([record('old')]);
    expect(outcome.preReset).toEqual(['old']);
    expect(fold.calls).toHaveLength(0);

    // Traffic completed after the clear still counts, or the ledger would be
    // permanently deaf rather than merely reset.
    const fresh = record('fresh', { timestamp: Date.now() });
    const after = await recordExternalRequests([fresh]);
    expect(after.accepted).toEqual(['fresh']);
    expect(fold.calls).toHaveLength(1);
  });

  it('honours a per-server barrier without muting other servers', async () => {
    noteUsageReset({ serverUrl: 'http://127.0.0.1:8123/v1' });
    const outcome = await recordExternalRequests([
      record('barred'),
      record('elsewhere', { serverUrl: 'http://127.0.0.1:9999/v1' }),
    ]);
    expect(outcome.preReset).toEqual(['barred']);
    expect(outcome.accepted).toEqual(['elsewhere']);
    expect(fold.calls).toHaveLength(1);
  });

  it('refuses an unaccountable payload instead of corrupting the totals', async () => {
    const outcome = await recordExternalRequests([
      record('negative', { promptTokens: -5 }),
      record('nan', { completionTokens: Number.NaN }),
      record('no-server', { serverUrl: '' }),
      record('sane'),
    ]);
    expect(outcome.rejected.sort()).toEqual(['nan', 'negative', 'no-server']);
    expect(outcome.accepted).toEqual(['sane']);
    expect(fold.calls).toHaveLength(1);
  });

  it('settles every submitted id in exactly one bucket so no queue file loops forever', async () => {
    const batch = [record('a'), record('b'), record('negative', { promptTokens: -1 })];
    const outcome = await recordExternalRequests(batch);
    const settled = [...outcome.accepted, ...outcome.duplicate, ...outcome.preReset, ...outcome.rejected];
    expect(settled.sort()).toEqual(['a', 'b', 'negative']);
    // Duplicate ids inside one batch must not both fold in.
    const foldedBefore = fold.calls.length;
    const sameBatch = await recordExternalRequests([record('a'), record('a')]);
    expect(sameBatch.accepted).toEqual([]);
    expect(sameBatch.duplicate).toEqual(['a', 'a']);
    expect(fold.calls).toHaveLength(foldedBefore);
  });
});
