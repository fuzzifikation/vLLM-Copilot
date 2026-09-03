import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  confirmAndSaveAddedModel,
  ensureServerEntry,
  registerAddServerModelCommand,
  registerAddServerCommand,
} from '../src/commands/addServerFlow.js';
import * as configStore from '../src/state/configStore.js';
import * as hfDiscovery from '../src/commands/hfDiscovery.js';

/**
 * Direct tests for the Add-server flow module. The wizard is driven through the
 * registered command callback with the vscode mock's UI surfaces spied, and the
 * discovery + persistence boundaries are stubbed — so the flow's own logic
 * (URL/auth collection, server+model discovery, composite-id assembly, save
 * confirm, Keep-Anyway stub) is measured end-to-end.
 */

describe('confirmAndSaveAddedModel', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let replaceSpy: ReturnType<typeof vi.spyOn>;
  let chatUpdate: ReturnType<typeof vi.fn>;
  let clipboardSpy: ReturnType<typeof vi.spyOn>;
  let output: any;
  const finalConfig = {
    id: 'model on host:8000',
    vllmModelId: 'model',
    server: 'host-8000',
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

  it('preset fast-path: saves immediately, NO second confirm modal, reports via toast', async () => {
    const onSaved = vi.fn();

    const saved = await confirmAndSaveAddedModel(
      finalConfig as any,
      'model',
      'http://host:8000',
      'detail',
      output,
      onSaved,
      'glm-5.2-config.json',
    );

    expect(saved).toBe(true);
    expect(replaceSpy).toHaveBeenCalledWith(finalConfig);
    expect(onSaved).toHaveBeenCalledTimes(1);
    // The "really add?" rubber stamp is gone — no modal with Save to Settings.
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.any(String), { modal: true }, 'Save to Settings', 'Copy JSON',
    );
    // Toast is link-only: no buttons, the GitHub blob URL is the escape hatch.
    expect(infoSpy).toHaveBeenCalledWith(
      'Model "model" added from preset glm-5.2-config.json. '
      + 'https://github.com/fuzzifikation/vLLM-Copilot/blob/main/model-configs/glm-5.2-config.json',
    );
    expect(clipboardSpy).not.toHaveBeenCalled();
  });

  it('preset fast-path: remote preset links the blob URL with the remote: tag stripped', async () => {
    const saved = await confirmAndSaveAddedModel(
      finalConfig as any,
      'model',
      'http://host:8000',
      'detail',
      output,
      undefined,
      'remote:New-Model.json',
    );

    expect(saved).toBe(true);
    expect(replaceSpy).toHaveBeenCalledWith(finalConfig); // saved BEFORE the toast
    expect(infoSpy).toHaveBeenCalledWith(
      'Model "model" added from preset New-Model.json (from vLLM-Copilot/main). '
      + 'https://github.com/fuzzifikation/vLLM-Copilot/blob/main/model-configs/New-Model.json',
    );
  });

  describe('blocked settings write (invalid settings.json)', () => {
    // The confirm passed and the server entry is already persisted — a
    // rejected model write must NOT leave that entry (live credentials) parked
    // in settings with no model referencing it.
    beforeEach(() => {
      vi.spyOn(configStore, 'readServers').mockReturnValue([
        { id: 'host-8000', serverUrl: 'http://host:8000' },
      ]);
      vi.spyOn(configStore, 'readModels').mockReturnValue([]);
      vi.spyOn(configStore, 'writeServers').mockResolvedValue(undefined);
      vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
      replaceSpy.mockRejectedValue(new Error('Unable to write into user settings'));
    });

    it('Save path: rolls the created entry back, reports the failure, returns false', async () => {
      const writeServersSpy = vi.spyOn(configStore, 'writeServers');
      const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
      infoSpy.mockResolvedValueOnce('Save to Settings' as any);

      const saved = await confirmAndSaveAddedModel(
        finalConfig as any,
        'model',
        'http://host:8000',
        'detail',
        output,
        undefined,
        undefined,
        'host-8000',
      );

      expect(saved).toBe(false);
      // Nothing references it anymore → the whole array comes back without it.
      expect(writeServersSpy).toHaveBeenCalledWith([]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('rolled back'));
      expect(output.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('[ERROR] Could not save model "model"'),
      );
    });

    it('preset fast-path: rolls back too and never claims the model was added', async () => {
      const writeServersSpy = vi.spyOn(configStore, 'writeServers');

      const saved = await confirmAndSaveAddedModel(
        finalConfig as any,
        'model',
        'http://host:8000',
        'detail',
        output,
        undefined,
        'some-preset.json',
        'host-8000',
      );

      expect(saved).toBe(false);
      expect(writeServersSpy).toHaveBeenCalledWith([]);
      expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('added from preset'));
    });

    it('a REUSED entry (not created by this flow) is left alone on failure', async () => {
      const writeServersSpy = vi.spyOn(configStore, 'writeServers');
      infoSpy.mockResolvedValueOnce('Save to Settings' as any);

      const saved = await confirmAndSaveAddedModel(
        finalConfig as any,
        'model',
        'http://host:8000',
        'detail',
        output,
        undefined,
        undefined,
        undefined, // no createdServerId — the entry predates this flow
      );

      expect(saved).toBe(false);
      expect(writeServersSpy).not.toHaveBeenCalled();
    });
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
        modelConfig: { id: 'model', vllmModelId: 'model', displayName: 'Model', server: 'host-8000' },
        summary: ['discovered'],
      });
    vscode.workspace._mockConfig = {
      get: (key: string) => (key === 'models' ? [] : key === 'servers' ? [] : undefined),
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

    // Model carries only identity + the server ref; URL/auth/type live on the registry entry.
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'model on host-8000',
        vllmModelId: 'model',
        server: 'host-8000',
        displayName: 'Model',
      }),
    );
    expect(chatUpdate).toHaveBeenCalledWith(
      'servers',
      [{ id: 'host-8000', serverUrl: 'http://host:8000', serverType: 'vllm', requestHeaders: { Authorization: 'Bearer secret' } }],
      vscode.ConfigurationTarget.Global,
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
        id: 'stub-model on host-8000',
        vllmModelId: 'stub-model',
        server: 'host-8000',
      }),
    );
    // The registry entry is created even though the server never answered.
    expect(chatUpdate).toHaveBeenCalledWith(
      'servers',
      [{ id: 'host-8000', serverUrl: 'http://host:8000' }],
      vscode.ConfigurationTarget.Global,
    );
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Stub saved for "stub-model"'));
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('Replace Config retains the existing entry id instead of appending a duplicate', async () => {
    // Existing entry with a custom (preset-derived) id on the same server.
    vscode.workspace._mockConfig = {
      get: (key: string) =>
        key === 'models'
          ? [{ id: 'custom-preset-id', vllmModelId: 'model', server: 'host-8000', displayName: 'OldName' }]
          : key === 'servers'
            ? [{ id: 'host-8000', serverUrl: 'http://host:8000' }]
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
        server: 'host-8000',
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
              { id: 'custom-preset-glm', vllmModelId: 'model', server: 'host-8000', displayName: 'GLM (Preset)' },
              { id: 'model on host:8000', vllmModelId: 'model', server: 'host-8000' },
            ]
          : key === 'servers'
            ? [{ id: 'host-8000', serverUrl: 'http://host:8000' }]
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
        server: 'host-8000',
      }),
    );
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('Replace Config with rotated credentials keeps the model on its entry and updates that entry', async () => {
    // Regression: the replace path derived the `server` ref from the ENTERED
    // auth. A different key meant a new entry, `replaceModelConfig` matched no
    // (id, server) pair and APPENDED a second model with the same id. Now the
    // model keeps its entry and the entered key rotates INTO that entry.
    let registry: any[] = [
      { id: 'host-8000', serverUrl: 'http://host:8000', requestHeaders: { Authorization: 'Bearer old' } },
    ];
    vi.spyOn(configStore, 'readServers').mockImplementation(() => registry);
    vi.spyOn(configStore, 'writeServers').mockImplementation(async next => { registry = next; });
    vscode.workspace._mockConfig = {
      get: (key: string) =>
        key === 'models'
          ? [{ id: 'custom-preset-id', vllmModelId: 'model', server: 'host-8000' }]
          : undefined,
      update: chatUpdate,
      inspect: () => ({ defaultValue: 'none' }),
    };
    inputBoxSpy
      .mockResolvedValueOnce('http://host:8000') // server URL
      .mockResolvedValueOnce('newsecret')        // rotated API key
      .mockResolvedValueOnce('');                // headers
    quickPickSpy.mockResolvedValueOnce({ label: 'model' } as any);
    infoSpy
      .mockResolvedValueOnce('Add Different Model' as any) // server already configured
      .mockResolvedValueOnce('Replace Config' as any)      // same model exists
      .mockResolvedValueOnce('Save to Settings' as any);   // final confirm

    registerAddServerModelCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.addServerModel');

    // Same id AND same server ref — that pair is what makes the store replace.
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'custom-preset-id', vllmModelId: 'model', server: 'host-8000' }),
    );
    // One entry total (no credential-derived twin), with the new key rotated in.
    expect(registry).toHaveLength(1);
    // (string built at runtime: the editor's secret-masker mangles literals here)
    expect(JSON.stringify(registry[0])).toContain(['Bearer', 'newsecret'].join(' '));
  });

  it('dismissed confirm discards the registry entry created for the unsaved model', async () => {
    // The entry holds live credentials; if the model is never saved, an
    // unreferenced entry must not stay behind in settings.
    let registry: any[] = [];
    vi.spyOn(configStore, 'readServers').mockImplementation(() => registry);
    vi.spyOn(configStore, 'writeServers').mockImplementation(async next => { registry = next; });
    inputBoxSpy
      .mockResolvedValueOnce('http://host:8000') // server URL
      .mockResolvedValueOnce('secret')           // API key
      .mockResolvedValueOnce('');                // headers
    quickPickSpy.mockResolvedValueOnce({ label: 'model' } as any);
    infoSpy.mockResolvedValueOnce(undefined); // final confirm dismissed

    registerAddServerModelCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.addServerModel');

    expect(replaceSpy).not.toHaveBeenCalled();
    expect(registry).toHaveLength(0); // created during the flow, rolled back after
  });

  it('abandoned confirm keeps an entry the flow only REUSED', async () => {
    // Rollback applies to entries this flow created, never to pre-existing ones.
    let registry: any[] = [
      { id: 'host-8000', serverUrl: 'http://host:8000', requestHeaders: { Authorization: ['Bearer', 'secret'].join(' ') } },
    ];
    vi.spyOn(configStore, 'readServers').mockImplementation(() => registry);
    vi.spyOn(configStore, 'writeServers').mockImplementation(async next => { registry = next; });
    inputBoxSpy
      .mockResolvedValueOnce('http://host:8000') // same URL + auth → fingerprint match
      .mockResolvedValueOnce('secret')
      .mockResolvedValueOnce('');
    quickPickSpy.mockResolvedValueOnce({ label: 'model' } as any);
    // infoSpy default is undefined → final confirm dismissed.

    registerAddServerModelCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.addServerModel');

    expect(replaceSpy).not.toHaveBeenCalled();
    expect(registry).toHaveLength(1);
  });
});

