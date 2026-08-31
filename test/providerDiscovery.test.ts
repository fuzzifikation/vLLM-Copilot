import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { VllmChatModelProvider } from '../src/provider.js';
import type { ProviderClient } from '../src/provider/contracts.js';
import type { VllmConfig } from '../src/config.js';

/**
 * Direct tests for the provider's class-owned discovery shell —
 * {@link VllmChatModelProvider.provideLanguageModelChatInformation} and
 * {@link VllmChatModelProvider.clearCache}.
 *
 * The per-model discovery core (`discoverModels` in provider/discovery.ts) is
 * tested separately; these tests pin the intentionally class-owned
 * responsibilities: the remote-install guard, silent-cache reuse, cache
 * population, the empty-config early return, and clearCache invalidation +
 * change-event firing.
 */

function makeContext(extensionKind = vscode.ExtensionKind.UI): any {
  return {
    secrets: { get: async () => undefined },
    extension: { extensionKind },
  };
}

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

function makeToken(): any {
  return { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
}

function fakeClient(overrides: Partial<ProviderClient> = {}): ProviderClient {
  return {
    getConfigCached: vi.fn(async () => ({ models: [], enableFileLogging: false } as VllmConfig)),
    invalidateConfigCache: vi.fn(),
    getModelContextWindow: vi.fn(async () => ({ contextWindow: 8192 })),
    chatCompletionStream: async function* () {},
    ...overrides,
  };
}

const server = 'http://localhost:8000';
const configWithModel = { models: [{ id: 'm1', serverUrl: server, family: 'test-family' }] } as VllmConfig;

describe('provideLanguageModelChatInformation (facade)', () => {
  it('returns [] and skips discovery when running locally on a remote', async () => {
    const originalRemoteName = vscode.env.remoteName;
    (vscode.env as any).remoteName = 'wsl';
    const client = fakeClient();
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });
    try {
      const models = await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
      expect(models).toEqual([]);
    } finally {
      (vscode.env as any).remoteName = originalRemoteName;
    }
    expect(client.getConfigCached).not.toHaveBeenCalled();
  });

  it('returns [] for an empty model config', async () => {
    const client = fakeClient();
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });

    const models = await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());

    expect(models).toEqual([]);
    expect(client.getConfigCached).toHaveBeenCalledTimes(1);
  });

  it('populates the cache on discovery and reuses it on silent calls without re-reading config', async () => {
    const client = fakeClient({ getConfigCached: vi.fn(async () => configWithModel) });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });

    const first = await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe('m1');

    const silent = await provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
    expect(silent).toBe(first); // same array identity — served from cache
    expect(client.getConfigCached).toHaveBeenCalledTimes(1);
  });

  it('re-runs discovery on a silent call when no cache exists yet', async () => {
    const client = fakeClient({ getConfigCached: vi.fn(async () => configWithModel) });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });

    const models = await provider.provideLanguageModelChatInformation({ silent: true }, makeToken());

    expect(models).toHaveLength(1);
    expect(client.getConfigCached).toHaveBeenCalledTimes(1);
  });
});

