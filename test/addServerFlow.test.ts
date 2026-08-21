import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  pickModelFromServer,
  confirmAndSaveAddedModel,
  registerAddServerModelCommand,
} from '../src/commands/addServerFlow.js';
import * as configStore from '../src/configStore.js';
import * as hfDiscovery from '../src/commands/hfDiscovery.js';

/**
 * Direct tests for the Add-server flow module. The wizard is driven through the
 * registered command callback with the vscode mock's UI surfaces spied, and the
 * discovery + persistence boundaries are stubbed — so the flow's own logic
 * (URL/auth collection, server+model discovery, composite-id assembly, save
 * confirm, Keep-Anyway stub) is measured end-to-end.
 */
describe('pickModelFromServer', () => {
  let quickPickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    quickPickSpy = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the selected model id and formats ctx/root as description/detail', async () => {
    quickPickSpy.mockResolvedValueOnce({ label: 'model-2' } as any);

    const result = await pickModelFromServer(
      [
        { id: 'model-1', max_model_len: 8192 },
        { id: 'model-2', root: 'org/model-2' },
      ],
      'host:8000',
      'Add a model',
    );

    expect(result).toBe('model-2');
    const items = quickPickSpy.mock.calls[0][0] as vscode.QuickPickItem[];
    expect(items[0].description).toBe('8,192 ctx'); // en-US grouping is deterministic
    expect(items[0].detail).toBe('');
    expect(items[1].detail).toBe('root: org/model-2');
    expect(quickPickSpy.mock.calls[0][1]).toEqual(
      expect.objectContaining({ title: 'Add a model', placeHolder: 'Select a model on host:8000' }),
    );
  });

  it('returns undefined when the user cancels', async () => {
    const result = await pickModelFromServer([{ id: 'm' }], 'host');
    expect(result).toBeUndefined();
  });
});

