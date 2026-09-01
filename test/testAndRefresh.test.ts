import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { groupModelsByServer, registerTestAndRefreshModelsCommand } from '../src/commands/testAndRefresh.js';
import * as diagnostics from '../src/diagnostics.js';
import type { ModelConfig } from '../src/config.js';

describe('groupModelsByServer', () => {
  it('groups models sharing the same server entry', () => {
    const models: ModelConfig[] = [
      { id: 'm1', server: 'srv' },
      { id: 'm2', server: 'srv' },
    ];
    const groups = groupModelsByServer(models, [{ id: 'srv', serverUrl: 'http://s:8000' }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].models).toHaveLength(2);
  });

  it('separates models on different server entries', () => {
    const models: ModelConfig[] = [
      { id: 'm1', server: 'a' },
      { id: 'm2', server: 'b' },
    ];
    const groups = groupModelsByServer(models, [
      { id: 'a', serverUrl: 'http://a:8000' },
      { id: 'b', serverUrl: 'http://b:8000' },
    ]);
    expect(groups).toHaveLength(2);
  });

  it('separates entries on one URL that use different headers', () => {
    const models: ModelConfig[] = [
      { id: 'm1', server: 's1' },
      { id: 'm2', server: 's2' },
    ];
    const groups = groupModelsByServer(models, [
      { id: 's1', serverUrl: 'http://srv:8000', requestHeaders: { 'X-Key': 'a' } },
      { id: 's2', serverUrl: 'http://srv:8000', requestHeaders: { 'X-Key': 'b' } },
    ]);
    expect(groups).toHaveLength(2);
  });

  it('groups URL spellings of one server together and probes the canonical form', () => {
    // Two registry entries whose URL spellings normalize to the same server
    // share a fingerprint, so one probe covers both — in canonical form.
    const models: ModelConfig[] = [
      { id: 'a', server: 'e1' },
      { id: 'b', server: 'e2' },
    ];
    const groups = groupModelsByServer(models, [
      { id: 'e1', serverUrl: 'http://s:8000' },
      { id: 'e2', serverUrl: 'http://s:8000/v1/' },
    ]);
    expect(groups).toHaveLength(1);
    // The group carries the URL the probe fetches through — canonical, so the
    // caller doesn't have to normalize again.
    expect(groups[0].serverUrl).toBe('http://s:8000');
  });

  it('gives each model with an unresolvable server ref its own group', () => {
    const models: ModelConfig[] = [
      { id: 'no-url-1', server: 'gone' },
      { id: 'no-url-2', server: 'gone' },
    ];
    const groups = groupModelsByServer(models, []);
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      expect(g.serverUrl).toBe('');
      expect(g.models).toHaveLength(1);
    }
  });

  it('mixes resolvable and dangling models correctly', () => {
    const models: ModelConfig[] = [
      { id: 'm1', server: 'srv' },
      { id: 'no-url', server: 'gone' },
      { id: 'm2', server: 'srv' },
    ];
    const groups = groupModelsByServer(models, [{ id: 'srv', serverUrl: 'http://s:8000' }]);
    // Two groups: one for the server, one for the dangling model
    const serverGroup = groups.find(g => g.serverUrl !== '');
    const noUrlGroup = groups.find(g => g.serverUrl === '');
    expect(serverGroup?.models).toHaveLength(2);
    expect(noUrlGroup?.models).toHaveLength(1);
  });
});

