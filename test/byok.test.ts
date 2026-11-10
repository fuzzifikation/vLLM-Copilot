import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ensureByokUtilityDefault, ensureAgentHostModelsEnabled, maybeShowUpdatePage } from '../src/vscode/commands/byok.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Direct tests for the BYOK utility-model module. The chat-config write is
 * observed through its side effect (config.update) rather than by stubbing
 * internal state. Covers opt-out preservation and the versioned update-page
 * lifecycle, including retries after failed reads or preview commands.
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
    models?: unknown[];
  }) => {
    vscode.workspace._mockConfig = {
      inspect: (key: string) => (key === BYOK_KEY ? opts.byok : opts.window),
      get: (key: string) => {
        if (key === 'models') return opts.models ?? [{ id: 'first-model', server: 'server' }];
        if (key === WINDOW_KEY) return opts.windowValue;
        return undefined;
      },
      update: chatUpdate,
    };
  };

  it('does nothing when no model is configured', async () => {
    mockConfigs({ models: [], byok: { defaultValue: false }, window: { defaultValue: {} } });

    await ensureAgentHostModelsEnabled();

    expect(chatUpdate).not.toHaveBeenCalled();
  });

  it('enables both Agent Host settings when the first model appears', async () => {
    mockConfigs({ byok: { defaultValue: false }, window: { defaultValue: {} } });

    await ensureAgentHostModelsEnabled();

    expect(chatUpdate).toHaveBeenCalledWith(
      BYOK_KEY,
      true,
      vscode.ConfigurationTarget.Global,
    );
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

describe('startup update page', () => {
  let context: Pick<vscode.ExtensionContext, 'extension' | 'extensionUri' | 'globalState'>;
  let flags: Map<string, unknown>;

  beforeEach(() => {
    const extensionUri = vscode.Uri.file('extension');
    flags = new Map();
    context = {
      extensionUri,
      extension: {
        id: 'System-Sciences.vllm-copilot', extensionUri,
        extensionKind: vscode.ExtensionKind.Workspace, packageJSON: { version: '1.38.0' },
      },
      globalState: {
        get<T>(key: string): T | undefined { return flags.get(key) as T | undefined; },
        async update(key: string, value: unknown) { flags.set(key, value); },
      },
    };
    vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(async uri =>
      new Uint8Array(readFileSync(join(import.meta.dirname, '..', 'resources', String(uri)))));
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vscode.workspace._mockConfig = { models: [] };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vscode.workspace._mockConfig = {};
  });

  const run = () => maybeShowUpdatePage(context as vscode.ExtensionContext);

  it('opens the packaged Markdown on a fresh install and does not repeat for that version', async () => {
    await run();
    await run();
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'markdown.showPreview', expect.anything(), undefined, { locked: true },
    );
    expect(vscode.workspace.fs.readFile).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('shows after an upgrade despite the old picker notice and remembers each installed version', async () => {
    flags.set('vllmCopilot.newPickerNotice.v1', 'seen');
    await run();
    context.extension.packageJSON.version = '1.38.1';
    await run();
    context.extension.packageJSON.version = '1.38.0';
    await run();
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(2);
  });

  it.each(['read', 'preview'])('retries a failed %s without recording the page as shown', async stage => {
    if (stage === 'read') {
      vi.mocked(vscode.workspace.fs.readFile).mockRejectedValueOnce(new Error('page unavailable'));
    } else {
      vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error('preview unavailable'));
    }
    await expect(run()).rejects.toThrow('unavailable');
    await run();
    const calls = vi.mocked(vscode.commands.executeCommand).mock.calls.length;
    await run();
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(calls);
    expect(calls).toBe(stage === 'read' ? 1 : 2);
  });
});
