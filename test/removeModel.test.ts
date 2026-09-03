import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerRemoveModelCommand } from '../src/commands.js';
import type { ModelConfig } from '../src/config.js';

/**
 * Command-level tests for vllm-copilot.removeModel (the Server Settings
 * webview's only model-removal write path). The old pure-helper tests died in
 * the U8 absorb wave when removeModelFromConfig merged into the command — the
 * pins below are the same semantics, measured through the write: removal
 * matches on (server ref, resolveConfigId) — extension id preferred, wire id
 * for legacy entries — and NEVER touches siblings on the same server or
 * same-vllmModelId entries on other servers. No match / missing args fail
 * loudly with zero writes.
 */

const output = { appendLine: vi.fn(), show: vi.fn() } as any;
const provider = { clearCache: vi.fn() } as any;

function makeConfig(models: ModelConfig[]): any {
  return {
    get: vi.fn((k: string) => (k === 'models' ? models : undefined)),
    has: () => false,
    update: vi.fn(async () => {}),
    inspect: () => undefined,
  };
}

const models: ModelConfig[] = [
  { id: 'a', vllmModelId: 'model-a', server: 'host', displayName: 'A' },
  { id: 'b', vllmModelId: 'model-b', server: 'host', displayName: 'B' },
  { id: 'a-other', vllmModelId: 'model-a', server: 'other', displayName: 'A2' },
];

/** Run the command; return the WorkspaceConfiguration spy it wrote through. */
async function runRemove(arg: unknown, fixture: ModelConfig[]) {
  const cfg = makeConfig(fixture);
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(cfg as any);
  const disposable = registerRemoveModelCommand({} as any, provider, output);
  await (vscode as any).commands._run('vllm-copilot.removeModel', arg);
  disposable.dispose();
  return cfg;
}

const written = (cfg: any): ModelConfig[] =>
  cfg.update.mock.calls.find((c: any[]) => c[0] === 'models')![1] as ModelConfig[];

describe('removeModel command', () => {
  beforeEach(() => {
    (vscode as any).commands._registrations = [];
    provider.clearCache.mockClear();
    output.appendLine.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes only the selected model, keeping siblings on the same server', async () => {
    const cfg = await runRemove({ server: 'host', id: 'a' }, models);
    const after = written(cfg);
    expect(after).toHaveLength(2);
    expect(after.find(m => m.id === 'a')).toBeUndefined();
    // Sibling model-b on the same server survives.
    expect(after.find(m => m.server === 'host')?.vllmModelId).toBe('model-b');
    // Same vllmModelId on a different server is untouched.
    expect(after.find(m => m.server === 'other')?.vllmModelId).toBe('model-a');
    expect(provider.clearCache).toHaveBeenCalledTimes(1);
  });

  it('removes by extension id even when the vllmModelId differs', async () => {
    const cfg = await runRemove(
      { server: 'h', id: 'custom-id' },
      [{ id: 'custom-id', vllmModelId: 'served-name', server: 'h' }],
    );
    expect(written(cfg)).toHaveLength(0);
  });

  it('P1: two presets sharing a vllmModelId on the same server are removed independently by id', async () => {
    const twins: ModelConfig[] = [
      { id: 'qwen-think', vllmModelId: 'qwen-7b', server: 'host' },
      { id: 'qwen-instruct', vllmModelId: 'qwen-7b', server: 'host' },
    ];
    const cfg = await runRemove({ server: 'host', id: 'qwen-think' }, twins);
    expect(written(cfg).map(m => m.id)).toEqual(['qwen-instruct']);
  });

  it('does NOT remove by vllmModelId alone when the entry has a distinct id', async () => {
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
    const cfg = await runRemove({ server: 'host', id: 'model-a' }, models);
    expect(cfg.update).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('model-a'));
    expect(provider.clearCache).not.toHaveBeenCalled();
  });

  it('falls back to id when vllmModelId is absent (legacy entries)', async () => {
    const legacy: ModelConfig[] = [
      { id: 'plain-model', server: 'h' },
      { id: 'other', server: 'h' },
    ];
    const cfg = await runRemove({ server: 'h', id: 'plain-model' }, legacy);
    expect(written(cfg).map(m => m.id)).toEqual(['other']);
  });

  it('warns without writing when nothing matches', async () => {
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
    const cfg = await runRemove({ server: 'host', id: 'nope' }, models);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nope'));
    expect(cfg.update).not.toHaveBeenCalled();
  });

  it('errors without writing when server or id is missing', async () => {
    const errSpy = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as any);
    const cfg = await runRemove({ server: 'host' }, models);
    expect(errSpy).toHaveBeenCalled();
    expect(cfg.update).not.toHaveBeenCalled();
  });
});
