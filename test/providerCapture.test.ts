import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { VllmChatModelProvider } from '../src/provider.js';

/**
 * Tests for the system-message capture write path (`enqueueWrite` in provider.ts).
 * Uses a real temp directory so the atomic temp-file + rename behavior and the
 * merge/overwrite semantics of `system-messages.json` are exercised end-to-end.
 */

function makeProvider(): VllmChatModelProvider {
  return new VllmChatModelProvider(
    { extension: { extensionKind: vscode.ExtensionKind.UI } } as any,
    { appendLine: vi.fn() } as any,
  );
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
  });

  const entry = (receivedContent: string, deliveredContent: string, rulesApplied: string[] = []) => ({
    receivedContent,
    deliveredContent,
    rulesApplied,
  });

  it('writes through a temp file and renames over the target (atomic)', async () => {
    const provider = makeProvider();

    await (provider as any).enqueueWrite(target, [entry('sys-a', 'sys-a')]);

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
    const provider = makeProvider();

    await (provider as any).enqueueWrite(target, [entry('sys-a', 'new'), entry('sys-c', 'sys-c')]);

    const stored = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(stored).toEqual([
      entry('sys-a', 'new'), // overwritten
      entry('sys-b', 'sys-b'), // preserved
      entry('sys-c', 'sys-c'), // appended
    ]);
  });

  it('starts fresh when the existing file is corrupted and does not crash', async () => {
    await fs.writeFile(target, '{ not valid json', 'utf-8');
    const provider = makeProvider();

    await (provider as any).enqueueWrite(target, [entry('sys-a', 'sys-a')]);

    const stored = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(stored).toEqual([entry('sys-a', 'sys-a')]);
  });
});
