import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { serverFingerprint, groupModelsByServer } from '../src/commands.js';
import { registerTestAndRefreshModelsCommand } from '../src/commands/testAndRefresh.js';
import * as diagnostics from '../src/diagnostics.js';
import type { ModelConfig } from '../src/config.js';

describe('serverFingerprint', () => {
  it('produces same fingerprint for same URL + headers', () => {
    const a = serverFingerprint('http://host:8000', { Authorization: 'Bearer x', 'X-Custom': 'val' });
    const b = serverFingerprint('http://host:8000', { 'X-Custom': 'val', Authorization: 'Bearer x' });
    expect(a).toBe(b);
  });

  it('differs when URL changes', () => {
    const a = serverFingerprint('http://a:8000', {});
    const b = serverFingerprint('http://b:8000', {});
    expect(a).not.toBe(b);
  });

  it('differs when headers change', () => {
    const a = serverFingerprint('http://host:8000', { Authorization: 'Bearer x' });
    const b = serverFingerprint('http://host:8000', { Authorization: 'Bearer y' });
    expect(a).not.toBe(b);
  });

  it('stably serialises empty headers', () => {
    const a = serverFingerprint('http://host:8000', {});
    const b = serverFingerprint('http://host:8000', {});
    expect(a).toBe(b);
  });
});

