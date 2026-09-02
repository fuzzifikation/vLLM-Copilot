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
 * measured: entry-id anchoring, infra-field preservation, and the
 * replace-based save.
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
  const newConfig = { id: 'm', vllmModelId: 'm', server: 'srv' };

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
        server: 'host-8000',
        autoContinueRetries: 3,
        streamInactivityTimeout: 60000,
        systemMessageReplacementsFile: '.vllm/spartan.json',
        maxInputTokens: 32768,
        estimateCharsPerToken: 4,
      },
    ];
    // Server facts (URL, auth, type) live on the registry entry the model refs.
    const servers = [
      { id: 'host-8000', serverUrl: 'http://host:8000', requestHeaders: { 'X-Auth': 'keep' } },
    ];
    vscode.workspace._mockConfig = {
      get: (key: string) => (key === 'models' ? existing : key === 'servers' ? servers : undefined),
      update: chatUpdate,
      inspect: () => ({ defaultValue: 'none' }),
    };
    resolveSpy = vi.spyOn(hfDiscovery, 'resolveModelConfigForAddSafely').mockResolvedValue({
      modelConfig: { id: 'existing-id', vllmModelId: 'wire', server: 'host-8000', capabilities: { toolCalling: true, imageInput: false } },
      summary: ['discovered'],
    });
    infoSpy.mockResolvedValue('Save' as any);

    registerAutoConfigureModelCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.autoConfigureModel', {
      server: 'host-8000',
      id: 'existing-id',
    });

    expect(resolveSpy).toHaveBeenCalledWith(
      expect.anything(), // output channel
      expect.anything(), // extension context
      'wire', 'http://host:8000', { 'X-Auth': 'keep' }, undefined, existing[0],
      'vllm', // entry backend type (unset on the entry → defaults to vllm)
    );
    // Infra/personal fields survive the discovery-result base merge.
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'existing-id',
        vllmModelId: 'wire',
        server: 'host-8000',
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
    const sibling = { id: 'sibling', vllmModelId: 'sib', server: 'host-8000' };
    const servers = [
      { id: 'host-8000', serverUrl: 'http://host:8000', requestHeaders: { 'X-Borrow': 'yes' } },
    ];
    vscode.workspace._mockConfig = {
      get: (key: string) => (key === 'models' ? [sibling] : key === 'servers' ? servers : undefined),
      update: chatUpdate,
      inspect: () => ({ defaultValue: 'none' }),
    };
    resolveSpy = vi.spyOn(hfDiscovery, 'resolveModelConfigForAddSafely').mockResolvedValue({
      modelConfig: { id: 'new-model', vllmModelId: 'new-model', server: 'host-8000', capabilities: { toolCalling: true, imageInput: false } },
      summary: ['discovered'],
    });
    // confirmAndSaveAddedModel dialog → Save to Settings (BYOK path).
    infoSpy.mockResolvedValue('Save to Settings' as any);

    registerAutoConfigureModelCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.autoConfigureModel', {
      server: 'host-8000',
      id: 'new-model',
    });

    // New entry: composite config key + the shared server ref (the sibling's
    // entry matched by connection, so no duplicate entry was written).
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'new-model on host-8000',
        vllmModelId: 'new-model',
        server: 'host-8000',
      }),
    );
    expect(chatUpdate).toHaveBeenCalledWith(
      'byokUtilityModelDefault',
      'mainAgent',
      vscode.ConfigurationTarget.Global,
    );
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('targets the selected entry\'s credentials when one URL has multiple identities', async () => {
    const siblings = [
      { id: 'identity-a', vllmModelId: 'model-a', server: 'srv-a' },
      { id: 'identity-b', vllmModelId: 'model-b', server: 'srv-b' },
    ];
    const servers = [
      { id: 'srv-a', serverUrl: 'http://host:8000', requestHeaders: { Authorization: 'Bearer a' } },
      { id: 'srv-b', serverUrl: 'http://host:8000', requestHeaders: { Authorization: 'Bearer b' } },
    ];
    vscode.workspace._mockConfig = {
      get: (key: string) => (key === 'models' ? siblings : key === 'servers' ? servers : undefined),
      update: chatUpdate,
      inspect: () => ({ defaultValue: 'none' }),
    };
    resolveSpy = vi.spyOn(hfDiscovery, 'resolveModelConfigForAddSafely').mockResolvedValue({
      modelConfig: { id: 'new-model', vllmModelId: 'new-model', server: 'srv-b' },
      summary: ['discovered'],
    });
    infoSpy.mockResolvedValue('Save to Settings' as any);

    registerAutoConfigureModelCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.autoConfigureModel', {
      server: 'srv-b',
      id: 'new-model',
    });

    expect(resolveSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'new-model',
      'http://host:8000',
      { Authorization: 'Bearer b' },
      undefined,
      undefined,
      'vllm',
    );
    // The model refs identity-b's registry entry — that IS the auth borrow.
    expect(replaceSpy).toHaveBeenCalledWith(expect.objectContaining({ server: 'srv-b' }));
  });
});
