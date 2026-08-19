import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { DashboardTreeProvider } from '../src/dashboard.js';
import { recordRequest, resetUsageStoreForTests } from '../src/usageStore.js';
import { normalizeServerUrl } from '../src/config.js';

/**
 * Dashboard tree-provider tests.
 *
 * Exercises the provider (not the metrics engine, which is covered in
 * vllmMetrics.test.ts): tree structure, the visibility/epoch subscription
 * lifecycle, and the offline/online metric rendering. Global fetch is stubbed
 * so the polling engine's first tick completes quickly against fake endpoints.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fetch stub that makes every endpoint offline (health check fails). */
const offlineFetch = vi.fn(async () => new Response(null, { status: 0 }));

/** Fetch stub that serves a reachable vLLM server with one loaded model. */
const onlineFetch = vi.fn(async (url: unknown) => {
  const u = String(url);
  if (u.endsWith('/health')) return new Response('OK', { status: 200 });
  if (u.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'm1', max_model_len: 100 }] });
  if (u.endsWith('/version')) return jsonResponse({ version: 'v0.6' });
  if (u.endsWith('/metrics')) return new Response('vllm:num_requests_running{model_name="m1"} 3', { status: 200 });
  if (u.endsWith('/load')) return jsonResponse({ server_load: 0.5 });
  return new Response(null, { status: 404 });
});

/**
 * Fetch stub for a reachable NON-vLLM server (e.g. Ollama): `/health` is not
 * documented and returns 404, but the OpenAI-compatible `/v1/models` (the
 * endpoint chat actually uses) works. Previously this made the server appear OFFLINE.
 */
const nonVllmOnlineFetch = vi.fn(async (url: unknown) => {
  const u = String(url);
  if (u.endsWith('/health')) return new Response(null, { status: 404 });
  if (u.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'm1', max_model_len: 100 }] });
  if (u.endsWith('/version')) return new Response(null, { status: 404 });
  if (u.endsWith('/metrics')) return new Response(null, { status: 404 });
  if (u.endsWith('/load')) return new Response(null, { status: 404 });
  return new Response(null, { status: 404 });
});

/** Let the async refreshSubscriptions + first engine tick settle. */
const settle = () => new Promise<void>(r => setTimeout(r, 0));

function makeProvider(): DashboardTreeProvider {
  const context = { subscriptions: [] } as any;
  const output = {
    appendLine: vi.fn(), append: vi.fn(), replace: vi.fn(), clear: vi.fn(),
    show: vi.fn(), hide: vi.fn(), dispose: vi.fn(), name: 'test',
  } as any;
  return new DashboardTreeProvider(context, output);
}

/** Root children with the given label, if any. */
function rootLabels(provider: DashboardTreeProvider): Promise<string[]> {
  return provider.getChildren().then(children => children.map(c => (c as any).label as string));
}

