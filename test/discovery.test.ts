import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { discoverModels } from '../src/provider/discovery.js';
import { createBudgetLedger } from '../src/provider/budgetLedger.js';
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
    const { models } = await discoverModels([{ id: 'm1' }], makeClient(), output);
    expect(models).toHaveLength(0);
    expect(lines(output)).toContain('has no serverUrl and will be skipped');
  });

  it('returns empty when there are no overrides', async () => {
    const output = makeOutput();
    const client = makeClient();
    const { models } = await discoverModels([], client, output);
    expect(models).toHaveLength(0);
  });



  it('keeps a throwing model visible as an offline row (no vanishing, no fabrication)', async () => {
    const output = makeOutput();
    const { models, failures } = await discoverModels(
      [{ id: 'm1', serverUrl: server }],
      makeClient({ getModelContextWindow: async () => { throw new Error('no context window'); } }),
      output,
    );
    // Policy: the server never answered → the model STAYS in the picker as an
    // honest offline row, and the failure count marks the list untrusted.
    expect(failures).toBe(1);
    expect(models).toHaveLength(1);
    const row = models[0] as typeof models[0] & { warningText?: Record<string, string>; statusIcon?: unknown };
    expect(row.warningText?.offline).toContain('no context window');
    expect(row.warningText?.offline).toContain('1-token placeholders');
    expect(row.statusIcon).toBeDefined();
    // Nothing was configured and nothing was ever reported → labeled placeholders,
    // NEVER the built-in 4096 default.
    expect(row.maxInputTokens).toBe(1);
    expect(row.maxOutputTokens).toBe(1);
    expect(lines(output)).toContain('offline');
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
    const { models } = await discoverModels(
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

  it('applies the selected mode max_tokens to the advertised output budget', async () => {
    const output = makeOutput();
    const selectedModeByModel = new Map<string, string>([['m1', 'Think Max']]);
    const { models } = await discoverModels(
      [{
        id: 'm1', serverUrl: server, family: 'test-family',
        modelModes: { 'Think Max': { max_tokens: 2000 } },
      }],
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
    const { models } = await discoverModels(
      [{
        id: 'm1', serverUrl: server, family: 'test-family',
        maxOutputTokens: 32768, // preset-style model-level budget
        modelModes: { 'Think Max': { max_tokens: 2000 } },
      }],
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
    const { models } = await discoverModels(
      [{
        id: 'm1', serverUrl: server, family: 'test-family',
        modelModes: { Big: { max_tokens: 50000 } },
      }],
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
    const { models } = await discoverModels(
      [{ id: 'm1', serverUrl: server, family: 'test-family', modelModes: { 'Think Max': { max_tokens: 2000 } } }],
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
    const { models } = await discoverModels(
      [{
        id: 'm1', serverUrl: server, family: 'test-family',
        defaultParams: { max_tokens: 2000 },
      }],
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
    const { models } = await discoverModels(
      [{
        id: 'm1', serverUrl: server, family: 'test-family',
        defaultParams: { max_tokens: 2000 },
        modelModes: { Big: { max_tokens: 5000 } },
      }],
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

  it('queries models in parallel; a dead server yields an offline row beside the healthy one', async () => {
    const output = makeOutput();
    const client = makeClient({
      getModelContextWindow: async (serverType: string, url: string) => {
        if (url === server) return { contextWindow: 4096 };
        throw new Error('no context window');
      },
    });
    const { models, failures } = await discoverModels(
      [
        { id: 'good', serverUrl: server, family: 'test-family' },
        { id: 'bad', serverUrl: 'http://other:8000' },
      ],
      client,
      output,
    );
    // 'good' survives with its real window; 'bad' stays visible — offline,
    // placeholder budget, counted as a failure so the cache is not trusted.
    expect(failures).toBe(1);
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('good');
    expect((models[1] as { warningText?: Record<string, string> }).warningText?.offline).toContain('no context window');
    const all = lines(output);
    expect(all).toContain('Loaded 2 model(s) (1 offline)');
    expect(all).toContain('⚠offline');
  });

  it('warns on duplicate model ids', async () => {
    const output = makeOutput();
    const { models } = await discoverModels(
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

  it('permanent skips (no serverUrl) are NOT failures — they must not pin the cache incomplete', async () => {
    const output = makeOutput();
    const { failures } = await discoverModels([{ id: 'm1' }], makeClient(), output);
    expect(failures).toBe(0);
  });
});

describe('discoverModels — offline budgets (ledger)', () => {
  function makeLedgerMemento() {
    const store: Record<string, unknown> = {};
    const memento = {
      keys: () => Object.keys(store),
      get: (key: string) => store[key],
      update: async (key: string, value: unknown) => { store[key] = value; },
    } as unknown as vscode.Memento;
    return { memento, store };
  }

  it('records healthy budgets and serves them on a later outage', async () => {
    const output = makeOutput();
    const { memento, store } = makeLedgerMemento();
    const ledger = createBudgetLedger(memento);

    const pass1 = await discoverModels(
      [{ id: 'm1', serverUrl: server, family: 'test-family' }],
      makeClient({ getModelContextWindow: async () => ({ contextWindow: 8192 }) }),
      output, undefined, undefined, undefined, ledger,
    );
    expect(pass1.failures).toBe(0);
    expect(store['vllm-copilot.lastKnownBudgets']).toBeDefined();

    const pass2 = await discoverModels(
      [{ id: 'm1', serverUrl: server, family: 'test-family' }],
      makeClient({ getModelContextWindow: async () => { throw new Error('connect ECONNREFUSED'); } }),
      output, undefined, undefined, undefined, ledger,
    );
    expect(pass2.failures).toBe(1);
    const row = pass2.models[0] as typeof pass2.models[0] & { warningText?: Record<string, string> };
    expect(row.warningText?.offline).toContain('connect ECONNREFUSED');
    expect(row.warningText?.offline).toContain('last successful connection');
    // Stale-but-honest: the exact budget the healthy row advertised.
    expect(row.maxInputTokens! + row.maxOutputTokens!).toBe(8192);
  });

  it('a budget recorded for one server never grafts onto a different server sharing the picker id', async () => {
    // globalState is shared across workspaces and picker ids are user-chosen:
    // identity is (serverUrl, wire id), so an unrelated 'm1' on another dead
    // server gets honest placeholders, not a borrowed budget.
    const output = makeOutput();
    const { memento } = makeLedgerMemento();
    const ledger = createBudgetLedger(memento);

    await discoverModels(
      [{ id: 'm1', serverUrl: server, family: 'test-family' }],
      makeClient({ getModelContextWindow: async () => ({ contextWindow: 8192 }) }),
      output, undefined, undefined, undefined, ledger,
    );

    const stranger = await discoverModels(
      [{ id: 'm1', serverUrl: 'http://other-box:9000', family: 'test-family' }],
      makeClient({ getModelContextWindow: async () => { throw new Error('nope'); } }),
      output, undefined, undefined, undefined, ledger,
    );
    const row = stranger.models[0] as typeof stranger.models[0] & { warningText?: Record<string, string> };
    expect(row.warningText?.offline).toContain('never reached');
    expect(row.maxInputTokens).toBe(1);
    expect(row.maxOutputTokens).toBe(1);
  });

  it('offline rows re-apply the configured input clamp to the last-known window', async () => {
    // The ledger stores window+output only, so the user's maxInputTokens clamp
    // must be re-applied at reconstruction — a clamped 1000 must not silently
    // grow back to window−output.
    const output = makeOutput();
    const { memento } = makeLedgerMemento();
    const ledger = createBudgetLedger(memento);
    const override = { id: 'm1', serverUrl: server, family: 'test-family', maxInputTokens: 1000 };

    const healthy = await discoverModels(
      [override],
      makeClient({ getModelContextWindow: async () => ({ contextWindow: 8192 }) }),
      output, undefined, undefined, undefined, ledger,
    );
    expect(healthy.models[0].maxInputTokens).toBe(1000);

    const down = await discoverModels(
      [override],
      makeClient({ getModelContextWindow: async () => { throw new Error('EHOSTDOWN'); } }),
      output, undefined, undefined, undefined, ledger,
    );
    expect(down.models[0].maxInputTokens).toBe(1000);
    expect(down.models[0].maxOutputTokens).toBe(4096);
  });

  it('never-reached rows honor configured limits and placeholder only the unknowns', async () => {
    const output = makeOutput();
    const { models } = await discoverModels(
      [{ id: 'm1', serverUrl: server, maxInputTokens: 40000 }],
      makeClient({ getModelContextWindow: async () => { throw new Error('down'); } }),
      output,
    );
    // Input is genuinely configured → advertised; output never configured →
    // 1-token placeholder, never the built-in 4096.
    expect(models[0].maxInputTokens).toBe(40000);
    expect(models[0].maxOutputTokens).toBe(1);
  });

  it('offline rows drop the Output-length menu but keep the mode dropdown', async () => {
    // The length menu renders from the RAW vector override, so it does NOT
    // vanish just because the budget is synthetic. An offline row must not
    // offer picks against a stale/placeholder ceiling; the mode dropdown
    // selects behavior, not reserved budget, and stays.
    const output = makeOutput();
    const { memento } = makeLedgerMemento();
    const ledger = createBudgetLedger(memento);
    const override = {
      id: 'm1', serverUrl: server, family: 'test-family',
      maxOutputTokens: [8192, 4096, 2048],
      modelModes: { Think: {}, Fast: {} },
    };

    const healthy = await discoverModels(
      [override],
      makeClient({ getModelContextWindow: async () => ({ contextWindow: 32768 }) }),
      output, undefined, undefined, undefined, ledger,
    );
    const healthyProps = (healthy.models[0] as any).configurationSchema.properties;
    expect(healthyProps.maxOutputTokens).toBeDefined(); // menu exists when healthy
    expect(healthyProps.reasoningEffort).toBeDefined();

    const down = await discoverModels(
      [override],
      makeClient({ getModelContextWindow: async () => { throw new Error('down'); } }),
      output, undefined, undefined, undefined, ledger,
    );
    const offlineProps = (down.models[0] as any).configurationSchema.properties;
    expect(offlineProps.maxOutputTokens).toBeUndefined(); // no picks against a stale ceiling
    expect(offlineProps.reasoningEffort).toBeDefined();   // modes stay
  });
});
