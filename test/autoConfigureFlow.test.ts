import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  applyAutoConfigUpdate,
  registerAutoConfigureModelCommand,
} from '../src/commands/autoConfigureFlow.js';
import * as configStore from '../src/configStore.js';
import * as hfDiscovery from '../src/commands/hfDiscovery.js';

/**
 * Direct tests for the auto-configure flow module: the update-confirm helper and
 * the re-configure command (arg-based existing-model and unconfigured-new-model
 * paths). Discovery + persistence are stubbed so the flow's own logic is
 * measured: identity matching, sibling auth borrowing, infra-field preservation,
 * and the replace-based save.
 */
describe('applyAutoConfigUpdate', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let replaceSpy: ReturnType<typeof vi.spyOn>;
  let clipboardSpy: ReturnType<typeof vi.spyOn>;
  const output = {
    appendLine: vi.fn(),
    dispose: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
  } as any;
  const newConfig = { id: 'm', vllmModelId: 'm', serverUrl: 'http://host:8000' };

  beforeEach(() => {
    infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    clipboardSpy = vi.spyOn(vscode.env.clipboard, 'writeText').mockResolvedValue(undefined);
    replaceSpy = vi
      .spyOn(configStore, 'replaceModelConfig')
      .mockResolvedValue({ model: newConfig as any, created: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replaces the config, runs onSaved, and toasts on Save', async () => {
    infoSpy.mockResolvedValueOnce('Save' as any);
    const onSaved = vi.fn();

    await applyAutoConfigUpdate(newConfig, 'm', 'detail', output, onSaved);

    expect(replaceSpy).toHaveBeenCalledWith(newConfig);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('Model "m" updated.');
  });

  it('copies the JSON and does not persist on Copy JSON', async () => {
    infoSpy.mockResolvedValueOnce('Copy JSON' as any);

    await applyAutoConfigUpdate(newConfig, 'm', 'detail', output);

    expect(clipboardSpy).toHaveBeenCalledWith(JSON.stringify(newConfig, null, 2));
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});

describe('registerAutoConfigureModelCommand', () => {
  const provider = { clearCache: vi.fn() } as any;
  const output = {
    appendLine: vi.fn(),
    dispose: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
  } as any;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let quickPickSpy: ReturnType<typeof vi.spyOn>;
  let replaceSpy: ReturnType<typeof vi.spyOn>;
  let resolveSpy: ReturnType<typeof vi.spyOn>;
  let chatUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (vscode as any).commands._registrations = [];
    infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    quickPickSpy = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    chatUpdate = vi.fn().mockResolvedValue(undefined);
    replaceSpy = vi
      .spyOn(configStore, 'replaceModelConfig')
      .mockResolvedValue({ model: { id: 'x' } as any, created: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vscode.workspace._mockConfig = {};
  });

  it('re-configures an existing model by arg, preserving infrastructure/personal fields', async () => {
    const existing = [
      {
        id: 'existing-id',
        vllmModelId: 'wire',
        serverUrl: 'http://host:8000',
        requestHeaders: { 'X-Auth': 'keep' },
        serverType: undefined, // missing → treated as vllm by policy
        autoContinueRetries: 3,
        streamInactivityTimeout: 60000,
        systemMessageReplacementsFile: '.vllm/spartan.json',
        maxInputTokens: 32768,
        estimateCharsPerToken: 4,
      },
    ];
    vscode.workspace._mockConfig = {
      get: (key: string) => (key === 'models' ? existing : undefined),
      update: chatUpdate,
      inspect: () => ({ defaultValue: 'none' }),
    };
    resolveSpy = vi.spyOn(hfDiscovery, 'resolveModelConfigForAddSafely').mockResolvedValue({
      modelConfig: { id: 'existing-id', vllmModelId: 'wire', capabilities: { toolCalling: true, imageInput: false } },
      summary: ['discovered'],
    });
    infoSpy.mockResolvedValue('Save' as any);

    registerAutoConfigureModelCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.autoConfigureModel', {
      serverUrl: 'http://host:8000',
      id: 'existing-id',
    });

    expect(resolveSpy).toHaveBeenCalledWith(
      expect.anything(), // output channel
      expect.anything(), // extension context
      'wire', 'http://host:8000', { 'X-Auth': 'keep' }, undefined, existing[0],
      existing[0].serverType, // model's own persisted backend type (undefined → vllm)
    );
    // Infra/personal fields survive the discovery-result base merge.
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'existing-id',
        vllmModelId: 'wire',
        serverUrl: 'http://host:8000',
        requestHeaders: { 'X-Auth': 'keep' },
        autoContinueRetries: 3,
        streamInactivityTimeout: 60000,
        systemMessageReplacementsFile: '.vllm/spartan.json',
        maxInputTokens: 32768,
        estimateCharsPerToken: 4,
        capabilities: { toolCalling: true, imageInput: false },
      }),
    );
    expect(provider.clearCache).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith('Model "wire" updated.');
  });

  it('auto-configures an unconfigured server-reported model, borrowing sibling auth', async () => {
    const sibling = {
      id: 'sibling',
      vllmModelId: 'sib',
      serverUrl: 'http://host:8000',
      requestHeaders: { 'X-Borrow': 'yes' },
    };
    vscode.workspace._mockConfig = {
      get: (key: string) => (key === 'models' ? [sibling] : undefined),
      update: chatUpdate,
      inspect: () => ({ defaultValue: 'none' }),
    };
    resolveSpy = vi.spyOn(hfDiscovery, 'resolveModelConfigForAddSafely').mockResolvedValue({
      modelConfig: { id: 'new-model', vllmModelId: 'new-model', capabilities: { toolCalling: true, imageInput: false } },
      summary: ['discovered'],
    });
    // confirmAndSaveAddedModel dialog → Save to Settings (BYOK path).
    infoSpy.mockResolvedValue('Save to Settings' as any);

    registerAutoConfigureModelCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.autoConfigureModel', {
      serverUrl: 'http://host:8000',
      id: 'new-model',
    });

    // New entry: composite id, borrowed headers, BYOK bootstrap ran.
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'new-model on host:8000',
        vllmModelId: 'new-model',
        serverUrl: 'http://host:8000',
        requestHeaders: { 'X-Borrow': 'yes' },
      }),
    );
    expect(chatUpdate).toHaveBeenCalledWith(
      'byokUtilityModelDefault',
      'mainAgent',
      vscode.ConfigurationTarget.Global,
    );
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('borrows auth from the selected identity when one URL has multiple credentials', async () => {
    const siblings = [
      {
        id: 'identity-a',
        vllmModelId: 'model-a',
        serverUrl: 'http://host:8000',
        requestHeaders: { Authorization: 'Bearer secret-a' },
      },
      {
        id: 'identity-b',
        vllmModelId: 'model-b',
        serverUrl: 'http://host:8000',
        requestHeaders: { Authorization: 'Bearer secret-b' },
      },
    ];
    vscode.workspace._mockConfig = {
      get: (key: string) => (key === 'models' ? siblings : undefined),
      update: chatUpdate,
      inspect: () => ({ defaultValue: 'none' }),
    };
    resolveSpy = vi.spyOn(hfDiscovery, 'resolveModelConfigForAddSafely').mockResolvedValue({
      modelConfig: { id: 'new-model', vllmModelId: 'new-model' },
      summary: ['discovered'],
    });
    infoSpy.mockResolvedValue('Save to Settings' as any);

    registerAutoConfigureModelCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.autoConfigureModel', {
      serverUrl: 'http://host:8000',
      id: 'new-model',
      identityModelId: 'identity-b',
    });

    expect(resolveSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'new-model',
      'http://host:8000',
      { Authorization: 'Bearer secret-b' },
      undefined,
      undefined,
      undefined,
    );
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requestHeaders: { Authorization: 'Bearer secret-b' } }),
    );
  });
});