describe('confirmAndSaveAddedModel', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let replaceSpy: ReturnType<typeof vi.spyOn>;
  let chatUpdate: ReturnType<typeof vi.fn>;
  let clipboardSpy: ReturnType<typeof vi.spyOn>;
  let output: any;
  const finalConfig = {
    id: 'model on http://host:8000',
    vllmModelId: 'model',
    serverUrl: 'http://host:8000',
  };

  beforeEach(() => {
    // Fresh output per test — a describe-scope object would leak appendLine
    // calls across tests.
    output = {
      appendLine: vi.fn(),
      dispose: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
    };
    infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    clipboardSpy = vi.spyOn(vscode.env.clipboard, 'writeText').mockResolvedValue(undefined);
    chatUpdate = vi.fn().mockResolvedValue(undefined);
    replaceSpy = vi
      .spyOn(configStore, 'replaceModelConfig')
      .mockResolvedValue({ model: finalConfig as any, created: true });
    vscode.workspace._mockConfig = {
      get: () => undefined,
      update: chatUpdate,
      inspect: () => ({ defaultValue: 'none' }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vscode.workspace._mockConfig = {};
  });

  it('persists + runs onSaved and shows the added toast on Save to Settings', async () => {
    infoSpy.mockResolvedValueOnce('Save to Settings' as any);
    const onSaved = vi.fn();

    const saved = await confirmAndSaveAddedModel(
      finalConfig as any,
      'model',
      'http://host:8000',
      'detail',
      output,
      onSaved,
    );

    expect(saved).toBe(true);
    expect(replaceSpy).toHaveBeenCalledWith(finalConfig);
    // BYOK write happens (chat config) after the model write.
    expect(chatUpdate).toHaveBeenCalledWith(
      'byokUtilityModelDefault',
      'mainAgent',
      vscode.ConfigurationTarget.Global,
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('Model "model" added.');
  });

  it('copies the JSON to the clipboard and persists nothing on Copy JSON', async () => {
    infoSpy.mockResolvedValueOnce('Copy JSON' as any);

    const saved = await confirmAndSaveAddedModel(
      finalConfig as any,
      'model',
      'http://host:8000',
      'detail',
      output,
    );

    expect(saved).toBe(false);
    expect(clipboardSpy).toHaveBeenCalledWith(JSON.stringify(finalConfig, null, 2));
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(chatUpdate).not.toHaveBeenCalled();
  });

  it('logs to the output channel when the confirm modal is dismissed instead of failing silently', async () => {
    const warningSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    infoSpy.mockResolvedValueOnce(undefined); // modal dismissed

    const saved = await confirmAndSaveAddedModel(
      finalConfig as any,
      'model',
      'http://host:8000',
      'detail',
      output,
    );

    expect(saved).toBe(false);
    expect(replaceSpy).not.toHaveBeenCalled();
    // No error popup — the outcome is logged to the output channel instead.
    expect(warningSpy).not.toHaveBeenCalled();
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('[INFO] Model add cancelled'));
    warningSpy.mockRestore();
  });
});

describe('registerAddServerModelCommand', () => {
  const provider = { clearCache: vi.fn() } as any;
  let output: any;
  let inputBoxSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let quickPickSpy: ReturnType<typeof vi.spyOn>;
  let warningSpy: ReturnType<typeof vi.spyOn>;
  let replaceSpy: ReturnType<typeof vi.spyOn>;
  let resolveSpy: ReturnType<typeof vi.spyOn>;
  let chatUpdate: ReturnType<typeof vi.fn>;
  let fetchFn: ReturnType<typeof vi.fn>;

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    (vscode as any).commands._registrations = [];
    // Fresh output per test — a describe-scope object would leak appendLine
    // calls across tests.
    output = {
      appendLine: vi.fn(),
      dispose: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
    };
    inputBoxSpy = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);
    infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    quickPickSpy = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    warningSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    chatUpdate = vi.fn().mockResolvedValue(undefined);
    replaceSpy = vi
      .spyOn(configStore, 'replaceModelConfig')
      .mockResolvedValue({ model: { id: 'x' } as any, created: true });
    resolveSpy = vi
      .spyOn(hfDiscovery, 'resolveModelConfigForAddSafely')
      .mockResolvedValue({
        modelConfig: { id: 'model', vllmModelId: 'model', displayName: 'Model' },
        summary: ['discovered'],
      });
    vscode.workspace._mockConfig = {
      get: (key: string) => (key === 'models' ? [] : undefined),
      update: chatUpdate,
      inspect: () => ({ defaultValue: 'none' }),
    };
    fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'model', root: 'org/model', max_model_len: 100 }] });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchFn);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vscode.workspace._mockConfig = {};
  });

  it('runs the full happy path: URL + auth → discovery → picker → save with composite id', async () => {
    inputBoxSpy
      .mockResolvedValueOnce('http://host:8000') // server URL
      .mockResolvedValueOnce('secret')            // API key
      .mockResolvedValueOnce('');                 // custom headers
    quickPickSpy.mockResolvedValueOnce({ label: 'model' } as any);
    infoSpy.mockResolvedValue('Save to Settings' as any);

    registerAddServerModelCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.addServerModel');

    // Discovery hit the server with the per-server auth headers.
    const vllmCall = fetchFn.mock.calls.find(([u]) => String(u).endsWith('/v1/models'));
    expect(vllmCall).toBeDefined();
    const [, init] = vllmCall as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');

    expect(resolveSpy).toHaveBeenCalledWith(
      expect.anything(), // output channel
      expect.anything(), // extension context
      'model', 'http://host:8000', { Authorization: 'Bearer secret' }, 'org/model',
      undefined, // no baseConfig (add-server path)
      'vllm',   // detected backend type passed into auto-discovery
    );

    // Composite id + serverUrl + detected serverType + suggested tokens.
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'model on host:8000',
        vllmModelId: 'model',
        serverUrl: 'http://host:8000',
        serverType: 'vllm',
        requestHeaders: { Authorization: 'Bearer secret' },
        displayName: 'Model',
      }),
    );
    expect(chatUpdate).toHaveBeenCalled(); // BYOK bootstrap ran
    expect(provider.clearCache).toHaveBeenCalled(); // onSaved
    expect(infoSpy).toHaveBeenCalledWith('Model "model" added.');
  });

  it('saves a minimal stub via Keep Anyway when the server is unreachable', async () => {
    inputBoxSpy
      .mockResolvedValueOnce('http://host:8000')
      .mockResolvedValueOnce('')  // API key
      .mockResolvedValueOnce('')  // headers
      .mockResolvedValueOnce('stub-model'); // Keep-Anyway model id
    fetchFn.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    warningSpy.mockResolvedValueOnce('Keep Anyway' as any);

    registerAddServerModelCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.addServerModel');

    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cannot connect to http://host:8000'),
      expect.anything(),
      'Discard',
      'Run Diagnostic',
      'Keep Anyway',
    );
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'stub-model on host:8000',
        vllmModelId: 'stub-model',
        serverUrl: 'http://host:8000',
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Stub saved for "stub-model"'));
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('appends the http.systemCertificatesNode fix to the failure modal on a TLS error', async () => {
    inputBoxSpy
      .mockResolvedValueOnce('https://host:8000') // server URL
      .mockResolvedValueOnce('')                  // API key
      .mockResolvedValueOnce('');                 // headers
    // A reverse-proxy TLS failure (missing intermediate) — must surface the fix.
    fetchFn.mockRejectedValueOnce(new Error('unable to verify the first certificate'));
    warningSpy.mockResolvedValueOnce('Discard' as any);

    registerAddServerModelCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.addServerModel');

    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('http.systemCertificatesNode'),
      expect.anything(),
      'Discard',
      'Run Diagnostic',
      'Keep Anyway',
    );
    // The raw TLS cause is still present alongside the fix.
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('unable to verify the first certificate'),
      expect.anything(),
      'Discard',
      'Run Diagnostic',
      'Keep Anyway',
    );
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('Replace Config retains the existing entry id instead of appending a duplicate', async () => {
    // Existing entry with a custom (preset-derived) id on the same server.
    vscode.workspace._mockConfig = {
      get: (key: string) =>
        key === 'models'
          ? [{ id: 'custom-preset-id', vllmModelId: 'model', serverUrl: 'http://host:8000', displayName: 'OldName' }]
          : undefined,
      update: chatUpdate,
      inspect: () => ({ defaultValue: 'none' }),
    };
    inputBoxSpy
      .mockResolvedValueOnce('http://host:8000') // server URL
      .mockResolvedValueOnce('')                 // API key
      .mockResolvedValueOnce('');                // headers
    quickPickSpy.mockResolvedValueOnce({ label: 'model' } as any);
    infoSpy
      .mockResolvedValueOnce('Add Different Model' as any) // server already configured
      .mockResolvedValueOnce('Replace Config' as any)      // same model exists
      .mockResolvedValueOnce('Save to Settings' as any);   // final confirm

    registerAddServerModelCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.addServerModel');

    // The composite id would not match resolveConfigId('custom-preset-id'), so
    // replaceModelConfig would append. Replacing must carry the existing id.
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'custom-preset-id',
        vllmModelId: 'model',
        serverUrl: 'http://host:8000',
      }),
    );
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('disambiguates via picker when multiple configs share the chosen model', async () => {
    // Two entries on the same server expose the same wire id but keep distinct
    // extension ids (a preset-derived entry + a discovered composite entry).
    vscode.workspace._mockConfig = {
      get: (key: string) =>
        key === 'models'
          ? [
              { id: 'custom-preset-glm', vllmModelId: 'model', serverUrl: 'http://host:8000', displayName: 'GLM (Preset)' },
              { id: 'model on host:8000', vllmModelId: 'model', serverUrl: 'http://host:8000' },
            ]
          : undefined,
      update: chatUpdate,
      inspect: () => ({ defaultValue: 'none' }),
    };
    inputBoxSpy
      .mockResolvedValueOnce('http://host:8000') // server URL
      .mockResolvedValueOnce('')                 // API key
      .mockResolvedValueOnce('');                // headers
    // Model picker, then the disambiguator: the user selects the SECOND entry
    // (the composite) rather than the preset that .find() would take first.
    quickPickSpy
      .mockResolvedValueOnce({ label: 'model' } as any)
      .mockResolvedValueOnce({ label: 'model on host:8000', description: 'model on host:8000' } as any);
    infoSpy
      .mockResolvedValueOnce('Add Different Model' as any) // server already configured
      .mockResolvedValueOnce('Replace Config' as any)      // same model exists
      .mockResolvedValueOnce('Save to Settings' as any);   // final confirm

    registerAddServerModelCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.addServerModel');

    // The disambiguator ran, listing both candidates.
    expect(quickPickSpy).toHaveBeenCalledTimes(2);
    expect(quickPickSpy).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([expect.objectContaining({ description: 'model on host:8000' })]),
      expect.anything(),
    );
    // The selected (second) entry is replaced, not the first .find() match.
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'model on host:8000',
        vllmModelId: 'model',
        serverUrl: 'http://host:8000',
      }),
    );
    expect(provider.clearCache).toHaveBeenCalled();
  });
});
