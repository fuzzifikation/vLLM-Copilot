import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConfigurationTarget } from 'vscode';
import { applyServerDisplayName, registerRenameServerCommand } from '../src/commands.js';

/**
 * Tests for the "Rename Server" command and its group-write helper.
 *
 * Semantics pinned here: the display name labels THE SERVER, so the helper
 * matches by NORMALIZED URL (wider than the URL+headers fingerprint that groups
 * the tree — two credential identities are two views of the same box and share
 * its label). Empty/whitespace input CLEARS by deleting the key — this write
 * path bypasses normalizeModelEntry, so storing '' verbatim would be a bug.
 * OpenRouter is rejected: openrouter.ai is a fixed managed relay, nothing to
 * rename. Cancel = no write.
 */

const output = { appendLine: vi.fn(), show: vi.fn() } as any;
const provider = { clearCache: vi.fn() } as any;

/** A spyable WorkspaceConfiguration whose get() serves a models array. */
function makeConfig(models: any[]): any {
  return {
    get: vi.fn((k: string) => (k === 'models' ? models : undefined)),
    has: () => false,
    update: vi.fn(async () => {}),
    inspect: () => undefined,
  };
}

describe('applyServerDisplayName', () => {
  it('writes the name to every model sharing the normalized URL', () => {
    const existing = [
      { id: 'a', vllmModelId: 'ma', serverUrl: 'http://s:8000/' },
      { id: 'b', vllmModelId: 'mb', serverUrl: 'http://s:8000/v1' },
      { id: 'c', vllmModelId: 'mc', serverUrl: 'http://other:9000' },
    ];
    const { models, changed } = applyServerDisplayName(existing, 'http://s:8000', 'IT Server');

    expect(changed).toBe(2);
    expect(models[0].serverDisplayName).toBe('IT Server');
    expect(models[1].serverDisplayName).toBe('IT Server');
    expect('serverDisplayName' in models[2]).toBe(false);
    // Untouched entries keep their object identity — no spurious rewrites.
    expect(models[2]).toBe(existing[2]);
  });

  it('trims surrounding whitespace from the name', () => {
    const existing = [{ id: 'a', vllmModelId: 'ma', serverUrl: 'http://s:8000' }];
    const { models } = applyServerDisplayName(existing, 'http://s:8000', '  GPU Box  ');
    expect(models[0].serverDisplayName).toBe('GPU Box');
  });

  it('clears by deleting the key when the name is empty', () => {
    const existing = [{ id: 'a', vllmModelId: 'ma', serverUrl: 'http://s:8000', serverDisplayName: 'Old' }];
    const { models, changed } = applyServerDisplayName(existing, 'http://s:8000', '');
    expect(changed).toBe(1);
    // '' must never be persisted — absent means "show the URL again".
    expect('serverDisplayName' in models[0]).toBe(false);
  });

  it('clears on whitespace-only input too', () => {
    const existing = [{ id: 'a', vllmModelId: 'ma', serverUrl: 'http://s:8000', serverDisplayName: 'Old' }];
    const { models } = applyServerDisplayName(existing, 'http://s:8000', '   ');
    expect('serverDisplayName' in models[0]).toBe(false);
  });

  it('is a no-op when every matched entry already carries the value', () => {
    const existing = [{ id: 'a', vllmModelId: 'ma', serverUrl: 'http://s:8000', serverDisplayName: 'Same' }];
    const { models, changed } = applyServerDisplayName(existing, 'http://s:8000', 'Same');
    expect(changed).toBe(0);
    expect(models[0]).toBe(existing[0]);
  });

  it('matches no models on an unknown URL (changed stays 0)', () => {
    const existing = [{ id: 'a', vllmModelId: 'ma', serverUrl: 'http://s:8000' }];
    const { models, changed } = applyServerDisplayName(existing, 'http://ghost:1', 'X');
    expect(changed).toBe(0);
    expect(models).toEqual(existing);
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

  it('renames all models on the server and invalidates the provider cache', async () => {
    const models = [
      { id: 'a', vllmModelId: 'ma', serverUrl: 'http://s:8000' },
      { id: 'b', vllmModelId: 'mb', serverUrl: 'http://s:8000' },
    ];
    const cfg = makeConfig(models);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('IT Server for GLM5.2');

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'http://s:8000');
    disposable.dispose();

    const written = cfg.update.mock.calls.find((c: any[]) => c[0] === 'models')![1] as any[];
    expect(written.every((m: any) => m.serverDisplayName === 'IT Server for GLM5.2')).toBe(true);
    expect(cfg.update.mock.calls.find((c: any[]) => c[0] === 'models')![2]).toBe(ConfigurationTarget.Global);
    expect(provider.clearCache).toHaveBeenCalledTimes(1);
  });

  it("deletes the key instead of persisting '' when cleared", async () => {
    const models = [{ id: 'a', vllmModelId: 'ma', serverUrl: 'http://s:8000', serverDisplayName: 'Old' }];
    const cfg = makeConfig(models);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('');

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'http://s:8000');
    disposable.dispose();

    const written = cfg.update.mock.calls.find((c: any[]) => c[0] === 'models')![1] as any[];
    expect(written[0]).not.toHaveProperty('serverDisplayName');
    expect(provider.clearCache).toHaveBeenCalledTimes(1);
  });

  it('performs no write when cancelled', async () => {
    const models = [{ id: 'a', vllmModelId: 'ma', serverUrl: 'http://s:8000' }];
    const cfg = makeConfig(models);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce(undefined);

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'http://s:8000');
    disposable.dispose();

    expect(cfg.update).not.toHaveBeenCalled();
    expect(provider.clearCache).not.toHaveBeenCalled();
  });

  it('rejects OpenRouter relays without prompting or writing', async () => {
    const models = [{ id: 'or', vllmModelId: 'x', serverUrl: 'https://openrouter.ai/api', serverType: 'openrouter' }];
    const cfg = makeConfig(models);
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

  it('warns (not "no changes") when no model matches the URL', async () => {
    // Stale tree item / programmatic call with a wrong URL must fail loudly —
    // conflating this with a no-op rename hides the real problem.
    const models = [{ id: 'a', vllmModelId: 'ma', serverUrl: 'http://s:8000' }];
    const cfg = makeConfig(models);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('Ghost Name');
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValueOnce(undefined as any);

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'http://ghost:1');
    disposable.dispose();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No models found'));
    expect(cfg.update).not.toHaveBeenCalled();
    expect(provider.clearCache).not.toHaveBeenCalled();
  });

  it('shows "No changes" (not a warning) when the name is already set', async () => {
    const models = [{ id: 'a', vllmModelId: 'ma', serverUrl: 'http://s:8000', serverDisplayName: 'Same' }];
    const cfg = makeConfig(models);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('Same');
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValueOnce(undefined as any);
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'http://s:8000');
    disposable.dispose();

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('No changes'));
    expect(warnSpy).not.toHaveBeenCalled();
    expect(cfg.update).not.toHaveBeenCalled();
  });

  it('pre-fills the input with the current display name', async () => {
    const models = [{ id: 'a', vllmModelId: 'ma', serverUrl: 'http://s:8000', serverDisplayName: 'Current' }];
    const cfg = makeConfig(models);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    const inputSpy = vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce(undefined) as any;

    const disposable = registerRenameServerCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.renameServer', 'http://s:8000');
    disposable.dispose();

    expect(inputSpy.mock.calls[0][0]).toMatchObject({ value: 'Current', ignoreFocusOut: true });
  });

  it('re-reads models after the prompt so concurrent edits are not clobbered', async () => {
    // A model added to settings WHILE the prompt is open must survive the
    // rename write — the pre-prompt snapshot is prefill-only.
    const beforePrompt = [{ id: 'a', vllmModelId: 'ma', serverUrl: 'http://s:8000' }];
    const afterPrompt = [
      { id: 'a', vllmModelId: 'ma', serverUrl: 'http://s:8000' },
      { id: 'new', vllmModelId: 'mn', serverUrl: 'http://s:8000' },
    ];
    const cfg = {
      get: vi.fn()
        .mockReturnValueOnce(beforePrompt)  // prefill read
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

    const written = (cfg.update.mock.calls as any[]).find((c: any[]) => c[0] === 'models')![1] as any[];
    expect(written).toHaveLength(2);
    expect(written.every((m: any) => m.serverDisplayName === 'Late Name')).toBe(true);
  });
});
