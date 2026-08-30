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

describe('self-healing after an outage', () => {
  it('serves the offline cache during the cooldown while healing in the background', async () => {
    // Server down at first resolve: the model STAYS visible (offline row).
    // While any row is offline the cache is not authoritative; a silent call
    // inside the dead-server cooldown returns the cached list IMMEDIATELY
    // (never stalling behind a 10s probe) and re-checks in the background,
    // firing the change event on full recovery so the picker updates itself.
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
      let events = 0;
      provider.onDidChangeLanguageModelChatInformation(() => { events++; });

      const down = await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
      expect(down).toHaveLength(1); // offline row, not a vanishing model
      expect((down[0] as any).warningText?.offline).toContain('connect ECONNREFUSED');

      // Server recovers. A silent call inside the cooldown serves the cached
      // offline list without waiting, and kicks a background heal.
      online = true;
      const throttled = await provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
      expect((throttled[0] as any).warningText?.offline).toBeDefined();

      // The background pass settles: cache healed, change event fired once.
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toBe(1);

      // Healed metadata is authoritative now: served directly, no re-probe.
      const up = await provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
      expect((up[0] as any).warningText?.offline).toBeUndefined();
      expect(client.getConfigCached).toHaveBeenCalledTimes(2); // down pass + background heal

      await provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
      expect(client.getConfigCached).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('concurrent resolves join one shared discovery pass', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const client = fakeClient({
      getConfigCached: vi.fn(async () => configWithModel),
      getModelContextWindow: vi.fn(async () => { await gate; return { contextWindow: 8192 }; }),
    });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });

    const p1 = provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
    const p2 = provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
    await new Promise(resolve => setImmediate(resolve));
    expect(client.getModelContextWindow).toHaveBeenCalledTimes(1); // one probe wave, not two

    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(client.getConfigCached).toHaveBeenCalledTimes(1);
  });

  it('a resolve after invalidation never waits behind the obsolete in-flight pass', async () => {
    // clearCache() mid-probe bumps the generation: a fresh resolve must start
    // its OWN probe immediately instead of joining (and waiting behind) the
    // obsolete pass — whose result would be discarded anyway.
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const client = fakeClient({
      getConfigCached: vi.fn(async () => configWithModel),
      getModelContextWindow: vi.fn(async () => { await gate; return { contextWindow: 8192 }; }),
    });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });

    const p1 = provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    await new Promise(resolve => setImmediate(resolve));
    expect(client.getModelContextWindow).toHaveBeenCalledTimes(1);

    provider.clearCache(); // settings change / Test & Refresh mid-probe
    const p2 = provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
    await new Promise(resolve => setImmediate(resolve));
    expect(client.getModelContextWindow).toHaveBeenCalledTimes(2); // fresh pass, no stale join

    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    // The abandoned pass converges on the published result — no third wave.
    expect(client.getModelContextWindow).toHaveBeenCalledTimes(2);
  });

  it('a request against a just-recovered server is not strangled by its stale offline row', async () => {
    // The recovery race: server wakes up between the last discovery and the
    // request. VS Code still holds the offline row (placeholder budget), and
    // request construction hard-clamps the wire max_tokens to the advertised
    // value — so the provider must re-check live and build the request from
    // the healed row, not the snapshot.
    let online = false;
    let wireMaxTokens: number | undefined;
    const client = fakeClient({
      getConfigCached: vi.fn(async () => configWithModel),
      getModelContextWindow: vi.fn(async () => {
        if (!online) throw new Error('connect ECONNREFUSED');
        return { contextWindow: 8192 };
      }),
      chatCompletionStream: vi.fn(async function* (_m: string, _msgs: unknown, options: { max_tokens?: number }) {
        wireMaxTokens = options.max_tokens;
      }),
    });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });
    let events = 0;
    provider.onDidChangeLanguageModelChatInformation(() => { events++; });

    // Discovery while the server is down → offline placeholder row cached.
    const down = await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    expect(down[0].maxOutputTokens).toBe(1); // 1-token placeholder

    // Server recovers — no silent resolve happens before the request (the race).
    online = true;
    await provider.provideLanguageModelChatResponse(
      down[0], // VS Code hands over the STALE offline row
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [] }] as any,
      {} as any,
      { report: vi.fn() } as any,
      makeToken(),
    );

    // The provider re-discovered on the request path and the wire carries the
    // HEALTHY advertised budget — not the placeholder clamp.
    expect(client.getModelContextWindow).toHaveBeenCalledTimes(2);
    expect(wireMaxTokens).toBe(4096); // default output at 8192 window, not 1
    // Full recovery is pushed to VS Code so the picker's ⚠ marker clears now,
    // not at some later silent resolve.
    expect(events).toBe(1);
  });

  it('a request for a model id absent from the cache never triggers a discovery probe', async () => {
    // VS Code can hand over a stale row for a model that no longer exists
    // (deleted from settings) or arrive mid-refresh (cache nulled). Such a row
    // also has "no registered window" — probing it would fire a full server
    // wave on EVERY doomed request. Only OUR offline rows may trigger a probe.
    const client = fakeClient({
      getConfigCached: vi.fn(async () => configWithModel),
      getModelContextWindow: vi.fn(async () => ({ contextWindow: 8192 })),
    });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });

    await provider.provideLanguageModelChatResponse(
      { id: 'ghost', maxOutputTokens: 100, maxInputTokens: 100 } as any,
      [{ content: [] }] as any,
      {} as any,
      { report: vi.fn() } as any,
      makeToken(),
    );

    expect(client.getModelContextWindow).not.toHaveBeenCalled(); // no probe wave
  });

  it('a non-silent resolve re-probes even when a complete cache exists (management flows want the truth now)', async () => {
    // silent:false = VS Code's provider-management flows. Upstream contract:
    // these always recompute; only silent calls may reuse the cache. A fast
    // path that answers a first non-silent call from a pre-existing complete
    // cache would show a just-died server as healthy in the management UI.
    const client = fakeClient({ getConfigCached: vi.fn(async () => configWithModel) });
    const provider = new VllmChatModelProvider(makeContext(), makeOutput(), undefined, { client });

    await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    expect(client.getConfigCached).toHaveBeenCalledTimes(1);

    // Silent: cache-served (authoritative), no probe.
    await provider.provideLanguageModelChatInformation({ silent: true }, makeToken());
    expect(client.getConfigCached).toHaveBeenCalledTimes(1);

    // Non-silent again: must hit the servers again, not the cache.
    await provider.provideLanguageModelChatInformation({ silent: false }, makeToken());
    expect(client.getConfigCached).toHaveBeenCalledTimes(2);
  });
});