describe('clearCache (invalidation + change event)', () => {
  it('nulls the cache, invalidates the client config cache, and fires the change event', async () => {
    const client = fakeClient({ getConfigCached: vi.fn(async () => configWithModel) });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });
    await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());

    let fired = 0;
    provider.onDidChangeLanguageModelChatInformation(() => { fired++; });

    provider.clearCache();

    expect(client.invalidateConfigCache).toHaveBeenCalled();
    expect(fired).toBe(1);
  });

  it('forces a silent call to re-discover after invalidation', async () => {
    const client = fakeClient({ getConfigCached: vi.fn(async () => configWithModel) });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });
    await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    expect(client.getConfigCached).toHaveBeenCalledTimes(1);

    provider.clearCache();

    const silent = await provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
    expect(silent).toHaveLength(1);
    expect(client.getConfigCached).toHaveBeenCalledTimes(2); // re-read after invalidation
  });

  it('does not return or cache a discovery result invalidated while in flight', async () => {
    let resolveOldContext!: (value: { contextWindow: number }) => void;
    const oldContext = new Promise<{ contextWindow: number }>(resolve => {
      resolveOldContext = resolve;
    });
    const oldConfig = {
      models: [{ id: 'old', serverUrl: server, family: 'old-family' }],
      enableFileLogging: false,
    } as VllmConfig;
    const newConfig = {
      models: [{ id: 'new', serverUrl: server, family: 'new-family' }],
      enableFileLogging: false,
    } as VllmConfig;
    const client = fakeClient({
      getConfigCached: vi.fn()
        .mockResolvedValueOnce(oldConfig)
        .mockResolvedValue(newConfig),
      getModelContextWindow: vi.fn()
        .mockImplementationOnce(() => oldContext)
        .mockResolvedValue({ contextWindow: 8192 }),
    });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });

    const pending = provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    await vi.waitFor(() => expect(client.getModelContextWindow).toHaveBeenCalledTimes(1));
    provider.clearCache();
    resolveOldContext({ contextWindow: 8192 });

    const models = await pending;
    expect(models.map(model => model.id)).toEqual(['new']);
    const silent = await provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
    expect(silent.map(model => model.id)).toEqual(['new']);
    expect(client.getConfigCached).toHaveBeenCalledTimes(2);
  });

  it('does not cache a discovery result invalidated by a MODE SWITCH while in flight (finding 2)', async () => {
    // The mode-switch path (trackModeSelection) must invalidate an in-flight
    // discovery exactly like clearCache does — otherwise stale metadata (old
    // output budget) could be restored after the switch. This pins the
    // generation-increment in trackModeSelection specifically.
    const modelWithModes = {
      models: [{ id: 'm1', serverUrl: server, family: 'test-family', modelModes: { Think: { max_tokens: 8000 }, Fast: {} } }],
      enableFileLogging: false,
    } as VllmConfig;

    let resolveOldContext!: (value: { contextWindow: number }) => void;
    const oldContext = new Promise<{ contextWindow: number }>(resolve => {
      resolveOldContext = resolve;
    });

    const client = fakeClient({
      getConfigCached: vi.fn(async () => modelWithModes),
      getModelContextWindow: vi.fn()
        .mockImplementationOnce(() => oldContext)   // first (in-flight) discovery blocks
        .mockResolvedValue({ contextWindow: 8192 }), // re-discovery resolves
      chatCompletionStream: async function* () {},    // request completes without error
    });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });

    // Start discovery #1 (mode not yet selected → baseline, no re-registration).
    const pending = provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    await vi.waitFor(() => expect(client.getModelContextWindow).toHaveBeenCalledTimes(1));

    // Mode switch: fires the re-registration path (increments generation, clears cache).
    await provider.provideLanguageModelChatResponse(
      { id: 'm1', maxOutputTokens: 4096, maxInputTokens: 4096 } as any,
      [{ content: [] }] as any,
      { modelConfiguration: { reasoningEffort: 'Think' } } as any,
      { report: vi.fn() } as any,
      makeToken(),
    );

    // Resolve the STALE in-flight discovery — it must NOT be cached.
    resolveOldContext({ contextWindow: 8192 });
    const stale = await pending;
    // The generation was bumped by the mode switch, so the in-flight result is
    // discarded; the provider loops and re-discovers with the mode's budget.
    expect(stale.map(model => model.id)).toEqual(['m1']);
    expect(stale[0].maxOutputTokens).toBe(8000); // re-discovery used the selected mode budget
    // A subsequent silent call serves the FRESH metadata, not the stale pre-switch one.
    const silent = await provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
    expect(silent[0].maxOutputTokens).toBe(8000);
  });

  it('advertises the picked OUTPUT LENGTH with grown input budget; the menu keeps bigger options', async () => {
    // The output-length pick IS the advertised output budget: Copilot's context
    // math (window − output) hands the freed tokens to the prompt. The dropdown
    // menu is filtered by the static ceiling, so 4096 stays selectable at 2048.
    const modelWithLengths = {
      models: [{
        id: 'm1', serverUrl: server, family: 'test-family',
        maxOutputTokens: [4096, 2048],
      }],
      enableFileLogging: false,
    } as VllmConfig;
    const client = fakeClient({
      getConfigCached: vi.fn(async () => modelWithLengths),
      getModelContextWindow: vi.fn(async () => ({ contextWindow: 8192 })),
    });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });

    const first = await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    expect(first[0].maxOutputTokens).toBe(4096); // default = ceiling
    expect(first[0].maxInputTokens).toBe(8192 - 4096);

    // User picks 2048 in the dropdown → the next request carries the pick →
    // metadata re-registers with the picked budget.
    await provider.provideLanguageModelChatResponse(
      { id: 'm1', maxOutputTokens: 4096, maxInputTokens: 4096 } as any,
      [{ content: [] }] as any,
      { modelConfiguration: { maxOutputTokens: 2048 } } as any,
      { report: vi.fn() } as any,
      makeToken(),
    );

    const refresh = await provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
    expect(refresh[0].maxOutputTokens).toBe(2048);         // advertised output = pick
    expect(refresh[0].maxInputTokens).toBe(8192 - 2048);   // freed tokens grew the prompt budget
    const enumVals = ((refresh[0] as any).configurationSchema as any)?.properties?.maxOutputTokens?.enum;
    expect(enumVals).toEqual([4096, 2048]);                // menu NOT filtered by the pick
    // A deliberate pick is not a clamp — no false warning banner.
    expect((refresh[0] as any).warningText?.output_limit).toBeUndefined();
  });

  it('a legacy per-mode max_tokens never shrinks the Output-length menu and the pick outranks it', async () => {
    // Menu/banner ceilings derive from the model's own budget under the
    // PHYSICAL clamps only. A selected mode's max_tokens (legacy layer) must
    // not collapse the dropdown on a mode switch, and a deliberate pick beats
    // it — the advertised budget follows the pick, not the mode.
    const modelWithModeCap = {
      models: [{
        id: 'm1', serverUrl: server, family: 'test-family',
        maxOutputTokens: [4096, 2048],
        modelModes: { Fast: { max_tokens: 1024 } },
      }],
      enableFileLogging: false,
    } as VllmConfig;
    const client = fakeClient({
      getConfigCached: vi.fn(async () => modelWithModeCap),
      getModelContextWindow: vi.fn(async () => ({ contextWindow: 8192 })),
    });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });

    const first = await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    expect(first[0].maxOutputTokens).toBe(4096);

    // Switch to the capped mode while the default 4096 pick stays in place.
    await provider.provideLanguageModelChatResponse(
      { id: 'm1', maxOutputTokens: 4096, maxInputTokens: 4096 } as any,
      [{ content: [] }] as any,
      { modelConfiguration: { reasoningEffort: 'Fast', maxOutputTokens: 4096 } } as any,
      { report: vi.fn() } as any,
      makeToken(),
    );

    const refresh = await provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
    expect(refresh[0].maxOutputTokens).toBe(4096); // pick outranks the mode's 1024 cap
    const enumVals = ((refresh[0] as any).configurationSchema as any)?.properties?.maxOutputTokens?.enum;
    expect(enumVals).toEqual([4096, 2048]);        // menu survived the mode switch intact
    expect((refresh[0] as any).warningText?.output_limit).toBeUndefined();
  });

  it('skips re-registration when the pick already equals the advertised output (default pick)', async () => {
    // VS Code merges the schema default into every request, so the default pick
    // arrives on EVERY request — re-registering for it would refetch context
    // windows forever. Only an actual change may invalidate the cache.
    const modelWithLengths = {
      models: [{
        id: 'm1', serverUrl: server, family: 'test-family',
        maxOutputTokens: [4096, 2048],
      }],
      enableFileLogging: false,
    } as VllmConfig;
    const client = fakeClient({
      getConfigCached: vi.fn(async () => modelWithLengths),
      getModelContextWindow: vi.fn(async () => ({ contextWindow: 8192 })),
    });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });

    const first = await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    expect(client.getConfigCached).toHaveBeenCalledTimes(1);

    await provider.provideLanguageModelChatResponse(
      { id: 'm1', maxOutputTokens: 4096, maxInputTokens: 4096 } as any,
      [{ content: [] }] as any,
      { modelConfiguration: { maxOutputTokens: 4096 } } as any, // the default pick
      { report: vi.fn() } as any,
      makeToken(),
    );
    // The request itself reads config for routing — count from AFTER it, so
    // only a spurious re-discovery could increase this number.
    const callsAfterRequest = vi.mocked(client.getConfigCached).mock.calls.length;

    const silent = await provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
    expect(silent).toBe(first); // same cache array — nothing was invalidated
    expect(client.getConfigCached).toHaveBeenCalledTimes(callsAfterRequest);
  });
});

