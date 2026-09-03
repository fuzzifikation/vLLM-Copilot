import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  initUsageStore, recordRequest, getLastRequest, getServerUsage, getServerCost, hasServerUsage,
  getServersWithUsage, resetUsage, computeCost, findModelCost, getModelStartedAt,
  formatCost, formatCostFine, formatCostSummary, fmtCount, resetUsageStoreForTests, onUsageStoreDidChange,
  type LastRequestData,
} from '../src/usageStore.js';
import type { ModelConfig } from '../src/config.js';

/** Mirrors usageStore's private day-bucket key (kept un-exported on purpose). */
function todayKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Usage-store tests: the combined last-request + cumulative token/cost store.
 * Pure accumulator math (record/sum/reset), persistence round-trip via a fake
 * Memento, retention pruning, and cost derivation from per-model rates.
 */

const url = 'http://s:8000';

function req(over: Partial<LastRequestData> = {}): LastRequestData {
  return {
    serverUrl: url, modelId: 'm1', timestamp: Date.now(),
    promptTokens: 100, completionTokens: 50, totalTokens: 150,
    cachedTokens: 10, reasoningTokens: 5,
    hasMetrics: false, hasCacheDetails: true, maxModelLen: 1000, maxOutputTokens: 100,
    firstTokenTimeMs: 5, totalTimeMs: 500, ...over,
  };
}

/** In-memory Memento with optional seed + observable stored value + write counter. */
function makeMemento(initial?: unknown) {
  let stored: unknown = initial;
  let writes = 0;
  return {
    memento: {
      get: (_k: string, d?: unknown) => (stored !== undefined ? stored : d),
      update: async (_k: string, v: unknown) => { stored = v; writes++; },
    } as unknown as vscode.Memento,
    // Test helper — test assertions treat the persisted blob as an untyped record.
    get stored(): any { return stored; },
    get writes() { return writes; },
  };
}

const output = { appendLine: vi.fn() } as any;

/** Wait until the serialized globalState write queue has flushed `n` writes. */
const flushWrites = (m: ReturnType<typeof makeMemento>, n: number) =>
  vi.waitFor(() => expect(m.writes).toBeGreaterThanOrEqual(n));

