/**
 * ServerMetricsEngine — the hidden `contextWindow` fallback's display contract
 * (the metadata-stripping-gateway shape): the configured number surfaces ONLY
 * on a /v1/models row that itself lacks a positive max_model_len, a
 * server-reported window always wins, an absent row is never resurrected, and
 * an empty map clears a previously applied fallback. Same contract as the
 * runtime resolver — kept display-only.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getMetricsEngine, type ServerMetrics } from '../src/ui/vllmMetrics.js';

/** The engine surface as production hands it out - the class itself is module-private. */
type Engine = ReturnType<typeof getMetricsEngine>;

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** vLLM endpoint stub: /health and /v1/models statuses configurable, rest inert. */
function stubFetch(rows: Array<Record<string, unknown>>, health = 200, models = 200): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: unknown) => {
    const url = String(input);
    if (url.endsWith('/health')) return Promise.resolve(new Response('', { status: health }));
    if (url.endsWith('/v1/models')) return Promise.resolve(models === 200 ? jsonResponse({ data: rows }) : new Response('', { status: models }));
    if (url.endsWith('/version')) return Promise.resolve(jsonResponse({ version: 'test' }));
    if (url.endsWith('/metrics')) return Promise.resolve(new Response('# empty', { status: 200 }));
    return Promise.resolve(new Response('', { status: 404 }));
  });
}

/** Drive one engine to its first completed tick and collect every aggregated snapshot. */
async function firstTick(engine: Engine, seen: ServerMetrics[]): Promise<void> {
  engine.subscribe((agg) => seen.push(agg));
  await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));
}

describe('ServerMetricsEngine — configured contextWindow fallback (vLLM display)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies the fallback to a row without max_model_len (contextByModel + server row)', async () => {
    stubFetch([{ id: 'gw-model', object: 'model', owned_by: 'gateway' }]);
    const engine = getMetricsEngine('gw', 'http://gateway:8000', {}, 'vllm', ['gw-model'], undefined, { 'gw-model': 262144 });
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(seen[0].contextByModel).toEqual({ 'gw-model': 262144 });
      expect(seen[0].maxModelLen).toBe(262144);
    } finally {
      engine.dispose();
    }
  });

  it('a server-reported max_model_len wins and the compliant row never sees the fallback', async () => {
    stubFetch([
      { id: 'gw-model', object: 'model', owned_by: 'gateway' },
      { id: 'ok-model', object: 'model', owned_by: 'vllm', max_model_len: 8192 },
    ]);
    const engine = getMetricsEngine('gw', 'http://gateway:8000', {}, 'vllm', ['gw-model', 'ok-model'], undefined, { 'gw-model': 262144, 'ok-model': 131072 });
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      // Only the metadata-stripped row gets the fallback; the compliant row's
      // 8192 also owns the server-level maxModelLen (set from the rows, so the
      // fallback never overwrites it).
      expect(seen[0].contextByModel).toEqual({ 'gw-model': 262144 });
      expect(seen[0].maxModelLen).toBe(8192);
    } finally {
      engine.dispose();
    }
  });

  it('a fallback never resurrects a model absent from /v1/models', async () => {
    stubFetch([]);
    const engine = getMetricsEngine('gw', 'http://gateway:8000', {}, 'vllm', ['ghost-model'], undefined, { 'ghost-model': 262144 });
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(seen[0].online).toBe(true); // the server answered — the GHOST just isn't on it
      expect(seen[0].contextByModel).toBeUndefined();
      expect(seen[0].maxModelLen).toBeNull();
    } finally {
      engine.dispose();
    }
  });

  it('an empty fallback map clears a previously applied fallback on the next tick', async () => {
    stubFetch([{ id: 'gw-model', object: 'model', owned_by: 'gateway' }]);
    const engine = getMetricsEngine('gw', 'http://gateway:8000', {}, 'vllm', ['gw-model'], undefined, { 'gw-model': 262144 });
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(seen[0].contextByModel).toEqual({ 'gw-model': 262144 });
      // The dashboard passes {} when the settings field is deleted — the stale
      // number must not linger on the next tick.
      engine.setContextWindowFallbacks({});
      engine.pollNow();
      await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
      expect(seen[1].contextByModel).toBeUndefined();
      expect(seen[1].maxModelLen).toBeNull();
    } finally {
      engine.dispose();
    }
  });
});

describe('ServerMetricsEngine — liveness through a /v1-only proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('health 404 with a healthy /v1/models is ONLINE (a proxy answer is not death)', async () => {
    stubFetch([{ id: 'gw-model', object: 'model', owned_by: 'gateway' }], 404);
    const engine = getMetricsEngine('gw2', 'http://gateway:8000', {}, 'vllm', ['gw-model']);
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(seen[0].online).toBe(true);
    } finally {
      engine.dispose();
    }
  });

  it('health 404 with a dead /v1/models stays OFFLINE (no alibi)', async () => {
    stubFetch([], 404, 500);
    const engine = getMetricsEngine('gw3', 'http://gateway:8000', {}, 'vllm', []);
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(seen[0].online).toBe(false);
    } finally {
      engine.dispose();
    }
  });
});
