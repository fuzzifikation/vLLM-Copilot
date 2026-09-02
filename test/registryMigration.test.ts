import { describe, it, expect } from 'vitest';
import { planRegistryMigration } from '../src/registryMigration.js';
import { makeLegacyModelConfig, DEFAULT_TEST_SERVER_URL } from './factories.js';

describe('planRegistryMigration', () => {
  it('migrates a single model to one server entry referenced by id', () => {
    const plan = planRegistryMigration([makeLegacyModelConfig()]);

    expect(plan.skipped).toEqual([]);
    expect(plan.servers).toEqual([
      { id: 'localhost-8000', serverUrl: DEFAULT_TEST_SERVER_URL },
    ]);
    expect(plan.models).toEqual([
      { id: 'test-model', vllmModelId: 'test-model', server: 'localhost-8000' },
    ]);
  });

  it('groups N models on one server (same URL + headers) into a single entry', () => {
    const plan = planRegistryMigration([
      makeLegacyModelConfig({ id: 'a' }),
      makeLegacyModelConfig({ id: 'b' }),
      makeLegacyModelConfig({ id: 'c' }),
    ]);

    expect(plan.skipped).toEqual([]);
    expect(plan.servers).toEqual([
      { id: 'localhost-8000', serverUrl: DEFAULT_TEST_SERVER_URL },
    ]);
    expect(plan.models.map(m => [m.id, 'server' in m ? m.server : null])).toEqual([
      ['a', 'localhost-8000'],
      ['b', 'localhost-8000'],
      ['c', 'localhost-8000'],
    ]);
  });

  it('keeps same-URL models with different credentials in separate entries', () => {
    const plan = planRegistryMigration([
      makeLegacyModelConfig({ id: 'a', requestHeaders: { Authorization: 'Bearer key-one' } }),
      makeLegacyModelConfig({ id: 'b', requestHeaders: { Authorization: 'Bearer key-two' } }),
    ]);

    expect(plan.skipped).toEqual([]);
    expect(plan.servers).toEqual([
      {
        id: 'localhost-8000',
        serverUrl: DEFAULT_TEST_SERVER_URL,
        requestHeaders: { Authorization: 'Bearer key-one' },
      },
      {
        id: 'localhost-8000-2',
        serverUrl: DEFAULT_TEST_SERVER_URL,
        requestHeaders: { Authorization: 'Bearer key-two' },
      },
    ]);
    expect(plan.models.map(m => [m.id, 'server' in m ? m.server : null])).toEqual([
      ['a', 'localhost-8000'],
      ['b', 'localhost-8000-2'],
    ]);
  });

  it('creates an `openrouter` entry when a model points at the OpenRouter endpoint', () => {
    const plan = planRegistryMigration([
      makeLegacyModelConfig({ serverUrl: 'https://openrouter.ai/api' }),
    ]);

    expect(plan.skipped).toEqual([]);
    expect(plan.servers).toEqual([
      { id: 'openrouter', serverUrl: 'https://openrouter.ai/api', serverType: 'openrouter' },
    ]);
    expect(plan.models).toEqual([
      { id: 'test-model', vllmModelId: 'test-model', server: 'openrouter' },
    ]);
  });

  it('auto-detects the `openrouter` type for any openrouter.ai host variant, not just the canonical /api base', () => {
    // Must use the same host-based classifier (isOpenRouterUrl) the runtime
    // uses — the old exact-string check typed 'https://openrouter.ai/api/'
    // variants and bare hosts as plain vllm, then every probe misbehaved.
    const plan = planRegistryMigration([
      makeLegacyModelConfig({ id: 'or', serverUrl: 'https://openrouter.ai' }),
    ]);

    expect(plan.skipped).toEqual([]);
    expect(plan.servers[0].serverType).toBe('openrouter');
  });

  it('creates no OpenRouter entry when no model points at it', () => {
    const plan = planRegistryMigration([makeLegacyModelConfig()]);

    expect(plan.servers.some(s => s.id === 'openrouter')).toBe(false);
    expect(plan.servers.some(s => s.serverType === 'openrouter')).toBe(false);
  });

  it('migrates an empty models array to an empty plan', () => {
    expect(planRegistryMigration([])).toEqual({ servers: [], models: [], skipped: [], conflicts: [] });
  });

  it('skips scheme-less junk that normalizes to the localhost sentinel', () => {
    // "//host:8000", "/v1" and "?x" gain a bogus scheme from normalizeServerUrl
    // and collapse to its localhost:8000 sentinel. Without a hostname check they
    // would mint a live localhost-8000 entry (here: silently JOINING the real
    // localhost model's entry, which is exactly the confusion this guards).
    const junk = ['//host:8000', '/v1', '?x'].map((u, i) =>
      makeLegacyModelConfig({ id: `junk-${i}`, serverUrl: u })
    );
    const plan = planRegistryMigration([
      makeLegacyModelConfig({ id: 'real-localhost' }),
      ...junk,
    ]);

    expect(plan.skipped.map(s => s.id)).toEqual(['junk-0', 'junk-1', 'junk-2']);
    expect(plan.skipped.every(s => s.reason.includes('unparseable serverUrl'))).toBe(true);
    expect(plan.servers).toEqual([{ id: 'localhost-8000', serverUrl: DEFAULT_TEST_SERVER_URL }]);
    // Only the real model joined the entry — no junk rode in on the sentinel.
    expect(plan.models.map(m => ('server' in m ? m.server : null))).toEqual([
      'localhost-8000', null, null, null,
    ]);
  });

  it('still migrates a scheme-less but real host (normalizeServerUrl feature, not junk)', () => {
    const plan = planRegistryMigration([makeLegacyModelConfig({ serverUrl: 'localhost:8001' })]);

    expect(plan.skipped).toEqual([]);
    expect(plan.servers).toEqual([{ id: 'localhost-8001', serverUrl: 'http://localhost:8001' }]);
  });

  describe('backend protocol conflicts', () => {
    it('reports a group whose members declare different serverTypes', () => {
      const plan = planRegistryMigration([
        makeLegacyModelConfig({ id: 'a', serverType: 'ollama' }),
        makeLegacyModelConfig({ id: 'b', serverType: 'vllm' }),
      ]);

      // One entry (one URL + auth = one connection), but the disagreement is named.
      expect(plan.servers).toHaveLength(1);
      expect(plan.conflicts).toEqual([
        {
          serverId: 'localhost-8000',
          serverUrl: DEFAULT_TEST_SERVER_URL,
          modelIds: ['a', 'b'],
          protocols: ['ollama', 'vllm'],
        },
      ]);
    });

    it('reports a typeless member being defaulted onto a declared non-vllm type', () => {
      // Missing serverType meant vllm pre-migration; a shared entry typed
      // 'ollama' silently changes that model's protocol — must not be silent.
      const plan = planRegistryMigration([
        makeLegacyModelConfig({ id: 'plain' }),
        makeLegacyModelConfig({ id: 'ollama-one', serverType: 'ollama' }),
      ]);

      expect(plan.conflicts).toHaveLength(1);
      expect(plan.conflicts[0].modelIds).toEqual(['plain', 'ollama-one']);
      expect(plan.conflicts[0].protocols).toEqual(['ollama', 'vllm']);
    });

    it('is NOT a conflict when a typeless member joins a declared vllm group', () => {
      const plan = planRegistryMigration([
        makeLegacyModelConfig({ id: 'plain' }),
        makeLegacyModelConfig({ id: 'explicit-vllm', serverType: 'vllm' }),
      ]);

      expect(plan.conflicts).toEqual([]);
    });

    it('is NOT a conflict on an OpenRouter URL where typeless members classify as openrouter', () => {
      const plan = planRegistryMigration([
        makeLegacyModelConfig({ id: 'plain', serverUrl: 'https://openrouter.ai/api' }),
        makeLegacyModelConfig({ id: 'typed', serverUrl: 'https://openrouter.ai/api', serverType: 'openrouter' }),
      ]);

      expect(plan.conflicts).toEqual([]);
    });

    it('reports conflicts inside a group merged into a REUSED existing entry', () => {
      const existing = [{ id: 'my-box', serverUrl: DEFAULT_TEST_SERVER_URL }];
      const plan = planRegistryMigration(
        [
          makeLegacyModelConfig({ id: 'a', serverType: 'llamacpp' }),
          makeLegacyModelConfig({ id: 'b', serverType: 'ollama' }),
        ],
        existing
      );

      expect(plan.servers).toEqual([]); // reused, nothing created
      expect(plan.conflicts).toEqual([
        {
          serverId: 'my-box',
          serverUrl: DEFAULT_TEST_SERVER_URL,
          modelIds: ['a', 'b'],
          protocols: ['llamacpp', 'ollama'],
        },
      ]);
    });
  });

  it('keeps a model with no serverUrl verbatim instead of inventing one', () => {
    const withoutUrl = makeLegacyModelConfig({ id: 'no-server' });
    delete withoutUrl.serverUrl;
    const plan = planRegistryMigration([
      withoutUrl,
      makeLegacyModelConfig({ id: 'has-server' }),
    ]);

    expect(plan.skipped).toEqual([{ id: 'no-server', reason: 'no serverUrl' }]);
    // Skipped models stay in the array, untouched and in place — never deleted.
    expect(plan.models[0]).toBe(withoutUrl);
    expect(plan.models.map(m => m.id)).toEqual(['no-server', 'has-server']);
    expect('server' in plan.models[0]).toBe(false);
    expect(plan.servers).toEqual([
      { id: 'localhost-8000', serverUrl: DEFAULT_TEST_SERVER_URL },
    ]);
  });

  it('takes the entry displayName from the first group member with a non-empty one', () => {
    const plan = planRegistryMigration([
      makeLegacyModelConfig({ id: 'a' }),
      makeLegacyModelConfig({ id: 'b', serverDisplayName: 'GPU Box' }),
    ]);

    expect(plan.servers).toEqual([
      { id: 'localhost-8000', serverUrl: DEFAULT_TEST_SERVER_URL, displayName: 'GPU Box' },
    ]);
  });

  it("inherits the group's serverType onto the entry", () => {
    const plan = planRegistryMigration([
      makeLegacyModelConfig({ id: 'a', serverType: 'ollama' }),
      makeLegacyModelConfig({ id: 'b', serverType: 'ollama' }),
    ]);

    expect(plan.servers).toEqual([
      { id: 'localhost-8000', serverUrl: DEFAULT_TEST_SERVER_URL, serverType: 'ollama' },
    ]);
  });

  it('reuses an existing registry entry with a matching fingerprint instead of duplicating', () => {
    const existing = [
      { id: 'my-box', serverUrl: DEFAULT_TEST_SERVER_URL, requestHeaders: { Authorization: 'alpha' } },
    ];
    const plan = planRegistryMigration(
      [makeLegacyModelConfig({ requestHeaders: { Authorization: 'alpha' } })],
      existing
    );

    // No new entry — the retry-after-partial-write case must converge.
    expect(plan.servers).toEqual([]);
    expect(plan.models).toEqual([
      { id: 'test-model', vllmModelId: 'test-model', server: 'my-box' },
    ]);
  });

  it('does not reuse an existing entry with a different fingerprint', () => {
    const existing = [
      { id: 'my-box', serverUrl: DEFAULT_TEST_SERVER_URL, requestHeaders: { Authorization: 'alpha' } },
    ];
    const plan = planRegistryMigration(
      [makeLegacyModelConfig({ requestHeaders: { Authorization: 'beta' } })],
      existing
    );

    expect(plan.servers).toEqual([
      { id: 'localhost-8000', serverUrl: DEFAULT_TEST_SERVER_URL, requestHeaders: { Authorization: 'beta' } },
    ]);
    expect(plan.models[0]).toEqual({
      id: 'test-model',
      vllmModelId: 'test-model',
      server: 'localhost-8000',
    });
  });

  it('avoids id collisions with existing entries and leaves them untouched', () => {
    const existing = [{ id: 'localhost-8000', serverUrl: 'https://elsewhere.example/v1' }];
    const plan = planRegistryMigration([makeLegacyModelConfig()], existing);

    expect(plan.servers).toEqual([
      { id: 'localhost-8000-2', serverUrl: DEFAULT_TEST_SERVER_URL },
    ]);
    expect(existing[0]).toEqual({ id: 'localhost-8000', serverUrl: 'https://elsewhere.example/v1' });
  });

  it('produces deterministic ids — same input, same plan', () => {
    const models = [
      makeLegacyModelConfig({ id: 'a' }),
      makeLegacyModelConfig({ id: 'b', requestHeaders: { Authorization: 'Bearer key' } }),
      makeLegacyModelConfig({ id: 'c', serverUrl: 'https://openrouter.ai/api' }),
    ];

    expect(planRegistryMigration(models)).toEqual(planRegistryMigration(models));
  });

  it('preserves all non-server model fields untouched', () => {
    const plan = planRegistryMigration([
      makeLegacyModelConfig({
        displayName: 'My Model',
        maxInputTokens: 32768,
        maxOutputTokens: [8192, 4096, 2048],
        capabilities: { toolCalling: true, imageInput: true },
        modelModes: { Think: { chat_template_kwargs: { enable_thinking: true } } },
        defaultMode: 'Think',
        defaultParams: { temperature: 0.7 },
        family: 'qwen3_5',
        estimateCharsPerToken: 3.5,
      }),
    ]);

    expect(plan.models).toEqual([
      {
        id: 'test-model',
        vllmModelId: 'test-model',
        displayName: 'My Model',
        maxInputTokens: 32768,
        maxOutputTokens: [8192, 4096, 2048],
        capabilities: { toolCalling: true, imageInput: true },
        modelModes: { Think: { chat_template_kwargs: { enable_thinking: true } } },
        defaultMode: 'Think',
        defaultParams: { temperature: 0.7 },
        family: 'qwen3_5',
        estimateCharsPerToken: 3.5,
        server: 'localhost-8000',
      },
    ]);
  });

  it('keeps provider and routingMode on the model, not on the entry', () => {
    const plan = planRegistryMigration([
      makeLegacyModelConfig({
        serverUrl: 'https://openrouter.ai/api',
        provider: 'deepseek',
        routingMode: 'nitro',
      }),
    ]);

    expect(plan.servers).toEqual([
      { id: 'openrouter', serverUrl: 'https://openrouter.ai/api', serverType: 'openrouter' },
    ]);
    expect(plan.models).toEqual([
      {
        id: 'test-model',
        vllmModelId: 'test-model',
        provider: 'deepseek',
        routingMode: 'nitro',
        server: 'openrouter',
      },
    ]);
  });

  it('skips a model with an unparseable serverUrl instead of throwing (migration must not brick)', () => {
    // `new URL()` inside generateServerId would otherwise abort the whole
    // one-shot migration forever, orphaning EVERY model (Phase 2 deleted all
    // legacy-field readers). One rotten URL must not sink the fleet.
    const garbage = makeLegacyModelConfig({ id: 'broken', serverUrl: 'http://my server:8000' });
    const plan = planRegistryMigration([
      garbage,
      makeLegacyModelConfig({ id: 'healthy' }),
    ]);

    expect(plan.skipped).toEqual([{ id: 'broken', reason: 'unparseable serverUrl "http://my server:8000"' }]);
    expect(plan.models[0]).toBe(garbage); // verbatim, in place
    expect(plan.models[1]).toMatchObject({ id: 'healthy', server: 'localhost-8000' });
    expect(plan.servers).toEqual([{ id: 'localhost-8000', serverUrl: DEFAULT_TEST_SERVER_URL }]);
  });

  it('skips a non-URL serverUrl ("not a url") without touching valid models', () => {
    const junk = makeLegacyModelConfig({ id: 'junk', serverUrl: 'not a url' });
    const plan = planRegistryMigration([makeLegacyModelConfig({ id: 'ok' }), junk]);

    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].id).toBe('junk');
    expect(plan.models[1]).toBe(junk);
    expect(plan.servers).toHaveLength(1);
  });
});
