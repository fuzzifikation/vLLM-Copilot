/**
 * ServerMetricsEngine — the hidden `contextWindow` fallback's display contract
 * (the metadata-stripping-gateway shape): the configured number surfaces ONLY
 * on a /v1/models row that itself lacks a positive max_model_len, a
 * server-reported window always wins, an absent row is never resurrected, and
 * an empty map clears a previously applied fallback. Same contract as the
 * runtime resolver — kept display-only.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { getMetricsEngine, type ServerMetrics } from '../src/ui/vllmMetrics.js';
import { resetOpenRouterCaches } from '../src/backends/openRouter.js';

/** The engine surface as production hands it out - the class itself is module-private. */
type Engine = ReturnType<typeof getMetricsEngine>;

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** vLLM endpoint stub: /health and /v1/models statuses configurable, rest inert.
 *  Returns the spy so a test can count calls or swap the implementation live. */
function stubFetch(rows: Array<Record<string, unknown>>, health = 200, models = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input: unknown) => {
    const url = String(input);
    if (url.endsWith('/health')) return Promise.resolve(new Response('', { status: health }));
    if (url.endsWith('/v1/models')) return Promise.resolve(models === 200 ? jsonResponse({ data: rows }) : new Response('', { status: models }));
    if (url.endsWith('/version')) return Promise.resolve(jsonResponse({ version: 'test' }));
    if (url.endsWith('/metrics')) return Promise.resolve(new Response('# empty', { status: 200 }));
    return Promise.resolve(new Response('', { status: 404 }));
  });
}

/** Drive one engine to its first completed tick and collect every aggregated snapshot. */
async function firstTick(engine: Engine, seen: ServerMetrics[], timeoutMs = 1000): Promise<void> {
  engine.subscribe((agg) => seen.push(agg));
  await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1), { timeout: timeoutMs });
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

/**
 * Canary for the shipped-1.36.10 false-offline (user report 2026-09-17):
 * the relay verdict must come from the small authenticated key probe, NEVER
 * from the ~1 MB public catalog. A rate-limited or dead catalog keeps the
 * node reachable; a rate-limited KEY keeps it reachable. Only "nothing
 * answered" is an offline verdict.
 */
describe('ServerMetricsEngine — OpenRouter relay health (catalog is data, not health)', () => {
  beforeEach(() => {
    // The catalog is session-memoized module state; a leaked snapshot would
    // serve stale data to the next case and mask a catalog-failure verdict.
    resetOpenRouterCaches();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetOpenRouterCaches();
  });

  type Stub = { json?: unknown; status?: number; reject?: Error; hang?: boolean };
  function stubRelay(key: Stub, catalog: Stub): void {
    const answer = (s: Stub) =>
      s.hang
        ? new Promise<Response>(() => { /* never settles: the 2 s race must carry the tick */ })
        : s.reject
          ? Promise.reject(s.reject)
          : Promise.resolve(new Response(s.json !== undefined ? JSON.stringify(s.json) : '', { status: s.status ?? 200 }));
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/key')) return answer(key);
      if (url.endsWith('/v1/models')) return answer(catalog);
      return Promise.resolve(new Response('', { status: 404 }));
    });
  }

  const dead = new Error('connect');
  (dead as Error & { cause: unknown }).cause = Object.assign(new Error('inner'), { code: 'ECONNREFUSED' });
  const keyOk = { json: { data: { label: 'test-key', usage: 1 } } };
  const catalogOk = { json: { data: [{ id: 'deepseek/deepseek-chat', context_length: 128000 }] } };

  it('key 429 + catalog 429 stays ONLINE — a rate limit is an answer, not death', async () => {
    stubRelay({ status: 429 }, { status: 429 });
    const engine = getMetricsEngine('or1', 'https://openrouter.ai/api', {}, 'openrouter', []);
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(seen[0].online).toBe(true);
    } finally {
      engine.dispose();
    }
  });

  it('key 200 with a DEAD catalog stays ONLINE, noting the data gap (catalog failure ≠ relay death)', async () => {
    stubRelay(keyOk, { reject: dead });
    const engine = getMetricsEngine('or2', 'https://openrouter.ai/api', {}, 'openrouter', []);
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(seen[0].online).toBe(true);
      expect(seen[0].account?.label).toBe('test-key');
      expect(seen[0].staleError).toContain('catalog fetch failed');
    } finally {
      engine.dispose();
    }
  });

  it('key 401 stays ONLINE — the relay lives, only the key is a corpse', async () => {
    stubRelay({ status: 401 }, catalogOk);
    const engine = getMetricsEngine('or3', 'https://openrouter.ai/api', {}, 'openrouter', []);
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(seen[0].online).toBe(true);
      expect(seen[0].account).toBeUndefined();
      expect(seen[0].staleError).toBeUndefined();
    } finally {
      engine.dispose();
    }
  });

  it('nothing answers at all (ECONNREFUSED on both) is OFFLINE — the honest death verdict', async () => {
    stubRelay({ reject: dead }, { reject: dead });
    const engine = getMetricsEngine('or4', 'https://openrouter.ai/api', {}, 'openrouter', []);
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(seen[0].online).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it('a configured model absent from the freshly parsed catalog is flagged missingModels', async () => {
    // The picker silently drops such a model (live-inventory policy) — the
    // dashboard must not keep its node smiling. Absence from a CLEANLY
    // parsed catalog is OpenRouter's own statement the id is gone.
    stubRelay(keyOk, catalogOk);
    const engine = getMetricsEngine('or5', 'https://openrouter.ai/api', {}, 'openrouter', [
      'deepseek/deepseek-chat', // listed in catalogOk
      'stealth/gone-model', // not listed
    ]);
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(seen[0].online).toBe(true);
      expect(seen[0].missingModels).toEqual(['stealth/gone-model']);
    } finally {
      engine.dispose();
    }
  });

  it('a failed catalog NEVER flags models missing (absence against a sulked download proves nothing)', async () => {
    stubRelay(keyOk, { reject: dead });
    const engine = getMetricsEngine('or6', 'https://openrouter.ai/api', {}, 'openrouter', ['deepseek/deepseek-chat']);
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(seen[0].online).toBe(true); // key probe answered — relay lives
      expect(seen[0].staleError).toBeDefined(); // catalog data gap noted
      expect(seen[0].missingModels).toBeUndefined(); // and NO model is accused
    } finally {
      engine.dispose();
    }
  });

  it('a still-DOWNLOADING cold catalog accuses nothing (pending rows are absence of data, not evidence)', async () => {
    // The session's first tick races the catalog read on 2 s; a download
    // slower than that publishes online-with-no-rows. An empty listing is
    // not a listing models can be absent from — one slow first tick must
    // not paint red "not on OpenRouter anymore" markers on everything
    // (2026-09-18 self-review catch on the session-memo change).
    stubRelay(keyOk, { hang: true });
    const engine = getMetricsEngine('or7', 'https://openrouter.ai/api', {}, 'openrouter', ['deepseek/deepseek-chat']);
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen, 3000); // the 2 s race cap runs for real
      expect(seen[0].online).toBe(true); // key probe answered — relay lives
      expect(seen[0].staleError).toBeUndefined(); // pending is neither data nor failure
      expect(seen[0].missingModels).toBeUndefined();
      expect(engine.getServerModels()).toEqual([]); // rows unknown, never an empty-lie
    } finally {
      engine.dispose();
    }
  });
});