describe('gone when down (picker is a live inventory)', () => {
  it('a down server drops its models from the picker entirely', async () => {
    const client = fakeClient({
      getConfigCached: vi.fn(async () => configWithModel),
      getModelContextWindow: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }),
    });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });

    const models = await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());

    expect(models).toEqual([]); // gone, not grayed
  });

  it('a recovered server reappears on the first resolve past the TTL', async () => {
    vi.useFakeTimers();
    try {
      let online = false;
      const client = fakeClient({
        getConfigCached: vi.fn(async () => configWithModel),
        getModelContextWindow: vi.fn(async () => {
          if (!online) throw new Error('connect ECONNREFUSED');
          return { contextWindow: 8192 };
        }),
      });
      const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });

      const down = await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
      expect(down).toEqual([]);

      // Server recovers. A silent call inside the TTL still serves the
      // (empty) cache; past the TTL the provider re-probes and the model
      // returns on its own.
      online = true;
      vi.advanceTimersByTime(61_000);
      const up = await provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
      expect(up).toHaveLength(1);
      expect(client.getConfigCached).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a transport failure on a chat request invalidates the model cache', async () => {
    // Mid-session death: the picker advertised the model, the server then
    // died. The request's ECONNREFUSED must invalidate the cache so the next
    // resolve drops the model instead of offering a dead server again.
    const client = fakeClient({
      getConfigCached: vi.fn(async () => configWithModel),
      getModelContextWindow: vi.fn(async () => ({ contextWindow: 8192 })),
      chatCompletionStream: vi.fn(async function* (): AsyncGenerator<never> {
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
      }),
    });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });
    let events = 0;
    provider.onDidChangeLanguageModelChatInformation(() => { events++; });

    const up = await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    expect(up).toHaveLength(1);

    await provider.provideLanguageModelChatResponse(
      up[0],
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [] }] as any,
      {} as any,
      { report: vi.fn() } as any,
      makeToken(),
    );

    // The failure invalidated the cache and told VS Code to re-resolve.
    expect(events).toBe(1);
    expect(client.invalidateConfigCache).toHaveBeenCalled();

    // And the re-resolve drops the now-dead model.
    client.getModelContextWindow = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    const after = await provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
    expect(after).toEqual([]);
  });

  it('a 5xx is NOT a transport failure: the server answered, the cache survives', async () => {
    const client = fakeClient({
      getConfigCached: vi.fn(async () => configWithModel),
      chatCompletionStream: vi.fn(async function* (): AsyncGenerator<never> {
        throw new Error('HTTP 503: Service Unavailable');
      }),
    });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });
    let events = 0;
    provider.onDidChangeLanguageModelChatInformation(() => { events++; });

    const up = await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    await provider.provideLanguageModelChatResponse(
      up[0],
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [] }] as any,
      {} as any,
      { report: vi.fn() } as any,
      makeToken(),
    );

    // The server is alive and answered; invalidating would flicker the picker
    // for a transient 503. The cache must NOT be invalidated.
    expect(events).toBe(0);
    expect(client.invalidateConfigCache).not.toHaveBeenCalled();
  });
});
