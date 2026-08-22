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
});
