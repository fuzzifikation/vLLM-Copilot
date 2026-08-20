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
  return { getModelContextWindow: async () => ({ contextWindow: 4096 }), ...overrides };
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



  it('skips the model when the resolver throws (no fabrication)', async () => {
    const output = makeOutput();
    const models = await discoverModels(
      [{ id: 'm1', serverUrl: server }],
      makeClient({ getModelContextWindow: async () => { throw new Error('no context window'); } }),
      output,
    );
    // Policy: no fabricated budget — the model is NOT served.
    expect(models).toHaveLength(0);
    expect(lines(output)).toContain('skipped');
  });

  it('preserves the resolver detail, only naming transport failures as such', async () => {
    const output = makeOutput();
    await discoverModels(
      [{ id: 'm1', serverUrl: server }],
      makeClient({ getModelContextWindow: async () => {
        throw new Error('llamacpp model "qwen" has no context window: GET /props did not report default_generation_settings.n_ctx.');
      } }),
      output,
    );
    const all = lines(output);
    expect(all).toContain('llamacpp model "qwen" has no context window');
    expect(all).toContain('default_generation_settings.n_ctx');
    // The resolver's backend-specific message is NOT rewritten as a connection failure.
    expect(all).not.toContain('failed to connect');
  });

  it('passes the resolved serverType into the resolver and builds model info', async () => {
    const output = makeOutput();
    const spy = vi.fn(async () => ({ contextWindow: 8192 }));
    const onModelDiscovered = vi.fn();
    const models = await discoverModels(
      [{ id: 'm1', serverUrl: server, family: 'test-family' }],
      { getModelContextWindow: spy },
      output,
      onModelDiscovered,
    );
    expect(spy).toHaveBeenCalledWith('vllm', server, {}, 'm1');
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('m1');
    expect(models[0].family).toBe('test-family');
    // Default maxOutputTokens=4096 leaves 4096 for input at 8192 context.
    expect(models[0].maxInputTokens).toBeGreaterThan(0);
    expect(models[0].maxInputTokens + models[0].maxOutputTokens).toBe(8192);
    expect(onModelDiscovered).toHaveBeenCalledWith('m1', 8192);
    expect(lines(output)).toContain('Loaded 1 model(s)');
  });

  it('queries models in parallel; a missing window skips that model (no fabrication)', async () => {
    const output = makeOutput();
    const client = makeClient({
      getModelContextWindow: async (serverType: string, url: string) => {
        if (url === server) return { contextWindow: 4096 };
        throw new Error('no context window');
      },
    });
    const models = await discoverModels(
      [
        { id: 'good', serverUrl: server, family: 'test-family' },
        { id: 'bad', serverUrl: 'http://other:8000' },
      ],
      client,
      output,
    );
    // 'good' survives with its real window; 'bad' is skipped — no default invented.
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('good');
    const all = lines(output);
    expect(all).toContain('skipped');
    expect(all).toContain('Loaded 1 model(s)');
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
});
