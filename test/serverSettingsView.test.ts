import * as vscode from 'vscode';
import { ServerSettingsViewProvider } from '../src/serverSettingsView.js';
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
});