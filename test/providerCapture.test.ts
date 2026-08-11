import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { SystemMessagePipeline } from '../src/provider/systemMessagePipeline.js';

/**
 * Tests for the system-message capture write path (`enqueueWrite` in
 * `systemMessagePipeline.ts`). Uses a real temp directory so the atomic
 * temp-file + rename behavior and the merge/overwrite semantics of
 * `system-messages.json` are exercised end-to-end.
 */

function makePipeline(): SystemMessagePipeline {
  return new SystemMessagePipeline({ appendLine: vi.fn() } as any);
}

describe('enqueueWrite (system message capture)', () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-capture-'));
    target = path.join(dir, 'system-messages.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    vscode.workspace._mockConfig = {};
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  const entry = (receivedContent: string, deliveredContent: string, rulesApplied: string[] = []) => ({
    receivedContent,
    deliveredContent,
    rulesApplied,
  });

  it('writes through a temp file and renames over the target (atomic)', async () => {
    const pipeline = makePipeline();

    await pipeline.enqueueWrite(target, [entry('sys-a', 'sys-a')]);

    const stored = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(stored).toEqual([entry('sys-a', 'sys-a')]);
    // No temp file is left behind.
    await expect(fs.access(`${target}.tmp`)).rejects.toBeTruthy();
  });

  it('merges new entries with existing ones, overwriting by receivedContent', async () => {
    await fs.writeFile(
      target,
      JSON.stringify([entry('sys-a', 'old'), entry('sys-b', 'sys-b')], null, 2),
      'utf-8',
    );
    const pipeline = makePipeline();

    await pipeline.enqueueWrite(target, [entry('sys-a', 'new'), entry('sys-c', 'sys-c')]);

    const stored = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(stored).toEqual([
      entry('sys-a', 'new'), // overwritten
      entry('sys-b', 'sys-b'), // preserved
      entry('sys-c', 'sys-c'), // appended
    ]);
  });

  it('starts fresh when the existing file is corrupted and does not crash', async () => {
    await fs.writeFile(target, '{ not valid json', 'utf-8');
    const pipeline = makePipeline();

    await pipeline.enqueueWrite(target, [entry('sys-a', 'sys-a')]);

    const stored = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(stored).toEqual([entry('sys-a', 'sys-a')]);
  });

  it('drops null members from a valid JSON array instead of wedging the write', async () => {
    // `null` used to throw inside the merge (reading .receivedContent), failing
    // every future write through the queue. Valid members must survive.
    await fs.writeFile(
      target,
      JSON.stringify([null, entry('sys-a', 'sys-a')], null, 2),
      'utf-8',
    );
    const pipeline = makePipeline();

    await pipeline.enqueueWrite(target, [entry('sys-b', 'sys-b')]);

    const stored = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(stored).toEqual([entry('sys-a', 'sys-a'), entry('sys-b', 'sys-b')]);
  });

  it('drops malformed members while merging valid ones', async () => {
    // `{}` used to be preserved forever (its undefined receivedContent never
    // matched a real entry). Partial / malformed members must be discarded.
    await fs.writeFile(
      target,
      JSON.stringify([{}, { receivedContent: 'no-delivery' }, entry('sys-a', 'sys-a')], null, 2),
      'utf-8',
    );
    const pipeline = makePipeline();

    await pipeline.enqueueWrite(target, [entry('sys-b', 'sys-b')]);

    const stored = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(stored).toEqual([entry('sys-a', 'sys-a'), entry('sys-b', 'sys-b')]);
  });

  it('serializes concurrent writes through the queue so no entries are lost', async () => {
    const pipeline = makePipeline();
    // Fire both writes without awaiting between them. The queue chains the
    // second behind the first; without serialization the second's
    // read-modify-write would clobber the first's entries.
    const p1 = pipeline.enqueueWrite(target, [entry('sys-a', 'sys-a')]);
    const p2 = pipeline.enqueueWrite(target, [entry('sys-b', 'sys-b')]);
    await Promise.all([p1, p2]);

    const stored = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(stored).toEqual([entry('sys-a', 'sys-a'), entry('sys-b', 'sys-b')]);
  });

  it('writes through the default capture writer end-to-end from processSystemMessages', async () => {
    // No injected writer: processSystemMessages must write through the real
    // captureToDisk -> enqueueWrite path (the production wiring the injected
    // writer tests deliberately bypass). The write is fire-and-forget by design,
    // so wait for it to land rather than reading immediately.
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: dir } }];
    vscode.workspace._mockConfig = {
      get: (key: string) => key === 'systemMessageCapture' ? true : undefined,
    };
    const pipeline = makePipeline();

    await pipeline.processSystemMessages(
      { id: 'model' } as unknown as vscode.LanguageModelChatInformation,
      [{ role: vscode.LanguageModelChatMessageRole.System, content: [new vscode.LanguageModelTextPart('original prompt')] }],
      { models: [{ id: 'model' }], enableFileLogging: false },
    );

    const captureFile = path.join(dir, '.vllm', 'system-messages.json');
    await vi.waitFor(async () => {
      const stored = JSON.parse(await fs.readFile(captureFile, 'utf-8'));
      expect(stored).toEqual([entry('original prompt', 'original prompt')]);
    });
  });
});
