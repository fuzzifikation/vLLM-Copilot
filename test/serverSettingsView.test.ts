import * as vscode from 'vscode';
import { ServerSettingsViewProvider, resolveDetectedServerType, serverGroupKey } from '../src/serverSettingsView.js';
import { serverFingerprint } from '../src/commands.js';
import { ModelConfig } from '../src/config.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('ServerSettingsViewProvider', () => {
  let provider: ServerSettingsViewProvider;
  let mockContext: any;
  let mockOutputChannel: any;
  let mockConfig: ModelConfig[];

  beforeEach(() => {
    mockConfig = [];
    mockOutputChannel = {
      appendLine: vi.fn(),
      dispose: vi.fn(),
    };

    mockContext = {
      extensionUri: vscode.Uri.joinPath(vscode.Uri.file('.'), 'extension'),
      subscriptions: [],
      secrets: {
        get: () => Promise.resolve(undefined),
        store: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
    };

    // Spy on window.showInformationMessage
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    provider = new ServerSettingsViewProvider(mockContext, mockOutputChannel);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('saveModelConfig', () => {
    it('should update an existing model entry', async () => {
      const existingConfig: ModelConfig[] = [
        {
          id: 'test-model',
          vllmModelId: 'test-model',
          serverUrl: 'http://localhost:8000',
          displayName: 'Old Name',
        },
      ];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      const updates: Partial<ModelConfig> = {
        displayName: 'New Name',
        serverUrl: 'http://localhost:8000',
        vllmModelId: 'test-model',
        id: 'test-model',
      };

      // Access private method via any cast for testing
      await (provider as any).saveModelConfig(updates);

      expect(vscode.workspace._mockConfig.update).toHaveBeenCalledWith(
        'models',
        expect.arrayContaining([
          expect.objectContaining({
            id: 'test-model',
            displayName: 'New Name',
          }),
        ]),
        vscode.ConfigurationTarget.Global,
      );

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Settings saved for "New Name"',
      );
    });

    it('should create a new model entry when not found (composite id like other creation paths)', async () => {
      const existingConfig: ModelConfig[] = [];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      // The webview stub sends the raw server id as both id and vllmModelId.
      const updates: Partial<ModelConfig> = {
        id: 'new-model',
        vllmModelId: 'new-model',
        serverUrl: 'http://localhost:8000',
        displayName: 'New Model',
      };

      await (provider as any).saveModelConfig(updates);

      expect(vscode.workspace._mockConfig.update).toHaveBeenCalledWith(
        'models',
        expect.arrayContaining([
          expect.objectContaining({
            id: 'new-model on localhost:8000',
            vllmModelId: 'new-model',
            serverUrl: 'http://localhost:8000',
            displayName: 'New Model',
          }),
        ]),
        vscode.ConfigurationTarget.Global,
      );

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Settings saved for "New Model"',
      );
    });

    it('P1: same model saved via webview on two servers gets distinct ids (no duplicate id)', async () => {
      const existingConfig: ModelConfig[] = [];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (provider as any).saveModelConfig({
        id: 'qwen-7b',
        vllmModelId: 'qwen-7b',
        serverUrl: 'http://a:8000',
      });
      const afterFirst = vscode.workspace._mockConfig.update.mock.calls[0][1];

      vscode.workspace._mockConfig.get = (key: string) => (key === 'models' ? afterFirst : undefined);
      await (provider as any).saveModelConfig({
        id: 'qwen-7b',
        vllmModelId: 'qwen-7b',
        serverUrl: 'http://b:8000',
      });
      const afterSecond = vscode.workspace._mockConfig.update.mock.calls[1][1];

      expect(afterSecond).toHaveLength(2);
      expect(new Set(afterSecond.map((m: any) => m.id)).size).toBe(2);
      expect(afterSecond[0].id).toBe('qwen-7b on a:8000');
      expect(afterSecond[1].id).toBe('qwen-7b on b:8000');
    });

    it('should preserve existing properties when updating', async () => {
      const existingConfig: ModelConfig[] = [
        {
          id: 'test-model',
          vllmModelId: 'test-model',
          serverUrl: 'http://localhost:8000',
          displayName: 'Test Model',
          maxOutputTokens: 4096,
          modelModes: {
            coding: { temperature: 0.1 },
          },
        },
      ];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      const updates: Partial<ModelConfig> = {
        displayName: 'Updated Name',
        serverUrl: 'http://localhost:8000',
        vllmModelId: 'test-model',
        id: 'test-model',
      };

      await (provider as any).saveModelConfig(updates);

      const callArgs = vscode.workspace._mockConfig.update.mock.calls[0];
      const updatedModels = callArgs[1];

      expect(updatedModels[0]).toEqual(
        expect.objectContaining({
          id: 'test-model',
          displayName: 'Updated Name',
          maxOutputTokens: 4096,
          modelModes: { coding: { temperature: 0.1 } },
        }),
      );
    });

    it('should handle fallback to id when vllmModelId is missing', async () => {
      const existingConfig: ModelConfig[] = [
        {
          id: 'fallback-model',
          serverUrl: 'http://localhost:8000',
        },
      ];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      const updates: Partial<ModelConfig> = {
        id: 'fallback-model',
        serverUrl: 'http://localhost:8000',
        displayName: 'Fallback Model',
      };

      await (provider as any).saveModelConfig(updates);

      expect(vscode.workspace._mockConfig.update).toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Settings saved for "Fallback Model"',
      );
    });

    it('should show info message with vllmModelId when displayName is missing', async () => {
      const existingConfig: ModelConfig[] = [];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      const updates: Partial<ModelConfig> = {
        id: 'no-display-name',
        vllmModelId: 'no-display-name',
        serverUrl: 'http://localhost:8000',
      };

      await (provider as any).saveModelConfig(updates);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Settings saved for "no-display-name"',
      );
    });

    it('P1 clear: deletes an empty systemMessageReplacementsFile instead of storing ""', async () => {
      const existingConfig: ModelConfig[] = [
        {
          id: 'test-model',
          vllmModelId: 'test-model',
          serverUrl: 'http://localhost:8000',
          systemMessageReplacementsFile: 'C:/some/personalities/tough-love.json',
        },
      ];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      // The webview posts an empty string when "Default (no personality)" is chosen.
      await (provider as any).saveModelConfig({
        id: 'test-model',
        vllmModelId: 'test-model',
        serverUrl: 'http://localhost:8000',
        systemMessageReplacementsFile: '',
      });

      const stored = vscode.workspace._mockConfig.update.mock.calls[0][1];
      expect(stored).toHaveLength(1);
      expect('systemMessageReplacementsFile' in stored[0]).toBe(false);
    });

    // ── Step 2: patch-mode characterization (refactor-plan §4.1 #3/#5 + side effects) ──
    // Pins the CURRENT patch contract of serverSettingsView.saveModelConfig so the
    // configStore unification (step 3b) cannot silently change behavior.

    it('P2: preserves headers, family, defaults, and transport settings when the patch omits them', async () => {
      const existingConfig: ModelConfig[] = [
        {
          id: 'test-model',
          vllmModelId: 'test-model',
          serverUrl: 'http://localhost:8000',
          displayName: 'Test Model',
          requestHeaders: { 'X-Auth': 'secret' },
          family: 'qwen3_5',
          defaultParams: { temperature: 0.7 },
          defaultMode: 'balanced',
          streamInactivityTimeout: 60000,
          autoContinueRetries: 2,
          maxOutputTokens: 4096,
          modelModes: { balanced: { temperature: 0.5 } },
        },
      ];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (provider as any).saveModelConfig({
        id: 'test-model',
        vllmModelId: 'test-model',
        serverUrl: 'http://localhost:8000',
        displayName: 'Renamed',
      });

      const stored = vscode.workspace._mockConfig.update.mock.calls[0][1];
      expect(stored).toHaveLength(1);
      // Patch is a shallow merge — fields absent from the patch survive.
      expect(stored[0]).toEqual(
        expect.objectContaining({
          displayName: 'Renamed',
          requestHeaders: { 'X-Auth': 'secret' },
          family: 'qwen3_5',
          defaultParams: { temperature: 0.7 },
          defaultMode: 'balanced',
          streamInactivityTimeout: 60000,
          autoContinueRetries: 2,
          maxOutputTokens: 4096,
          modelModes: { balanced: { temperature: 0.5 } },
        }),
      );
    });

    it('P2: replaces (not merges) requestHeaders when the patch supplies them', async () => {
      const existingConfig: ModelConfig[] = [
        {
          id: 'test-model',
          vllmModelId: 'test-model',
          serverUrl: 'http://localhost:8000',
          displayName: 'Test Model',
          requestHeaders: { 'X-Old': 'value', 'X-Share': 'both' },
        },
      ];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (provider as any).saveModelConfig({
        id: 'test-model',
        vllmModelId: 'test-model',
        serverUrl: 'http://localhost:8000',
        requestHeaders: { 'X-New': 'value', 'X-Share': 'updated' },
      });

      const stored = vscode.workspace._mockConfig.update.mock.calls[0][1];
      expect(stored[0].requestHeaders).toEqual({ 'X-New': 'value', 'X-Share': 'updated' });
      expect('X-Old' in (stored[0].requestHeaders ?? {})).toBe(false);
    });

    it('P2: derives the composite id from vllmModelId when id and wire id differ (new entry)', async () => {
      const existingConfig: ModelConfig[] = [];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      // Config identity is the preset id; the wire id is the server model.
      await (provider as any).saveModelConfig({
        id: 'preset-a',
        vllmModelId: 'wire-model',
        serverUrl: 'http://a:8000',
        displayName: 'Preset A',
      });

      const stored = vscode.workspace._mockConfig.update.mock.calls[0][1];
      expect(stored).toHaveLength(1);
      // buildModelId(serverUrl, vllmModelId) — the wire id wins, not updates.id.
      expect(stored[0].id).toBe('wire-model on a:8000');
      expect(stored[0].vllmModelId).toBe('wire-model');
    });

    it('P2: fires toast and clearCache after persistence; the config listener owns the refresh', async () => {
      const clearCache = vi.fn();
      const providerWithCache = new ServerSettingsViewProvider(mockContext, mockOutputChannel, clearCache);
      const refreshSpy = vi.spyOn(providerWithCache as any, 'refreshWebview').mockResolvedValue(undefined);

      vscode.workspace._mockConfig = {
        get: () => [],
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (providerWithCache as any).saveModelConfig({
        id: 'new-model',
        vllmModelId: 'new-model',
        serverUrl: 'http://localhost:8000',
        displayName: 'New Model',
      });

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Settings saved for "New Model"');
      expect(clearCache).toHaveBeenCalled();
      // saveModelConfig must NOT refresh: patchModelConfig writes vllm-copilot.models,
      // which fires the onDidChangeConfiguration listener that owns the single refresh.
      // A second refresh here would post a duplicate 'data' message that clobbers a
      // draft the webview preserved across an auto-applied personality change.
      expect(refreshSpy).not.toHaveBeenCalled();
    });

    it('P2: a rejected persistence suppresses clearCache, refresh, and the success toast', async () => {
      const clearCache = vi.fn();
      const providerWithCache = new ServerSettingsViewProvider(mockContext, mockOutputChannel, clearCache);
      const refreshSpy = vi.spyOn(providerWithCache as any, 'refreshWebview').mockResolvedValue(undefined);

      vscode.workspace._mockConfig = {
        get: () => [],
        update: vi.fn().mockRejectedValue(new Error('write failed')),
      };

      await expect(
        (providerWithCache as any).saveModelConfig({
          id: 'new-model',
          vllmModelId: 'new-model',
          serverUrl: 'http://localhost:8000',
          displayName: 'New Model',
        }),
      ).rejects.toThrow('write failed');

      // The handler awaits persistence first, so a failed write must not fire
      // cache invalidation, a webview refresh, or a "saved" success toast.
      expect(clearCache).not.toHaveBeenCalled();
      expect(refreshSpy).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  describe('applyPersonality', () => {
    it('P1: keys the target preset by extension id when two presets share a vllmModelId', async () => {
      const existingConfig: ModelConfig[] = [
        { id: 'preset-a', vllmModelId: 'shared-model', serverUrl: 'http://localhost:8000', displayName: 'A' },
        { id: 'preset-b', vllmModelId: 'shared-model', serverUrl: 'http://localhost:8000', displayName: 'B' },
      ];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      // clear: true avoids ensureGlobalPersonality (no fs access).
      await (provider as any).applyPersonality({
        type: 'applyPersonality',
        serverUrl: 'http://localhost:8000',
        id: 'preset-b',
        clear: true,
      });

      const updatedModels = vscode.workspace._mockConfig.update.mock.calls[0][1];
      expect(updatedModels).toHaveLength(2);
      // preset-a must be untouched — only preset-b gets the clear.
      expect(updatedModels.find((m: any) => m.id === 'preset-a')).toEqual(
        expect.objectContaining({ displayName: 'A' }),
      );
      // Clear removes the key entirely (not a lingering "").
      expect('systemMessageReplacementsFile' in updatedModels.find((m: any) => m.id === 'preset-b')).toBe(false);
    });

    it('does nothing for an unknown id (unconfigured server model)', async () => {
      vscode.workspace._mockConfig = {
        get: () => [],
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (provider as any).applyPersonality({
        type: 'applyPersonality',
        serverUrl: 'http://localhost:8000',
        id: 'server-reported-only-model',
        clear: true,
      });

      expect(vscode.workspace._mockConfig.update).not.toHaveBeenCalled();
    });

    it('clear removes an existing personality instead of resurrecting the old value', async () => {
      const existingConfig: ModelConfig[] = [
        {
          id: 'test-model',
          vllmModelId: 'test-model',
          serverUrl: 'http://localhost:8000',
          displayName: 'Test',
          systemMessageReplacementsFile: 'C:/personalities/tough-love.json',
        },
      ];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (provider as any).applyPersonality({
        type: 'applyPersonality',
        serverUrl: 'http://localhost:8000',
        id: 'test-model',
        clear: true,
      });

      const stored = vscode.workspace._mockConfig.update.mock.calls[0][1];
      expect(stored).toHaveLength(1);
      // The old personality must be gone — a naive `{...existing, ...updates}`
      // merge would have resurrected it because the clear passes `''`.
      expect('systemMessageReplacementsFile' in stored[0]).toBe(false);
    });
  });

  describe('setSystemMessageCapture', () => {
    it('updates the global systemMessageCapture setting', async () => {
      vscode.workspace._mockConfig = {
        get: () => undefined,
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (provider as any).setSystemMessageCapture(true);

      expect(vscode.workspace._mockConfig.update).toHaveBeenCalledWith(
        'systemMessageCapture',
        true,
        vscode.ConfigurationTarget.Global,
      );
    });

    it('persists disabling recording', async () => {
      vscode.workspace._mockConfig = {
        get: () => undefined,
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (provider as any).setSystemMessageCapture(false);

      expect(vscode.workspace._mockConfig.update).toHaveBeenCalledWith(
        'systemMessageCapture',
        false,
        vscode.ConfigurationTarget.Global,
      );
    });
  });

  describe('refreshWebview', () => {
    it('uses trusted headers with a canonical URL but strips them from webview state', async () => {
      const postMessage = vi.fn().mockResolvedValue(true);
      (provider as any).view = { webview: { postMessage } };
      (provider as any).isWebviewReady = true;
      mockContext.extensionUri = { fsPath: 'extension' };
      mockContext.globalStorageUri = { fsPath: 'global-storage' };
      vscode.workspace._mockConfig = {
        get: (key: string) => key === 'models'
          ? [{
              id: 'configured',
              vllmModelId: 'configured',
              serverUrl: 'http://secure:8000/v1',
              requestHeaders: { Authorization: 'Bearer secret' },
            }]
          : undefined,
        update: vi.fn().mockResolvedValue(undefined),
      };
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          data: [
            { id: 'configured', max_model_len: 8192 },
            { id: 'unconfigured', max_model_len: 8192 },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );

      await (provider as any).refreshWebview();

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://secure:8000/v1/models',
        expect.objectContaining({ headers: { Authorization: 'Bearer secret' } }),
      );
      const payload = postMessage.mock.calls[0][0];
      expect(payload.servers[0].url).toBe('http://secure:8000');
      expect(payload.servers[0].serverModelIds).toEqual(['configured', 'unconfigured']);
      expect(payload.servers[0].models[0]).not.toHaveProperty('requestHeaders');
      expect(payload.servers[0].models[0].serverUrl).toBe('http://secure:8000');
    });

    it('probes each header identity independently on one canonical URL', async () => {
      const postMessage = vi.fn().mockResolvedValue(true);
      (provider as any).view = { webview: { postMessage } };
      (provider as any).isWebviewReady = true;
      mockContext.extensionUri = { fsPath: 'extension' };
      mockContext.globalStorageUri = { fsPath: 'global-storage' };
      vscode.workspace._mockConfig = {
        get: (key: string) => key === 'models'
          ? [
              { id: 'a', vllmModelId: 'a', serverUrl: 'http://gw:8000/v1', requestHeaders: { Authorization: 'Bearer secret-a' } },
              { id: 'b', vllmModelId: 'b', serverUrl: 'http://gw:8000/', requestHeaders: { Authorization: 'Bearer secret-b' } },
            ]
          : undefined,
        update: vi.fn().mockResolvedValue(undefined),
      };
      // Two different header identities on one canonical URL → two logical
      // servers, each probed with its own credentials (never the first model's
      // headers standing in for a sibling).
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'shared' }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'shared' }] }), { status: 200 }));

      await (provider as any).refreshWebview();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        'http://gw:8000/v1/models',
        expect.objectContaining({ headers: { Authorization: 'Bearer secret-a' } }),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        'http://gw:8000/v1/models',
        expect.objectContaining({ headers: { Authorization: 'Bearer secret-b' } }),
      );

      const payload = postMessage.mock.calls[0][0];
      expect(payload.servers).toHaveLength(2);
      expect(payload.servers[0].url).toBe('http://gw:8000');
      expect(payload.servers[1].url).toBe('http://gw:8000');
      // Distinct identities get distinct keys; each group is labelled against
      // its own probe, and raw header values never reach the webview DOM.
      expect(payload.servers[0].key).not.toBe(payload.servers[1].key);
      expect(payload.servers[0].serverModelIds).toEqual(['a', 'shared']);
      expect(payload.servers[1].serverModelIds).toEqual(['b', 'shared']);
      expect(payload.servers[0].models[0]).not.toHaveProperty('requestHeaders');
      expect(JSON.stringify(payload)).not.toContain('secret-a');
      expect(JSON.stringify(payload)).not.toContain('secret-b');
    });

    it('discards an older refresh that finishes after a newer one', async () => {
      const postMessage = vi.fn().mockResolvedValue(true);
      (provider as any).view = { webview: { postMessage } };
      (provider as any).isWebviewReady = true;
      mockContext.extensionUri = { fsPath: 'extension' };
      mockContext.globalStorageUri = { fsPath: 'global-storage' };
      let models: ModelConfig[] = [{ id: 'old', serverUrl: 'http://old:8000' }];
      vscode.workspace._mockConfig = {
        get: (key: string) => key === 'models' ? models : undefined,
        update: vi.fn().mockResolvedValue(undefined),
      };
      let resolveOld!: (response: Response) => void;
      const oldResponse = new Promise<Response>(resolve => { resolveOld = resolve; });
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockImplementationOnce(() => oldResponse)
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'new' }] }), { status: 200 }));

      const oldRefresh = (provider as any).refreshWebview();
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      models = [{ id: 'new', serverUrl: 'http://new:8000' }];
      await (provider as any).refreshWebview();
      resolveOld(new Response(JSON.stringify({ data: [{ id: 'old' }] }), { status: 200 }));
      await oldRefresh;

      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage.mock.calls[0][0].servers[0].url).toBe('http://new:8000');
    });

    it('fetches OpenRouter provider lists keyed by wire id, in parallel, with failures dropped', async () => {
      const postMessage = vi.fn().mockResolvedValue(true);
      (provider as any).view = { webview: { postMessage } };
      (provider as any).isWebviewReady = true;
      mockContext.extensionUri = { fsPath: 'extension' };
      mockContext.globalStorageUri = { fsPath: 'global-storage' };
      vscode.workspace._mockConfig = {
        get: (key: string) => key === 'models'
          ? [
              { id: 'cfg-a', vllmModelId: 'author/a', serverUrl: 'https://openrouter.ai/api', serverType: 'openrouter', requestHeaders: { Authorization: 'Bearer secret' } },
              { id: 'cfg-b', vllmModelId: 'author/b', serverUrl: 'https://openrouter.ai/api', serverType: 'openrouter', requestHeaders: { Authorization: 'Bearer secret' } },
            ]
          : undefined,
        update: vi.fn().mockResolvedValue(undefined),
      };
      // The /v1/models probe is called once per identity; the /endpoints fetches
      // run for both wire ids. One endpoint resolves, one 404s (dropped → no entry).
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockImplementation(async (url: unknown) => {
          const u = String(url);
          if (u.endsWith('/v1/models')) {
            return new Response(JSON.stringify({ data: [{ id: 'author/a' }, { id: 'author/b' }] }), { status: 200 });
          }
          if (u.endsWith('/author/a/endpoints')) {
            return new Response(JSON.stringify({ data: { id: 'author/a', endpoints: [{ tag: 'together', provider_name: 'Together', quantization: 'unknown', pricing: { prompt: '0.0000005', completion: '0.0000015' } }] } }), { status: 200 });
          }
          return new Response(null, { status: 404 });
        });

      await (provider as any).refreshWebview();

      // The /endpoints URL keeps the model id's literal path separator.
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models/author/a/endpoints',
        expect.anything(),
      );
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models/author/b/endpoints',
        expect.anything(),
      );
      const payload = postMessage.mock.calls[0][0];
      // Only the resolved provider list reaches the webview — keyed by the wire id.
      expect(payload.providersByModel).toEqual({
        'author/a': [expect.objectContaining({ tag: 'together', providerName: 'Together' })],
      });
      expect(payload.providersByModel['author/b']).toBeUndefined();
      // Header values never leak into the payload.
      expect(JSON.stringify(payload)).not.toContain('secret');
    });
  });
});

