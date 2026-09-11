import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { personalityTemplate, ServerSettingsViewProvider } from '../src/ui/serverSettingsView.js';
import { ModelConfig } from '../src/state/config.js';
import { resetOpenRouterCaches } from '../src/backends/openRouter.js';
import { clearRuntimeLimitsCache } from '../src/backends/runtimeLimits.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('ServerSettingsViewProvider', () => {
  let provider: ServerSettingsViewProvider;
  let mockContext: any;
  let mockOutputChannel: any;

  beforeEach(() => {
    resetOpenRouterCaches();
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
          server: 'test',
          displayName: 'Old Name',
        },
      ];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      const updates: Partial<ModelConfig> = {
        displayName: 'New Name',
        server: 'test',
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
        expect.any(String), // toast fired; wording is chrome (CR-109)
      );
    });

    it('should create a new model entry with the config id verbatim (no composite id)', async () => {
      const existingConfig: ModelConfig[] = [];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      // The webview sends the raw id plus the server registry ref it belongs to.
      const updates: Partial<ModelConfig> = {
        id: 'new-model',
        vllmModelId: 'new-model',
        server: 'test',
        displayName: 'New Model',
      };

      await (provider as any).saveModelConfig(updates);

      expect(vscode.workspace._mockConfig.update).toHaveBeenCalledWith(
        'models',
        expect.arrayContaining([
          expect.objectContaining({
            id: 'new-model',
            vllmModelId: 'new-model',
            server: 'test',
            displayName: 'New Model',
          }),
        ]),
        vscode.ConfigurationTarget.Global,
      );

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.any(String), // toast fired; wording is chrome (CR-109)
      );
    });

    it('P1: same model saved via webview on two servers stays two entries keyed by (id, server)', async () => {
      const existingConfig: ModelConfig[] = [];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (provider as any).saveModelConfig({
        id: 'qwen-7b',
        vllmModelId: 'qwen-7b',
        server: 'a',
      });
      const afterFirst = vscode.workspace._mockConfig.update.mock.calls[0][1];

      vscode.workspace._mockConfig.get = (key: string) => (key === 'models' ? afterFirst : undefined);
      await (provider as any).saveModelConfig({
        id: 'qwen-7b',
        vllmModelId: 'qwen-7b',
        server: 'b',
      });
      const afterSecond = vscode.workspace._mockConfig.update.mock.calls[1][1];

      expect(afterSecond).toHaveLength(2);
      // Identity is the (id, server) pair — the id itself stays verbatim.
      expect(new Set(afterSecond.map((m: any) => `${m.id}|${m.server}`)).size).toBe(2);
      expect(afterSecond[0].id).toBe('qwen-7b');
      expect(afterSecond[0].server).toBe('a');
      expect(afterSecond[1].id).toBe('qwen-7b');
      expect(afterSecond[1].server).toBe('b');
    });

    it('should preserve existing properties when updating', async () => {
      const existingConfig: ModelConfig[] = [
        {
          id: 'test-model',
          vllmModelId: 'test-model',
          server: 'test',
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
        server: 'test',
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
          server: 'test',
        },
      ];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      const updates: Partial<ModelConfig> = {
        id: 'fallback-model',
        server: 'test',
        displayName: 'Fallback Model',
      };

      await (provider as any).saveModelConfig(updates);

      expect(vscode.workspace._mockConfig.update).toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.any(String), // toast fired; wording is chrome (CR-109)
      );
    });

    it('P1 clear: deletes an empty systemMessageReplacementsFile instead of storing ""', async () => {
      const existingConfig: ModelConfig[] = [
        {
          id: 'test-model',
          vllmModelId: 'test-model',
          server: 'test',
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
        server: 'test',
        systemMessageReplacementsFile: '',
      });

      const stored = vscode.workspace._mockConfig.update.mock.calls[0][1];
      expect(stored).toHaveLength(1);
      expect('systemMessageReplacementsFile' in stored[0]).toBe(false);
    });

    // ── Step 2: patch-mode characterization (#3/#5 + side effects) ──
    // Pins the CURRENT patch contract of serverSettingsView.saveModelConfig so the
    // configStore unification (step 3b) cannot silently change behavior.

    it('P2: preserves headers, family, defaults, and transport settings when the patch omits them', async () => {
      // Smuggled legacy keys: characterization of the patch merge — entries saved
      // before migration keep unknown legacy keys in storage (normalizeModelEntry
      // only strips empty strings), so the assertions below stay valid.
      const existingConfig = [
        {
          id: 'test-model',
          vllmModelId: 'test-model',
          server: 'test',
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
      ] as unknown as ModelConfig[];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (provider as any).saveModelConfig({
        id: 'test-model',
        vllmModelId: 'test-model',
        server: 'test',
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
      const existingConfig = [
        {
          id: 'test-model',
          vllmModelId: 'test-model',
          server: 'test',
          displayName: 'Test Model',
          requestHeaders: { 'X-Old': 'value', 'X-Share': 'both' },
        },
      ] as unknown as ModelConfig[];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (provider as any).saveModelConfig({
        id: 'test-model',
        vllmModelId: 'test-model',
        server: 'test',
        requestHeaders: { 'X-New': 'value', 'X-Share': 'updated' },
      });

      const stored = vscode.workspace._mockConfig.update.mock.calls[0][1];
      expect(stored[0].requestHeaders).toEqual({ 'X-New': 'value', 'X-Share': 'updated' });
      expect('X-Old' in (stored[0].requestHeaders ?? {})).toBe(false);
    });

    it('P2: keeps the config id verbatim for a new entry (composite ids are gone)', async () => {
      const existingConfig: ModelConfig[] = [];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      // Config identity is the preset id; the wire id is the server model.
      await (provider as any).saveModelConfig({
        id: 'preset-a',
        vllmModelId: 'wire-model',
        server: 'a',
        displayName: 'Preset A',
      });

      const stored = vscode.workspace._mockConfig.update.mock.calls[0][1];
      expect(stored).toHaveLength(1);
      // Identity is the (id, server) pair — no url-derived composite anymore.
      expect(stored[0].id).toBe('preset-a');
      expect(stored[0].vllmModelId).toBe('wire-model');
      expect(stored[0].server).toBe('a');
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
          server: 'test',
          displayName: 'New Model',
        }),
      ).rejects.toThrow('write failed');

      // The handler awaits persistence first, so a failed write must not fire
      // cache invalidation, a webview refresh, or a "saved" success toast.
      expect(clearCache).not.toHaveBeenCalled();
      expect(refreshSpy).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('P3: a failed save replies save-failed so the webview re-arms its draft (no silent wipe)', async () => {
      // Regression: on a failed save the webview's one-shot `pendingSave` flag is
      // consumed only by a 'data' message — which a failed save suppresses. The
      // stale flag would make the NEXT unrelated 'data' refresh wipe the draft the
      // user just failed to save. saveModelConfig must reply 'save-failed' so the
      // webview clears the flag and re-arms the dirty indicator.
      const providerWithView = new ServerSettingsViewProvider(mockContext, mockOutputChannel);
      const postMessage = vi.fn();
      (providerWithView as any).view = { webview: { postMessage } };

      vscode.workspace._mockConfig = {
        get: () => [],
        update: vi.fn().mockRejectedValue(new Error('write failed')),
      };

      await expect(
        (providerWithView as any).saveModelConfig({
          id: 'new-model',
          vllmModelId: 'new-model',
          server: 'test',
          displayName: 'New Model',
        }),
      ).rejects.toThrow('write failed');

      expect(postMessage).toHaveBeenCalledWith({ type: 'save-failed' });
      // Still no success toast or config write side effects.
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  describe('applyPersonality', () => {
    it('P1: keys the target preset by extension id when two presets share a vllmModelId', async () => {
      const existingConfig: ModelConfig[] = [
        { id: 'preset-a', vllmModelId: 'shared-model', server: 'test', displayName: 'A' },
        { id: 'preset-b', vllmModelId: 'shared-model', server: 'test', displayName: 'B' },
      ];

      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      // clear: true is a bare path write (no fs access — applying never copies).
      await (provider as any).applyPersonality({
        type: 'applyPersonality',
        server: 'test',
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

    it('clear removes an existing personality instead of resurrecting the old value', async () => {
      const existingConfig: ModelConfig[] = [
        {
          id: 'test-model',
          vllmModelId: 'test-model',
          server: 'test',
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
        server: 'test',
        id: 'test-model',
        clear: true,
      });

      const stored = vscode.workspace._mockConfig.update.mock.calls[0][1];
      expect(stored).toHaveLength(1);
      // The old personality must be gone — a naive `{...existing, ...updates}`
      // merge would have resurrected it because the clear passes `''`.
      expect('systemMessageReplacementsFile' in stored[0]).toBe(false);
    });

    it('a shipped preset (name) stores the portable name and clears the machine-bound path', async () => {
      const existingConfig: ModelConfig[] = [
        {
          id: 'glm',
          vllmModelId: 'glm',
          server: 'test',
          // The reported shape: preset applied on WINDOWS, path now dead here.
          systemMessageReplacementsFile: 'c:\\Users\\me\\personalities\\prompt-replacements-sarcastic-robot.json',
        },
      ];
      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (provider as any).applyPersonality({
        type: 'applyPersonality',
        server: 'test',
        id: 'glm',
        sourcePath: '/any/host/globalStorage/personalities/prompt-replacements-sarcastic-robot.json',
        name: 'Sarcastic Robot',
      });

      const stored = vscode.workspace._mockConfig.update.mock.calls[0][1];
      // Name in, path gone: the entry now resolves on every machine from the
      // name alone; the option's path was a display detail, never the storage.
      expect(stored[0].personality).toBe('Sarcastic Robot');
      expect('systemMessageReplacementsFile' in stored[0]).toBe(false);
    });

    it('clear removes a stored name reference too, not only the path', async () => {
      const existingConfig: ModelConfig[] = [
        { id: 'glm', vllmModelId: 'glm', server: 'test', personality: 'Sarcastic Robot' },
      ];
      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'models' ? existingConfig : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (provider as any).applyPersonality({
        type: 'applyPersonality',
        server: 'test',
        id: 'glm',
        clear: true,
      });

      const stored = vscode.workspace._mockConfig.update.mock.calls[0][1];
      expect('personality' in stored[0]).toBe(false);
      expect('systemMessageReplacementsFile' in stored[0]).toBe(false);
    });
  });

  describe('setServerType', () => {
    it('writes exactly the addressed entry — the entry id is the identity', async () => {
      // 'b' is a same-URL + same-auth sibling of 'a' (redundant — validateConfig
      // warns). Under the entry-id doctrine it is a SEPARATE server: the webview
      // addressed 'a', so only 'a' gets the type. No fingerprint sweep exists.
      const servers = [
        { id: 'a', serverUrl: 'http://s:8000', requestHeaders: { Authorization: 'k' } },
        { id: 'b', serverUrl: 'http://s:8000', requestHeaders: { authorization: 'k' } },
        { id: 'c', serverUrl: 'http://s:8000', requestHeaders: { Authorization: 'other-credential' } },
        { id: 'd', serverUrl: 'http://s:9000' },
      ];
      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'servers' ? servers : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (provider as any).setServerType({ type: 'setServerType', server: 'a', serverType: 'ollama' });

      expect(vscode.workspace._mockConfig.update).toHaveBeenCalledTimes(1);
      const written = vscode.workspace._mockConfig.update.mock.calls[0][1] as any[];
      const byId = Object.fromEntries(written.map(s => [s.id, s]));
      expect(byId.a.serverType).toBe('ollama');
      expect(byId.b.serverType).toBeUndefined();
      expect(byId.c.serverType).toBeUndefined();
      expect(byId.d.serverType).toBeUndefined();
    });

    it('does not write when the addressed entry already has the type', async () => {
      const servers = [{ id: 'a', serverUrl: 'http://s:8000', serverType: 'ollama' }];
      vscode.workspace._mockConfig = {
        get: (key: string) => (key === 'servers' ? servers : undefined),
        update: vi.fn().mockResolvedValue(undefined),
      };

      await (provider as any).setServerType({ type: 'setServerType', server: 'a', serverType: 'ollama' });

      expect(vscode.workspace._mockConfig.update).not.toHaveBeenCalled();
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
          ? [{ id: 'configured', vllmModelId: 'configured', server: 'srv' }]
          : key === 'servers'
            ? [{ id: 'srv', serverUrl: 'http://secure:8000/v1', requestHeaders: { Authorization: 'Bearer secret' } }]
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
      expect(payload.servers[0].models[0].server).toBe('srv');
    });
  });
});

// Relocated from runtimeLimits.test.ts when detectServerTypeFromV1Models
// merged into its only production caller. The detector is module-private
// (N-1, 2026-09-11): driven through refreshWebview's server-group build, the
// same fetch-stub harness the block above uses, asserting the payload field
// the webview actually receives.
describe('server type detection (via refreshWebview)', () => {
  let provider: ServerSettingsViewProvider;
  let mockContext: any;

  beforeEach(() => {
    resetOpenRouterCaches();
    // The server-list memo is module state keyed by URL - all cases share one
    // URL, so without this the first probe's answer would serve every case.
    clearRuntimeLimitsCache();
    mockContext = {
      extensionUri: { fsPath: 'extension' },
      globalStorageUri: { fsPath: 'global-storage' },
      subscriptions: [],
      secrets: { get: () => Promise.resolve(undefined), store: () => Promise.resolve(), delete: () => Promise.resolve() },
    };
    provider = new ServerSettingsViewProvider(mockContext, { appendLine: vi.fn(), dispose: vi.fn() } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** One configured server entry, one /v1/models answer → the detected type. */
  async function detect(
    serverEntry: Record<string, unknown>,
    modelsBody: unknown,
    tagsStatus = 500,
  ): Promise<unknown> {
    vscode.workspace._mockConfig = {
      get: (key: string) => (key === 'models' ? [] : key === 'servers' ? [serverEntry] : undefined),
      update: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/tags')) {
        return new Response('', { status: tagsStatus });
      }
      return new Response(JSON.stringify(modelsBody), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const postMessage = vi.fn().mockResolvedValue(true);
    (provider as any).view = { webview: { postMessage } };
    (provider as any).isWebviewReady = true;
    await (provider as any).refreshWebview();
    const payload = (postMessage.mock.calls.find(c => c[0]?.type === 'data') as [any] | undefined)?.[0];
    return payload?.servers?.[0]?.detectedServerType;
  }

  it('returns vllm when any entry has a positive max_model_len', async () => {
    expect(await detect(
      { id: 's', serverUrl: 'http://d:8000' },
      { data: [{ id: 'a', owned_by: 'llamacpp' }, { id: 'b', owned_by: 'vllm', max_model_len: 262144 }] },
    )).toBe('vllm');
  });

  it('returns llamacpp when entries have owned_by llamacpp and no positive max_model_len', async () => {
    expect(await detect(
      { id: 's', serverUrl: 'http://d:8000' },
      { data: [{ id: 'a', owned_by: 'llamacpp' }, { id: 'b', owned_by: 'llamacpp' }] },
    )).toBe('llamacpp');
  });

  it('falls back to the persisted entry serverType when the probe yields no /v1/models signal', async () => {
    // Ollama entry: the vLLM probe never runs against it, the lister answer
    // carries no vLLM/llama.cpp signature - the entry's own type is adopted.
    expect(await detect(
      { id: 's', serverUrl: 'http://d:8000', serverType: 'ollama' },
      { data: [] },
      500,
    )).toBe('ollama');
  });

  it('stays undefined with neither a probe signal nor a persisted type', async () => {
    expect(await detect({ id: 's', serverUrl: 'http://d:8000' }, { data: [] })).toBeUndefined();
  });

  it('does not treat a zero max_model_len as a vLLM signal', async () => {
    expect(await detect(
      { id: 's', serverUrl: 'http://d:8000' },
      { data: [{ id: 'a', owned_by: 'llamacpp', max_model_len: 0 }] },
    )).toBe('llamacpp');
  });
});

describe('personalityTemplate (+ New seed content)', () => {
  // Real breakage caught: the template is generated JSON (a copy of the Raw
  // preset) shipped to every user who clicks the button. Pinning: valid JSON,
  // the real rules are copied untouched, the shared include is rewritten to
  // an ABSOLUTE path into the seeded folder (a new file has no fixed home,
  // so a bare name would resolve only by luck), meta is the placeholder, and
  // the drop-in folder is printed.
  const dir = 'C:/Users/tester/AppData/Roaming/Code/User/globalStorage/System-Sciences.vllm-copilot/personalities';
  const rawPath = path.join(process.cwd(), 'prompt-replacements', 'prompt-replacements-raw.json');

  it('copies the Raw preset rules, rewrites the shared include to the folder\'s absolute path, placeholder meta', async () => {
    const raw = JSON.parse(await fs.readFile(rawPath, 'utf-8')) as { rules: unknown[] };
    const parsed = JSON.parse(await personalityTemplate(rawPath, dir)) as {
      _howTo: string[];
      meta: { name: string; description: string };
      rules: unknown[];
    };

    expect(parsed.rules).toHaveLength(raw.rules.length);
    expect(parsed.rules.slice(0, -1)).toEqual(raw.rules.slice(0, -1)); // real rules, untouched
    expect(parsed.rules.at(-1)).toEqual({ include: `${dir}/prompt-replacements-common.json` }); // absolute: resolves wherever the file is saved
    expect(parsed.meta).toEqual({ name: 'My Personality', description: 'Say what this personality does.' });
    expect(parsed._howTo.join('\n')).toContain(dir);
  });
});
