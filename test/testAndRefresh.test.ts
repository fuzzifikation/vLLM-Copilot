import { describe, it, expect, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerTestAndRefreshModelsCommand } from '../src/commands/testAndRefresh.js';
import { clearRuntimeLimitsCache } from '../src/backends/runtimeLimits.js';

/**
 * Test & Refresh pins for the hidden `contextWindow` repair flow. Real stack,
 * stubbed network: config reads via the vscode mock's `_mockConfig`, the REAL
 * backend resolver against a stubbed /v1/models (a row without max_model_len
 * throws MissingContextWindowError on its own), configStore writes captured on
 * the settings section's update().
 */
describe('testAndRefreshModels — context-window repair', () => {
  const fakeOutput = { appendLine: vi.fn(), show: vi.fn() } as any;
  const updateSpy = vi.fn((..._args: unknown[]) => Promise.resolve());

  const seedConfig = (models: unknown[], servers: unknown[]) => {
    vscode.workspace._mockConfig = {
      get: (key: string, def?: unknown) =>
        key === 'models' ? models : key === 'servers' ? servers : def,
      update: updateSpy,
    };
  };

  const stubServerModels = (rows: Array<Record<string, unknown>>) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) =>
      String(url).endsWith('/v1/models')
        ? new Response(JSON.stringify({ data: rows }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('{}', { status: 404 })
    ));
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearRuntimeLimitsCache();
    vscode.workspace._mockConfig = {};
    updateSpy.mockClear();
    vscode.commands._registrations.length = 0;
  });

  const run = async () => {
    registerTestAndRefreshModelsCommand({ clearCache: vi.fn() } as any, fakeOutput);
    await vscode.commands._run('vllm-copilot.testAndRefreshModels');
  };

  it('offers "Set Context Window" for a context-less model even when a sibling model is healthy', async () => {
    seedConfig(
      [
        { id: 'good', vllmModelId: 'good', server: 'gw' },
        { id: 'ghost', vllmModelId: 'ghost', server: 'gw' },
      ],
      [{ id: 'gw', serverUrl: 'http://gateway:8000' }],
    );
    stubServerModels([{ id: 'good', max_model_len: 4096 }, { id: 'ghost', owned_by: 'gateway' }]);

    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(
      (async (_message: string, ...items: (string | Record<string, unknown>)[]) =>
        (items.includes('Set Context Window') ? 'Set Context Window' : undefined)) as any,
    );
    const inputSpy = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('131072');

    await run();

    // The healthy model keeps its ✓ — and the broken one is NAMED on that same
    // line instead of hiding behind it.
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining(
      '✓ http://gateway:8000: good, ghost (4,096 ctx) (⚠ no context, not served: ghost)'
    ));
    // Finding #1 pin: the mixed server ALSO surfaces the ⚠ popup with the repair
    // action. Before the fix, only all-failed servers reached that popup, so a
    // healthy sibling silently stranded the broken model with no way to fix it.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ghost: Error: vLLM model "ghost" has no runtime context window'),
      'Set Context Window',
    );
    expect(inputSpy).toHaveBeenCalledTimes(1);

    // Finding #2 pin: the prompt rejects every value the resolver would reject
    // ('000'→0 and sub-50k floors used to sail through; there is deliberately
    // NO upper bound).
    const validate = inputSpy.mock.calls[0]?.[0]?.validateInput;
    expect(validate).toBeDefined();
    for (const bad of ['', '000', '2.5', '-4096', '40000', '50000', 'abc']) {
      expect(String(validate!('' + bad))).toContain('whole number');
    }
    expect(validate!('262144')).toBeUndefined();

    // The accepted answer persists onto the ghost entry as contextWindow.
    const write = updateSpy.mock.calls.find(([k]) => k === 'models');
    expect(write).toBeDefined();
    const saved = (write![1] as Array<{ id: string; contextWindow?: number }>).find(m => m.id === 'ghost');
    expect(saved?.contextWindow).toBe(131072);
  });

  it('leaves a fully compliant server untouched — no warning, no prompt, no write', async () => {
    seedConfig(
      [{ id: 'm1', vllmModelId: 'm1', server: 'ok' }],
      [{ id: 'ok', serverUrl: 'http://good:8000' }],
    );
    stubServerModels([{ id: 'm1', max_model_len: 8192 }]);

    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');
    const inputSpy = vi.spyOn(vscode.window, 'showInputBox');

    await run();

    // No-regression pin for good servers: exactly the old green line, zero new
    // popups, zero writes.
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('✓ http://good:8000: m1 (8,192 ctx)'));
    expect(warnSpy).not.toHaveBeenCalled();
    expect(inputSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('offers repair when EVERY model on the server lacks a context window', async () => {
    seedConfig(
      [{ id: 'ghost', vllmModelId: 'ghost', server: 'gw' }],
      [{ id: 'gw', serverUrl: 'http://gw2:8000' }],
    );
    stubServerModels([{ id: 'ghost', owned_by: 'gateway' }]);

    vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(
      (async (_message: string, ...items: (string | Record<string, unknown>)[]) =>
        (items.includes('Set Context Window') ? 'Set Context Window' : undefined)) as any,
    );
    const inputSpy = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('262144');

    await run();

    expect(inputSpy).toHaveBeenCalledTimes(1);
    const write = updateSpy.mock.calls.find(([k]) => k === 'models');
    const saved = write && (write[1] as Array<{ id: string; contextWindow?: number }>).find(m => m.id === 'ghost');
    expect(saved?.contextWindow).toBe(262144);
  });
});
