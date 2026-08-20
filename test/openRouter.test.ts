import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseOpenRouterModelRef,
  parseOpenRouterBranchInput,
  normalizeOpenRouterModel,
  fetchOpenRouterModel,
  fetchOpenRouterAccount,
  resolveOpenRouterRuntimeLimits,
  autoConfigureOpenRouterModel,
  fetchOpenRouterModelEndpoints,
  PermanentContextError,
  OpenRouterModelNotFoundError,
  fetchOpenRouterCatalog,
  OPENROUTER_API_BASE,
  type OpenRouterModelData,
} from '../src/openRouter.js';

// ── parseOpenRouterBranchInput ─────────────────────────────────────────────

describe('parseOpenRouterBranchInput', () => {
  it('passes a fully-qualified model-page URL straight through', () => {
    const r = parseOpenRouterBranchInput('https://openrouter.ai/nvidia/nemotron-3.5-lightning:free');
    expect(r).toEqual({ requestedId: 'nvidia/nemotron-3.5-lightning:free' });
  });

  it('treats a scheme-less openrouter.ai base as a base reference (error → catalog picker)', () => {
    // "openrouter.ai/api" must NOT parse as a bare slug (author "openrouter.ai").
    const r = parseOpenRouterBranchInput('openrouter.ai/api');
    expect('error' in r).toBe(true);
  });

  it('resolves a scheme-less openrouter.ai model-page URL as a URL, not a bare slug', () => {
    const r = parseOpenRouterBranchInput('openrouter.ai/nvidia/nemotron-3.5-lightning:free');
    expect(r).toEqual({ requestedId: 'nvidia/nemotron-3.5-lightning:free' });
  });

  it('leaves a bare author/slug on a non-openrouter host on the slug path', () => {
    const r = parseOpenRouterBranchInput('nvidia/nemotron-3.5-lightning:free');
    expect(r).toEqual({ requestedId: 'nvidia/nemotron-3.5-lightning:free' });
  });
});

// ── parseOpenRouterModelRef ────────────────────────────────────────────────

describe('parseOpenRouterModelRef', () => {
  it('parses a plain author/slug and preserves it as the requested id', () => {
    const r = parseOpenRouterModelRef('deepseek/deepseek-chat');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat' });
  });

  it('strips a variant suffix for the LOOKUP but preserves the full id for CHAT', () => {
    const r = parseOpenRouterModelRef('meta-llama/llama-3.3-70b-instruct:free');
    expect(r).toEqual({ requestedId: 'meta-llama/llama-3.3-70b-instruct:free' });
  });

  it('parses a ~family-latest alias: strips ~ for lookup, keeps it for chat', () => {
    const r = parseOpenRouterModelRef('~deepseek/family-latest');
    expect(r).toEqual({ requestedId: '~deepseek/family-latest' });
  });

  it('parses a model-page URL, ignoring query, fragment, and trailing slash', () => {
    const r = parseOpenRouterModelRef('https://openrouter.ai/deepseek/deepseek-chat?x=1#frag/');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat' });
  });

  it('accepts the www subdomain', () => {
    const r = parseOpenRouterModelRef('https://www.openrouter.ai/deepseek/deepseek-chat');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat' });
  });

  it('rejects unrelated hosts', () => {
    const r = parseOpenRouterModelRef('https://evil.com/deepseek/deepseek-chat');
    expect(r).toEqual({ error: expect.stringContaining('openrouter.ai') });
  });

  it('rejects reserved paths (catalog, docs, settings)', () => {
    expect(parseOpenRouterModelRef('https://openrouter.ai/models')).toMatchObject({ error: expect.any(String) });
    expect(parseOpenRouterModelRef('https://openrouter.ai/docs/api')).toMatchObject({ error: expect.any(String) });
  });

  it('rejects malformed values: empty, no slash, too many segments', () => {
    expect(parseOpenRouterModelRef('')).toMatchObject({ error: expect.any(String) });
    expect(parseOpenRouterModelRef('deepseek')).toMatchObject({ error: expect.any(String) });
    expect(parseOpenRouterModelRef('a/b/c')).toMatchObject({ error: expect.any(String) });
  });

  it('trims trailing slashes in the bare form so the chat id is clean', () => {
    const r = parseOpenRouterModelRef('deepseek/deepseek-chat/');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat' });
  });

  it('trims leading slashes in the bare form (pasted /author/model)', () => {
    const r = parseOpenRouterModelRef('/deepseek/deepseek-chat');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat' });
  });

  it('preserves the ~ alias prefix in the chat id but strips it for the lookup', () => {
    const r = parseOpenRouterModelRef('~deepseek/family-latest/');
    expect(r).toEqual({ requestedId: '~deepseek/family-latest' });
  });

  it('collapses internal double slashes so the chat id is clean', () => {
    const r = parseOpenRouterModelRef('deepseek//deepseek-chat');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat' });
  });

  it('trims spaces around the slash in the bare form (pasted "author / model")', () => {
    const r = parseOpenRouterModelRef('deepseek / deepseek-chat');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat' });
  });
});

