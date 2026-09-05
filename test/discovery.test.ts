import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { discoverModels } from '../src/provider/discovery.js';
import type { ProviderClient } from '../src/provider/contracts.js';
import type { ServerEntry } from '../src/state/serverRegistry.js';

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
const servers: ServerEntry[] = [{ id: 'srv', serverUrl: server }];

describe('discoverModels', () => {
  it('skips models whose server reference does not resolve and warns', async () => {
    const output = makeOutput();
    const models = await discoverModels([{ id: 'm1', server: 'missing' }], servers, makeClient(), output);
    expect(models).toHaveLength(0);
    expect(lines(output)).toContain('references unknown server "missing" and will be skipped');
  });

  it('returns empty when there are no overrides', async () => {
    const output = makeOutput();
    const client = makeClient();
    const models = await discoverModels([], servers, client, output);
    expect(models).toHaveLength(0);
  });



  it('a model whose server does not answer is dropped from the picker (no fabrication)', async () => {
    const output = makeOutput();
    const models = await discoverModels(
      [{ id: 'm1', server: 'srv' }],
      servers,
      makeClient({ getModelContextWindow: async () => { throw new Error('no context window'); } }),
      output,
    );
    // Policy: the picker is a live inventory. The model is GONE, not grayed,
    // and the reason is logged verbatim. Budgets are never fabricated.
    expect(models).toHaveLength(0);
    expect(lines(output)).toContain('unavailable');
    expect(lines(output)).toContain('no context window');
  });

  it('preserves the resolver detail, only naming transport failures as such', async () => {
    const output = makeOutput();
    await discoverModels(
      [{ id: 'm1', server: 'srv' }],
      servers,
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
      [{ id: 'm1', server: 'srv', family: 'test-family' }],
      servers,
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

  it('applies the selected mode max_tokens to the advertised output budget', async () => {
    const output = makeOutput();
    const selectedModeByModel = new Map<string, string>([['m1', 'Think Max']]);
    const models = await discoverModels(
      [{
        id: 'm1', server: 'srv', family: 'test-family',
        modelModes: { 'Think Max': { max_tokens: 2000 } },
      }],
      servers,
      makeClient({ getModelContextWindow: async () => ({ contextWindow: 8192 }) }),
      output,
      undefined,
      selectedModeByModel,
    );
    expect(models).toHaveLength(1);
    // Mode max_tokens=2000 → output budget 2000, input = 8192 − 2000 = 6192.
    expect(models[0].maxOutputTokens).toBe(2000);
    expect(models[0].maxInputTokens).toBe(6192);
  });

  it('applies the mode max_tokens even when the model/preset sets maxOutputTokens (finding 1)', async () => {
    const output = makeOutput();
    const selectedModeByModel = new Map<string, string>([['m1', 'Think Max']]);
    // Regression: a preset/model-level maxOutputTokens used to win inside
    // deriveTokenBudget, silently discarding the selected mode's max_tokens —
    // so Copilot never received updated limits for preset-configured models.
    const models = await discoverModels(
      [{
        id: 'm1', server: 'srv', family: 'test-family',
        maxOutputTokens: 32768, // preset-style model-level budget
        modelModes: { 'Think Max': { max_tokens: 2000 } },
      }],
      servers,
      makeClient({ getModelContextWindow: async () => ({ contextWindow: 8192 }) }),
      output,
      undefined,
      selectedModeByModel,
    );
    expect(models).toHaveLength(1);
    // The mode budget must win over the preset's 32768.
    expect(models[0].maxOutputTokens).toBe(2000);
    expect(models[0].maxInputTokens).toBe(6192);
  });

  it('clamps a mode max_tokens to the context window when advertising', async () => {
    const output = makeOutput();
    const selectedModeByModel = new Map<string, string>([['m1', 'Big']]);
    const models = await discoverModels(
      [{
        id: 'm1', server: 'srv', family: 'test-family',
        modelModes: { Big: { max_tokens: 50000 } },
      }],
      servers,
      makeClient({ getModelContextWindow: async () => ({ contextWindow: 8192 }) }),
      output,
      undefined,
      selectedModeByModel,
    );
    expect(models).toHaveLength(1);
    // Clamped to window − 1.
    expect(models[0].maxOutputTokens).toBe(8191);
  });

  it('keeps the model-wide budget when no mode is selected', async () => {
    const output = makeOutput();
    const models = await discoverModels(
      [{ id: 'm1', server: 'srv', family: 'test-family', modelModes: { 'Think Max': { max_tokens: 2000 } } }],
      servers,
      makeClient({ getModelContextWindow: async () => ({ contextWindow: 8192 }) }),
      output,
    );
    expect(models).toHaveLength(1);
    // No selected mode → model-wide default budget (4096) → input 4096.
    expect(models[0].maxOutputTokens).toBe(4096);
    expect(models[0].maxInputTokens).toBe(4096);
  });

  it('reflects defaultParams.max_tokens in the advertised budget (matches the wire)', async () => {
    const output = makeOutput();
    // Regression: discovery used to honor only modelModes.max_tokens, so a
    // defaultParams.max_tokens produced a bar that disagreed with the wire.
    const models = await discoverModels(
      [{
        id: 'm1', server: 'srv', family: 'test-family',
        defaultParams: { max_tokens: 2000 },
      }],
      servers,
      makeClient({ getModelContextWindow: async () => ({ contextWindow: 8192 }) }),
      output,
    );
    expect(models).toHaveLength(1);
    expect(models[0].maxOutputTokens).toBe(2000);
    expect(models[0].maxInputTokens).toBe(6192);
  });

  it('defaultParams.max_tokens is overridden by a selected mode max_tokens in metadata', async () => {
    const output = makeOutput();
    const selectedModeByModel = new Map<string, string>([['m1', 'Big']]);
    const models = await discoverModels(
      [{
        id: 'm1', server: 'srv', family: 'test-family',
        defaultParams: { max_tokens: 2000 },
        modelModes: { Big: { max_tokens: 5000 } },
      }],
      servers,
      makeClient({ getModelContextWindow: async () => ({ contextWindow: 8192 }) }),
      output,
      undefined,
      selectedModeByModel,
    );
    expect(models).toHaveLength(1);
    // Mode wins over defaultParams.
    expect(models[0].maxOutputTokens).toBe(5000);
    expect(models[0].maxInputTokens).toBe(3192);
  });

  it('queries models in parallel; a dead server drops only its own models', async () => {
    const output = makeOutput();
    const client = makeClient({
      getModelContextWindow: async (_serverType: string, url: string) => {
        if (url === server) return { contextWindow: 4096 };
        throw new Error('no context window');
      },
    });
    const models = await discoverModels(
      [
        { id: 'good', server: 'srv', family: 'test-family' },
        { id: 'bad', server: 'other' },
      ],
      [...servers, { id: 'other', serverUrl: 'http://other:8000' }],
      client,
      output,
    );
    // 'good' survives with its real window; 'bad' drops out of the picker.
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('good');
    const all = lines(output);
    expect(all).toContain('unavailable');
    expect(all).toContain('Loaded 1 model(s)');
  });

  it('warns on duplicate model ids', async () => {
    const output = makeOutput();
    const models = await discoverModels(
      [
        { id: 'dup', server: 'srv', family: 'test-family' },
        { id: 'dup', server: 'srv', family: 'test-family' },
      ],
      servers,
      makeClient(),
      output,
    );
    expect(models).toHaveLength(2);
    expect(lines(output)).toContain('Duplicate model id "dup"');
  });
});
