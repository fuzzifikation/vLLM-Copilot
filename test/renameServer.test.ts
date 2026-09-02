import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConfigurationTarget } from 'vscode';
import { applyServerDisplayName, registerRenameServerCommand } from '../src/commands.js';

/**
 * Tests for the "Rename Server" command and its registry-write helper.
 *
 * Semantics pinned here: the display name labels THE SERVER, so the helper
 * matches registry entries by NORMALIZED URL (wider than the URL+headers
 * fingerprint that groups the dashboard tree — two credential identities are
 * two views of the same box and share its label). Empty/whitespace input
 * CLEARS by deleting the key — this write path bypasses entry sanitization,
 * so storing '' verbatim would be a bug. OpenRouter is rejected:
 * openrouter.ai is a fixed managed relay, nothing to rename. Cancel = no
 * write. Unknown URLs fail loudly (stale tree items must not look like no-ops).
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

describe('applyServerDisplayName', () => {
  it('writes the name to every entry sharing the normalized URL', () => {
    const existing = [
      { id: 'a', serverUrl: 'http://s:8000/' },
      { id: 'b', serverUrl: 'http://s:8000/v1' },
      { id: 'c', serverUrl: 'http://other:9000' },
    ];
    const { servers, matched, changed } = applyServerDisplayName(existing, 'http://s:8000', 'IT Server');

    expect(matched).toBe(2);
    expect(changed).toBe(2);
    expect(servers[0].displayName).toBe('IT Server');
    expect(servers[1].displayName).toBe('IT Server');
    expect('displayName' in servers[2]).toBe(false);
    // Untouched entries keep their object identity — no spurious rewrites.
    expect(servers[2]).toBe(existing[2]);
  });

  it('clears by deleting the key when the name is empty', () => {
    const existing = [{ id: 'a', serverUrl: 'http://s:8000', displayName: 'Old' }];
    const { servers, changed } = applyServerDisplayName(existing, 'http://s:8000', '');
    expect(changed).toBe(1);
    // '' must never be persisted — absent means "show the URL again".
    expect('displayName' in servers[0]).toBe(false);
  });

});

describe('renameServer command', () => {
  beforeEach(() => {
    (vscode as any).commands._registrations = [];
    vi.restoreAllMocks();
    // provider/output are module-scope plain vi.fn()s — restoreAllMocks does
    // not reset their call history, which would leak between tests.
    provider.clearCache.mockClear();
    output.appendLine.mockClear();
  });

  it('renames every entry on the URL and invalidates the provider cache', async () => {
    const servers = [
      { id: 'a', serverUrl: 'http://s:8000' },
      { id: 'b', serverUrl: 'http://s:8000/v1' },
    ];
    const cfg = makeConfig(servers);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('IT Server for GLM5.2');

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'http://s:8000');
    disposable.dispose();

    const written = cfg.update.mock.calls.find((c: any[]) => c[0] === 'servers')![1] as any[];
    expect(written.every((s: any) => s.displayName === 'IT Server for GLM5.2')).toBe(true);
    expect(cfg.update.mock.calls.find((c: any[]) => c[0] === 'servers')![2]).toBe(ConfigurationTarget.Global);
    expect(provider.clearCache).toHaveBeenCalledTimes(1);
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

  it('rejects OpenRouter relays without prompting or writing', async () => {
    const servers = [{ id: 'or', serverUrl: 'https://openrouter.ai/api', serverType: 'openrouter' }];
    const cfg = makeConfig(servers);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    const inputSpy = vi.spyOn(vscode.window, 'showInputBox');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValueOnce(undefined as any);

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'https://openrouter.ai/api');
    disposable.dispose();

    expect(inputSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('OpenRouter'));
    expect(cfg.update).not.toHaveBeenCalled();
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
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'http://s:8000');
    disposable.dispose();

    const written = (cfg.update.mock.calls as any[]).find((c: any[]) => c[0] === 'servers')![1] as any[];
    expect(written).toHaveLength(2);
    expect(written.every((s: any) => s.displayName === 'Late Name')).toBe(true);
  });
});