describe('registerTestAndRefreshModelsCommand', () => {
  let provider: any;
  let output: any;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warningSpy: ReturnType<typeof vi.spyOn>;
  let executeSpy: ReturnType<typeof vi.spyOn>;
  let fetchFn: ReturnType<typeof vi.fn>;
  let diagSpy: ReturnType<typeof vi.spyOn>;
  let formatSpy: ReturnType<typeof vi.spyOn>;

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  function run() {
    registerTestAndRefreshModelsCommand({} as any, provider, output);
    return (vscode as any).commands._run('vllm-copilot.testAndRefreshModels');
  }

    function configWith(models: any[]): any {
    // Auto-derive a registry: every distinct server ref in the fixtures probes
    // the canonical test URL, mirroring the real settings the command reads.
    const servers = [...new Set(models.map(m => m.server).filter(Boolean))].map(id => ({
      id,
      serverUrl: 'http://s:8000',
    }));
    return {
      get: (key: string) => (key === 'models' ? models : key === 'servers' ? servers : undefined),
    };
  }

  beforeEach(() => {
    (vscode as any).commands._registrations = [];
    provider = { clearCache: vi.fn() };
    output = { appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn(), hide: vi.fn() };
    infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    warningSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    executeSpy = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    diagSpy = vi.spyOn(diagnostics, 'runDiagnostics').mockResolvedValue({ conclusion: 'test report' } as diagnostics.DiagnosticReport);
    formatSpy = vi.spyOn(diagnostics, 'formatReport').mockReturnValue('formatted report');
    fetchFn = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal('fetch', fetchFn);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vscode.workspace._mockConfig = {};
  });

  it('offers to add a model when none are configured', async () => {
    vscode.workspace._mockConfig = configWith([]);
    infoSpy.mockResolvedValueOnce('Add vLLM Server & Model' as any);

    await run();

    expect(infoSpy).toHaveBeenCalledWith('No models are configured yet.', 'Add vLLM Server & Model');
    expect(executeSpy).toHaveBeenCalledWith('vllm-copilot.addServerModel');
    expect(provider.clearCache).not.toHaveBeenCalled();
  });

  it('reports a matching server as OK and clears the cache', async () => {
    vscode.workspace._mockConfig = configWith([{ id: 'm1', server: 'srv', vllmModelId: 's-model' }]);
    // The shared resolver re-fetches /v1/models for the context display, so
    // return a FRESH response per call (a shared Response would be consumed by the
    // first reader and break the second — Body is unusable).
    fetchFn.mockImplementation(async () => jsonResponse({ data: [{ id: 's-model', max_model_len: 100 }] }));

    await run();

    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/v1/models'), expect.anything());
    expect(infoSpy).toHaveBeenCalledWith('✓ http://s:8000 — s-model (100 ctx)');
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('fetches once per unique server for grouping, and the resolver supplies contexts', async () => {
    vscode.workspace._mockConfig = configWith([
      { id: 'm1', server: 'srv', vllmModelId: 'a' },
      { id: 'm2', server: 'srv', vllmModelId: 'b' },
    ]);
    fetchFn.mockImplementation(async () => jsonResponse({ data: [{ id: 'a', max_model_len: 100 }, { id: 'b', max_model_len: 200 }] }));

    await run();

    // Grouping /v1/models fetch happens once per unique server; the shared
    // resolver adds its own per-model context fetches.
    const groupingCalls = fetchFn.mock.calls.filter(([u]) => String(u).includes('/v1/models'));
    expect(groupingCalls.length).toBeGreaterThanOrEqual(1);
    expect(infoSpy).toHaveBeenCalledWith('✓ http://s:8000 — a, b (100 ctx)');
  });

  it('parks a config whose vllmModelId is not an exact served id (exact-only)', async () => {
    // A config for "Qwen/Qwen3.6-27B" against a server serving only
    // "Qwen/Qwen3.6-27B-FP8" violates the wire-id contract. Exact matching must
    // surface it as parked (no-match), NOT forgive it and report ✓ — the chat
    // request would be rejected by the server.
    vscode.workspace._mockConfig = configWith([{ id: 'm1', server: 'srv', vllmModelId: 'Qwen/Qwen3.6-27B' }]);
    fetchFn.mockImplementation(async () => jsonResponse({ data: [{ id: 'Qwen/Qwen3.6-27B-FP8', max_model_len: 100 }] }));

    await run();

    // No success popup — the config's chat request would be rejected by the server.
    // (clearCache always runs in a finally — it's the ✓ line that must not appear.)
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('✓ http://s:8000'));
  });

  it('matches a configured model to its exact served id', async () => {
    // Exact wire-id match: config vllmModelId === server served id.
    vscode.workspace._mockConfig = configWith([{ id: 'm1', server: 'srv', vllmModelId: 'Qwen/Qwen3.6-27B-FP8' }]);
    fetchFn.mockImplementation(async () => jsonResponse({ data: [{ id: 'Qwen/Qwen3.6-27B-FP8', max_model_len: 100 }] }));

    await run();

    expect(infoSpy).toHaveBeenCalledWith('✓ http://s:8000 — Qwen/Qwen3.6-27B-FP8 (100 ctx)');
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('reports parked models on a server that also has matches', async () => {
    vscode.workspace._mockConfig = configWith([
      { id: 'm1', server: 'srv', vllmModelId: 'a' },
      { id: 'm2', server: 'srv', vllmModelId: 'not-served' },
    ]);
    fetchFn.mockImplementation(async () => jsonResponse({ data: [{ id: 'a', max_model_len: 100 }] }));

    await run();

    // The server is OK, but the configured-but-not-served model must be surfaced
    // rather than silently dropped from the success report.
    expect(infoSpy).toHaveBeenCalledWith('✓ http://s:8000 — a (100 ctx) — parked: not-served');
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('does NOT report a matched model as healthy when its context cannot be resolved', async () => {
    // A llama.cpp /v1/models entry has no max_model_len → the shared resolver
    // throws. Test & Refresh must surface it as a warning, never a green ✓.
    vscode.workspace._mockConfig = configWith([{ id: 'm1', server: 'srv', vllmModelId: 'llama-model' }]);
    fetchFn.mockImplementation(async () => jsonResponse({ data: [{ id: 'llama-model', owned_by: 'llamacpp' }] }));

    await run();

    // No success popup — the model will not be served.
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('✓ http://s:8000'));
    // A warning names the server and the actionable resolver detail.
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('⚠ http://s:8000'),
    );
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('has no runtime context window'),
    );
    // And the WARN line in the output channel is still written.
    expect(output.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('no resolvable context'),
    );
  });

  it('reports an auth failure as a server error', async () => {
    vscode.workspace._mockConfig = configWith([{ id: 'm1', server: 'srv', vllmModelId: 's-model' }]);
    fetchFn.mockResolvedValue(jsonResponse({}, 401));

    await run();

    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('Authentication failed (HTTP 401)'));
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('offers a deep diagnostic when a server fails to connect', async () => {
    vscode.workspace._mockConfig = configWith([{ id: 'm1', server: 'srv', vllmModelId: 's-model' }]);
    fetchFn.mockRejectedValue(new Error('ECONNREFUSED'));
    warningSpy.mockResolvedValue('Run Diagnostic' as any); // 3b popup ignores its return; the offer consumes it

    await run();

    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    expect(warningSpy).toHaveBeenCalledWith(
      'One or more servers failed to connect. Run a deep diagnostic?', 'Run Diagnostic'
    );
    expect(diagSpy).toHaveBeenCalled();
    expect(formatSpy).toHaveBeenCalled();
    expect(output.show).toHaveBeenCalledWith(true);
  });

  it('warns about network gating settings on failure and offers Open Settings', async () => {
    vscode.workspace._mockConfig = {
      get: (key: string) =>
        key === 'models' ? [{ id: 'm1', server: 'srv', vllmModelId: 's-model' }]
        : key === 'servers' ? [{ id: 'srv', serverUrl: 'http://s:8000' }]
        : key === 'proxySupport' ? 'off'
        : undefined,
    };
    fetchFn.mockRejectedValue(new Error('ECONNREFUSED'));
    warningSpy.mockResolvedValue('Open Settings' as any);

    await run();

    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('network settings may be blocking the connection'), 'Open Settings'
    );
    expect(executeSpy).toHaveBeenCalledWith('workbench.action.openSettings', 'http.proxy');
  });

  it('hints to open Model Settings when a reachable server has no matching model', async () => {
    vscode.workspace._mockConfig = configWith([{ id: 'm1', server: 'srv', vllmModelId: 's-model' }]);
    fetchFn.mockResolvedValue(jsonResponse({ data: [{ id: 'other-model' }] }));
    warningSpy.mockResolvedValue('Open Model Settings' as any);

    await run();

    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('model(s) not configured in settings.json'), 'Open Model Settings'
    );
    expect(executeSpy).toHaveBeenCalledWith('vllm-copilot.serverSettings.focus');
  });

  it('reports models without a serverUrl individually', async () => {
    vscode.workspace._mockConfig = configWith([{ id: 'no-url' }]);

    await run();

    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('no resolvable server configured'));
  });

  it('offers a deep diagnostic for an unreachable server even when a server-less model precedes it', async () => {
    // Finding 1: the first 'error' result is the server-less model (no serverUrl).
    // The diagnostic must still target the unreachable server that follows it.
    // The server-less group performs no fetch; the s:8000 fetch (the only one) rejects.
    vscode.workspace._mockConfig = configWith([
      { id: 'no-url' },
      { id: 'm1', server: 'srv', vllmModelId: 's-model' },
    ]);
    fetchFn.mockRejectedValue(new Error('ECONNREFUSED'));
    warningSpy.mockResolvedValue('Run Diagnostic' as any);

    await run();

    expect(warningSpy).toHaveBeenCalledWith(
      'One or more servers failed to connect. Run a deep diagnostic?', 'Run Diagnostic'
    );
    expect(diagSpy).toHaveBeenCalledWith(
      expect.stringContaining('/v1/models'), expect.anything()
    );
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('reports a reachable server that served zero models (not silent)', async () => {
    // Finding 2: a no-match result with an empty model list must surface, not vanish.
    vscode.workspace._mockConfig = configWith([{ id: 'm1', server: 'srv', vllmModelId: 's-model' }]);
    fetchFn.mockResolvedValue(jsonResponse({ data: [] }));

    await run();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('reachable, but no models served')
    );
  });

  it('does not offer a network-gating warning for a server-less config', async () => {
    // Finding 3: a missing serverUrl is a configuration error, not a network failure.
    // Non-default proxy settings must not produce a misleading network warning.
    vscode.workspace._mockConfig = {
      get: (key: string) =>
        key === 'models' ? [{ id: 'no-url' }]
        : key === 'proxySupport' ? 'off'
        : undefined,
    };

    await run();

    expect(warningSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('network settings may be blocking the connection'), 'Open Settings'
    );
    expect(executeSpy).not.toHaveBeenCalledWith('workbench.action.openSettings', 'http.proxy');
  });

  it('still runs clearCache when the diagnostic rejects', async () => {
    // Finding 4: a diagnostic rejection must not escape and must not skip clearCache.
    vscode.workspace._mockConfig = configWith([{ id: 'm1', server: 'srv', vllmModelId: 's-model' }]);
    fetchFn.mockRejectedValue(new Error('ECONNREFUSED'));
    diagSpy.mockRejectedValueOnce(new Error('boom'));
    warningSpy.mockResolvedValue('Run Diagnostic' as any);

    await run();

    expect(diagSpy).toHaveBeenCalled();
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('[ERROR] Diagnostics failed unexpectedly'));
    expect(provider.clearCache).toHaveBeenCalled();
  });
});
