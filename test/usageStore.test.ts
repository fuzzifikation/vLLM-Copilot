import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  initUsageStore, recordRequest, getLastRequest, getServerUsage, hasServerUsage,
  getServersWithUsage, resetUsage, computeCost, findModelCost,
  formatCost, sumCounts, dayKey, resetUsageStoreForTests, onUsageStoreDidChange,
  type LastRequestData,
} from '../src/usageStore.js';
import type { ModelConfig } from '../src/config.js';

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
    firstTokenTimeMs: 5, ...over,
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

  it('stores the last request per server (replace semantics)', () => {
    recordRequest(req({ promptTokens: 10 }));
    recordRequest(req({ promptTokens: 20, modelId: 'm2' }));
    recordRequest(req({ promptTokens: 30 }));

    expect(getLastRequest(url)?.promptTokens).toBe(30); // last write wins for m1
    expect(getLastRequest(url)?.modelId).toBe('m1');
  });

  it('accumulates all-time, today, and session per (server, model)', () => {
    recordRequest(req({ promptTokens: 100, completionTokens: 50, cachedTokens: 10, reasoningTokens: 5 }));
    recordRequest(req({ promptTokens: 200, completionTokens: 100, cachedTokens: 20, reasoningTokens: 0 }));
    recordRequest(req({ modelId: 'm2', promptTokens: 7, completionTokens: 3, cachedTokens: 1 }));

    const usage = getServerUsage(url);
    expect(usage.allTime['m1']).toEqual({ prompt: 300, completion: 150, cached: 30, reasoning: 5 });
    expect(usage.allTime['m2']).toEqual({ prompt: 7, completion: 3, cached: 1, reasoning: 5 }); // req() default reasoningTokens
    // today and session mirror allTime for the same activation/day
    expect(usage.today['m1']).toEqual(usage.allTime['m1']);
    expect(usage.session['m1']).toEqual(usage.allTime['m1']);
  });

  it('tracks independent servers and model-keyed usage', () => {
    recordRequest(req({ serverUrl: 'http://a:1', modelId: 'm1', promptTokens: 5 }));
    recordRequest(req({ serverUrl: 'http://b:2', modelId: 'm1', promptTokens: 9 }));

    expect(getServerUsage('http://a:1').allTime['m1'].prompt).toBe(5);
    expect(getServerUsage('http://b:2').allTime['m1'].prompt).toBe(9);
    expect(hasServerUsage('http://a:1')).toBe(true);
    expect(getServersWithUsage()).toContain('http://a:1');
    expect(getServersWithUsage()).toContain('http://b:2');
  });

  it('sumCounts aggregates across models without double-counting cached', () => {
    recordRequest(req({ promptTokens: 100, completionTokens: 50, cachedTokens: 40 }));
    recordRequest(req({ modelId: 'm2', promptTokens: 50, completionTokens: 25, cachedTokens: 10 }));
    const s = sumCounts(getServerUsage(url).today);
    expect(s).toEqual({ prompt: 150, completion: 75, cached: 50, reasoning: 10 }); // 5 (m1) + 5 (m2 default)
  });

  it('fires the change event on record', () => {
    let fired = 0;
    const sub = onUsageStoreDidChange(() => { fired++; });
    recordRequest(req());
    expect(fired).toBe(1);
    sub.dispose();
  });
});

describe('persistence (globalState)', () => {
  beforeEach(() => resetUsageStoreForTests());
  afterEach(() => resetUsageStoreForTests());

  it('persists and reloads the cumulative totals across activations', async () => {
    const m = makeMemento();
    initUsageStore({ globalState: m.memento, subscriptions: [] } as any, output);
    recordRequest(req({ promptTokens: 100, completionTokens: 50, cachedTokens: 10 }));
    await flushWrites(m, 1);

    expect(m.stored.version).toBe(1);
    expect(m.stored.allTime[url]['m1']).toEqual({ prompt: 100, completion: 50, cached: 10, reasoning: 5 });
    expect(m.stored.days[dayKey()][url]['m1'].prompt).toBe(100);

    // Simulate a window reload: fresh module state, same memento.
    resetUsageStoreForTests();
    initUsageStore({ globalState: m.memento, subscriptions: [] } as any, output);
    const usage = getServerUsage(url);
    expect(usage.allTime['m1'].prompt).toBe(100);
    // session is in-memory — empty after reload
    expect(usage.session).toEqual({});
  });

  it('ignores corrupt/missing persisted data and starts fresh', () => {
    const m = makeMemento({ version: 99, bogus: true });
    initUsageStore({ globalState: m.memento, subscriptions: [] } as any, output);
    expect(hasServerUsage(url)).toBe(false);
  });

  it('prunes day buckets older than the retention window on init', async () => {
    const oldKey = dayKey(Date.now() - 120 * 24 * 60 * 60 * 1000);
    const stale = { version: 1 as const, allTime: {}, days: { [oldKey]: { [url]: { m1: { prompt: 1, completion: 1, cached: 0, reasoning: 0 } } } } };
    const m = makeMemento(stale);
    initUsageStore({ globalState: m.memento, subscriptions: [] } as any, output);

    // init prunes the stale day from the seeded object immediately
    expect(m.stored.days).not.toHaveProperty(oldKey);
    expect(hasServerUsage(url)).toBe(false); // pruned day contributes nothing to allTime

    // a fresh record persists the pruned days (no stale key returns)
    recordRequest(req({ promptTokens: 10 }));
    await flushWrites(m, 1);
    expect(m.stored.days).not.toHaveProperty(oldKey);
    expect(m.stored.days[dayKey()][url]['m1'].prompt).toBe(10);
  });
});

