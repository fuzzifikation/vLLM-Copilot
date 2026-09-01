import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConfigurationTarget } from 'vscode';
import { mergeAuthHeaders, registerUpdateServerAuthCommand } from '../src/commands.js';

/**
 * Tests for the "Update Auth" command and its header-merge helper.
 *
 * The critical regression: updating auth used to REPLACE each model's whole
 * requestHeaders object, so rotating only the API key silently deleted existing
 * custom headers (e.g. CF-Access proxy headers) — the same class of silent data
 * loss as the focus-loss bug. New behavior merges: a non-empty key sets
 * Authorization, entered headers merge on top, and fields left empty keep their
 * current value.
 */

const output = { appendLine: vi.fn(), show: vi.fn() } as any;
const provider = { clearCache: vi.fn() } as any;

/** A spyable WorkspaceConfiguration serving models plus an optional server registry. */
function makeConfig(models: any[], servers: any[] = []): any {
  return {
    get: vi.fn((k: string) => (k === 'models' ? models : k === 'servers' ? servers : undefined)),
    has: () => false,
    update: vi.fn(async () => {}),
    inspect: () => undefined,
  };
}

describe('mergeAuthHeaders', () => {
  it('returns the same reference when nothing is entered (no-op)', () => {
    const existing = { Authorization: 'Bearer old', 'X-API-Key': 'x' };
    expect(mergeAuthHeaders(existing, {})).toBe(existing);
  });

  it('keeps existing custom headers when only the API key changes', () => {
    const existing = { Authorization: 'Bearer old', 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'secret' };
    expect(mergeAuthHeaders(existing, { Authorization: 'Bearer new' })).toEqual({
      Authorization: 'Bearer new',
      'CF-Access-Client-Id': 'id',
      'CF-Access-Client-Secret': 'secret',
    });
  });

  it('keeps the existing key when only custom headers are entered', () => {
    const existing = { Authorization: 'Bearer old' };
    expect(mergeAuthHeaders(existing, { 'X-API-Key': 'custom' })).toEqual({
      Authorization: 'Bearer old',
      'X-API-Key': 'custom',
    });
  });

  it('overwrites a colliding header name', () => {
    const existing = { 'X-API-Key': 'old' };
    expect(mergeAuthHeaders(existing, { 'X-API-Key': 'new' })).toEqual({ 'X-API-Key': 'new' });
  });

  it('creates headers from scratch when there were none', () => {
    expect(mergeAuthHeaders(undefined, { Authorization: 'Bearer new' })).toEqual({ Authorization: 'Bearer new' });
  });

  it('returns the same reference when incoming values match existing (no spurious write)', () => {
    const existing = { Authorization: 'Bearer same' };
    expect(mergeAuthHeaders(existing, { Authorization: 'Bearer same' })).toBe(existing);
  });
});

describe('updateServerAuth command', () => {
  beforeEach(() => {
    (vscode as any).commands._registrations = [];
    vi.restoreAllMocks();
  });

  /** Fixture: the registry entry owns the auth; the model only references it. */
  function makeFixture(entryHeaders?: Record<string, string>) {
    const servers: any[] = [{ id: 'srv', serverUrl: 'http://s:8000', ...(entryHeaders ? { requestHeaders: entryHeaders } : {}) }];
    const models = [{ id: 'cfg1', vllmModelId: 'm1', server: 'srv' }];
    return { cfg: makeConfig(models, servers), servers };
  }

  it('merges a new API key into existing custom headers (no wipe)', async () => {
    const { cfg, servers } = makeFixture({ Authorization: 'Bearer old', 'CF-Access-Client-Id': 'id' });
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    // Update Auth prompts: key then headers (via promptForServerAuth).
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('new-key') // API key
      .mockResolvedValueOnce('');       // headers left empty

    const disposable = registerUpdateServerAuthCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.updateServerAuth', 'http://s:8000');
    disposable.dispose();

    const updateCalls = cfg.update.mock.calls.filter((c: any[]) => c[0] === 'servers');
    expect(updateCalls.length).toBe(1);
    const written = updateCalls[0][1] as any[];
    expect(written[0].requestHeaders).toEqual({
      Authorization: 'Bearer new-key',
      'CF-Access-Client-Id': 'id', // preserved on the ENTRY — the wipe bug stays fixed
    });
    expect(updateCalls[0][2]).toBe(ConfigurationTarget.Global);
  });

  it('keeps the existing key when only custom headers are entered', async () => {
    const { cfg } = makeFixture({ Authorization: 'keep-me' });
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('')                   // key left empty (keep)
      .mockResolvedValueOnce('{"X-API-Key":"new"}'); // headers

    const disposable = registerUpdateServerAuthCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.updateServerAuth', 'http://s:8000');
    disposable.dispose();

    const written = cfg.update.mock.calls.find((c: any[]) => c[0] === 'servers')![1] as any[];
    expect(written[0].requestHeaders).toEqual({ Authorization: 'keep-me', 'X-API-Key': 'new' });
  });

  it('is a no-op (no config write) when both key and headers are left empty', async () => {
    const { cfg, servers } = makeFixture({ Authorization: 'keep-me', 'X-API-Key': 'x' });
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');

    const disposable = registerUpdateServerAuthCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.updateServerAuth', 'http://s:8000');
    disposable.dispose();

    expect(cfg.update).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('No auth changes'));
    // Existing entry headers untouched.
    expect(servers[0].requestHeaders).toEqual({ Authorization: 'keep-me', 'X-API-Key': 'x' });
  });

  it('merges a complete auth set passed via initialHeaders without re-prompting (OpenRouter)', async () => {
    // The OpenRouter Add flow passes the freshly collected key; merge still
    // applies, but a fresh Authorization replaces the old one.
    const servers: any[] = [{ id: 'openrouter', serverUrl: 'https://openrouter.ai/api', requestHeaders: { Authorization: 'sk-or-old', 'HTTP-Referer': 'https://github.com' } }];
    const models = [{ id: 'or', vllmModelId: 'm', server: 'openrouter' }];
    const cfg = makeConfig(models, servers);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    const inputBoxSpy = vi.spyOn(vscode.window, 'showInputBox');

    const disposable = registerUpdateServerAuthCommand({} as any, provider, output);
    await (vscode as any).commands._run(
      'vllm-copilot.updateServerAuth',
      'https://openrouter.ai/api',
      { Authorization: 'sk-or-new' },
    );
    disposable.dispose();

    expect(inputBoxSpy).not.toHaveBeenCalled();
    const written = cfg.update.mock.calls.find((c: any[]) => c[0] === 'servers')![1] as any[];
    expect(written[0].requestHeaders).toEqual({
      Authorization: 'sk-or-new',
      'HTTP-Referer': 'https://github.com', // lossless merge — still preserved
    });
  });

  it('warns (no config write) when the server is not registered', async () => {
    const cfg = makeConfig([{ id: 'other', vllmModelId: 'm', server: 'elsewhere' }], [{ id: 'elsewhere', serverUrl: 'http://elsewhere:8000' }]);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('new-key')
      .mockResolvedValueOnce('');

    const disposable = registerUpdateServerAuthCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.updateServerAuth', 'http://s:8000');
    disposable.dispose();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No registered server found'));
    expect(cfg.update).not.toHaveBeenCalled();
  });
});
