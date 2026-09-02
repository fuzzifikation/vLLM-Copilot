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

  it('starts fresh when the existing file is corrupted and does not crash', async () => {
    await fs.writeFile(target, '{ not valid json', 'utf-8');
    const pipeline = makePipeline();

    await pipeline.enqueueWrite(target, [entry('sys-a', 'sys-a')]);

    const stored = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(stored).toEqual([entry('sys-a', 'sys-a')]);
  });
});
