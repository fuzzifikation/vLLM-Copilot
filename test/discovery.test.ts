import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { discoverModels } from '../src/provider/discovery.js';
import type { ProviderClient } from '../src/provider/contracts.js';

function makeOutput(): vscode.OutputChannel & { appendLine: ReturnType<typeof vi.fn> } {
  return {
    name: 'test',
    append: vi.fn(),
    appendLine: vi.fn<(value: string) => void>(),
    replace: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

function lines(output: { appendLine: ReturnType<typeof vi.fn> }): string {
  return output.appendLine.mock.calls.map(c => c[0]).join('\n');
}

function makeClient(
  overrides: Partial<Pick<ProviderClient, 'getModelContextWindow'>> = {}
): Pick<ProviderClient, 'getModelContextWindow'> {
  return { getModelContextWindow: async () => 4096, ...overrides };
}

const server = 'http://localhost:8000';

describe('discoverModels', () => {
  it('skips models without a serverUrl and warns', async () => {
    const output = makeOutput();
    const models = await discoverModels([{ id: 'm1' }], makeClient(), output);
    expect(models).toHaveLength(0);
    expect(lines(output)).toContain('has no serverUrl and will be skipped');
  });

  it('returns empty when there are no overrides', async () => {
    const output = makeOutput();
    const client = makeClient();
    const models = await discoverModels([], client, output);
    expect(models).toHaveLength(0);
  });

  it('warns when the server does not report max_model_len', async () => {
    const output = makeOutput();
    const models = await discoverModels(
      [{ id: 'm1', serverUrl: server }],
      makeClient({ getModelContextWindow: async () => undefined }),
      output,
    );
    expect(models).toHaveLength(0);
    expect(lines(output)).toContain('did not report max_model_len');
  });

  it('warns when connecting to the server fails', async () => {
    const output = makeOutput();
    const models = await discoverModels(
      [{ id: 'm1', serverUrl: server }],
      makeClient({ getModelContextWindow: async () => { throw new Error('ECONNREFUSED'); } }),
      output,
    );
    expect(models).toHaveLength(0);
    expect(lines(output)).toContain('failed to connect to server');
  });

  it('builds model info on success and logs a summary', async () => {
    const output = makeOutput();
    const models = await discoverModels(
      [{ id: 'm1', serverUrl: server, family: 'test-family' }],
      makeClient({ getModelContextWindow: async () => 8192 }),
      output,
    );
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('m1');
    expect(models[0].family).toBe('test-family');
    // Default maxOutputTokens=4096 leaves 4096 for input at 8192 context.
    expect(models[0].maxInputTokens).toBeGreaterThan(0);
    expect(models[0].maxInputTokens + models[0].maxOutputTokens).toBe(8192);
    expect(lines(output)).toContain('Loaded 1 model(s)');
  });

  it('warns on duplicate model ids', async () => {
    const output = makeOutput();
    const models = await discoverModels(
      [
        { id: 'dup', serverUrl: server, family: 'test-family' },
        { id: 'dup', serverUrl: server, family: 'test-family' },
      ],
      makeClient(),
      output,
    );
    expect(models).toHaveLength(2);
    expect(lines(output)).toContain('Duplicate model id "dup"');
  });

  it('queries models in parallel and collects per-model failures', async () => {
    const output = makeOutput();
    const client = makeClient({
      getModelContextWindow: async (url: string) => (url === server ? 4096 : undefined),
    });
    const models = await discoverModels(
      [
        { id: 'good', serverUrl: server, family: 'test-family' },
        { id: 'bad', serverUrl: 'http://other:8000' },
      ],
      client,
      output,
    );
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('good');
    const all = lines(output);
    expect(all).toContain('did not report max_model_len');
    expect(all).toContain('Loaded 1 model(s)');
  });
});