// ── normalizeOpenRouterModel ───────────────────────────────────────────────

describe('normalizeOpenRouterModel', () => {
  const base: OpenRouterModelData = {
    id: 'deepseek/deepseek-chat',
    canonical_slug: 'deepseek/deepseek-chat-v3',
    name: 'DeepSeek: DeepSeek V3',
    context_length: 163840,
    pricing: { prompt: '0.0000002574', completion: '0.0000010287' },
    top_provider: { context_length: 128000, max_completion_tokens: 16000 },
    per_request_limits: null,
  };

  it('resolves context conservatively (min of reported bounds), clamps output', () => {
    const info = normalizeOpenRouterModel(base, 'deepseek/deepseek-chat');
    expect(info.runtimeLimits).toEqual({ contextWindow: 128000, maxOutputTokens: 16000 });
  });

  it('prefers per_request_limits when present (defensive; null in practice)', () => {
    const info = normalizeOpenRouterModel(
      { ...base, per_request_limits: { context_tokens: 4000, completion_tokens: 3000 } },
      'x',
    );
    expect(info.runtimeLimits).toEqual({ contextWindow: 4000, maxOutputTokens: 3000 });
  });

  it('falls back to 10% of the context window (hard-capped) when no completion cap is reported', () => {
    // No max_completion_tokens anywhere — the common catalog case.
    const noCap = normalizeOpenRouterModel(
      { ...base, top_provider: { context_length: 128000 } },
      'x',
    );
    // floor(128000 × 0.1) = 12800 < cap 81920.
    expect(noCap.runtimeLimits).toEqual({ contextWindow: 128000, maxOutputTokens: 12800 });

    // A huge window must still respect the 81920 hard cap (never the full window).
    const huge = normalizeOpenRouterModel(
      { id: 'big/ctx', context_length: 2000000, top_provider: { context_length: 2000000 } },
      'x',
    );
    // floor(2000000 × 0.1) = 200000 > cap 81920 → clamped to 81920.
    expect(huge.runtimeLimits).toEqual({ contextWindow: 2000000, maxOutputTokens: 81920 });
  });

  it('derives estimated per-1M USD rates from per-token pricing strings', () => {
    const info = normalizeOpenRouterModel(base, 'x');
    expect(info.cost).toEqual({
      input: 0.2574,
      output: 1.0287,
      cachedInput: undefined,
      currency: 'USD',
    });
  });

  it('treats -1 (unknown, dynamic routers) and malformed pricing as undefined', () => {
    const info = normalizeOpenRouterModel(
      { ...base, pricing: { prompt: '-1', completion: 'not-a-number', input_cache_read: '' } },
      'x',
    );
    expect(info.cost).toBeUndefined();
  });

  it('throws when no positive context bound is reported', () => {
    expect(() =>
      normalizeOpenRouterModel(
        { ...base, context_length: null, top_provider: { context_length: null } },
        'x',
      ),
    ).toThrow(/no positive context bound/);
  });

  it('derives toolCalling from supported_parameters and imageInput from modalities', () => {
    const info = normalizeOpenRouterModel(
      {
        ...base,
        supported_parameters: ['tools', 'temperature'],
        architecture: { input_modalities: ['text', 'image'] },
      },
      'x',
    );
    expect(info.capabilities).toEqual({ toolCalling: true, imageInput: true });
  });

  it('builds reasoning modes when supported, omits No Think when mandatory', () => {
    const optional = normalizeOpenRouterModel(
      { ...base, supported_parameters: ['reasoning_effort'], reasoning: { mandatory: false } },
      'x',
    );
    expect(optional.modelModes).toEqual({
      'Think (High)': { reasoning: { enabled: true, effort: 'high' } },
      'No Think': { reasoning: { enabled: false } },
    });
    expect(optional.defaultMode).toBe('Think (High)');

    const mandatory = normalizeOpenRouterModel(
      { ...base, supported_parameters: ['reasoning'], reasoning: { mandatory: true } },
      'x',
    );
    expect(mandatory.modelModes).toEqual({
      'Think (High)': { reasoning: { enabled: true, effort: 'high' } },
    });
    expect('No Think' in (mandatory.modelModes ?? {})).toBe(false);
  });

  it('builds the full effort ladder from supported_efforts (no hardcoded pair)', () => {
    const info = normalizeOpenRouterModel(
      {
        ...base,
        supported_parameters: ['reasoning_effort'],
        reasoning: {
          mandatory: false,
          default_effort: 'medium',
          default_enabled: true,
          supported_efforts: ['high', 'medium', 'low', 'minimal'],
        },
      },
      'x',
    );
    expect(info.modelModes).toEqual({
      'Think (High)': { reasoning: { enabled: true, effort: 'high' } },
      'Think (Medium)': { reasoning: { enabled: true, effort: 'medium' } },
      'Think (Low)': { reasoning: { enabled: true, effort: 'low' } },
      'Think (Minimal)': { reasoning: { enabled: true, effort: 'minimal' } },
      'No Think': { reasoning: { enabled: false } },
    });
    // Default mode honors the model's default_effort.
    expect(info.defaultMode).toBe('Think (Medium)');
  });

  it('defaults to No Think when reasoning is disabled by default', () => {
    const info = normalizeOpenRouterModel(
      {
        ...base,
        supported_parameters: ['reasoning_effort'],
        reasoning: { mandatory: false, default_enabled: false, supported_efforts: ['high'] },
      },
      'x',
    );
    expect(info.defaultMode).toBe('No Think');
  });

  it('uses a single Think mode for Anthropic-style max_tokens reasoning (no effort ladder)', () => {
    const info = normalizeOpenRouterModel(
      {
        ...base,
        supported_parameters: ['reasoning'],
        reasoning: { mandatory: false, supports_max_tokens: true, supported_efforts: ['high'] },
      },
      'x',
    );
    expect(info.modelModes).toEqual({
      'Think': { reasoning: { enabled: true } },
      'No Think': { reasoning: { enabled: false } },
    });
    expect(info.defaultMode).toBe('Think');
  });

  it('detects reasoning from the reasoning object even when the param is not listed', () => {
    // The reasoning object is authoritative evidence of support; don't require it
    // to be echoed in supported_parameters (API variance).
    const info = normalizeOpenRouterModel(
      {
        ...base,
        supported_parameters: ['tools'],
        reasoning: { mandatory: false, default_effort: 'low', supported_efforts: ['low'] },
      },
      'x',
    );
    expect(info.modelModes).toEqual({
      'Think (Low)': { reasoning: { enabled: true, effort: 'low' } },
      'No Think': { reasoning: { enabled: false } },
    });
    expect(info.defaultMode).toBe('Think (Low)');
  });

  it('does not dangle a No Think default when reasoning is mandatory + default is none', () => {
    // Contradictory-but-reachable metadata: reasoning is mandatory (no No Think
    // mode) yet the default_effort is 'none'. defaultMode must not reference a
    // mode that doesn't exist (regression: it used to point at 'No Think').
    const info = normalizeOpenRouterModel(
      {
        ...base,
        supported_parameters: ['reasoning_effort'],
        reasoning: { mandatory: true, default_effort: 'none', default_enabled: true, supported_efforts: ['high'] },
      },
      'x',
    );
    expect(info.modelModes).toEqual({
      'Think (High)': { reasoning: { enabled: true, effort: 'high' } },
    });
    expect('No Think' in (info.modelModes ?? {})).toBe(false);
    // Falls back to the only real mode instead of the nonexistent No Think.
    expect(info.defaultMode).toBe('Think (High)');
  });

  it('falls back to a single high effort when supported_efforts is empty or all-none', () => {
    // An empty or all-'none' ladder is contradictory metadata — treat like missing.
    for (const supported_efforts of [[], ['none']]) {
      const info = normalizeOpenRouterModel(
        {
          ...base,
          supported_parameters: ['reasoning_effort'],
          reasoning: { mandatory: false, supported_efforts },
        },
        'x',
      );
      expect(info.modelModes).toEqual({
        'Think (High)': { reasoning: { enabled: true, effort: 'high' } },
        'No Think': { reasoning: { enabled: false } },
      });
      expect(info.defaultMode).toBe('Think (High)');
    }
  });

  it('filters default_parameters to non-null supported values', () => {
    const info = normalizeOpenRouterModel(
      {
        ...base,
        supported_parameters: ['temperature', 'top_p'],
        default_parameters: { temperature: 0.7, top_p: null, bogus_param: 5 },
      },
      'x',
    );
    expect(info.defaultParams).toEqual({ temperature: 0.7 });
  });

  it('keeps the requested wire id verbatim (variant preserved)', () => {
    const info = normalizeOpenRouterModel(base, 'meta-llama/llama-3.3-70b-instruct:free');
    expect(info.wireModelId).toBe('meta-llama/llama-3.3-70b-instruct:free');
    expect(info.canonicalSlug).toBe('deepseek/deepseek-chat-v3');
  });
});

