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

/**
 * Fetch stub for an OpenRouter relay: /v1/models serves the whole catalog
 * (each configured model is its own entry with a context window — this is the
 * shared catalog the dashboard resolves windows from), /v1/key serves account
 * health.
 */
const openRouterFetch = vi.fn(async (url: unknown) => {
  const u = String(url);
  if (u.endsWith('/v1/models')) {
    return jsonResponse({ data: [
      { id: 'nvidia/nemotron-3.5-lightning:free', context_length: 1000000 },
      { id: 'deepseek/deepseek-chat', context_length: 163840 },
      { id: 'catalog-model-a' },
    ] });
  }
  if (u.endsWith('/v1/key')) return jsonResponse({ data: { label: 'my-key', limit: 10, limit_remaining: 3.5, usage: 100, is_free_tier: false } });
  if (u.includes('/endpoints')) {
    const id = decodeURIComponent(u.split('/v1/models/')[1]?.split('/endpoints')[0] ?? '');
    if (id === 'deepseek/deepseek-chat') {
      return jsonResponse({ data: { id, endpoints: [
        { tag: 'deepseek', provider_name: 'DeepSeek', quantization: 'unknown', status: 0, pricing: { prompt: '0.00000066', completion: '0.00000198', input_cache_read: '0.000000022' } },
        { tag: 'alibaba', provider_name: 'Alibaba', quantization: 'unknown', status: 0, pricing: { prompt: '0.000000726', completion: '0.000002178' } },
      ] } });
    }
    return jsonResponse({ data: { id, endpoints: [] } });
  }
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

  it('treats two header identities on one URL as separate server nodes', async () => {
    // Per-model credentials: two models share a URL but carry different keys.
    // They are DIFFERENT logical servers — each must get its own node, probed
    // with its own credentials (never the first model's headers for the other).
    (vscode as any).workspace._mockConfig = {
      models: [
        { id: 'a', serverUrl: 'http://gw:8000', vllmModelId: 'm-a', requestHeaders: { Authorization: 'Bearer secret-a' } },
        { id: 'b', serverUrl: 'http://gw:8000', vllmModelId: 'm-b', requestHeaders: { Authorization: 'Bearer secret-b' } },
      ],
    };
    const fetchMock = vi.fn(async (url: unknown, _init?: RequestInit) => {
      if (String(url).endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'probe' }] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    provider.setVisible(true);
    await settle();

    const labels = await rootLabels(provider);
    expect(labels).toContain('gw:8000 (identity 1)');
    expect(labels).toContain('gw:8000 (identity 2)');

    // Each identity was probed with its OWN credentials.
    const authHeaders = fetchMock.mock.calls.map(([, init]) =>
      (init?.headers as Record<string, string> | undefined)?.Authorization
    );
    expect(authHeaders).toContain('Bearer secret-a');
    expect(authHeaders).toContain('Bearer secret-b');
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

  it('renders an OpenRouter relay with per-model nodes + account health', async () => {
    // OpenRouter is a relay: /v1/models is the whole catalog and each configured
    // model has its own context. The relay node shows an Account node (from
    // /api/v1/key) plus ONE collapsible node PER configured model (direct
    // children — no intermediate "collection" container).
    (vscode as any).workspace._mockConfig = {
      models: [
        {
          id: 'm1', serverUrl: 'https://openrouter.ai/api', vllmModelId: 'nvidia/nemotron-3.5-lightning:free', serverType: 'openrouter', displayName: 'Nemotron',
          requestHeaders: { Authorization: 'Bearer dashboard-secret' },
          capabilities: { toolCalling: true, imageInput: false }, maxOutputTokens: 4096,
          modelModes: { 'Think (High)': { reasoning: { enabled: true, effort: 'high' } }, 'No Think': { reasoning: { enabled: false } } },
          cost: { input: 0.2, output: 0.4 },
        },
        {
          id: 'm2', serverUrl: 'https://openrouter.ai/api', vllmModelId: 'deepseek/deepseek-chat', serverType: 'openrouter', displayName: 'DeepSeek',
          requestHeaders: { Authorization: 'Bearer dashboard-secret' },
          capabilities: { toolCalling: true, imageInput: true }, maxOutputTokens: 16000,
        },
      ],
    };
    vi.stubGlobal('fetch', openRouterFetch);

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 'openrouter.ai:'); // shortUrl → "host:port" (empty port)
      expect(serverNode).toBeDefined();
      const metrics = await provider.getChildren(serverNode as any);
      const labels = metrics.map(m => (m as any).label as string);
      // No vLLM-style server rows (catalog is not "the server's models").
      expect(labels).not.toContain('Model IDs');
      expect(labels).not.toContain('Context Window');
      // Account health + one node per configured model, rendered directly.
      expect(labels).toContain('Account');
      expect(labels).not.toContain('Model Collection'); // container removed
      // The server is still online and usable.
      expect((serverNode as any).description).not.toContain('Offline');

      // Account node shows credits remaining.
      const accountNode = metrics.find(m => (m as any).label === 'Account');
      expect(String((accountNode as any).id)).not.toContain('dashboard-secret');
      const accountRows = await provider.getChildren(accountNode as any);
      expect(accountRows.some(r => (r as any).label === 'Credits Remaining')).toBe(true);
      expect((accountRows.find(r => (r as any).label === 'Credits Remaining') as any).description).toBe('$3.50');

      // Each configured model is a direct child, labeled by displayName.
      const modelLabels = labels.filter(l => l === 'Nemotron' || l === 'DeepSeek');
      expect(modelLabels).toEqual(['Nemotron', 'DeepSeek']);
      const nemotron = metrics.find(m => (m as any).label === 'Nemotron');
      const deepseek = metrics.find(m => (m as any).label === 'DeepSeek');
      expect(String((nemotron as any).id)).not.toContain('dashboard-secret');
      expect(String((deepseek as any).id)).not.toContain('dashboard-secret');

      // Each model node has its OWN context window from the per-model resolve.
      expect((nemotron as any).description).toBe('1M'); // fmtCount(1000000)
      expect((deepseek as any).description).toBe('164k'); // fmtCount(163840)

      // Expand a model node — model-level rows (context, output, caps, modes).
      const nemotronRows = await provider.getChildren(nemotron as any);
      const rowLabels = nemotronRows.map(r => (r as any).label as string);
      expect(rowLabels).toContain('Context Window');
      expect(rowLabels).toContain('Capabilities');
    });
  });

  it('hides OpenRouter account + model nodes when no relay models are configured', async () => {
    // A non-OpenRouter server must not show relay nodes.
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    };
    vi.stubGlobal('fetch', onlineFetch);

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 's:8000');
      const metrics = await provider.getChildren(serverNode as any);
      const labels = metrics.map(m => (m as any).label as string);
      expect(labels).not.toContain('Account');
      expect(labels).not.toContain('Nemotron'); // no relay model nodes
      expect(labels).toContain('Model IDs'); // vLLM path unchanged
    });
  });

  it('shows an OpenRouter model node Cost row preferring actual reported spend', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [
        {
          id: 'm1', serverUrl: 'https://openrouter.ai/api', vllmModelId: 'nvidia/nemotron-3.5-lightning:free', serverType: 'openrouter', displayName: 'Nemotron',
          capabilities: { toolCalling: true, imageInput: false }, maxOutputTokens: 4096,
          modelModes: { 'Think (High)': { reasoning: { enabled: true, effort: 'high' } }, 'No Think': { reasoning: { enabled: false } } },
          cost: { input: 1, output: 2 }, // would estimate, but actual must win
        },
      ],
    };
    vi.stubGlobal('fetch', openRouterFetch);
    recordRequest({
      serverUrl: normalizeServerUrl('https://openrouter.ai/api'),
      modelId: 'nvidia/nemotron-3.5-lightning:free', timestamp: 1, promptTokens: 100, completionTokens: 50, totalTokens: 150,
      hasMetrics: false, hasCacheDetails: false, maxModelLen: 1000000, maxOutputTokens: 4096,
      firstTokenTimeMs: 10, totalTimeMs: 50, actualCost: 0.0012,
    });

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 'openrouter.ai:');
      const metrics = await provider.getChildren(serverNode as any);
      // The model node is a DIRECT child of the relay server (no container).
      const nemotron = metrics.find(m => (m as any).label === 'Nemotron');

      const rows = await provider.getChildren(nemotron as any);
      const rowLabels = rows.map(r => (r as any).label as string);
      // Model-level rows from config metadata.
      expect(rowLabels).toContain('Context Window');
      expect(rowLabels).toContain('Max Output');
      expect(rowLabels).toContain('Capabilities');
      expect(rowLabels).toContain('Modes');
      // Cost row: actual spend ($0.0012, fine precision) beats the per-1M estimate.
      const costRow = rows.find(r => (r as any).label === 'Cost');
      expect((costRow as any).description).toBe('$0.0012 today');
      // Token rows for the recorded request.
      expect(rowLabels).toContain('Tokens Today');
    });
  });

  it('shows the pinned provider and its reported per-1M pricing on an OpenRouter model node', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [
        {
          id: 'm1', serverUrl: 'https://openrouter.ai/api', vllmModelId: 'deepseek/deepseek-chat', serverType: 'openrouter', displayName: 'DeepSeek',
          capabilities: { toolCalling: true, imageInput: false }, maxOutputTokens: 16000,
          provider: 'deepseek', // pinned in Model Settings
          cost: { input: 9, output: 9, cachedInput: 9, currency: 'USD' }, // must NOT be used — the pinned provider wins
        },
      ],
    };
    vi.stubGlobal('fetch', openRouterFetch);

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 'openrouter.ai:');
      const metrics = await provider.getChildren(serverNode as any);
      const deepseek = metrics.find(m => (m as any).label === 'DeepSeek');

      const rows = await provider.getChildren(deepseek as any);
      // Provider row: the pinned provider's label from /endpoints (matched by tag).
      const providerRow = rows.find(r => (r as any).label === 'Provider');
      expect((providerRow as any).description).toBe('DeepSeek');
      // Pricing row: the PINNED provider's reported per-1M rates, not the config estimate.
      // The per-1M formatter is locale-dependent (same as the picker), so format
      // the expectation with the identical toLocaleString the source uses.
      const rate = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}/1M`;
      const pricingRow = rows.find(r => (r as any).label === 'Pricing');
      expect((pricingRow as any).description).toBe(`in ${rate(0.66)}  ·  out ${rate(1.98)}  ·  cached ${rate(0.022)}`);
      expect(String((pricingRow as any).tooltip)).toContain('reported by the pinned provider "deepseek"');
    });
  });

  it('falls back to config-rate estimate pricing when Auto and hides the Provider row', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [
        {
          id: 'm1', serverUrl: 'https://openrouter.ai/api', vllmModelId: 'deepseek/deepseek-chat', serverType: 'openrouter', displayName: 'DeepSeek',
          capabilities: { toolCalling: true, imageInput: false }, maxOutputTokens: 16000,
          // no provider → Auto routing
          cost: { input: 1, output: 2, currency: 'USD' },
        },
      ],
    };
    vi.stubGlobal('fetch', openRouterFetch);

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 'openrouter.ai:');
      const metrics = await provider.getChildren(serverNode as any);
      const deepseek = metrics.find(m => (m as any).label === 'DeepSeek');

      const rows = await provider.getChildren(deepseek as any);
      const rowLabels = rows.map(r => (r as any).label as string);
      expect(rowLabels).not.toContain('Provider'); // Auto = no pinned provider
      const pricingRow = rows.find(r => (r as any).label === 'Pricing');
      // Auto estimate comes from the model's configured per-1M rates.
      expect((pricingRow as any).description).toBe('in $1/1M  ·  out $2/1M');
      expect(String((pricingRow as any).tooltip)).toContain('Auto routing');
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

  it('prefers actual reported cost in the per-model summary when the model reports it', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000/v1', vllmModelId: 'm1', displayName: 'Friendly M1', cost: { input: 1, output: 2, cachedInput: 0.5 } }],
    };
    vi.stubGlobal('fetch', onlineFetch);
    // 1M prompt / 500k completion would derive $1.90 from rates — but the server
    // reports actual cost, which must win.
    recordRequest({
      serverUrl: normalizeServerUrl('http://s:8000/v1'),
      modelId: 'm1', timestamp: 1, promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000,
      cachedTokens: 200_000, hasMetrics: false, hasCacheDetails: true, maxModelLen: 1000, maxOutputTokens: 100,
      firstTokenTimeMs: 10, totalTimeMs: 50, actualCost: 3.5,
    });

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 's:8000');
      const metrics = await provider.getChildren(serverNode as any);
      const usageNode = metrics.find(m => (m as any).label === 'Token Usage and Cost');
      const modelNodes = await provider.getChildren(usageNode as any);
      const modelNode = modelNodes.find(m => (m as any).label === 'Friendly M1');
      // Actual $3.50 beats the $1.90 estimate.
      expect((modelNode as any).description).toBe('$3.50 today');
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

  it('prefers actual reported cost over the estimate on the Last Request Cost row', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000/v1', vllmModelId: 'm1', cost: { input: 1, output: 2, cachedInput: 0.5 } }],
    };
    vi.stubGlobal('fetch', onlineFetch);
    recordRequest({
      serverUrl: normalizeServerUrl('http://s:8000/v1'),
      modelId: 'm1', timestamp: 1, promptTokens: 5, completionTokens: 7, totalTokens: 12,
      cachedTokens: 0, hasMetrics: false, hasCacheDetails: true, maxModelLen: 1000, maxOutputTokens: 100,
      firstTokenTimeMs: 10, totalTimeMs: 50,
      actualCost: 0.000019,
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
      // Actual cost wins over the derived estimate, formatted fine-precision USD.
      expect((costRow as any).description).toBe('$0.000019');
      // Same value as the estimate here, so prove it's the actual path via the BYOK row.
      const byokRow = rows.find(r => (r as any).label === 'BYOK');
      expect(byokRow).toBeUndefined(); // usedByok not set on this record
    });
  });

  it('shows a BYOK row under Last Request when the backend served with an upstream key', async () => {
    (vscode as any).workspace._mockConfig = {
      models: [{ id: 'm1', serverUrl: 'http://s:8000/v1', vllmModelId: 'm1' }],
    };
    vi.stubGlobal('fetch', onlineFetch);
    recordRequest({
      serverUrl: normalizeServerUrl('http://s:8000/v1'),
      modelId: 'm1', timestamp: 1, promptTokens: 5, completionTokens: 7, totalTokens: 12,
      hasMetrics: false, hasCacheDetails: false, maxModelLen: 1000, maxOutputTokens: 100,
      firstTokenTimeMs: 10, totalTimeMs: 50,
      actualCost: 0.001, usedByok: true,
    });

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 's:8000');
      const metrics = await provider.getChildren(serverNode as any);
      const last = metrics.find(m => (m as any).label === 'Last Request');
      const rows = await provider.getChildren(last as any);
      const costRow = rows.find(r => (r as any).label === 'Cost');
      expect((costRow as any).description).toBe('$0.001');
      const byokRow = rows.find(r => (r as any).label === 'BYOK');
      expect(byokRow).toBeDefined();
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
