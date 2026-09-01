import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerConfigureCostCommand } from '../src/commands.js';
import { ConfigurationTarget } from 'vscode';

/**
 * Tests for the "Set Cost…" command on the Token Usage node.
 * Exercises the guided flow (model quickpick → three rate inputs → currency)
 * and asserts the `cost` block is written via patchModelConfig.
 */

const output = { appendLine: vi.fn() } as any;

/** Registry serving the URL the command is invoked with. */
const SERVERS = [{ id: 'srv', serverUrl: 'http://s:8000' }];

/** A spyable WorkspaceConfiguration whose get() serves a models array. */
function makeConfig(models: any[], servers: any[] = SERVERS): any {
  return {
    get: vi.fn((k: string) => (k === 'models' ? models : k === 'servers' ? servers : undefined)),
    has: () => false,
    update: vi.fn(async () => {}),
    inspect: () => undefined,
  };
}

describe('configureCost command', () => {
  beforeEach(() => {
    (vscode as any).commands._registrations = [];
    vi.restoreAllMocks();
  });

  it('writes a cost block via patchModelConfig for the picked model', async () => {
    const models = [{ id: 'cfg1', vllmModelId: 'm1', server: 'srv' }];
    const cfg = makeConfig(models);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showQuickPick')
      .mockResolvedValueOnce({ label: 'cfg1', description: 'm1', model: models[0] } as any) // model pick
      .mockResolvedValueOnce({ label: 'USD' } as any); // currency
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('1')    // input
      .mockResolvedValueOnce('2')    // output
      .mockResolvedValueOnce('0.5'); // cachedInput

    const disposable = registerConfigureCostCommand({} as any, output);
    await (vscode as any).commands._run('vllm-copilot.configureCost', { serverUrl: 'http://s:8000' });
    disposable.dispose();

    // patchModelConfig reads models, then updates with a cost-bearing entry.
    const updateCalls = cfg.update.mock.calls.filter((c: any[]) => c[0] === 'models');
    expect(updateCalls.length).toBeGreaterThan(0);
    const written = updateCalls[0][1] as any[];
    expect(written[0].cost).toEqual({ input: 1, output: 2, cachedInput: 0.5, currency: 'USD' });
    expect(updateCalls[0][2]).toBe(ConfigurationTarget.Global);
  });

  it('lists models of EVERY entry on the URL (§5 URL-wide scope)', async () => {
    // Two credential identities on one URL: first-match resolution would list
    // only the first entry's models and silently drop the rest.
    const servers = [
      { id: 'srv-a', serverUrl: 'http://s:8000' },
      { id: 'srv-b', serverUrl: 'http://s:8000' },
    ];
    const models = [
      { id: 'ma', vllmModelId: 'ma', server: 'srv-b' }, // lives on the SECOND identity
      { id: 'mb', vllmModelId: 'mb', server: 'srv-a' },
    ];
    const cfg = makeConfig(models, servers);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    const pick = vi.spyOn(vscode.window, 'showQuickPick')
      .mockResolvedValueOnce({ label: 'ma', model: models[0] } as any) // model pick
      .mockResolvedValueOnce({ label: 'USD' } as any);                // currency
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('1')
      .mockResolvedValueOnce('0')
      .mockResolvedValueOnce('');

    const disposable = registerConfigureCostCommand({} as any, output);
    await (vscode as any).commands._run('vllm-copilot.configureCost', { serverUrl: 'http://s:8000' });
    disposable.dispose();

    const items = pick.mock.calls[0][0] as any[];
    expect(items.map(i => i.model.id)).toEqual(['ma', 'mb']);
    const written = cfg.update.mock.calls.find((c: any[]) => c[0] === 'models')![1] as any[];
    expect(written.find(m => m.id === 'ma').cost).toMatchObject({ input: 1 });
  });

  it('prefills existing rates and preserves them on partial entry', async () => {
    const models = [{ id: 'cfg1', vllmModelId: 'm1', server: 'srv', cost: { input: 0.1, output: 0.2, currency: 'AI Credits' } }];
    const cfg = makeConfig(models);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showQuickPick')
      .mockResolvedValueOnce({ label: 'cfg1', model: models[0] } as any)
      .mockResolvedValueOnce({ label: 'AI Credits' } as any);
    // ShowInputBox spies receive options — verify the prefilled value is passed.
    const inputBox = vi.spyOn(vscode.window, 'showInputBox');
    inputBox
      .mockResolvedValueOnce('')     // input cleared → 0
      .mockResolvedValueOnce('0.5')  // output changed
      .mockResolvedValueOnce('');    // cachedInput blank → 0

    const disposable = registerConfigureCostCommand({} as any, output);
    await (vscode as any).commands._run('vllm-copilot.configureCost', { serverUrl: 'http://s:8000' });
    disposable.dispose();

    // Prefill assertion: first input box received the existing input value.
    const firstOptions = inputBox.mock.calls[0][0] as { value?: string };
    expect(firstOptions.value).toBe('0.1');

    const written = cfg.update.mock.calls.find((c: any[]) => c[0] === 'models')[1] as any[];
    expect(written[0].cost).toEqual({ input: 0, output: 0.5, cachedInput: 0, currency: 'AI Credits' });
  });

  it('aborts early when no model is picked', async () => {
    const models = [{ id: 'cfg1', vllmModelId: 'm1', server: 'srv' }];
    const cfg = makeConfig(models);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValueOnce(undefined as any); // cancel pick

    const disposable = registerConfigureCostCommand({} as any, output);
    await (vscode as any).commands._run('vllm-copilot.configureCost', { serverUrl: 'http://s:8000' });
    disposable.dispose();

    expect(cfg.update).not.toHaveBeenCalled();
  });

  it('warns when the server has no configured models', async () => {
    const cfg = makeConfig([]);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);

    const disposable = registerConfigureCostCommand({} as any, output);
    await (vscode as any).commands._run('vllm-copilot.configureCost', { serverUrl: 'http://s:8000' });
    disposable.dispose();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('No configured models'));
    expect(cfg.update).not.toHaveBeenCalled();
  });
});