describe('DashboardTreeProvider', () => {
  let provider: DashboardTreeProvider;

  beforeEach(() => {
    (vscode as any).workspace._mockConfig = {};
    resetUsageStoreForTests();
    provider = makeProvider();
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
    (vscode as any).workspace._mockConfig = {};
    resetUsageStoreForTests();
  });

  it('shows poll interval, add, and refresh items with no servers configured', async () => {
    (vscode as any).workspace._mockConfig = { models: [] };

    const labels = await rootLabels(provider);

    expect(labels).toContain('Refresh Interval');
    expect(labels).toContain('Add or Reconfigure Server/Model');
    expect(labels).toContain('Test & Refresh Models');
    expect(labels).toHaveLength(3);
  });

  it('setVisible(true) subscribes configured servers and lists them', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    };
    vi.stubGlobal('fetch', offlineFetch);

    provider.setVisible(true);
    await settle();

    const labels = await rootLabels(provider);
    expect(labels).toContain('s:8000');
  });

  it('shows an offline server with an Error child', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    };
    vi.stubGlobal('fetch', offlineFetch);

    provider.setVisible(true);
    await settle();

    const serverNode = (await provider.getChildren()).find(c => (c as any).label === 's:8000');
    expect(serverNode).toBeDefined();
    const children = await provider.getChildren(serverNode as any);
    expect(children).toHaveLength(1);
    expect((children[0] as any).label).toBe('Error');
  });

  it('setVisible(false) removes the server from the tree and stops polling', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    };
    vi.stubGlobal('fetch', offlineFetch);

    provider.setVisible(true);
    await settle();
    expect(await rootLabels(provider)).toContain('s:8000');

    provider.setVisible(false);
    expect(await rootLabels(provider)).not.toContain('s:8000');
  });

  it('does not subscribe when the sidebar is hidden during an in-flight refresh', async () => {
    // Regression for the background-polling race: setVisible(true) fires an
    // async refreshSubscriptions that awaits getConfig; hiding during that gap
    // must abort the continuation so no engine is subscribed for a hidden view.
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    };
    vi.stubGlobal('fetch', offlineFetch);

    provider.setVisible(true); // starts refresh; continuation queued on getConfig
    provider.setVisible(false); // hides before the continuation runs
    await settle();

    expect(await rootLabels(provider)).not.toContain('s:8000');
  });

  it('two overlapping shows do not double-subscribe (epoch guard)', async () => {
    // Regression for the double-subscribe race: two refreshSubscriptions in
    // flight must leave exactly one subscription per server, or the tree would
    // list duplicate server nodes (and poll the server twice).
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    };
    vi.stubGlobal('fetch', offlineFetch);

    provider.setVisible(true);
    provider.setVisible(true);
    await settle();

    const labels = await rootLabels(provider);
    expect(labels.filter(l => l === 's:8000')).toHaveLength(1);
  });

  it('renders online server metric rows from a completed poll', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    };
    vi.stubGlobal('fetch', onlineFetch);

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 's:8000');
      expect(serverNode).toBeDefined();
      const metrics = await provider.getChildren(serverNode as any);
      const labels = metrics.map(m => (m as any).label as string);
      expect(labels).toContain('vLLM Version');
      expect(labels).toContain('Model IDs');
      expect(labels).toContain('Running');

      const versionItem = metrics.find(m => (m as any).label === 'vLLM Version');
      expect((versionItem as any).description).toBe('v0.6');
      const runningItem = metrics.find(m => (m as any).label === 'Running');
      expect((runningItem as any).description).toBe('3');
    });
  });

  it('shows Last Request for a server configured with a non-canonical URL (normalized lookup)', async () => {
    // consumeStream writes the store keyed by the NORMALIZED server URL; the
    // dashboard's node carries the raw `model.serverUrl`. A /v1 form must still
    // find its Last Request entry (regression: the node silently vanished).
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000/v1', vllmModelId: 'm1' }],
    };
    vi.stubGlobal('fetch', onlineFetch);
    recordRequest({
      serverUrl: normalizeServerUrl('http://s:8000/v1'),
      modelId: 'm1', timestamp: 1, promptTokens: 5, completionTokens: 7, totalTokens: 12,
      hasMetrics: false, hasCacheDetails: false, maxModelLen: 100, maxOutputTokens: 100,
      firstTokenTimeMs: 10, totalTimeMs: 50,
    });

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 's:8000');
      expect(serverNode).toBeDefined();
      const metrics = await provider.getChildren(serverNode as any);
      expect(metrics.some(m => (m as any).label === 'Last Request')).toBe(true);
    });
  });

  it('dispose() clears subscriptions so no server remains listed', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    };
    vi.stubGlobal('fetch', offlineFetch);

    provider.setVisible(true);
    await settle();
    expect(await rootLabels(provider)).toContain('s:8000');

    provider.dispose();
    expect(await rootLabels(provider)).not.toContain('s:8000');
  });

  it('shows a Token Usage and Cost node with per-model Today/Overall rows and derived cost', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000/v1', vllmModelId: 'm1', displayName: 'Friendly M1', cost: { input: 1, output: 2, cachedInput: 0.5 } }],
    };
    vi.stubGlobal('fetch', onlineFetch);
    recordRequest({
      serverUrl: normalizeServerUrl('http://s:8000/v1'),
      modelId: 'm1', timestamp: 1, promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000,
      cachedTokens: 200_000, hasMetrics: false, hasCacheDetails: true, maxModelLen: 1000, maxOutputTokens: 100,
      firstTokenTimeMs: 10, totalTimeMs: 50,
    });

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 's:8000');
      const metrics = await provider.getChildren(serverNode as any);
      const usageNode = metrics.find(m => (m as any).label === 'Token Usage and Cost');
      expect(usageNode).toBeDefined();
      // No in/out summary on the node itself — it's a pure container.
      expect((usageNode as any).description).toBeUndefined();

      // Model-first: one collapsible model node, labeled by displayName,
      // priced at a glance (today's cost).
      const modelNodes = await provider.getChildren(usageNode as any);
      const modelNode = modelNodes.find(m => (m as any).label === 'Friendly M1');
      expect(modelNode).toBeDefined();
      // fresh 800k×$1 + cached 200k×$0.5 + out 500k×$2 = $1.90. Just recorded, so the
      // recording window is under 0.1 days → today-only summary.
      expect((modelNode as any).description).toBe('$1.90 today');
      expect(modelNodes.find(m => (m as any).label === 'm1')).toBeUndefined(); // wire id hidden

      // Today + Overall rows under the model — token-only (price is on the model line above).
      const rows = await provider.getChildren(modelNode as any);
      const labels = rows.map(r => (r as any).label as string);
      expect(labels).toEqual(['Today', 'Overall']);

      const today = rows.find(r => (r as any).label === 'Today');
      expect((today as any).description).toBe('800k in · 200k cached · 500k out');

      const overall = rows.find(r => (r as any).label === 'Overall');
      expect((overall as any).description).toContain('800k in · 200k cached · 500k out');
      expect((overall as any).description).not.toContain('$'); // price lives on the model line
      expect((overall as any).description).toContain('started'); // recording-since suffix
    });
  });

  it('shows a Cost row under Last Request when the model has cost rates', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000/v1', vllmModelId: 'm1', cost: { input: 1, output: 2, cachedInput: 0.5 } }],
    };
    vi.stubGlobal('fetch', onlineFetch);
    recordRequest({
      serverUrl: normalizeServerUrl('http://s:8000/v1'),
      modelId: 'm1', timestamp: 1, promptTokens: 5, completionTokens: 7, totalTokens: 12,
      cachedTokens: 0, hasMetrics: false, hasCacheDetails: true, maxModelLen: 1000, maxOutputTokens: 100,
      firstTokenTimeMs: 10, totalTimeMs: 50,
    });

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 's:8000');
      const metrics = await provider.getChildren(serverNode as any);
      const last = metrics.find(m => (m as any).label === 'Last Request');
      const rows = await provider.getChildren(last as any);
      const costRow = rows.find(r => (r as any).label === 'Cost');
      expect(costRow).toBeDefined();
      // fresh 5×$1 + output 7×$2 = $0.000005 + $0.000014 = $0.000019
      expect((costRow as any).description).toBe('$0.000019');
    });
  });

  it('splits Last Request Input Tokens into fresh + cached when cache details exist', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000/v1', vllmModelId: 'm1' }],
    };
    vi.stubGlobal('fetch', onlineFetch);
    recordRequest({
      serverUrl: normalizeServerUrl('http://s:8000/v1'),
      modelId: 'm1', timestamp: 1, promptTokens: 3_700, completionTokens: 5_000, totalTokens: 8_700,
      cachedTokens: 1_200, hasMetrics: false, hasCacheDetails: true, maxModelLen: 1000, maxOutputTokens: 100,
      firstTokenTimeMs: 10, totalTimeMs: 50,
    });

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 's:8000');
      const metrics = await provider.getChildren(serverNode as any);
      const last = metrics.find(m => (m as any).label === 'Last Request');
      const rows = await provider.getChildren(last as any);
      const input = rows.find(r => (r as any).label === 'Input Tokens');
      expect(input).toBeDefined();
      // fresh 3.7k − 1.2k cached → 2.5k, rounded to whole thousands → 3k in · 1k cached
      expect((input as any).description).toContain('3k in');
      expect((input as any).description).toContain('1k cached');
      expect((input as any).description).not.toContain('%');
    });
  });

  it('renders a non-vLLM server cleanly: no degraded label, hides absent vLLM-only rows', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1', serverType: 'llamacpp' }],
    };
    vi.stubGlobal('fetch', onlineFetch);
    // Non-vLLM backends never report per-request metrics → measured path only.
    recordRequest({
      serverUrl: normalizeServerUrl('http://s:8000'),
      modelId: 'm1', timestamp: 1, promptTokens: 10, completionTokens: 40, totalTokens: 50,
      hasMetrics: false, hasCacheDetails: false, maxModelLen: 100, maxOutputTokens: 100,
      firstTokenTimeMs: 10, totalTimeMs: 50,
    });

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 's:8000');
      expect(serverNode).toBeDefined();
      // No "(degraded)" label anymore — every backend is first-class.
      expect((serverNode as any).description).not.toContain('degraded');

      const metrics = await provider.getChildren(serverNode as any);
      const labels = metrics.map(m => (m as any).label as string);
      // No "Backend" warning row (removed with the degraded cleanup).
      expect(labels).not.toContain('Backend');
      // vLLM-only metric rows are absent (not "—") for a non-vLLM backend:
      // the engine only probes /v1/models, so KV cache / running / TTFT have no data.
      expect(labels).not.toContain('KV Cache');
      expect(labels).not.toContain('Running');
      expect(labels).not.toContain('Avg TTFT');

      const last = metrics.find(m => (m as any).label === 'Last Request');
      const rows = await provider.getChildren(last as any);
      const rowLabels = rows.map(r => (r as any).label as string);
      // Client-measured throughput: the decode window [10ms, 50ms] covers
      // tokens 2..40 (39 tokens) → 39 tok / 40ms = 975.0 tok/s.
      const gen = rows.find(r => (r as any).label === 'Generation (measured)');
      expect(gen).toBeDefined();
      expect((gen as any).description).toContain('975.0 tok/s');
      // vLLM-only launch flags are meaningless here — no hint.
      expect(rowLabels).not.toContain('⚡ More data with --enable-per-request-metrics');
    });
  });

  it('keeps a non-vLLM server ONLINE when /health is absent but /v1/models works', async () => {
    // Regression: the metrics engine gated online solely on /health, which LM
    // Studio/Ollama/llama.cpp do not document — so they appeared offline (only an
    // error row), hiding Last Request / Token Usage / measured throughput even though
    // chat worked. Online is now /v1/models.ok for non-vLLM backends.
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1', serverType: 'ollama' }],
    };
    vi.stubGlobal('fetch', nonVllmOnlineFetch);
    recordRequest({
      serverUrl: normalizeServerUrl('http://s:8000'),
      modelId: 'm1', timestamp: 1, promptTokens: 10, completionTokens: 3, totalTokens: 13,
      hasMetrics: false, hasCacheDetails: false, maxModelLen: 100, maxOutputTokens: 100,
      firstTokenTimeMs: 10, totalTimeMs: 20,
    });

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 's:8000');
      expect(serverNode).toBeDefined();
      // Not "Offline" — online via /v1/models for non-vLLM backends.
      expect((serverNode as any).description).not.toContain('Offline');
      expect((serverNode as any).description).not.toContain('degraded');

      const metrics = await provider.getChildren(serverNode as any);
      const labels = metrics.map(m => (m as any).label as string);
      // No error row — Last Request and Token Usage are reachable.
      expect(labels).not.toContain('Error');
      expect(labels).toContain('Last Request');
      const last = metrics.find(m => (m as any).label === 'Last Request');
      const rows = await provider.getChildren(last as any);
      const rowLabels = rows.map(r => (r as any).label as string);
      // Measured throughput present (2 decode tokens over the [10,20]ms window).
      expect(rowLabels).toContain('Generation (measured)');
    });
  });

  it('shows measured generation for vLLM when --enable-per-request-metrics is off', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    };
    vi.stubGlobal('fetch', onlineFetch);
    recordRequest({
      serverUrl: normalizeServerUrl('http://s:8000'),
      modelId: 'm1', timestamp: 1, promptTokens: 10, completionTokens: 20, totalTokens: 30,
      hasMetrics: false, hasCacheDetails: true, maxModelLen: 100, maxOutputTokens: 100,
      firstTokenTimeMs: 10, totalTimeMs: 50,
    });

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 's:8000');
      const metrics = await provider.getChildren(serverNode as any);
      const last = metrics.find(m => (m as any).label === 'Last Request');
      const rows = await provider.getChildren(last as any);
      const rowLabels = rows.map(r => (r as any).label as string);
      expect(rowLabels).toContain('Generation (measured)');
      // It's vLLM, so the flag hint to enable server metrics still applies.
      expect(rowLabels).toContain('⚡ More data with --enable-per-request-metrics');
    });
  });
});
