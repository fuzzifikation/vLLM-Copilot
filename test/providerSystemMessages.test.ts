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
 * touching the file system; the capture write path (`enqueueWrite`) runs
 * against a real temp directory in the describe at the end of this file.
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

  it('passes non-system messages through by reference (never mutated)', async () => {
    const { pipeline } = makePipeline();
    const userMsg = { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hi')] };

    const result = await pipeline.processSystemMessages(
      makeModel('model'),
      [userMsg],
      { models: [{ id: 'model', server: 'srv' }], servers: [{ id: 'srv', serverUrl: 'http://localhost:8000' }], enableFileLogging: false },
    );

    expect(result).toEqual([userMsg]);
  });

  it('returns the original messages when a malformed replacements file is configured', async () => {
    // This exercises the internal load-failure swallow in processSystemMessages (bad file -> []
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
        { models: [{ id: 'model', server: 'srv', systemMessageReplacementsFile: bad }], servers: [{ id: 'srv', serverUrl: 'http://localhost:8000' }], enableFileLogging: false },
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
      { models: [{ id: 'model', server: 'srv' }], servers: [{ id: 'srv', serverUrl: 'http://localhost:8000' }], enableFileLogging: false },
    );

    expect(result).toEqual([msg]);
    expect(appendLine).toHaveBeenCalledWith(expect.stringContaining('System message pipeline failed'));
  });
});

// ── capture write path (folded from test/providerCapture.test.ts) ──────
// Real temp directory so the atomic temp-file + rename behavior of
// system-messages.json is exercised end-to-end.

describe('enqueueWrite (system message capture)', () => {
  function makePipeline(): SystemMessagePipeline {
    return new SystemMessagePipeline({ appendLine: vi.fn() } as any);
  }

  const entry = (receivedContent: string, deliveredContent: string, rulesApplied: string[] = []) => ({
    receivedContent,
    deliveredContent,
    rulesApplied,
  });

  it('starts fresh when the existing file is corrupted and does not crash', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-capture-'));
    try {
      const target = path.join(dir, 'system-messages.json');
      await fs.writeFile(target, '{ not valid json', 'utf-8');
      const pipeline = makePipeline();

      await pipeline.enqueueWrite(target, [entry('sys-a', 'sys-a')]);

      const stored = JSON.parse(await fs.readFile(target, 'utf-8'));
      expect(stored).toEqual([entry('sys-a', 'sys-a')]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
