import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { maybeRunServerRegistryMigration } from '../src/serverRegistryMigration.js';
import type { LegacyModelConfig } from '../src/registryMigration.js';

const FLAG = 'vllmCopilot.serverRegistryMigration.v1';

interface Settings {
  models?: LegacyModelConfig[];
  servers?: unknown;
}

let settings: Settings;
let writes: Array<{ key: string; value: unknown }>;
let stateStore: Record<string, unknown>;
let globalStateUpdates: Array<{ key: string; value: unknown }>;
let context: any;
let output: { appendLine: ReturnType<typeof vi.fn> };
let info: ReturnType<typeof vi.fn>;
let error: ReturnType<typeof vi.fn>;

function model(overrides: Partial<LegacyModelConfig> = {}): LegacyModelConfig {
  return { id: 'm', vllmModelId: 'm', serverUrl: 'http://localhost:8000', ...overrides };
}

beforeEach(() => {
  settings = { models: [model({ id: 'a' }), model({ id: 'b' })] };
  writes = [];
  stateStore = {};
  globalStateUpdates = [];
  context = {
    globalState: {
      get: (k: string) => stateStore[k],
      update: vi.fn(async (k: string, v: unknown) => {
        globalStateUpdates.push({ key: k, value: v });
        stateStore[k] = v;
      }),
    },
  };
  vi.mocked(vscode.workspace).getConfiguration = vi.fn(() => ({
    get: (key: string) => (settings as Record<string, unknown>)[key],
    update: vi.fn(async (key: string, value: unknown) => {
      writes.push({ key, value });
      (settings as Record<string, unknown>)[key] = value;
    }),
    has: () => false,
    inspect: () => undefined,
  }) as unknown as vscode.WorkspaceConfiguration);
  info = vi.fn(async () => undefined);
  error = vi.fn(async () => undefined);
  vi.mocked(vscode.window).showInformationMessage = info as never;
  vi.mocked(vscode.window).showErrorMessage = error as never;
  output = { appendLine: vi.fn() };
  (vscode.commands as any)._registrations = [];
});

/** Make the settings write for `key` reject. */
function blockWrite(key: string) {
  vi.mocked(vscode.workspace).getConfiguration = vi.fn(() => ({
    get: (k: string) => (settings as Record<string, unknown>)[k],
    update: vi.fn(async (k: string, value: unknown) => {
      if (k === key) throw new Error('Unable to write into user settings');
      writes.push({ key: k, value });
      (settings as Record<string, unknown>)[k] = value;
    }),
    has: () => false,
    inspect: () => undefined,
  }) as unknown as vscode.WorkspaceConfiguration);
}

describe('maybeRunServerRegistryMigration', () => {
  it('does nothing once the migration is done', async () => {
    stateStore[FLAG] = 'done';
    await maybeRunServerRegistryMigration(context, output as never);
    expect(writes).toHaveLength(0);
    expect(globalStateUpdates).toHaveLength(0);
  });

  it('sets the marker without writing anything when models is empty', async () => {
    settings.models = [];
    await maybeRunServerRegistryMigration(context, output as never);
    expect(writes).toHaveLength(0);
    expect(stateStore[FLAG]).toBe('done');
  });

  it('adopts one server per URL group and rewrites models to server refs', async () => {
    await maybeRunServerRegistryMigration(context, output as never);

    expect(settings.servers).toEqual([{ id: 'localhost-8000', serverUrl: 'http://localhost:8000' }]);
    expect((settings.models as Array<Record<string, unknown>> | undefined)?.every(m => m.server === 'localhost-8000')).toBe(true);
    expect((settings.models as Array<Record<string, unknown>> | undefined)?.some(m => 'serverUrl' in m)).toBe(false);
    expect(stateStore[FLAG]).toBe('done');
    expect(String(info.mock.calls[0][0])).toContain('adopted 1 server');
  });

  it('writes servers before models', async () => {
    await maybeRunServerRegistryMigration(context, output as never);
    expect(writes.map(w => w.key)).toEqual(['servers', 'models']);
  });

  it('keeps pre-existing servers and appends adopted ones', async () => {
    settings.servers = [{ id: 'old', serverUrl: 'http://old:1' }];
    await maybeRunServerRegistryMigration(context, output as never);
    expect(settings.servers).toEqual([
      { id: 'old', serverUrl: 'http://old:1' },
      { id: 'localhost-8000', serverUrl: 'http://localhost:8000' },
    ]);
  });

  it('a blocked servers write leaves the marker unset and the settings untouched', async () => {
    blockWrite('servers');
    const originalModels = settings.models;
    await maybeRunServerRegistryMigration(context, output as never);

    expect(writes).toHaveLength(0);
    expect(settings.models).toBe(originalModels);
    expect(stateStore[FLAG]).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('a blocked models write leaves the marker unset so the next activation retries', async () => {
    blockWrite('models');
    await maybeRunServerRegistryMigration(context, output as never);

    expect(stateStore[FLAG]).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('a retry after a partial write reuses the already-written server instead of duplicating', async () => {
    // State left behind by a first attempt where the servers write succeeded
    // but the models write failed: registry holds the entry, models are legacy.
    settings.servers = [{ id: 'localhost-8000', serverUrl: 'http://localhost:8000' }];
    await maybeRunServerRegistryMigration(context, output as never);

    expect(settings.servers).toEqual([{ id: 'localhost-8000', serverUrl: 'http://localhost:8000' }]);
    expect((settings.models as Array<Record<string, unknown>>).every(m => m.server === 'localhost-8000')).toBe(true);
    expect(stateStore[FLAG]).toBe('done');
    // Only the models key needs writing — the servers key already holds the entry.
    expect(writes.map(w => w.key)).toEqual(['models']);
    expect(String(info.mock.calls[0][0])).toContain('rewrote your model settings');
  });

  it('is idempotent across repeated activations', async () => {
    await maybeRunServerRegistryMigration(context, output as never);
    const writesAfterFirst = writes.length;
    await maybeRunServerRegistryMigration(context, output as never);
    expect(writes).toHaveLength(writesAfterFirst);
  });

  it('reports models without serverUrl and keeps them verbatim instead of inventing one', async () => {
    const withoutUrl = model({ id: 'orphan' });
    delete withoutUrl.serverUrl;
    settings.models = [withoutUrl, model({ id: 'ok' })];

    await maybeRunServerRegistryMigration(context, output as never);

    const warnings = output.appendLine.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[WARN]'));
    expect(warnings.some(l => l.includes('orphan'))).toBe(true);
    const written = settings.models as Array<Record<string, unknown>>;
    expect(written).toHaveLength(2);
    expect(written[0]).toBe(withoutUrl);
    expect('server' in written[1]).toBe(true);
  });

  it('sets the marker and writes nothing when no model has a serverUrl', async () => {
    const withoutUrl = model({ id: 'orphan' });
    delete withoutUrl.serverUrl;
    settings.models = [withoutUrl];

    await maybeRunServerRegistryMigration(context, output as never);

    expect(writes).toHaveLength(0);
    expect(stateStore[FLAG]).toBe('done');
  });

  it('logs full before/after JSON to the output channel', async () => {
    await maybeRunServerRegistryMigration(context, output as never);
    const lines = output.appendLine.mock.calls.map(c => String(c[0]));
    const before = lines.find(l => l.includes('before:'));
    const after = lines.find(l => l.includes('after:'));
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(JSON.parse(after!.split('\n').slice(1).join('\n')).servers).toHaveLength(1);
  });
});