describe('resolveDetectedServerType', () => {
  it('prefers the /v1/models signal over a sibling serverType', () => {
    expect(
      resolveDetectedServerType(
        [{ owned_by: 'llamacpp' }, { owned_by: 'mystery' }],
        [{ serverType: 'lmstudio' }],
      )
    ).toBe('llamacpp');
  });

  it('adopts a configured sibling serverType when /v1/models is inconclusive', () => {
    // LM Studio / Ollama have no /v1/models signature → no vLLM/llamacpp signal.
    expect(
      resolveDetectedServerType(
        [{ owned_by: 'mystery' }],
        [{ serverType: 'lmstudio' }],
      )
    ).toBe('lmstudio');
    expect(
      resolveDetectedServerType(
        [],
        [{ serverType: 'ollama' }],
      )
    ).toBe('ollama');
  });

  it('returns undefined when neither the endpoint nor a sibling provides a type', () => {
    expect(resolveDetectedServerType([{ owned_by: 'mystery' }], [])).toBeUndefined();
    expect(
      resolveDetectedServerType([{ owned_by: 'mystery' }], [{}])
    ).toBeUndefined();
  });

  it('returns undefined for a fully inconclusive endpoint with no siblings at all', () => {
    expect(resolveDetectedServerType([], [])).toBeUndefined();
  });
});

describe('serverGroupKey', () => {
  it('is deterministic, distinct per header identity, and leaks no header values', () => {
    const fpA = serverFingerprint('http://gw:8000', { Authorization: 'Bearer secret-a' });
    const fpB = serverFingerprint('http://gw:8000', { Authorization: 'Bearer secret-b' });
    const kA1 = serverGroupKey(fpA);
    const kA2 = serverGroupKey(fpA);
    const kB = serverGroupKey(fpB);
    expect(kA1).toBe(kA2);
    expect(kA1).not.toBe(kB);
    expect(kA1).toMatch(/^srv-/);
    // The key must not be (or contain) the raw fingerprint, which embeds secrets.
    expect(kA1).not.toContain('Bearer');
    expect(kA1).not.toContain('secret-a');
    expect(kA1).not.toBe(fpA);
  });
});