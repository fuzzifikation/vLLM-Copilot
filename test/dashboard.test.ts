import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { DashboardTreeProvider } from '../src/dashboard.js';
import { recordRequest, resetUsageStoreForTests } from '../src/usageStore.js';
import { normalizeServerUrl, sanitizeRequestHeaders, serverFingerprint } from '../src/config.js';
import { getMetricsEngine } from '../src/vllmMetrics.js';
import { resetOpenRouterProviderListCache } from '../src/openRouter.js';

/**
 * Dashboard tree-provider tests.
 *
 * Exercises the provider (not the metrics engine, which is covered in
 * vllmMetrics.test.ts): tree structure, the visibility/epoch subscription
 * lifecycle, and the offline/online metric rendering. Global fetch is stubbed
 * so the polling engine's first tick completes quickly against fake endpoints.
 */

/**
 * Registry shim for the flat legacy fixtures below: splits models that still
 * carry serverUrl/requestHeaders/serverType/serverDisplayName into
 * { models (server refs), servers (registry entries) }. Entries key on
 * URL + sanitized headers + type — the registry's fingerprint semantics — so
 * multi-identity fixtures stay separate entries.
 */
function regFix(cfg: any): any {
  const models: any[] = cfg.models ?? [];
  const entries: Array<Record<string, any>> = [];
  const migrated = models.map((m: any) => {
    if (!m || typeof m !== 'object' || m.server || !m.serverUrl) return m;
    const headers = m.requestHeaders as Record<string, string> | undefined;
    const key = serverFingerprint(normalizeServerUrl(m.serverUrl), sanitizeRequestHeaders(headers ?? {})) + '|' + (m.serverType ?? '');
    let entry = entries.find(e => e.__key === key);
    if (!entry) {
      const slug = String(m.serverUrl).replace(/^[a-zA-Z]+:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'srv';
      let id = slug;
      for (let n = 2; entries.some(e => e.id === id); n++) id = `${slug}-${n}`;
      entry = {
        __key: key,
        id,
        serverUrl: m.serverUrl,
        ...(headers ? { requestHeaders: headers } : {}),
        ...(m.serverType ? { serverType: m.serverType } : {}),
        ...(m.serverDisplayName ? { displayName: m.serverDisplayName } : {}),
      };
      entries.push(entry);
    }
    const { serverUrl: _u, requestHeaders: _h, serverType: _t, serverDisplayName: _d, ...rest } = m;
    return { ...rest, server: entry.id };
  });
  const { models: _models, ...rest } = cfg;
  return { ...rest, models: migrated, servers: entries.map(({ __key: _k, ...e }) => e) };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fetch stub that makes every endpoint unreachable (no answer at all). */
const offlineFetch = vi.fn(async () => { throw new TypeError('fetch failed'); });

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
  if (u.endsWith('/v1/key')) return jsonResponse({ data: { label: 'my-key', limit: 10, limit_remaining: 3.5, usage: 100, usage_monthly: 4, usage_weekly: 2, usage_daily: 1, byok_usage: 0, byok_usage_monthly: 0, is_free_tier: false, expires_at: '2027-01-15T00:00:00Z', limit_reset: '2026-09-01T00:00:00Z' } });
  if (u.endsWith('/v1/credits')) return jsonResponse({ data: { total_credits: 10, total_usage: 3.5 } });
  if (u.includes('/endpoints')) {
    const id = decodeURIComponent(u.split('/v1/models/')[1]?.split('/endpoints')[0] ?? '');
    if (id === 'deepseek/deepseek-chat') {
      return jsonResponse({ data: { id, endpoints: [
        { tag: 'deepseek', provider_name: 'DeepSeek', quantization: 'unknown', status: 0, uptime_last_1d: 99.97, pricing: { prompt: '0.00000066', completion: '0.00000198', input_cache_read: '0.000000022' } },
        { tag: 'alibaba', provider_name: 'Alibaba', quantization: 'unknown', status: 0, uptime_last_1d: 99.8, pricing: { prompt: '0.000000726', completion: '0.000002178' } },
      ] } });
    }
    if (id === 'author/degraded') {
      return jsonResponse({ data: { id, endpoints: [
        { tag: 'slow', provider_name: 'SlowNet', quantization: 'fp8', status: -2, uptime_last_1d: 91.4, pricing: { prompt: '0.0000005', completion: '0.0000015' } },
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
    resetOpenRouterProviderListCache();
    provider = makeProvider();
  });

  afterEach(() => {
    provider.dispose();
    vi.unstubAllGlobals();
    (vscode as any).workspace._mockConfig = {};
    resetUsageStoreForTests();
  });

  it('shows poll interval, add, and refresh items with no servers configured', async () => {
    (vscode as any).workspace._mockConfig = regFix({ models: [] });

    const labels = await rootLabels(provider);

    expect(labels).toContain('Refresh Interval');
    expect(labels).toContain('Add or Reconfigure Server/Model');
    expect(labels).toContain('Test & Refresh Models');
    expect(labels).toHaveLength(3);
  });

  it('setVisible(true) subscribes configured servers and lists them', async () => {
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    });
    vi.stubGlobal('fetch', offlineFetch);

    provider.setVisible(true);
    await settle();

    const labels = await rootLabels(provider);
    expect(labels).toContain('s:8000');
  });

  it('shows an offline server with an Error child', async () => {
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    });
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
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    });
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
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    });
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
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    });
    vi.stubGlobal('fetch', offlineFetch);

    provider.setVisible(true);
    provider.setVisible(true);
    await settle();

    const labels = await rootLabels(provider);
    expect(labels.filter(l => l === 's:8000')).toHaveLength(1);
  });

  it('a rebuilt subscription shows the reload state, not the retired identity\'s readings', async () => {
    // Teardown-then-rebuild is what a settings change does. Between the two the
    // view must never present the OLD identity's numbers as if they were the
    // new one's — and it must say so immediately rather than waiting for the
    // first cycle to finish (which is up to the 5s timeout when the server is
    // unreachable).
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    });
    vi.stubGlobal('fetch', onlineFetch);
    provider.setVisible(true);
    await settle();
    const before = (await provider.getChildren()).find(c => (c as any).label === 's:8000');
    expect(await provider.getChildren(before as any)).not.toHaveLength(1); // real metrics, not one error row

    // Same URL, new credentials = a new identity. Nothing answers it yet.
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1', requestHeaders: { Authorization: '******' } }],
    });
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    provider.setVisible(false);
    provider.setVisible(true);
    await settle();

    const after = (await provider.getChildren()).find(c => (c as any).label === 's:8000');
    expect(after).toBeDefined();
    const children = await provider.getChildren(after as any);
    expect((children[0] as any).description).toBe('Loading…');
  });

  it('a retired identity releases its engine instead of keeping it warm', async () => {
    // The engine is reference-counted, so with the dashboard as its only viewer
    // a rebuild must dispose the old engine AND drop it from the registry —
    // otherwise it polls a no-longer-configured identity forever in the
    // background and hands its stale cache to whatever comes next.
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://retired:8000', vllmModelId: 'm1' }],
    });
    vi.stubGlobal('fetch', onlineFetch);
    provider.setVisible(true);
    await settle();

    const first = getMetricsEngine('http://retired:8000', {}, 'vllm', ['m1']);
    expect(first.getCachedAggregated()?.online).toBe(true);

    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://retired:8000', vllmModelId: 'm1', requestHeaders: { Authorization: '******' } }],
    });
    provider.setVisible(false);
    provider.setVisible(true);
    await settle();

    // The old identity's slot is empty: a lookup now builds a fresh engine with
    // no cached readings and no poller.
    const reopened = getMetricsEngine('http://retired:8000', {}, 'vllm', ['m1']);
    expect(reopened).not.toBe(first);
    expect(reopened.getCachedAggregated()).toBeNull();
  });

  it('treats two header identities on one URL as separate server nodes', async () => {
    // Per-model credentials: two models share a URL but carry different keys.
    // They are DIFFERENT logical servers — each must get its own node, probed
    // with its own credentials (never the first model's headers for the other).
    (vscode as any).workspace._mockConfig = regFix({
      models: [
        { id: 'a', serverUrl: 'http://gw:8000', vllmModelId: 'm-a', requestHeaders: { Authorization: 'Bearer secret-a' } },
        { id: 'b', serverUrl: 'http://gw:8000', vllmModelId: 'm-b', requestHeaders: { Authorization: 'Bearer secret-b' } },
      ],
    });
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

  it('shows a configured serverDisplayName instead of the URL', async () => {
    (vscode as any).workspace._mockConfig = regFix({
      models: [
        { id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1', serverDisplayName: 'IT Server for GLM5.2' },
      ],
    });
    vi.stubGlobal('fetch', offlineFetch);

    provider.setVisible(true);
    await settle();

    const labels = await rootLabels(provider);
    expect(labels).toContain('IT Server for GLM5.2');
    expect(labels).not.toContain('s:8000');
  });

  it('keeps identity suffixes when renamed identities share one URL', async () => {
    // The `(identity N)` suffix keys off URL-sharing credential groups — never
    // off label equality — so two identically-NAMED identities stay distinct.
    (vscode as any).workspace._mockConfig = regFix({
      models: [
        { id: 'a', serverUrl: 'http://gw:8000', vllmModelId: 'm-a', requestHeaders: { Authorization: 'Bearer secret-a' }, serverDisplayName: 'Gateway' },
        { id: 'b', serverUrl: 'http://gw:8000', vllmModelId: 'm-b', requestHeaders: { Authorization: 'Bearer secret-b' }, serverDisplayName: 'Gateway' },
      ],
    });
    vi.stubGlobal('fetch', offlineFetch);

    provider.setVisible(true);
    await settle();

    const labels = await rootLabels(provider);
    expect(labels).toContain('Gateway (identity 1)');
    expect(labels).toContain('Gateway (identity 2)');
  });

  it('ignores serverDisplayName on OpenRouter relays and marks them Relay', async () => {
    // The fixed openrouter.ai endpoint is not renamable — a hand-edited name
    // must not render, and the node carries the Relay context value so the
    // Rename Server menu entry is hidden for it.
    (vscode as any).workspace._mockConfig = regFix({
      models: [{
        id: 'or1', serverUrl: 'https://openrouter.ai/api', vllmModelId: 'deepseek/deepseek-chat',
        serverType: 'openrouter', displayName: 'DeepSeek', serverDisplayName: 'My Relay',
      }],
    });
    vi.stubGlobal('fetch', openRouterFetch);

    provider.setVisible(true);
    await settle();

    const children = await provider.getChildren();
    const serverNode = children.find(c => (c as any).label === 'openrouter.ai');
    expect(serverNode).toBeDefined();
    expect((serverNode as any).contextValue).toBe('serverOnlineRelay');
    const labels = children.map(c => (c as any).label as string);
    expect(labels).not.toContain('My Relay');
  });

  it('treats a whitespace-only hand-edited display name as unset', async () => {
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1', serverDisplayName: '   ' }],
    });
    vi.stubGlobal('fetch', offlineFetch);

    provider.setVisible(true);
    await settle();

    const labels = await rootLabels(provider);
    expect(labels).toContain('s:8000');
    expect(labels).not.toContain('   ');
  });

  it('renders online server metric rows from a completed poll', async () => {
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    });
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
    (vscode as any).workspace._mockConfig = regFix({
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
    });
    vi.stubGlobal('fetch', openRouterFetch);

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 'openrouter.ai'); // shortUrl omits empty port
      expect(serverNode).toBeDefined();
      const metrics = await provider.getChildren(serverNode as any);
      const labels = metrics.map(m => (m as any).label as string);
      // No vLLM-style server rows (catalog is not "the server's models").
      expect(labels).not.toContain('Model IDs');
      expect(labels).not.toContain('Context Window');
      // Account health + one node per configured model, rendered directly.
      expect(labels).toContain('Account');
      expect(labels).not.toContain('Model Collection'); // container removed
      // The server is still online and usable — and shows NO description behind it
      // (a relay has no running/waiting-request gauges, so "idle" would be fake).
      expect((serverNode as any).description).toBeUndefined();

      // Account node shows credits remaining.
      const accountNode = metrics.find(m => (m as any).label === 'Account');
      expect(String((accountNode as any).id)).not.toContain('dashboard-secret');
      const accountRows = await provider.getChildren(accountNode as any);
      expect(accountRows.some(r => (r as any).label === 'Credits Remaining')).toBe(true);
      expect((accountRows.find(r => (r as any).label === 'Credits Remaining') as any).description).toBe('$3.50');
      // Total budget from /api/v1/credits — the account-level money.
      expect((accountRows.find(r => (r as any).label === 'Invested Total') as any).description).toBe('$10.00');
      expect((accountRows.find(r => (r as any).label === 'Available') as any).description).toBe('$6.50');
      // Total Used is arithmetic (Invested − Available) — deliberately not a row.
      expect(accountRows.some(r => (r as any).label === 'Total Used')).toBe(false);
      // Account node collapsed description prefers the available budget.
      expect((accountNode as any).description).toBe('$6.50 available');

      // Each configured model is a direct child, labeled by displayName.
      const modelLabels = labels.filter(l => l === 'Nemotron' || l === 'DeepSeek');
      expect(modelLabels).toEqual(['Nemotron', 'DeepSeek']);
      const nemotron = metrics.find(m => (m as any).label === 'Nemotron');
      const deepseek = metrics.find(m => (m as any).label === 'DeepSeek');
      expect(String((nemotron as any).id)).not.toContain('dashboard-secret');
      expect(String((deepseek as any).id)).not.toContain('dashboard-secret');

      // Model nodes show NO collapsed description — the context window at a glance
      // isn't intuitive; neither model has a pinned provider, so nothing is shown.
      expect((nemotron as any).description).toBeUndefined();
      expect((deepseek as any).description).toBeUndefined();

      // Expand a model node — model-level rows (context+output, caps).
      const nemotronRows = await provider.getChildren(nemotron as any);
      const rowLabels = nemotronRows.map(r => (r as any).label as string);
      expect(rowLabels).toContain('Context Window');
      expect(rowLabels).toContain('Capabilities');
    });
  });

  it('shows an Attention icon on a relay model whose output budget is clamped', async () => {
    // The DeepSeek catalog entry has context_length 163840 → the effective
    // output ceiling is 10% = 16384. Configuring a 200000 budget means the
    // budget is clamped to the ceiling → the node must carry the Attention icon
    // with an explanatory tooltip. The Nemotron (1M ctx → 81920 ceiling) with a
    // modest 4096 budget is NOT clamped → no icon.
    (vscode as any).workspace._mockConfig = regFix({
      models: [
        {
          id: 'm1', serverUrl: 'https://openrouter.ai/api', vllmModelId: 'deepseek/deepseek-chat', serverType: 'openrouter', displayName: 'DeepSeek',
          requestHeaders: { Authorization: 'Bearer dashboard-secret' },
          maxOutputTokens: 200000,
        },
        {
          id: 'm2', serverUrl: 'https://openrouter.ai/api', vllmModelId: 'nvidia/nemotron-3.5-lightning:free', serverType: 'openrouter', displayName: 'Nemotron',
          requestHeaders: { Authorization: 'Bearer dashboard-secret' },
          maxOutputTokens: 4096,
        },
      ],
    });
    vi.stubGlobal('fetch', openRouterFetch);

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 'openrouter.ai');
      const metrics = await provider.getChildren(serverNode as any);

      const deepseek = metrics.find(m => (m as any).label === 'DeepSeek') as any;
      const nemotron = metrics.find(m => (m as any).label === 'Nemotron') as any;

      // Clamped model → Alert icon (yellow), explanatory tooltip.
      expect(deepseek.iconPath?.id).toBe('alert');
      expect(String(deepseek.iconPath?.color?.id)).toBe('charts.yellow');
      const dsTooltip = String(deepseek.tooltip?.value ?? '');
      expect(dsTooltip).toContain('clamped');
      expect(dsTooltip).toContain('200,000');      // configured
      expect(dsTooltip).toContain('16,384');       // effective (10% of 163840)

      // Unclamped model → normal icon, no attention.
      expect(nemotron.iconPath?.id).toBe('symbol-class');
      expect(String(nemotron.tooltip?.value ?? '')).not.toContain('clamped');
    });
  });

  it('hides OpenRouter account + model nodes when no relay models are configured', async () => {
    // A non-OpenRouter server must not show relay nodes.
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    });
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
    (vscode as any).workspace._mockConfig = regFix({
      models: [
        {
          id: 'm1', serverUrl: 'https://openrouter.ai/api', vllmModelId: 'nvidia/nemotron-3.5-lightning:free', serverType: 'openrouter', displayName: 'Nemotron',
          capabilities: { toolCalling: true, imageInput: false }, maxOutputTokens: 4096,
          modelModes: { 'Think (High)': { reasoning: { enabled: true, effort: 'high' } }, 'No Think': { reasoning: { enabled: false } } },
          cost: { input: 1, output: 2 }, // would estimate, but actual must win
        },
      ],
    });
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
      const serverNode = children.find(c => (c as any).label === 'openrouter.ai');
      const metrics = await provider.getChildren(serverNode as any);
      // The model node is a DIRECT child of the relay server (no container).
      const nemotron = metrics.find(m => (m as any).label === 'Nemotron');

      const rows = await provider.getChildren(nemotron as any);
      const rowLabels = rows.map(r => (r as any).label as string);
      // Model-level rows from config metadata. Context and Output are one row now.
      expect(rowLabels).toContain('Context Window');
      expect(rowLabels).not.toContain('Max Output'); // merged into Context Window
      const ctxRow = rows.find(r => (r as any).label === 'Context Window');
      expect((ctxRow as any).description).toBe('Total 1M  ·  Output 4k'); // fmtCount(1000000) + fmtCount(4096)
      expect(rowLabels).toContain('Capabilities');
      expect(rowLabels).toContain('Modes');
      // Cost row: actual spend (fine precision) beats the per-1M estimate. One
      // recorded request → same figure in both today and all-time slots.
      const costRow = rows.find(r => (r as any).label === 'Cost');
      expect((costRow as any).description).toBe('$0.0012 today and $0.0012 total');
      // Token rows for the recorded request.
      expect(rowLabels).toContain('Tokens Today');
    });
  });

  it('shows the pinned provider and its reported per-1M pricing on an OpenRouter model node', async () => {
    (vscode as any).workspace._mockConfig = regFix({
      models: [
        {
          id: 'm1', serverUrl: 'https://openrouter.ai/api', vllmModelId: 'deepseek/deepseek-chat', serverType: 'openrouter', displayName: 'DeepSeek',
          capabilities: { toolCalling: true, imageInput: false }, maxOutputTokens: 16000,
          provider: 'deepseek', // pinned in Model Settings
          cost: { input: 9, output: 9, cachedInput: 9, currency: 'USD' }, // must NOT be used — the pinned provider wins
        },
      ],
    });
    vi.stubGlobal('fetch', openRouterFetch);

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 'openrouter.ai');
      const metrics = await provider.getChildren(serverNode as any);
      const deepseek = metrics.find(m => (m as any).label === 'DeepSeek');

      const rows = await provider.getChildren(deepseek as any);
      // Provider row: the pinned provider's label from /endpoints (matched by tag),
      // plus the reported 1-day uptime percentage.
      const providerRow = rows.find(r => (r as any).label === 'Provider');
      expect((providerRow as any).description).toBe('DeepSeek  ·  99.97% uptime');
      // Provider is the FIRST row; the collapsed model description shows the
      // routing identity as "<model> run by <provider>".
      expect(rows[0]).toBe(providerRow);
      expect((deepseek as any).description).toBe('run by DeepSeek');
      // Pricing (1M) row: the PINNED provider's reported per-1M rates, no /1M suffix.
      // Formatting is locale-independent (en-US forced) — hardcode the expectation.
      const pricingRow = rows.find(r => (r as any).label === 'Pricing (1M)');
      expect((pricingRow as any).description).toBe('in $0.66  ·  out $1.98  ·  cached $0.022');
      expect(String((pricingRow as any).tooltip)).toContain('reported by the pinned provider "deepseek"');
    });
  });

  it('shows the pinned provider limits (context + output) on an OpenRouter model node', async () => {
    // The pinned provider's endpoint reports a smaller window/output than the
    // general catalog envelope — the row must show the PINNED provider's limits
    // (display-only; never persisted, never clamped) so the user sees what the
    // pinned provider actually serves.
    const limitedFetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'deepseek/deepseek-v3.2', context_length: 163840 }] });
      }
      if (u.includes('/endpoints')) {
        return jsonResponse({ data: { id: 'deepseek/deepseek-v3.2', endpoints: [
          { tag: 'sambanova-turbo', provider_name: 'SambaNova', context_length: 32768, max_completion_tokens: 7168, status: 0, uptime_last_1d: 99.5 },
        ] } });
      }
      if (u.endsWith('/v1/key')) return jsonResponse({ data: {} });
      return new Response(null, { status: 404 });
    });
    (vscode as any).workspace._mockConfig = regFix({
      models: [
        {
          id: 'm1', serverUrl: 'https://openrouter.ai/api', vllmModelId: 'deepseek/deepseek-v3.2', serverType: 'openrouter', displayName: 'DeepSeek',
          maxOutputTokens: 8192,
          provider: 'sambanova-turbo',
        },
      ],
    });
    vi.stubGlobal('fetch', limitedFetch);

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 'openrouter.ai');
      const metrics = await provider.getChildren(serverNode as any);
      const model = metrics.find(m => (m as any).label === 'DeepSeek');

      const rows = await provider.getChildren(model as any);
      const providerRow = rows.find(r => (r as any).label === 'Provider');
      // Pinned provider label + uptime + its OWN limits (context 32.8k, output 7.2k).
      expect((providerRow as any).description).toBe('SambaNova  ·  99.50% uptime  ·  33k ctx  ·  7k out');
      expect(String((providerRow as any).tooltip)).toContain('Pinned provider limits');
      expect(String((providerRow as any).tooltip)).toContain('32,768 context');
      expect(String((providerRow as any).tooltip)).toContain('7,168 max output');
    });
  });

  it('shows an Attention icon when a PINNED provider cap is below the configured budget', async () => {
    // The catalog ceiling is generous (deepseek-v3.2 → 16384 effective), so the
    // general clamp does NOT bind. But the pinned provider (SambaNova) reports a
    // 7168 cap — BELOW the configured 8192. Symmetric rule: the provider cap is a
    // real constraint, so the node must show the Attention icon and name the
    // provider in the tooltip (as a "may fail" — NOT a silent clamp).
    const pinnedFetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'deepseek/deepseek-v3.2', context_length: 163840 }] });
      }
      if (u.includes('/endpoints')) {
        return jsonResponse({ data: { id: 'deepseek/deepseek-v3.2', endpoints: [
          { tag: 'sambanova-turbo', provider_name: 'SambaNova', max_completion_tokens: 7168, context_length: 32768 },
        ] } });
      }
      if (u.endsWith('/v1/key')) return jsonResponse({ data: {} });
      return new Response(null, { status: 404 });
    });
    (vscode as any).workspace._mockConfig = regFix({
      models: [
        {
          id: 'm1', serverUrl: 'https://openrouter.ai/api', vllmModelId: 'deepseek/deepseek-v3.2', serverType: 'openrouter', displayName: 'DeepSeek',
          requestHeaders: { Authorization: 'Bearer dashboard-secret' },
          maxOutputTokens: 8192,
          provider: 'sambanova-turbo', // pinned
        },
      ],
    });
    vi.stubGlobal('fetch', pinnedFetch);

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 'openrouter.ai');
      const metrics = await provider.getChildren(serverNode as any);
      const model = metrics.find(m => (m as any).label === 'DeepSeek') as any;

      // Provider cap binds below the catalog ceiling → Attention icon.
      expect(model.iconPath?.id).toBe('alert');
      expect(String(model.iconPath?.color?.id)).toBe('charts.yellow');
      const tooltip = String(model.tooltip?.value ?? '');
      expect(tooltip).toContain('clamped');
      expect(tooltip).toContain('8,192');       // configured
      expect(tooltip).toContain('7,168');       // effective (pinned provider cap)
      // Honest wording: this is a provider cap → "may fail", names SambaNova.
      expect(tooltip).toContain('SambaNova');
      expect(tooltip).toContain('may **fail**');
    });
  });

  it('shows a red status dot and uptime for a degraded pinned provider', async () => {
    (vscode as any).workspace._mockConfig = regFix({
      models: [
        {
          id: 'm1', serverUrl: 'https://openrouter.ai/api', vllmModelId: 'author/degraded', serverType: 'openrouter', displayName: 'Degraded',
          capabilities: { toolCalling: true, imageInput: false }, maxOutputTokens: 16000,
          provider: 'slow',
        },
      ],
    });
    vi.stubGlobal('fetch', openRouterFetch);

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 'openrouter.ai');
      const metrics = await provider.getChildren(serverNode as any);
      const model = metrics.find(m => (m as any).label === 'Degraded');

      const rows = await provider.getChildren(model as any);
      const providerRow = rows.find(r => (r as any).label === 'Provider');
      // Status -2 = degraded → red dot icon; uptime shown as percentage.
      expect((providerRow as any).description).toBe('SlowNet (fp8)  ·  91.40% uptime');
      const icon = (providerRow as any).iconPath as any;
      expect(icon?.id).toBe('circle-filled');
      expect(String(icon?.color?.id)).toBe('charts.red');
    });
  });

  it('falls back to config-rate estimate pricing when Auto and hides the Provider row', async () => {
    (vscode as any).workspace._mockConfig = regFix({
      models: [
        {
          id: 'm1', serverUrl: 'https://openrouter.ai/api', vllmModelId: 'deepseek/deepseek-chat', serverType: 'openrouter', displayName: 'DeepSeek',
          capabilities: { toolCalling: true, imageInput: false }, maxOutputTokens: 16000,
          // no provider → Auto routing
          cost: { input: 1, output: 2, currency: 'USD' },
        },
      ],
    });
    vi.stubGlobal('fetch', openRouterFetch);

    provider.setVisible(true);

    await vi.waitFor(async () => {
      const children = await provider.getChildren();
      const serverNode = children.find(c => (c as any).label === 'openrouter.ai');
      const metrics = await provider.getChildren(serverNode as any);
      const deepseek = metrics.find(m => (m as any).label === 'DeepSeek');

      const rows = await provider.getChildren(deepseek as any);
      const rowLabels = rows.map(r => (r as any).label as string);
      expect(rowLabels).not.toContain('Provider'); // Auto = no pinned provider
      const pricingRow = rows.find(r => (r as any).label === 'Pricing (1M)');
      // Auto estimate comes from the model's configured per-1M rates.
      expect((pricingRow as any).description).toBe('in $1  ·  out $2');
      expect(String((pricingRow as any).tooltip)).toContain('Auto routing');
    });
  });

  it('shows Last Request for a server configured with a non-canonical URL (normalized lookup)', async () => {
    // consumeStream writes the store keyed by the NORMALIZED server URL; the
    // dashboard's node carries the raw `model.serverUrl`. A /v1 form must still
    // find its Last Request entry (regression: the node silently vanished).
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000/v1', vllmModelId: 'm1' }],
    });
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
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    });
    vi.stubGlobal('fetch', offlineFetch);

    provider.setVisible(true);
    await settle();
    expect(await rootLabels(provider)).toContain('s:8000');

    provider.dispose();
    expect(await rootLabels(provider)).not.toContain('s:8000');
  });

  it('shows a Token Usage and Cost node with per-model Today/Overall rows and derived cost', async () => {
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000/v1', vllmModelId: 'm1', displayName: 'Friendly M1', cost: { input: 1, output: 2, cachedInput: 0.5 } }],
    });
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
      // fresh 800k×$1 + cached 200k×$0.5 + out 500k×$2 = $1.90. Derived from the
      // one recorded request → same figure in both today and all-time slots.
      expect((modelNode as any).description).toBe('$1.90 today and $1.90 total');
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
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000/v1', vllmModelId: 'm1', displayName: 'Friendly M1', cost: { input: 1, output: 2, cachedInput: 0.5 } }],
    });
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
      // Actual $3.50 beats the $1.90 estimate. One recorded request → same in
      // today and total slots.
      expect((modelNode as any).description).toBe('$3.50 today and $3.50 total');
    });
  });

  it('shows a Cost row under Last Request when the model has cost rates', async () => {
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000/v1', vllmModelId: 'm1', cost: { input: 1, output: 2, cachedInput: 0.5 } }],
    });
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
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000/v1', vllmModelId: 'm1', cost: { input: 1, output: 2, cachedInput: 0.5 } }],
    });
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
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000/v1', vllmModelId: 'm1' }],
    });
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
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000/v1', vllmModelId: 'm1' }],
    });
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
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1', serverType: 'llamacpp' }],
    });
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
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1', serverType: 'ollama' }],
    });
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
    (vscode as any).workspace._mockConfig = regFix({
      models: [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'm1' }],
    });
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
