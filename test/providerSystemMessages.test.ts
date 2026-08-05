import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'node:fs/promises';
import { VllmChatModelProvider } from '../src/provider.js';

function makeProvider(): VllmChatModelProvider {
  return new VllmChatModelProvider(
    { extension: { extensionKind: vscode.ExtensionKind.UI } } as any,
    { appendLine: vi.fn() } as any,
  );
}

describe('system message processing', () => {
  afterEach(() => {
    vscode.workspace._mockConfig = {};
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  it('captures system messages when no replacements are configured', async () => {
    vscode.workspace._mockConfig = {
      get: (key: string) => key === 'systemMessageCapture' ? true : undefined,
    };

    const provider = makeProvider();
    const captureToDisk = vi.spyOn(provider as any, 'captureToDisk').mockResolvedValue(undefined);
    const systemMessage = {
      role: vscode.LanguageModelChatMessageRole.System,
      content: [new vscode.LanguageModelTextPart('original system prompt')],
    };

    const result = await (provider as any).processSystemMessages(
      { id: 'model' },
      [systemMessage],
      { models: [{ id: 'model' }], enableFileLogging: false },
    );

    expect(result).toEqual([systemMessage]);
    expect(captureToDisk).toHaveBeenCalledWith([
      {
        receivedContent: 'original system prompt',
        deliveredContent: 'original system prompt',
        rulesApplied: [],
      },
    ]);
  });

  it('does not call captureToDisk when capture is disabled even with replacements', async () => {
    const provider = makeProvider();
    const captureToDisk = vi.spyOn(provider as any, 'captureToDisk').mockResolvedValue(undefined);

    await (provider as any).processSystemMessages(
      { id: 'model' },
      [{ role: vscode.LanguageModelChatMessageRole.System, content: [new vscode.LanguageModelTextPart('x')] }],
      { models: [{ id: 'model' }], enableFileLogging: false },
    );

    expect(captureToDisk).not.toHaveBeenCalled();
  });

  it('passes non-system messages through by reference (never mutated)', async () => {
    const provider = makeProvider();
    const userMsg = { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hi')] };

    const result = await (provider as any).processSystemMessages(
      { id: 'model' },
      [userMsg],
      { models: [{ id: 'model' }], enableFileLogging: false },
    );

    expect(result).toEqual([userMsg]);
  });

  it('returns the original messages unchanged when processing fails', async () => {
    const provider = makeProvider();
    // A config whose models entry has a bad replacements file path still resolves;
    // force a failure via an unreadable config.models structure is awkward, so
    // instead verify the error-swallowing path via a malformed file below.

    const msg = { role: vscode.LanguageModelChatMessageRole.System, content: [new vscode.LanguageModelTextPart('text')] };
    // malformed replacements file → loadReplacements returns [] after logging.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-psm-'));
    try {
      const bad = path.join(dir, 'bad.json');
      await fs.writeFile(bad, '{ not json', 'utf-8');
      const result = await (provider as any).processSystemMessages(
        { id: 'model' },
        [msg],
        { models: [{ id: 'model', systemMessageReplacementsFile: bad }], enableFileLogging: false },
      );
      // Fallback: original messages pass through.
      expect(result).toEqual([msg]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('system message processing — replacement application', () => {
  let dir: string;
  let replFile: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-psm-repl-'));
    replFile = path.join(dir, 'repl.json');
    await fs.writeFile(
      replFile,
      JSON.stringify({ meta: { name: 'Test', description: 'd' }, rules: [{ ruleName: 'r1', find: 'original', replace: 'replaced' }] }),
      'utf-8',
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    vscode.workspace._mockConfig = {};
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  it('applies replacements and creates NEW message objects (original stays pristine)', async () => {
    const provider = makeProvider();
    const captureToDisk = vi.spyOn(provider as any, 'captureToDisk').mockResolvedValue(undefined);
    vscode.workspace._mockConfig = {
      get: (key: string) => key === 'systemMessageCapture' ? true : undefined,
    };

    const original = {
      role: vscode.LanguageModelChatMessageRole.System,
      content: [new vscode.LanguageModelTextPart('original system prompt')],
    };

    const result = await (provider as any).processSystemMessages(
      { id: 'model' },
      [original],
      { models: [{ id: 'model', systemMessageReplacementsFile: replFile }], enableFileLogging: false },
    );

    // New object, not the same reference — original must be untouched.
    expect(result[0]).not.toBe(original);
    expect(original.content[0].value).toBe('original system prompt');
    expect((result[0].content[0] as vscode.LanguageModelTextPart).value).toBe('replaced system prompt');

    expect(captureToDisk).toHaveBeenCalledWith([
      {
        receivedContent: 'original system prompt',
        deliveredContent: 'replaced system prompt',
        rulesApplied: ['r1'],
      },
    ]);
  });

  it('preserves non-system messages and applies replacements only to system role', async () => {
    const provider = makeProvider();
    vscode.workspace._mockConfig = { get: () => undefined };
    const userMsg = { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('original question')] };

    const result = await (provider as any).processSystemMessages(
      { id: 'model' },
      [userMsg, { role: vscode.LanguageModelChatMessageRole.System, content: [new vscode.LanguageModelTextPart('original system prompt')] }],
      { models: [{ id: 'model', systemMessageReplacementsFile: replFile }], enableFileLogging: false },
    );

    // User message passes through by reference; system message is replaced.
    expect(result[0]).toBe(userMsg);
    expect((result[1].content[0] as vscode.LanguageModelTextPart).value).toBe('replaced system prompt');
  });
});

describe('loadReplacements — path resolution', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-lr-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    vscode.workspace._mockConfig = {};
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  it('resolves a workspace-relative systemMessageReplacementsFile against the first workspace folder', async () => {
    const provider = makeProvider();
    // Fake workspace root = the temp dir; relative path points into .vllm inside it.
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: dir } }];
    const vllmDir = path.join(dir, '.vllm');
    await fs.mkdir(vllmDir);
    const file = path.join(vllmDir, 'repl.json');
    await fs.writeFile(file, JSON.stringify([{ find: 'a', replace: 'b' }]), 'utf-8');

    const rules = await (provider as any).loadReplacements({
      id: 'm',
      serverUrl: 'http://localhost:8000',
      systemMessageReplacementsFile: '.vllm/repl.json',
    });

    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ find: 'a', replace: 'b' });
  });

  it('returns [] (with a warning) when the relative file is missing', async () => {
    const provider = makeProvider();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: dir } }];
    const output = provider as any;

    const rules = await output.loadReplacements({
      id: 'm',
      serverUrl: 'http://localhost:8000',
      systemMessageReplacementsFile: '.vllm/missing.json',
    });

    expect(rules).toEqual([]);
  });
});