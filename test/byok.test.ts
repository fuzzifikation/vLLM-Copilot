import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ensureByokUtilityDefault, configureByokUtilityModel } from '../src/commands/byok.js';

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