/**
 * The engine's server-reported model rows (2026-09-18): the single fetched
 * list every display surface reads (Model Settings picker, dashboard Models
 * node) after the old one-shot probe in Model Settings left its view blank
 * until a settings write. Contract: `/v1/models`-served backends map the
 * already-parsed rows (no extra HTTP); LM Studio/Ollama adopt their NATIVE
 * endpoint's authoritative ids in rows AND `aggregated.models`; a failed
 * native probe yields empty rows (unknown, never stale) while the dashboard
 * keeps this tick's `/v1/models` ids; offline always reads empty.
 */
describe('ServerMetricsEngine — server-reported model rows (getServerModels)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('vLLM maps the tick rows: id + owned_by + max_model_len, no extra fetch', async () => {
    const fetchSpy = stubFetch([{ id: 'm1', object: 'model', owned_by: 'vllm', max_model_len: 4096 }]);
    const engine = getMetricsEngine('rows-vllm', 'http://rows-vllm:8000', {}, 'vllm', []);
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(engine.getServerModels()).toEqual([{ id: 'm1', ownedBy: 'vllm', maxModelLen: 4096 }]);
      // The row list is a re-map of the tick's /v1/models, not a second probe.
      const modelFetches = fetchSpy.mock.calls.filter(c => String(c[0]).endsWith('/v1/models')).length;
      expect(modelFetches).toBe(1);
    } finally {
      engine.dispose();
    }
  });

  it('lmstudio: the native key endpoint owns rows AND the dashboard model node', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/api/v1/models')) return jsonResponse({ models: [{ key: 'real/key', id: 'alias' }] });
      if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'alias' }] });
      return new Response('', { status: 404 });
    });
    const engine = getMetricsEngine('rows-lms', 'http://rows-lms:1234', {}, 'lmstudio');
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(engine.getServerModels().map(m => m.id)).toEqual(['real/key']);
      expect(seen[0].models).toEqual(['real/key']); // one id space, no drift
    } finally {
      engine.dispose();
    }
  });

  it('ollama: failed native probe leaves rows unknown while the dashboard keeps /v1/models ids', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/api/ps')) return new Response('', { status: 500 });
      if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'loaded-model' }] });
      return new Response('', { status: 404 });
    });
    const engine = getMetricsEngine('rows-oll', 'http://rows-oll:11434', {}, 'ollama');
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(seen[0].online).toBe(true); // /v1/models answered — server lives
      expect(engine.getServerModels()).toEqual([]); // "unknown", never a stale or empty-lie list
      expect(seen[0].models).toEqual(['loaded-model']); // dashboard loses nothing
    } finally {
      engine.dispose();
    }
  });

  it('offline reads empty rows regardless of the last good list', async () => {
    const fetchSpy = stubFetch([{ id: 'm1', object: 'model', owned_by: 'vllm', max_model_len: 4096 }], 200, 200);
    const engine = getMetricsEngine('rows-off', 'http://rows-off:8000', {}, 'vllm', []);
    const seen: ServerMetrics[] = [];
    try {
      await firstTick(engine, seen);
      expect(engine.getServerModels().map(m => m.id)).toEqual(['m1']);
      // Now kill the server: conclusive death (health AND models refuse)...
      fetchSpy.mockImplementation(async (input: unknown) => {
        const err = new Error('connect') as Error & { cause: unknown };
        err.cause = Object.assign(new Error('inner'), { code: 'ECONNREFUSED' });
        void input;
        throw err;
      });
      engine.pollNow();
      await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
      expect(seen[1].online).toBe(false);
      expect(engine.getServerModels()).toEqual([]);
    } finally {
      engine.dispose();
    }
  });
});
