import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ensureByokUtilityDefault, ensureAgentHostModelsEnabled, configureByokUtilityModel } from '../src/commands/byok.js';

/**
 * Direct tests for the BYOK utility-model module. The chat-config write is
 * observed through its side effect (config.update) rather than by stubbing
 * internal state — same pattern as test/persistAddedModel.test.ts.
 */
describe('ensureByokUtilityDefault', () => {
  let chatUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    chatUpdate = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vscode.workspace._mockConfig = {};
  });

  const mockChatConfig = (inspectResult: any, getResult?: string) => {
    vscode.workspace._mockConfig = {
      get: () => getResult,
      update: chatUpdate,
      inspect: () => inspectResult,
    };
  };

  it('writes mainAgent when the setting is registered but not explicitly set', async () => {
    mockChatConfig({ defaultValue: 'none' });

    await ensureByokUtilityDefault();

    expect(chatUpdate).toHaveBeenCalledWith(
      'byokUtilityModelDefault',
      'mainAgent',
      vscode.ConfigurationTarget.Global,
    );
  });

  it('does nothing when the setting is already explicitly set by the user', async () => {
    mockChatConfig({ defaultValue: 'none', globalValue: 'copilot' });

    await ensureByokUtilityDefault();

    expect(chatUpdate).not.toHaveBeenCalled();
  });

  it('bails out when the setting is not registered in this VS Code build', async () => {
    mockChatConfig({});

    await ensureByokUtilityDefault();

    expect(chatUpdate).not.toHaveBeenCalled();
  });
});

describe('ensureAgentHostModelsEnabled', () => {
  let chatUpdate: ReturnType<typeof vi.fn>;

  const BYOK_KEY = 'agentHost.byokModels.enabled';
  const WINDOW_KEY = 'supportAgentsWindow';
  const OUR_ID = 'System-Sciences.vllm-copilot';

  beforeEach(() => {
    chatUpdate = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vscode.workspace._mockConfig = {};
  });

  /** One mock config serves every section — dispatch per key like real VS Code would. */
  const mockConfigs = (opts: {
    byok?: any;
    window?: any;
    windowValue?: Record<string, boolean>;
  }) => {
    vscode.workspace._mockConfig = {
      inspect: (key: string) => (key === BYOK_KEY ? opts.byok : opts.window),
      get: (key: string) => (key === WINDOW_KEY ? opts.windowValue : undefined),
      update: chatUpdate,
    };
  };

  it('enables both settings when registered and untouched', async () => {
    mockConfigs({ byok: { defaultValue: false }, window: { defaultValue: {} } });

    await ensureAgentHostModelsEnabled();

    expect(chatUpdate).toHaveBeenCalledWith(BYOK_KEY, true, vscode.ConfigurationTarget.Global);
    expect(chatUpdate).toHaveBeenCalledWith(
      WINDOW_KEY,
      { [OUR_ID]: true },
      vscode.ConfigurationTarget.Global,
    );
  });

  it('respects an explicit user value for the agent-host setting (even false)', async () => {
    mockConfigs({ byok: { defaultValue: false, globalValue: false }, window: { defaultValue: {} } });

    await ensureAgentHostModelsEnabled();

    expect(chatUpdate.mock.calls.some(c => c[0] === BYOK_KEY)).toBe(false);
  });

  it('does not re-add the extension when the entry is already true', async () => {
    mockConfigs({
      byok: { defaultValue: false, globalValue: true },
      window: { defaultValue: {} },
      windowValue: { [OUR_ID]: true },
    });

    await ensureAgentHostModelsEnabled();

    expect(chatUpdate).not.toHaveBeenCalled();
  });

  it('preserves other extensions when merging our entry in', async () => {
    mockConfigs({
      byok: { defaultValue: false, globalValue: true },
      window: { defaultValue: {}, globalValue: { 'other.ext': true } },
      windowValue: { 'other.ext': true },
    });

    await ensureAgentHostModelsEnabled();

    expect(chatUpdate).toHaveBeenCalledWith(
      WINDOW_KEY,
      { 'other.ext': true, [OUR_ID]: true },
      vscode.ConfigurationTarget.Global,
    );
  });

  it('never overrides an explicit opt-out of the Agents window', async () => {
    mockConfigs({
      byok: { defaultValue: false, globalValue: true },
      window: { defaultValue: {} },
      windowValue: { [OUR_ID]: false },
    });

    await ensureAgentHostModelsEnabled();

    expect(chatUpdate).not.toHaveBeenCalled();
  });

  it('bails out entirely on VS Code builds without either setting', async () => {
    mockConfigs({ byok: undefined, window: undefined });

    await ensureAgentHostModelsEnabled();

    expect(chatUpdate).not.toHaveBeenCalled();
  });
});

describe('configureByokUtilityModel', () => {
  let chatUpdate: ReturnType<typeof vi.fn>;
  let quickPickSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let output: any;

  beforeEach(() => {
    chatUpdate = vi.fn().mockResolvedValue(undefined);
    quickPickSpy = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    // Fresh output per test — a describe-scope object would leak appendLine
    // calls across tests.
    output = {
      appendLine: vi.fn(),
      dispose: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
    };
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

  it('writes the chosen value and reports it when a pick is made', async () => {
    quickPickSpy.mockResolvedValueOnce({ label: 'GitHub Copilot', value: 'copilot' } as any);

    await configureByokUtilityModel(output);

    expect(chatUpdate).toHaveBeenCalledWith(
      'byokUtilityModelDefault',
      'copilot',
      vscode.ConfigurationTarget.Global,
    );
    expect(output.appendLine).toHaveBeenCalledWith("[INFO] BYOK utility model default set to 'copilot'");
    expect(infoSpy).toHaveBeenCalledWith('Utility model default: GitHub Copilot');
  });

  it('does nothing when the user dismisses the quick pick', async () => {
    await configureByokUtilityModel(output);

    expect(chatUpdate).not.toHaveBeenCalled();
    expect(output.appendLine).not.toHaveBeenCalled();
  });
});