describe('groupModelsByServer', () => {
  // Mock helpers passed as arguments.
  const resolveServer = (m: ModelConfig) => ({
    serverUrl: (m.serverUrl || '').replace(/\/+$/, ''),
    requestHeaders: (m as any)._headers ?? {},
  });
  const resolveId = (m: ModelConfig) => m.id;

  it('groups models sharing the same URL and headers', () => {
    const models: ModelConfig[] = [
      { id: 'm1', serverUrl: 'http://s:8000' },
      { id: 'm2', serverUrl: 'http://s:8000' },
    ];
    const groups = groupModelsByServer(models, resolveServer, resolveId);
    expect(groups).toHaveLength(1);
    expect(groups[0].models).toHaveLength(2);
  });

  it('separates models with different URLs', () => {
    const models: ModelConfig[] = [
      { id: 'm1', serverUrl: 'http://a:8000' },
      { id: 'm2', serverUrl: 'http://b:8000' },
    ];
    const groups = groupModelsByServer(models, resolveServer, resolveId);
    expect(groups).toHaveLength(2);
  });

  it('separates models with same URL but different headers', () => {
    const models: ModelConfig[] = [
      { id: 'm1', serverUrl: 'http://s:8000', _headers: { 'X-Key': 'a' } },
      { id: 'm2', serverUrl: 'http://s:8000', _headers: { 'X-Key': 'b' } },
    ] as any;
    const groups = groupModelsByServer(models, resolveServer, resolveId);
    expect(groups).toHaveLength(2);
  });

  it('normalises URL differences via the resolver (trailing slash)', () => {
    const resolveServerStrip = (m: ModelConfig) => ({
      serverUrl: (m.serverUrl || '').replace(/\/+$/, ''),
      requestHeaders: {},
    });
    const models: ModelConfig[] = [
      { id: 'a', serverUrl: 'http://s:8000' },
      { id: 'b', serverUrl: 'http://s:8000/' },
    ];
    const groups = groupModelsByServer(models, resolveServerStrip, resolveId);
    expect(groups).toHaveLength(1);
  });

  it('gives each model without a serverUrl its own group', () => {
    const models: ModelConfig[] = [
      { id: 'no-url-1' },
      { id: 'no-url-2' },
    ];
    const groups = groupModelsByServer(models, resolveServer, resolveId);
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      expect(g.serverUrl).toBe('');
      expect(g.models).toHaveLength(1);
    }
  });

  it('mixes serverful and serverless models correctly', () => {
    const models: ModelConfig[] = [
      { id: 'm1', serverUrl: 'http://s:8000' },
      { id: 'no-url' },
      { id: 'm2', serverUrl: 'http://s:8000' },
    ];
    const groups = groupModelsByServer(models, resolveServer, resolveId);
    // Two groups: one for the server, one for the serverless model
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
    return { get: (key: string) => (key === 'models' ? models : undefined) };
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
    vscode.workspace._mockConfig = configWith([{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 's-model' }]);
    fetchFn.mockResolvedValue(jsonResponse({ data: [{ id: 's-model', max_model_len: 100 }] }));

    await run();

    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/v1/models'), expect.anything());
    expect(infoSpy).toHaveBeenCalledWith('✓ http://s:8000 — s-model (100 ctx)');
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('fetches once per unique server and lists all matched models', async () => {
    vscode.workspace._mockConfig = configWith([
      { id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'a' },
      { id: 'm2', serverUrl: 'http://s:8000', vllmModelId: 'b' },
    ]);
    fetchFn.mockResolvedValue(jsonResponse({ data: [{ id: 'a', max_model_len: 100 }, { id: 'b', max_model_len: 200 }] }));

    await run();

    expect(fetchFn).toHaveBeenCalledTimes(1); // one fetch per unique server, not per model
    expect(infoSpy).toHaveBeenCalledWith('✓ http://s:8000 — a, b (100 ctx)');
  });

  it('matches a configured model to its quantized server variant', async () => {
    // A config for "Qwen/Qwen3.6-27B" must match a server serving the
    // quantized "Qwen/Qwen3.6-27B-FP8" (same org, quantization suffix). Strict
    // wire-id matching parked this as unmatched and offered re-adoption.
    vscode.workspace._mockConfig = configWith([{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'Qwen/Qwen3.6-27B' }]);
    fetchFn.mockResolvedValue(jsonResponse({ data: [{ id: 'Qwen/Qwen3.6-27B-FP8', max_model_len: 100 }] }));

    await run();

    expect(infoSpy).toHaveBeenCalledWith('✓ http://s:8000 — Qwen/Qwen3.6-27B (100 ctx)');
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('reports parked models on a server that also has matches', async () => {
    vscode.workspace._mockConfig = configWith([
      { id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 'a' },
      { id: 'm2', serverUrl: 'http://s:8000', vllmModelId: 'not-served' },
    ]);
    fetchFn.mockResolvedValue(jsonResponse({ data: [{ id: 'a', max_model_len: 100 }] }));

    await run();

    // The server is OK, but the configured-but-not-served model must be surfaced
    // rather than silently dropped from the success report.
    expect(infoSpy).toHaveBeenCalledWith('✓ http://s:8000 — a (100 ctx) — parked: not-served');
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('reports an auth failure as a server error', async () => {
    vscode.workspace._mockConfig = configWith([{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 's-model' }]);
    fetchFn.mockResolvedValue(jsonResponse({}, 401));

    await run();

    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('Authentication failed (HTTP 401)'));
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('offers a deep diagnostic when a server fails to connect', async () => {
    vscode.workspace._mockConfig = configWith([{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 's-model' }]);
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
        key === 'models' ? [{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 's-model' }]
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

  it('hints to open Server Settings when a reachable server has no matching model', async () => {
    vscode.workspace._mockConfig = configWith([{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 's-model' }]);
    fetchFn.mockResolvedValue(jsonResponse({ data: [{ id: 'other-model' }] }));
    warningSpy.mockResolvedValue('Open Server Settings' as any);

    await run();

    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('model(s) not configured in settings.json'), 'Open Server Settings'
    );
    expect(executeSpy).toHaveBeenCalledWith('vllm-copilot.serverSettings.focus');
  });

  it('reports models without a serverUrl individually', async () => {
    vscode.workspace._mockConfig = configWith([{ id: 'no-url' }]);

    await run();

    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('no serverUrl configured'));
  });

  it('offers a deep diagnostic for an unreachable server even when a server-less model precedes it', async () => {
    // Finding 1: the first 'error' result is the server-less model (no serverUrl).
    // The diagnostic must still target the unreachable server that follows it.
    // The server-less group performs no fetch; the s:8000 fetch (the only one) rejects.
    vscode.workspace._mockConfig = configWith([
      { id: 'no-url' },
      { id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 's-model' },
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
    vscode.workspace._mockConfig = configWith([{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 's-model' }]);
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
    vscode.workspace._mockConfig = configWith([{ id: 'm1', serverUrl: 'http://s:8000', vllmModelId: 's-model' }]);
    fetchFn.mockRejectedValue(new Error('ECONNREFUSED'));
    diagSpy.mockRejectedValueOnce(new Error('boom'));
    warningSpy.mockResolvedValue('Run Diagnostic' as any);

    await run();

    expect(diagSpy).toHaveBeenCalled();
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('[ERROR] Diagnostics failed unexpectedly'));
    expect(provider.clearCache).toHaveBeenCalled();
  });
});