// ── fetchOpenRouterModel / resolveOpenRouterRuntimeLimits ─────────────────

describe('fetchOpenRouterModel / resolveOpenRouterRuntimeLimits', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  /** Catalog entries sharing the exact-model shape `OpenRouterModelData`. */
  const CATALOG = [
    {
      id: 'deepseek/deepseek-chat',
      name: 'DeepSeek V3',
      context_length: 163840,
      top_provider: { context_length: 128000, max_completion_tokens: 16000 },
      per_request_limits: null,
    },
    {
      id: 'deepseek/deepseek-chat:free',
      name: 'DeepSeek V3 (free)',
      context_length: 163840,
      pricing: { prompt: '0', completion: '0' },
      top_provider: { context_length: 128000, max_completion_tokens: 16000 },
      per_request_limits: null,
    },
    {
      id: 'openai/gpt-4',
      name: 'GPT-4',
      context_length: 8192,
      top_provider: { max_completion_tokens: 4096 },
      per_request_limits: null,
    },
    {
      id: 'cohere/north-mini-code:free',
      name: 'Cohere North Mini Code (free)',
      context_length: 256000,
      pricing: { prompt: '0', completion: '0' },
      top_provider: { context_length: 256000, max_completion_tokens: 64000 },
      per_request_limits: null,
    },
    {
      id: 'cohere/north-mini-code',
      name: 'Cohere North Mini Code (paid)',
      context_length: 256000,
      pricing: { prompt: '0.0000005', completion: '0.000002' },
      top_provider: { context_length: 256000, max_completion_tokens: 64000 },
      per_request_limits: null,
    },
  ];

  function catalogResponse(): Response {
    return new Response(JSON.stringify({ data: CATALOG }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  /** Fresh catalog response per call — Response bodies are single-use. */
  function mockCatalogFetch(): ReturnType<typeof vi.spyOn> {
    fetchSpy.mockImplementation(() => Promise.resolve(catalogResponse()));
    return fetchSpy;
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves metadata by EXACT catalog id match — a :free pick uses the FREE entry, never the paid one', async () => {
    mockCatalogFetch();

    const info = await fetchOpenRouterModel('cohere/north-mini-code:free');
    expect(fetchSpy).toHaveBeenCalledWith(
      `${OPENROUTER_API_BASE}/v1/models`,
      expect.objectContaining({ method: 'GET' }),
    );
    // Free entry has pricing "0" → cost estimated at $0; the paid model is NOT
    // consulted. wireModelId preserves the exact :free id for chat.
    expect(info.wireModelId).toBe('cohere/north-mini-code:free');
    expect(info.runtimeLimits).toEqual({ contextWindow: 256000, maxOutputTokens: 64000 });
    expect(info.cost?.input).toBe(0);
    expect(info.cost?.output).toBe(0);
  });

  it('resolves a variant-free id by exact catalog match', async () => {
    mockCatalogFetch();
    const info = await fetchOpenRouterModel('deepseek/deepseek-chat');
    expect(info.wireModelId).toBe('deepseek/deepseek-chat');
    expect(info.runtimeLimits).toEqual({ contextWindow: 128000, maxOutputTokens: 16000 });
  });

  it('resolves a :free id to the FREE catalog entry (distinct from the base)', async () => {
    mockCatalogFetch();
    const info = await fetchOpenRouterModel('deepseek/deepseek-chat:free');
    expect(info.wireModelId).toBe('deepseek/deepseek-chat:free');
    // Free entry → $0 estimated rates, proving it did NOT resolve to the paid base model.
    expect(info.cost?.input).toBe(0);
    expect(info.cost?.output).toBe(0);
  });

  it('classifies an id NOT in the catalog as OpenRouterModelNotFoundError (recheckable, not permanent)', async () => {
    mockCatalogFetch();
    // Absent from this snapshot → OpenRouterModelNotFoundError. The metrics
    // engine rechecks next poll (the catalog is re-fetched); it is NOT a
    // permanent miss and NOT a guessed/derived slug.
    await expect(fetchOpenRouterModel('bad/not-a-real-model')).rejects.toBeInstanceOf(OpenRouterModelNotFoundError);
    await expect(fetchOpenRouterModel('bad/not-a-real-model')).rejects.toThrow(/not found in the current OpenRouter catalog/);
    await expect(fetchOpenRouterModel('bad/not-a-real-model')).rejects.not.toBeInstanceOf(PermanentContextError);
  });

  it('classifies a catalog ENTRY with no context bound as PermanentContextError', async () => {
    // The model IS listed, but its entry reports no usable context → genuinely
    // unresolvable, never retried (unlike an absent id).
    const noWindow = [{ id: 'openai/gpt-4', name: 'GPT-4' }]; // no context_length / top_provider
    fetchSpy.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ data: noWindow }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ));
    await expect(fetchOpenRouterModel('openai/gpt-4')).rejects.toBeInstanceOf(PermanentContextError);
  });

  it('treats a malformed catalog payload (missing data array) as a transient failure, never an empty list', async () => {
    // A 200 whose body is not `{ data: [...] }` is a protocol/proxy failure. It
    // must THROW (→ the metrics engine treats it as transient/not-yet-resolved),
    // NOT be silently interpreted as an empty authoritative catalog (which
    // would make every model look "not found").
    fetchSpy.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ something: 'else' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ));
    await expect(fetchOpenRouterCatalog()).rejects.toThrow(/Malformed OpenRouter catalog/);
  });

  it('drops catalog entries without a string id (they can never match) but keeps valid ones', async () => {
    const mixed = [
      { id: 'openai/gpt-4', context_length: 8192 },
      { name: 'no-id-entry' },
      { id: 123 as unknown },
    ];
    fetchSpy.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ data: mixed }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ));
    const catalog = await fetchOpenRouterCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0].id).toBe('openai/gpt-4');
  });

  it('wraps a catalog fetch/HTTP failure with model + catalog URL context', async () => {
    // fetchWithRetry retries once on a network error, so reject BOTH attempts.
    fetchSpy.mockRejectedValue(new Error('Network error: ECONNREFUSED'));
    await expect(fetchOpenRouterModel('deepseek/deepseek-chat')).rejects.toThrow(
      /OpenRouter model "deepseek\/deepseek-chat" lookup failed.*v1\/models/,
    );
  });

  it('resolveOpenRouterRuntimeLimits returns only the limits', async () => {
    mockCatalogFetch();
    const limits = await resolveOpenRouterRuntimeLimits('openai/gpt-4');
    expect(limits).toEqual({ contextWindow: 8192, maxOutputTokens: 4096 });
  });
});

