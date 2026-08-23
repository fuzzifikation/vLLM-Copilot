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

/** A spyable WorkspaceConfiguration whose get() serves a models array. */
function makeConfig(models: any[]): any {
  return {
    get: vi.fn((k: string) => (k === 'models' ? models : undefined)),
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

  it('merges a new API key into existing custom headers (no wipe)', async () => {
    const models = [{
      id: 'cfg1', vllmModelId: 'm1', serverUrl: 'http://s:8000',
      requestHeaders: { Authorization: 'Bearer old', 'CF-Access-Client-Id': 'id' },
    }];
    const cfg = makeConfig(models);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    // Update Auth prompts: key then headers (via promptForServerAuth).
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('new-key') // API key
      .mockResolvedValueOnce('');       // headers left empty

    const disposable = registerUpdateServerAuthCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.updateServerAuth', 'http://s:8000');
    disposable.dispose();

    const updateCalls = cfg.update.mock.calls.filter((c: any[]) => c[0] === 'models');
    expect(updateCalls.length).toBe(1);
    const written = updateCalls[0][1] as any[];
    expect(written[0].requestHeaders).toEqual({
      Authorization: 'Bearer new-key',
      'CF-Access-Client-Id': 'id', // preserved — the wipe bug is fixed
    });
    expect(updateCalls[0][2]).toBe(ConfigurationTarget.Global);
  });

  it('keeps the existing key when only custom headers are entered', async () => {
    const models = [{
      id: 'cfg1', vllmModelId: 'm1', serverUrl: 'http://s:8000',
      requestHeaders: { Authorization: 'Bearer old' },
    }];
    const cfg = makeConfig(models);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('')                   // key left empty (keep)
      .mockResolvedValueOnce('{"X-API-Key":"new"}'); // headers

    const disposable = registerUpdateServerAuthCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.updateServerAuth', 'http://s:8000');
    disposable.dispose();

    const written = cfg.update.mock.calls.find((c: any[]) => c[0] === 'models')![1] as any[];
    expect(written[0].requestHeaders).toEqual({ Authorization: 'Bearer old', 'X-API-Key': 'new' });
  });

  it('is a no-op (no config write) when both key and headers are left empty', async () => {
    const models = [{
      id: 'cfg1', vllmModelId: 'm1', serverUrl: 'http://s:8000',
      requestHeaders: { Authorization: 'Bearer old', 'X-API-Key': 'x' },
    }];
    const cfg = makeConfig(models);
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
    // Existing headers untouched.
    expect(models[0].requestHeaders).toEqual({ Authorization: 'Bearer old', 'X-API-Key': 'x' });
  });

  it('replaces wholesale when a complete auth set is passed via initialHeaders (OpenRouter)', async () => {
    // The OpenRouter Add flow passes the freshly collected key; merge still
    // applies, but a fresh Authorization replaces the old one.
    const models = [{
      id: 'cfg1', vllmModelId: 'm1', serverUrl: 'https://openrouter.ai/api',
      requestHeaders: { Authorization: 'Bearer old', 'HTTP-Referer': 'https://github.com' },
    }];
    const cfg = makeConfig(models);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);

    const disposable = registerUpdateServerAuthCommand({} as any, provider, output);
    await (vscode as any).commands._run(
      'vllm-copilot.updateServerAuth',
      'https://openrouter.ai/api',
      { Authorization: 'Bearer sk-or-v1-test' },
    );
    disposable.dispose();

    const written = cfg.update.mock.calls.find((c: any[]) => c[0] === 'models')![1] as any[];
    expect(written[0].requestHeaders).toEqual({
      Authorization: 'Bearer sk-or-v1-test',
      'HTTP-Referer': 'https://github.com', // lossless merge — still preserved
    });
  });

  it('warns (no config write) when no models match the server', async () => {
    const cfg = makeConfig([{ id: 'other', vllmModelId: 'm', serverUrl: 'http://elsewhere:8000' }]);
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('new-key')
      .mockResolvedValueOnce('');

    const disposable = registerUpdateServerAuthCommand({} as any, provider, output);
    await (vscode as any).commands._run('vllm-copilot.updateServerAuth', 'http://s:8000');
    disposable.dispose();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No models found'));
    expect(cfg.update).not.toHaveBeenCalled();
  });
});
