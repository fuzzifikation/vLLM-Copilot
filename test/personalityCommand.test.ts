import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerSetModelPersonalityCommand } from '../src/commands/personality.js';
import * as configStore from '../src/state/configStore.js';
import type { ModelConfig } from '../src/state/config.js';

/**
 * Server-less models must never reach replaceModelConfig from the personality
 * command: the config matcher requires both id and server ref, so without a
 * resolvable ref the store falls through to its append branch and writes a
 * duplicate entry into settings.json (verified bug, fixed as step 0a of the
 * refactor plan; the ref now also has to RESOLVE against the registry).
 * The applicability guard lives INSIDE the command since the U8 absorb wave
 * (helper deleted), so this canary runs the command itself.
 */
const SERVERS = [{ id: 'srv', serverUrl: 'http://x:8000' }];

function makeConfig(models: ModelConfig[]): any {
  return {
    get: vi.fn((k: string) => (k === 'models' ? models : k === 'servers' ? SERVERS : undefined)),
    has: () => false,
    update: vi.fn(async () => {}),
    inspect: () => undefined,
  };
}

describe('setModelPersonality applicability guard', () => {
  const output = { appendLine: vi.fn(), show: vi.fn() } as any;
  let replaceSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (vscode as any).commands._registrations = [];
    output.appendLine.mockClear();
    output.show.mockClear();
    replaceSpy = vi
      .spyOn(configStore, 'replaceModelConfig')
      .mockResolvedValue({ model: {}, created: false } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function pick(model: ModelConfig) {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(makeConfig([model]) as any);
    // Step 1/2 model picker resolves to this model; the guard must fire before
    // any step-2 personality discovery or persistence happens.
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue({ label: 'm', model } as any);
    const disposable = registerSetModelPersonalityCommand({} as any, {} as any, output);
    await (vscode as any).commands._run('vllm-copilot.setModelPersonality');
    disposable.dispose();
  }

  const lastWarn = (): string =>
    output.appendLine.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .find((l: string) => l.includes('[WARN] Personality not applicable')) ?? '';

  it('refuses a model without a server ref: no write, loud warning (duplicate-append canary)', async () => {
    await pick({ id: 'm', displayName: 'My Model' } as ModelConfig);
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(lastWarn()).toContain('no resolvable server');
    // Warning label prefers displayName...
    expect(lastWarn()).toContain('My Model');
  });

  it('refuses a blank/whitespace-only server ref', async () => {
    await pick({ id: 'm', server: '   ' } as ModelConfig);
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(lastWarn()).not.toBe('');
  });

  it('refuses a dangling server ref; label falls back to the quoted id', async () => {
    await pick({ id: 'm', server: 'ghost' } as ModelConfig);
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(lastWarn()).toContain('"m"');
  });
});
