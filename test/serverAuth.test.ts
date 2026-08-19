import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { promptForServerAuth } from '../src/commands/serverAuth.js';

/**
 * Direct tests for the serverAuth module's interactive prompt. The vscode mock
 * window.showInputBox/showErrorMessage are spied so the module is measured
 * without an Extension Host.
 */
describe('promptForServerAuth', () => {
  const opts = {
    apiKeyTitle: 'key',
    apiKeyPrompt: 'key prompt',
    apiKeyPlaceholder: 'key placeholder',
    headersTitle: 'headers',
    headersPrompt: 'headers prompt',
    headersPlaceholder: 'headers placeholder',
  };
  let inputBoxSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    inputBoxSpy = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);
    errorSpy = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when the user cancels the API key step', async () => {
    inputBoxSpy.mockResolvedValueOnce(undefined);

    const result = await promptForServerAuth(opts);

    expect(result).toBeUndefined();
    // The headers step is never reached after cancellation.
    expect(inputBoxSpy).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the user cancels at the headers step', async () => {
    inputBoxSpy.mockResolvedValueOnce('abc123').mockResolvedValueOnce(undefined);

    const result = await promptForServerAuth(opts);

    expect(result).toBeUndefined();
    expect(inputBoxSpy).toHaveBeenCalledTimes(2);
  });

  it('combines the API key into Bearer auth and merges custom headers on top', async () => {
    inputBoxSpy
      .mockResolvedValueOnce('  secret-key  ') // trimmed
      .mockResolvedValueOnce('{"X-API-Key": "custom"}');

    const result = await promptForServerAuth(opts);

    expect(result).toEqual({
      Authorization: 'Bearer secret-key',
      'X-API-Key': 'custom',
    });
    // Custom headers win over the key-derived header when names collide.
  });

  it('returns empty headers for a blank API key and blank headers input', async () => {
    inputBoxSpy.mockResolvedValueOnce('   ').mockResolvedValueOnce('');

    const result = await promptForServerAuth(opts);

    expect(result).toEqual({});
  });

  it('shows an error and returns undefined for invalid headers input', async () => {
    inputBoxSpy.mockResolvedValueOnce('abc').mockResolvedValueOnce('not json @@@');

    const result = await promptForServerAuth(opts);

    expect(result).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('Headers');
  });

  it('requires a non-empty key when requireApiKey is set', async () => {
    const callOpts = { ...opts, requireApiKey: true };
    inputBoxSpy.mockResolvedValueOnce('sk-ok').mockResolvedValueOnce('');

    await promptForServerAuth(callOpts);

    const keyCall = inputBoxSpy.mock.calls[0][0] as any;
    expect(keyCall.validateInput).toBeDefined();
    expect(keyCall.validateInput('')).toBe('An API key is required.');
    expect(keyCall.validateInput('   ')).toBe('An API key is required.');
    expect(keyCall.validateInput('sk-or-v1-abc')).toBeUndefined();
  });

  it('leaves the key optional when requireApiKey is omitted', async () => {
    inputBoxSpy.mockResolvedValueOnce('   ').mockResolvedValueOnce('');

    await promptForServerAuth(opts);

    const keyCall = inputBoxSpy.mock.calls[0][0] as any;
    expect(keyCall.validateInput).toBeUndefined();
  });
});