// ── fetchOpenRouterModelEndpoints ─────────────────────────────────────────

describe('fetchOpenRouterModelEndpoints', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const endpointsResponse = () => new Response(
    JSON.stringify({
      data: {
        id: 'deepseek/deepseek-v4-pro-0813',
        endpoints: [
          { name: 'Together | deepseek/deepseek-v4-pro-20260813', provider_name: 'Together', tag: 'together', quantization: 'unknown', max_completion_tokens: null, status: 0, pricing: { prompt: '0.00000132', completion: '0.00000396', input_cache_read: '0.00000013' } },
          { name: 'GMICloud | deepseek/deepseek-v4-pro-20260813', provider_name: 'GMICloud', tag: 'gmicloud/fp8', quantization: 'fp8', max_completion_tokens: null, status: 0, pricing: { prompt: '0.000001188', completion: '0.000003564', input_cache_read: '0.0000000396' } },
        ],
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  it('fetches the provider list with the requested id verbatim and preserves tag/provider_name', async () => {
    fetchSpy.mockResolvedValue(endpointsResponse());

    const endpoints = await fetchOpenRouterModelEndpoints('deepseek/deepseek-v4-pro-0813');

    // The URL uses the exact model id (encoded) — no derivation.
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models/deepseek%2Fdeepseek-v4-pro-0813/endpoints',
      expect.objectContaining({ method: 'GET' }),
    );
    // tag is the routing slug, preserved verbatim; provider_name is the label.
    expect(endpoints).toEqual([
      expect.objectContaining({ tag: 'together', providerName: 'Together' }),
      expect.objectContaining({ tag: 'gmicloud/fp8', providerName: 'GMICloud', quantization: 'fp8' }),
    ]);
  });

  it('drops an endpoint without a tag (cannot be routed) and keeps pricing/caps/status when present', async () => {
    fetchSpy.mockResolvedValue(new Response(
      JSON.stringify({
        data: {
          endpoints: [
            { provider_name: 'NoSlug' }, // no tag → dropped
            { provider_name: 'Real', tag: 'real', max_completion_tokens: 65536, status: -2, pricing: { prompt: '0.0000005', completion: '0.000002' } },
          ],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const endpoints = await fetchOpenRouterModelEndpoints('m');
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toEqual({
      tag: 'real',
      providerName: 'Real',
      quantization: undefined,
      pricing: { prompt: '0.0000005', completion: '0.000002', input_cache_read: undefined },
      maxCompletionTokens: 65536,
      status: -2,
    });
  });

  it('passes a :free variant verbatim to resolve only that variant\'s providers', async () => {
    fetchSpy.mockResolvedValue(new Response(
      JSON.stringify({
        data: { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', endpoints: [{ provider_name: 'Nvidia', tag: 'nvidia' }] },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const endpoints = await fetchOpenRouterModelEndpoints('nvidia/nemotron-3-ultra-550b-a55b:free');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models/nvidia%2Fnemotron-3-ultra-550b-a55b%3Afree/endpoints',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(endpoints).toEqual([expect.objectContaining({ tag: 'nvidia', providerName: 'Nvidia' })]);
  });

  it('throws on a malformed payload (missing data.endpoints)', async () => {
    fetchSpy.mockResolvedValue(new Response(
      JSON.stringify({ data: { id: 'm' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await expect(fetchOpenRouterModelEndpoints('m')).rejects.toThrow(/Malformed OpenRouter endpoints/);
  });

  it('wraps an HTTP failure with the endpoint URL', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error: ECONNREFUSED'));
    await expect(fetchOpenRouterModelEndpoints('m')).rejects.toThrow(/v1\/models\/m\/endpoints/);
  });
});

// ── autoConfigureOpenRouterModel ──────────────────────────────────────────

describe('autoConfigureOpenRouterModel', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  /** Full catalog fixture for auto-configure tests. */
  const CATALOG = [
    {
      id: 'x-ai/grok-4.6',
      name: 'Grok 4.6',
      context_length: 500000,
      top_provider: { context_length: 500000, max_completion_tokens: null },
      per_request_limits: null,
      supported_parameters: ['tools', 'reasoning', 'reasoning_effort'],
      architecture: { input_modalities: ['text'] },
      reasoning: {
        mandatory: true,
        default_enabled: true,
        supported_efforts: ['xhigh', 'high', 'medium', 'low'],
        default_effort: 'high',
      },
      pricing: { prompt: '0.000003', completion: '0.000015' },
    },
    {
      id: 'meta-llama/llama-3.3-70b-instruct',
      context_length: 131072,
      top_provider: { context_length: 131072 },
    },
    {
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      context_length: 131072,
      top_provider: { context_length: 131072 },
    },
  ];

  const catalogResponse = () => jsonResponse(200, { data: CATALOG });

  it('builds config + summary from the reasoning object (grok-like mandatory ladder)', async () => {
    fetchSpy.mockResolvedValue(catalogResponse());

    const { modelConfig, summary } = await autoConfigureOpenRouterModel('x-ai/grok-4.6');

    // Thinking modes from the effort ladder; mandatory reasoning → NO "No Think".
    expect(modelConfig.modelModes).toEqual({
      'Think (Xhigh)': { reasoning: { enabled: true, effort: 'xhigh' } },
      'Think (High)': { reasoning: { enabled: true, effort: 'high' } },
      'Think (Medium)': { reasoning: { enabled: true, effort: 'medium' } },
      'Think (Low)': { reasoning: { enabled: true, effort: 'low' } },
    });
    expect(modelConfig.defaultMode).toBe('Think (High)');
    expect(modelConfig.capabilities).toEqual({ toolCalling: true, imageInput: false });
    // No API completion cap → 10% of the context window (floor), hard-capped at 81920.
    // floor(500000 × 0.1) = 50000 < 81920 → 50000.
    expect(modelConfig.maxOutputTokens).toBe(50000);
    expect(modelConfig.cost).toEqual({ input: 3, output: 15, currency: 'USD' });
    const text = summary.join('\n');
    // Format via the same toLocaleString the code uses so the assertion is
    // locale-independent (the thousands separator varies across runtimes).
    expect(text).toContain(`Context window (OpenRouter): ${(500000).toLocaleString()} tokens`);
    expect(text).toContain('Modes: Think (Xhigh), Think (High), Think (Medium), Think (Low)');
    expect(text).toContain('Default mode: Think (High)');
    // No HuggingFace attribution in the OpenRouter summary.
    expect(text).not.toContain('HuggingFace');
  });

  it('preserves variant chat ids; catalog lookup is public (no per-model headers)', async () => {
    fetchSpy.mockResolvedValue(catalogResponse());

    const { modelConfig } = await autoConfigureOpenRouterModel('meta-llama/llama-3.3-70b-instruct:free');

    // Catalog lookup by exact id; the chat id keeps the :free variant. The
    // catalog is public/unauthenticated, so no per-model headers are sent.
    expect(fetchSpy).toHaveBeenCalledWith(
      `${OPENROUTER_API_BASE}/v1/models`,
      expect.anything(),
    );
    expect(modelConfig.vllmModelId).toBe('meta-llama/llama-3.3-70b-instruct:free');
  });
});

// ── fetchOpenRouterAccount ────────────────────────────────────────────────

describe('fetchOpenRouterAccount', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const keyHeaders = { Authorization: 'Bearer sk-test' };

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the per-model auth header and returns the data object', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { label: 'k', limit_remaining: 3.5, usage: 100, is_free_tier: false } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    const account = await fetchOpenRouterAccount(keyHeaders);
    expect(fetchSpy).toHaveBeenCalledWith(
      `${OPENROUTER_API_BASE}/v1/key`,
      expect.objectContaining({ method: 'GET', headers: keyHeaders }),
    );
    expect(account).toEqual({ label: 'k', limit_remaining: 3.5, usage: 100, is_free_tier: false });
  });

  it('returns undefined on a non-OK response (bad key) — never fabricates', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await fetchOpenRouterAccount(keyHeaders)).toBeUndefined();
  });

  it('returns undefined when the payload has no usable data object', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    expect(await fetchOpenRouterAccount(keyHeaders)).toBeUndefined();
  });

  it('returns undefined on a network failure (probe is best-effort)', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await fetchOpenRouterAccount(keyHeaders)).toBeUndefined();
  });
});
