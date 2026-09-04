import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConfigurationTarget } from 'vscode';
import { registerRenameServerCommand } from '../src/commands/commands.js';

/**
 * Tests for the "Rename Server" command.
 *
 * Semantics pinned here: rename addresses EXACTLY ONE registry entry — the
 * tree item's `serverId`, or the first entry on the URL for bare-URL
 * programmatic calls. Entries sharing a URL (two OpenRouter keys, two
 * gateway tenants) keep separate labels: entry id is the identity, and
 * rename is no exception. Every backend is renamable, relays included —
 * one rule, no OpenRouter refusal. Empty/whitespace input CLEARS by
 * deleting the key — this write path bypasses entry sanitization, so
 * storing '' verbatim would be a bug. Cancel = no write. Unknown
 * addresses fail loudly (stale tree items must not look like no-ops).
 */

const output = { appendLine: vi.fn(), show: vi.fn() } as any;
const provider = { clearCache: vi.fn() } as any;

/** A spyable WorkspaceConfiguration whose get() serves a servers array. */
function makeConfig(servers: any[]): any {
  return {
    get: vi.fn((k: string) => (k === 'servers' ? servers : undefined)),
    has: () => false,
    update: vi.fn(async () => {}),
    inspect: () => undefined,
  };
}

describe('renameServer command', () => {
  beforeEach(() => {
    (vscode as any).commands._registrations = [];
    vi.restoreAllMocks();
    // provider/output are module-scope plain vi.fn()s — restoreAllMocks does
    // not reset their call history, which would leak between tests.
    provider.clearCache.mockClear();
    output.appendLine.mockClear();
  });

  it('renames exactly the addressed entry and invalidates the provider cache', async () => {
    const servers = [
      { id: 'a', serverUrl: 'http://s:8000' },
      { id: 'b', serverUrl: 'http://s:8000/v1' },
      { id: 'c', serverUrl: 'http://other:9000' },
    ];
    const cfg = makeConfig(servers);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('IT Server for GLM5.2');

    const disposable = registerRenameServerCommand({} as any, provider, output);
    // The context menu passes the tree item, which carries the entry id.
    await (vscode as any).commands._run('vllm-copilot.renameServer',
      { serverUrl: 'http://s:8000', serverId: 'a' });
    disposable.dispose();

    const written = cfg.update.mock.calls.find((c: any[]) => c[0] === 'servers')![1] as any[];
    expect(written[0].displayName).toBe('IT Server for GLM5.2');
    // The sibling sharing the URL is NOT renamed — entries are separate
    // servers by doctrine — and it stays identity-preserved (no churn).
    expect('displayName' in written[1]).toBe(false);
    expect(written[1]).toBe(servers[1]);
    // Entries on other URLs are untouched AND identity-preserved too.
    expect('displayName' in written[2]).toBe(false);
    expect(written[2]).toBe(servers[2]);
    expect(cfg.update.mock.calls.find((c: any[]) => c[0] === 'servers')![2]).toBe(ConfigurationTarget.Global);
    expect(provider.clearCache).toHaveBeenCalledTimes(1);
  });

  it('two entries sharing one URL get separate labels (identity doctrine)', async () => {
    // The exact OpenRouter case that made rename URL-wide awkward: two keys,
    // one fixed endpoint. Each entry must wear its own name.
    const servers = [
      { id: 'or-work', serverUrl: 'https://openrouter.ai/api', serverType: 'openrouter' },
      { id: 'or-home', serverUrl: 'https://openrouter.ai/api', serverType: 'openrouter' },
    ];
    const cfg = makeConfig(servers);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('Personal key');

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer',
      { serverUrl: 'https://openrouter.ai/api', serverId: 'or-home' });
    disposable.dispose();

    const written = cfg.update.mock.calls.find((c: any[]) => c[0] === 'servers')![1] as any[];
    expect('displayName' in written[0]).toBe(false);
    expect(written[0]).toBe(servers[0]);
    expect(written[1].displayName).toBe('Personal key');
  });

  it('writes nothing and says so when the name is already exactly the target', async () => {
    const servers = [{ id: 'a', serverUrl: 'http://s:8000', displayName: 'Same' }];
    const cfg = makeConfig(servers);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('Same');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'http://s:8000');
    disposable.dispose();

    expect(cfg.update).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.any(String)); // toast fired; wording is chrome (CR-109)
  });

  it("deletes the key instead of persisting '' when cleared", async () => {
    const servers = [{ id: 'a', serverUrl: 'http://s:8000', displayName: 'Old' }];
    const cfg = makeConfig(servers);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('');

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'http://s:8000');
    disposable.dispose();

    const written = cfg.update.mock.calls.find((c: any[]) => c[0] === 'servers')![1] as any[];
    expect(written[0]).not.toHaveProperty('displayName');
    expect(provider.clearCache).toHaveBeenCalledTimes(1);
  });

  it('performs no write when cancelled', async () => {
    const servers = [{ id: 'a', serverUrl: 'http://s:8000' }];
    const cfg = makeConfig(servers);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce(undefined);

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'http://s:8000');
    disposable.dispose();

    expect(cfg.update).not.toHaveBeenCalled();
    expect(provider.clearCache).not.toHaveBeenCalled();
  });

  it('renames OpenRouter entries like every other backend (one rule, no relay refusal)', async () => {
    const servers = [{ id: 'or', serverUrl: 'https://openrouter.ai/api', serverType: 'openrouter' }];
    const cfg = makeConfig(servers);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('Work key');

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'https://openrouter.ai/api');
    disposable.dispose();

    const written = cfg.update.mock.calls.find((c: any[]) => c[0] === 'servers')![1] as any[];
    expect(written[0].displayName).toBe('Work key');
    expect(provider.clearCache).toHaveBeenCalledTimes(1);
  });

  it('warns before prompting when no registry entry matches the URL', async () => {
    // Stale tree item / programmatic call with a wrong URL must fail loudly —
    // conflating this with a no-op rename hides the real problem.
    const servers = [{ id: 'a', serverUrl: 'http://other:9000' }];
    const cfg = makeConfig(servers);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    const inputSpy = vi.spyOn(vscode.window, 'showInputBox');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValueOnce(undefined as any);

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'http://ghost:1');
    disposable.dispose();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No registered server found'));
    expect(inputSpy).not.toHaveBeenCalled();
    expect(cfg.update).not.toHaveBeenCalled();
    expect(provider.clearCache).not.toHaveBeenCalled();
  });

  it('pre-fills the input with the current display name', async () => {
    const servers = [{ id: 'a', serverUrl: 'http://s:8000', displayName: 'Current' }];
    const cfg = makeConfig(servers);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    const inputSpy = vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce(undefined) as any;

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'http://s:8000');
    disposable.dispose();

    expect(inputSpy.mock.calls[0][0]).toMatchObject({ value: 'Current', ignoreFocusOut: true });
  });

  it('re-reads the registry after the prompt so concurrent edits are not clobbered', async () => {
    // An entry added to settings WHILE the prompt is open must survive the
    // rename write — the pre-prompt read is prefill-only.
    const beforePrompt = [{ id: 'a', serverUrl: 'http://s:8000' }];
    const afterPrompt = [
      { id: 'a', serverUrl: 'http://s:8000' },
      { id: 'late', serverUrl: 'http://s:8000/v1' },
    ];
    const cfg = {
      get: vi.fn()
        .mockReturnValueOnce(beforePrompt)  // prefill + existence check
        .mockReturnValueOnce(afterPrompt),  // authoritative post-prompt read
      has: () => false,
      update: vi.fn(async () => {}),
      inspect: () => undefined,
    };
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('Late Name');

    const disposable = registerRenameServerCommand({} as any, provider, output);
    // Bare URL addresses the FIRST entry on that URL.
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'http://s:8000');
    disposable.dispose();

    const written = (cfg.update.mock.calls as any[]).find((c: any[]) => c[0] === 'servers')![1] as any[];
    expect(written).toHaveLength(2);
    expect(written[0].displayName).toBe('Late Name');
    // The entry that appeared mid-prompt survives, untouched and unnamed.
    expect('displayName' in written[1]).toBe(false);
  });
});