describe('resetUsage', () => {
  beforeEach(() => resetUsageStoreForTests());
  afterEach(() => resetUsageStoreForTests());

  it("clears all usage but keeps the last request", () => {
    recordRequest(req({ promptTokens: 100 }));
    resetUsage('all');

    expect(hasServerUsage(url)).toBe(false);
    expect(getServerUsage(url).allTime).toEqual({});
    expect(getServerUsage(url).session).toEqual({});
    // Last Request deliberately survives a reset
    expect(getLastRequest(url)).toBeDefined();
  });

  it('clears only the scoped server', () => {
    recordRequest(req({ serverUrl: 'http://a:1', promptTokens: 5 }));
    recordRequest(req({ serverUrl: 'http://b:2', promptTokens: 9 }));
    resetUsage({ serverUrl: 'http://a:1' });

    expect(hasServerUsage('http://a:1')).toBe(false);
    expect(getServerUsage('http://b:2').allTime['m1'].prompt).toBe(9);
  });

  it('fires the change event on reset', () => {
    recordRequest(req());
    let fired = 0;
    const sub = onUsageStoreDidChange(() => { fired++; });
    resetUsage('all');
    expect(fired).toBe(1);
    sub.dispose();
  });
});

describe('cost derivation', () => {
  beforeEach(() => resetUsageStoreForTests());
  afterEach(() => resetUsageStoreForTests());

  const counts = { prompt: 2_000_000, completion: 500_000, cached: 1_000_000, reasoning: 100_000 };

  it('returns undefined when no rates are configured', () => {
    expect(computeCost(counts, undefined)).toBeUndefined();
    expect(computeCost(counts, { input: 0, output: 0, cachedInput: 0 })).toBeUndefined();
  });

  it('prices fresh input, cached input, and output at their own rates', () => {
    // fresh input = prompt − cached = 1M × $0.10 = $0.10
    // cached = 1M × $0.01 = $0.01
    // output = 0.5M × $0.30 = $0.15
    const cost = computeCost(counts, { input: 0.10, output: 0.30, cachedInput: 0.01 });
    expect(cost).toBeCloseTo(0.26, 6);
  });

  it('supports partial rates (only priced components count)', () => {
    const cost = computeCost(counts, { output: 0.30 });
    expect(cost).toBeCloseTo(0.15, 6);
  });

  it('clamps negative fresh input (cached > prompt) to zero', () => {
    const cost = computeCost({ prompt: 100, completion: 10, cached: 200, reasoning: 0 }, { input: 1 });
    expect(cost).toBe(0);
  });

  it('formats currency and AI credits', () => {
    expect(formatCost(0.42)).toBe('$0.42');
    expect(formatCost(12.3456)).toBe('$12.35');
    expect(formatCost(120)).toBe('$120');
    expect(formatCost(0.0007)).toBe('$0.0007');
    expect(formatCost(0.000019)).toBe('$0.000019'); // per-request costs never collapse to 0
    expect(formatCost(42, 'AI Credits')).toBe('42.00 credits'); // fractional credits allowed
    expect(formatCost(42, 'ai credits')).toBe('42.00 credits');
  });

  it('findModelCost locates rates by (serverUrl, wire modelId)', () => {
    const models = [
      { id: 'cfg1', vllmModelId: 'm1', serverUrl: 'http://s:8000', cost: { input: 0.1 } },
      { id: 'cfg2', vllmModelId: 'm2', serverUrl: 'http://s:8000', cost: { output: 0.2 } },
    ] as ModelConfig[];
    expect(findModelCost(models, 'http://s:8000/v1', 'm1')?.input).toBe(0.1); // normalized URL match
    expect(findModelCost(models, url, 'm2')?.output).toBe(0.2);
    expect(findModelCost(models, url, 'nope')).toBeUndefined();
  });
});
