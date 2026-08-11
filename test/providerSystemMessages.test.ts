import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'node:fs/promises';
import { SystemMessagePipeline } from '../src/provider/systemMessagePipeline.js';

/**
 * Direct tests for the extracted system-message pipeline
 * (`systemMessagePipeline.ts`). The transformation path is exercised with an
 * injected capture writer so the collected entries are observable without
 * touching the file system; the write path itself has its own end-to-end suite
 * in `providerCapture.test.ts`.
 */
function makePipeline() {
  const captureWriter = vi.fn().mockResolvedValue(undefined);
  const pipeline = new SystemMessagePipeline({ appendLine: vi.fn() } as any, captureWriter);
  return { pipeline, captureWriter };
}

/** Minimal LanguageModelChatInformation fixture (the pipeline only reads model.id). */
function makeModel(id = 'model'): vscode.LanguageModelChatInformation {
  return {
    id, name: id, family: 'test', version: '1.0.0',
    maxInputTokens: 4096, maxOutputTokens: 4096,
    capabilities: { toolCalling: true, imageInput: false },
  };
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

    const { pipeline, captureWriter } = makePipeline();
    const systemMessage = {
      role: vscode.LanguageModelChatMessageRole.System,
      content: [new vscode.LanguageModelTextPart('original system prompt')],
    };

    const result = await pipeline.processSystemMessages(
      makeModel('model'),
      [systemMessage],
      { models: [{ id: 'model' }], enableFileLogging: false },
    );

    expect(result).toEqual([systemMessage]);
    expect(captureWriter).toHaveBeenCalledWith([
      {
        receivedContent: 'original system prompt',
        deliveredContent: 'original system prompt',
        rulesApplied: [],
      },
    ]);
  });

  it('does not call the capture writer when capture is disabled', async () => {
    const { pipeline, captureWriter } = makePipeline();

    await pipeline.processSystemMessages(
      makeModel('model'),
      [{ role: vscode.LanguageModelChatMessageRole.System, content: [new vscode.LanguageModelTextPart('x')] }],
      { models: [{ id: 'model' }], enableFileLogging: false },
    );

    expect(captureWriter).not.toHaveBeenCalled();
  });

  it('passes non-system messages through by reference (never mutated)', async () => {
    const { pipeline } = makePipeline();
    const userMsg = { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hi')] };

    const result = await pipeline.processSystemMessages(
      makeModel('model'),
      [userMsg],
      { models: [{ id: 'model' }], enableFileLogging: false },
    );

    expect(result).toEqual([userMsg]);
  });

  it('returns the original messages when a malformed replacements file is configured', async () => {
    // This exercises the INTERNAL swallow in loadReplacements (bad file -> []
    // after a warning) — it does NOT reach the pipeline's outer catch, which
    // has its own test below.
    const { pipeline } = makePipeline();
    const msg = { role: vscode.LanguageModelChatMessageRole.System, content: [new vscode.LanguageModelTextPart('text')] };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-psm-'));
    try {
      const bad = path.join(dir, 'bad.json');
      await fs.writeFile(bad, '{ not json', 'utf-8');
      const result = await pipeline.processSystemMessages(
        makeModel('model'),
        [msg],
        { models: [{ id: 'model', systemMessageReplacementsFile: bad }], enableFileLogging: false },
      );
      // Fallback: original messages pass through.
      expect(result).toEqual([msg]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the original messages when the pipeline itself throws', async () => {
    // Trigger the OUTER catch: the config read throws inside the try. The
    // malformed-file path never reaches it (loadReplacements swallows its own
    // errors), so this is the only test that exercises the WARN fallback.
    const appendLine = vi.fn();
    const pipeline = new SystemMessagePipeline({ appendLine } as any);
    vscode.workspace._mockConfig = {
      get: () => { throw new Error('config boom'); },
    };
    const msg = { role: vscode.LanguageModelChatMessageRole.System, content: [new vscode.LanguageModelTextPart('text')] };

    const result = await pipeline.processSystemMessages(
      makeModel('model'),
      [msg],
      { models: [{ id: 'model' }], enableFileLogging: false },
    );

    expect(result).toEqual([msg]);
    expect(appendLine).toHaveBeenCalledWith(expect.stringContaining('System message pipeline failed'));
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
    const { pipeline, captureWriter } = makePipeline();
    vscode.workspace._mockConfig = {
      get: (key: string) => key === 'systemMessageCapture' ? true : undefined,
    };

    const original = {
      role: vscode.LanguageModelChatMessageRole.System,
      content: [new vscode.LanguageModelTextPart('original system prompt')],
    };

    const result = await pipeline.processSystemMessages(
      makeModel('model'),
      [original],
      { models: [{ id: 'model', systemMessageReplacementsFile: replFile }], enableFileLogging: false },
    );

    // New object, not the same reference — original must be untouched.
    expect(result[0]).not.toBe(original);
    expect(original.content[0].value).toBe('original system prompt');
    expect((result[0].content[0] as vscode.LanguageModelTextPart).value).toBe('replaced system prompt');

    expect(captureWriter).toHaveBeenCalledWith([
      {
        receivedContent: 'original system prompt',
        deliveredContent: 'replaced system prompt',
        rulesApplied: ['r1'],
      },
    ]);
  });

  it('preserves non-system messages and applies replacements only to system role', async () => {
    const { pipeline } = makePipeline();
    vscode.workspace._mockConfig = { get: () => undefined };
    const userMsg = { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('original question')] };

    const result = await pipeline.processSystemMessages(
      makeModel('model'),
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
    const { pipeline } = makePipeline();
    // Fake workspace root = the temp dir; relative path points into .vllm inside it.
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: dir } }];
    const vllmDir = path.join(dir, '.vllm');
    await fs.mkdir(vllmDir);
    const file = path.join(vllmDir, 'repl.json');
    await fs.writeFile(file, JSON.stringify([{ find: 'a', replace: 'b' }]), 'utf-8');

    const rules = await pipeline.loadReplacements({
      id: 'm',
      serverUrl: 'http://localhost:8000',
      systemMessageReplacementsFile: '.vllm/repl.json',
    });

    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ find: 'a', replace: 'b' });
  });

  it('returns [] (with a warning) when the relative file is missing', async () => {
    const { pipeline } = makePipeline();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: dir } }];

    const rules = await pipeline.loadReplacements({
      id: 'm',
      serverUrl: 'http://localhost:8000',
      systemMessageReplacementsFile: '.vllm/missing.json',
    });

    expect(rules).toEqual([]);
  });
});