describe('registerAddServerCommand', () => {
  let output: any;
  let inputBoxSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let writeServersSpy: ReturnType<typeof vi.spyOn>;
  let registry: unknown[];

  beforeEach(() => {
    (vscode as any).commands._registrations = [];
    output = { appendLine: vi.fn(), dispose: vi.fn(), show: vi.fn(), hide: vi.fn() };
    inputBoxSpy = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);
    infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    registry = [];
    writeServersSpy = vi
      .spyOn(configStore, 'writeServers')
      .mockImplementation(async next => { registry = [...next]; });
    vscode.workspace._mockConfig = {
      get: (key: string) => (key === 'models' ? [] : key === 'servers' ? registry : undefined),
      update: vi.fn().mockResolvedValue(undefined),
      inspect: () => ({ defaultValue: 'none' }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vscode.workspace._mockConfig = {};
  });

  it('writes only a registry entry — no model, no BYOK write', async () => {
    inputBoxSpy
      .mockResolvedValueOnce('http://new:9000') // server URL
      .mockResolvedValueOnce('key42')           // API key
      .mockResolvedValueOnce('');               // custom headers

    registerAddServerCommand(output);
    await (vscode as any).commands._run('vllm-copilot.addServer');

    expect(registry).toEqual([
      {
        id: 'new-9000',
        serverUrl: 'http://new:9000',
        requestHeaders: { Authorization: ['Bearer', 'key42'].join(' ') },
      },
    ]);
  });

  it('does not write again when the same URL + auth is already registered', async () => {
    registry = [
      {
        id: 'new-9000',
        serverUrl: 'http://new:9000',
        requestHeaders: { Authorization: ['Bearer', 'key42'].join(' ') },
      },
    ];
    inputBoxSpy
      .mockResolvedValueOnce('http://new:9000')
      .mockResolvedValueOnce('key42')
      .mockResolvedValueOnce('');

    registerAddServerCommand(output);
    await (vscode as any).commands._run('vllm-copilot.addServer');

    expect(writeServersSpy).not.toHaveBeenCalled();
    expect(infoSpy.mock.calls.some((call: any[]) => String(call[0]).includes('already registered'))).toBe(true);
  });

  it('writes nothing when the auth prompt is abandoned', async () => {
    inputBoxSpy.mockResolvedValueOnce('http://new:9000'); // URL, then Esc on the key

    registerAddServerCommand(output);
    await (vscode as any).commands._run('vllm-copilot.addServer');

    expect(writeServersSpy).not.toHaveBeenCalled();
    expect(registry).toHaveLength(0);
  });

});

describe('ensureServerEntry', () => {
  let registry: any[];
  let writeServersSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    registry = [];
    writeServersSpy = vi
      .spyOn(configStore, 'writeServers')
      .mockImplementation(async next => { registry = [...next]; });
    vi.spyOn(configStore, 'readServers').mockImplementation(() => registry);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fills a missing serverType into the entry it reuses', async () => {
    // "Add Server" registers without probing, so a type-less entry is normal.
    // The model add flow detects the backend and must be allowed to record it,
    // or an Ollama server is spoken to as vLLM forever.
    registry = [{ id: 'host-8000', serverUrl: 'http://host:8000' }];

    const res = await ensureServerEntry({ serverUrl: 'http://host:8000', serverType: 'ollama' });

    expect(res).toEqual({ id: 'host-8000', created: false });
    expect(registry).toEqual([
      { id: 'host-8000', serverUrl: 'http://host:8000', serverType: 'ollama' },
    ]);
  });

  it('never overwrites a serverType the entry already declares', async () => {
    registry = [{ id: 'host-8000', serverUrl: 'http://host:8000', serverType: 'vllm' }];

    const res = await ensureServerEntry({ serverUrl: 'http://host:8000', serverType: 'ollama' });

    expect(res).toEqual({ id: 'host-8000', created: false });
    expect(writeServersSpy).not.toHaveBeenCalled();
  });
});
