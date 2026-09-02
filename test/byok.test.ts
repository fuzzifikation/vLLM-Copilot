import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ensureByokUtilityDefault, ensureAgentHostModelsEnabled } from '../src/commands/byok.js';

/**
 * Direct tests for the BYOK utility-model module. The chat-config write is
 * observed through its side effect (config.update) rather than by stubbing
 * internal state. What survives here is only the clobber-protection contract:
 * explicit user values and other extensions' entries must never be overwritten.
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

  it('does nothing when the setting is already explicitly set by the user', async () => {
    mockChatConfig({ defaultValue: 'none', globalValue: 'copilot' });

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

  it('respects an explicit user value for the agent-host setting (even false)', async () => {
    mockConfigs({ byok: { defaultValue: false, globalValue: false }, window: { defaultValue: {} } });

    await ensureAgentHostModelsEnabled();

    expect(chatUpdate.mock.calls.some(c => c[0] === BYOK_KEY)).toBe(false);
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
});