describe('recordRequest — last request + accumulation', () => {
  beforeEach(() => resetUsageStoreForTests());
  afterEach(() => resetUsageStoreForTests());

  it('ignores non-finite and absent actual cost (vLLM/local records nothing)', () => {
    recordRequest(req({ actualCost: undefined }));
    recordRequest(req({ actualCost: Number.NaN }));
    expect(getServerCost(url).allTime).toEqual({});
  });

  it('ignores a negative actual cost (invalid server data must not subtract)', () => {
    recordRequest(req({ actualCost: -0.5 }));
    recordRequest(req({ promptTokens: 5, actualCost: -1 }));
    expect(getServerCost(url).allTime).toEqual({});
    expect(getServerCost(url).today).toEqual({});
  });

describe('persistence (globalState)', () => {
  beforeEach(() => resetUsageStoreForTests());
  afterEach(() => resetUsageStoreForTests());

  it('persists and reloads the cumulative totals across activations', async () => {
    const m = makeMemento();
    initUsageStore({ globalState: m.memento, subscriptions: [] } as any, output);
    recordRequest(req({ promptTokens: 100, completionTokens: 50, cachedTokens: 10 }));
    await flushWrites(m, 1);

    expect(m.stored.version).toBe(3);
    expect(m.stored.allTime[url]['m1']).toEqual({ prompt: 100, completion: 50, cached: 10, reasoning: 5 });
    expect(m.stored.days[todayKey()][url]['m1'].prompt).toBe(100);
    expect(typeof m.stored.startedAt[url]['m1']).toBe('number'); // first-record stamp persisted

    // Simulate a window reload: fresh module state, same memento.
    resetUsageStoreForTests();
    initUsageStore({ globalState: m.memento, subscriptions: [] } as any, output);
    const usage = getServerUsage(url);
    expect(usage.allTime['m1'].prompt).toBe(100);
    expect(getModelStartedAt(url, 'm1')).toBe(m.stored.startedAt[url]['m1']);
  });

  it('migrates version-1 data in place (startedAt defaults to {})', async () => {
    const v1 = {
      version: 1 as const,
      allTime: { [url]: { m1: { prompt: 100, completion: 50, cached: 10, reasoning: 5 } } },
      days: {},
    };
    const m = makeMemento(v1);
    initUsageStore({ globalState: m.memento, subscriptions: [] } as any, output);

    expect(getServerUsage(url).allTime['m1'].prompt).toBe(100); // counts preserved
    expect(getModelStartedAt(url, 'm1')).toBeUndefined();       // no stamp for legacy data

    // a new record persists as version 3 with a stamp
    recordRequest(req({ promptTokens: 7 }));
    await flushWrites(m, 1);
    expect(m.stored.version).toBe(3);
    expect(m.stored.startedAt[url]['m1']).toBeTypeOf('number');
  });

  it('migrates version-2 data in place (cost planes default to {})', async () => {
    const v2 = {
      version: 2 as const,
      allTime: { [url]: { m1: { prompt: 100, completion: 50, cached: 10, reasoning: 5 } } },
      days: {},
      startedAt: { [url]: { m1: 12345 } },
    };
    const m = makeMemento(v2);
    initUsageStore({ globalState: m.memento, subscriptions: [] } as any, output);

    // counts + stamps preserved; no actual cost invented for legacy records
    expect(getServerUsage(url).allTime['m1'].prompt).toBe(100);
    expect(getModelStartedAt(url, 'm1')).toBe(12345);
    expect(getServerCost(url).allTime).toEqual({});

    // a new record with actual cost persists as version 3 alongside the legacy counts
    recordRequest(req({ promptTokens: 7, actualCost: 0.0012 }));
    await flushWrites(m, 1);
    expect(m.stored.version).toBe(3);
    expect(m.stored.allTime[url]['m1'].prompt).toBe(107); // legacy counts accumulated into
    expect(m.stored.allTimeCost[url]['m1']).toBeCloseTo(0.0012, 10);
  });

  it('round-trips version-3 data (cost planes reload intact)', async () => {
    const v3 = {
      version: 3 as const,
      allTime: { [url]: { m1: { prompt: 100, completion: 50, cached: 10, reasoning: 5 } } },
      days: { [todayKey()]: { [url]: { m1: { prompt: 100, completion: 50, cached: 10, reasoning: 5 } } } },
      startedAt: { [url]: { m1: 12345 } },
      allTimeCost: { [url]: { m1: 0.0037 } },
      daysCost: { [todayKey()]: { [url]: { m1: 0.0037 } } },
    };
    const m = makeMemento(v3);
    initUsageStore({ globalState: m.memento, subscriptions: [] } as any, output);

    expect(getServerUsage(url).allTime['m1'].prompt).toBe(100);
    expect(getServerCost(url).allTime['m1']).toBeCloseTo(0.0037, 10);
    expect(getServerCost(url).today['m1']).toBeCloseTo(0.0037, 10);
    expect(getModelStartedAt(url, 'm1')).toBe(12345);
  });

  it('ignores a corrupt blob with a truthy primitive allTime (no crash on first record)', () => {
    const m = makeMemento({ version: 3 as const, allTime: 5, days: {} });
    initUsageStore({ globalState: m.memento, subscriptions: [] } as any, output);
    // Corruption detected at load — the store starts fresh instead of crashing
    // on the first recordRequest with a strict-mode TypeError.
    recordRequest(req({ promptTokens: 10 }));
    expect(getServerUsage(url).allTime['m1'].prompt).toBe(10);
  });

  it('ignores corrupt/missing persisted data and starts fresh', () => {
    const m = makeMemento({ version: 99, bogus: true });
    initUsageStore({ globalState: m.memento, subscriptions: [] } as any, output);
    expect(hasServerUsage(url)).toBe(false);
  });
});
});
