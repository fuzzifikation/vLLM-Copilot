import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConfigurationTarget } from 'vscode';
import { registerRemoveServerCommand } from '../src/commands.js';

/**
 * Tests for "Remove Server". The command is ENTRY-ID-addressed (§5, 1.36.0-rc0
 * doctrine): the right-clicked node deletes exactly its own registry entry and
 * never sweeps sibling entries that merely share a URL. With two credential
 * identities on one URL, URL-wide deletion would destroy entries the user
 * never clicked — these tests pin the per-entry behavior.
 */

const output = { appendLine: vi.fn(), show: vi.fn() } as any;
const provider = { clearCache: vi.fn() } as any;

function makeConfig(models: any[], servers: any[]): any {
  return {
    get: vi.fn((k: string) => (k === 'models' ? models : k === 'servers' ? servers : undefined)),
    has: () => false,
    update: vi.fn(async () => {}),
    inspect: () => undefined,
  };
}

describe('removeServer command', () => {
  beforeEach(() => {
    (vscode as any).commands._registrations = [];
    vi.restoreAllMocks();
  });

  it('removes ONLY the addressed entry, leaving the same-URL sibling intact', async () => {
    const servers = [
      { id: 'srv-a', serverUrl: 'http://s:8000' },
      { id: 'srv-b', serverUrl: 'http://s:8000/' }, // same URL, other credential
      { id: 'other', serverUrl: 'http://elsewhere:9000' },
    ];
    const cfg = makeConfig([], servers);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);

    const disposable = registerRemoveServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.removeServer', { serverId: 'srv-a', skipConfirm: true });
    disposable.dispose();

    const updateCall = cfg.update.mock.calls.find((c: any[]) => c[0] === 'servers');
    expect(updateCall).toBeDefined();
    expect(updateCall![2]).toBe(ConfigurationTarget.Global);
    expect(updateCall![1].map((s: any) => s.id)).toEqual(['srv-b', 'other']);
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('refuses when the addressed entry is referenced, even if a same-URL sibling is free', async () => {
    const servers = [
      { id: 'srv-a', serverUrl: 'http://s:8000' },
      { id: 'srv-b', serverUrl: 'http://s:8000' },
    ];
    const models = [{ id: 'm1', vllmModelId: 'm1', server: 'srv-a' }];
    const cfg = makeConfig(models, servers);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);

    const disposable = registerRemoveServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.removeServer', { serverId: 'srv-a', skipConfirm: true });
    disposable.dispose();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('still used by 1 model(s): m1'));
    expect(cfg.update).not.toHaveBeenCalled();
  });

  it('does nothing when the id is not registered', async () => {
    const cfg = makeConfig([], [{ id: 'other', serverUrl: 'http://elsewhere:9000' }]);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);

    const disposable = registerRemoveServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.removeServer', { serverId: 'ghost', skipConfirm: true });
    disposable.dispose();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No registered server with id "ghost"'));
    expect(cfg.update).not.toHaveBeenCalled();
  });

  it('refuses without a serverId instead of guessing by URL', async () => {
    const cfg = makeConfig([], [{ id: 'srv-a', serverUrl: 'http://s:8000' }]);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    const errSpy = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as any);

    const disposable = registerRemoveServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.removeServer', { serverUrl: 'http://s:8000', skipConfirm: true });
    disposable.dispose();

    expect(errSpy).toHaveBeenCalledWith('Server id not provided.');
    expect(cfg.update).not.toHaveBeenCalled();
  });
});
