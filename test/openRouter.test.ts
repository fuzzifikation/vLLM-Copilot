import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchOpenRouterCatalog,
  normalizeOpenRouterFromCatalog,
  resolveOpenRouterRuntimeLimits,
  PermanentContextError,
  OpenRouterModelNotFoundError,
  OPENROUTER_API_BASE,
  resetOpenRouterCaches,
  type OpenRouterModelData,
  type OpenRouterModelInfo,
} from '../src/backends/openRouter.js';

/**
 * `parseOpenRouterModelRef`, `normalizeOpenRouterModel` and
 * `fetchOpenRouterModel` are module-private (U9 demotion). Each section below
 * drives its subject through the surviving public surface: refs through
 * `normalizeOpenRouterFromCatalog` (which parses first and carries the parsed
 * id into `wireModelId`), the normalizer through the same wrapper, and the
 * fetch flow through `fetchOpenRouterCatalog` + the wrapper - byte-for-byte
 * the composition production uses.
 */
/** Normalizer driver: the entry carries the requested id (the catalog's exact-match rule), so legacy `'x'` placeholder ids fall back to the entry's own id. */
const normalizeModelViaCatalog = (data: OpenRouterModelData, requestedId: string): OpenRouterModelInfo => {
  const id = requestedId.includes('/') ? requestedId : (data.id ?? requestedId);
  return normalizeOpenRouterFromCatalog([{ ...data, id }], id);
};

describe('parseOpenRouterModelRef', () => {
  // Ref parsing observed through the wrapper: success surfaces as the parsed
  // id on wireModelId, rejection surfaces as the parse error message.
  const PARSE_CATALOG: OpenRouterModelData[] = [
    'deepseek/deepseek-chat',
    'meta-llama/llama-3.3-70b-instruct:free',
    '~deepseek/family-latest',
  ].map((id) => ({ id, context_length: 10000 }) as OpenRouterModelData);
  const parse = (input: string): { requestedId?: string; error?: string } => {
    try {
      return { requestedId: normalizeOpenRouterFromCatalog(PARSE_CATALOG, input).wireModelId };
    } catch (err) {
      return { error: (err as Error).message };
    }
  };

  it('parses a plain author/slug and preserves it as the requested id', () => {
    const r = parse('deepseek/deepseek-chat');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat' });
  });

  it('strips a variant suffix for the LOOKUP but preserves the full id for CHAT', () => {
    const r = parse('meta-llama/llama-3.3-70b-instruct:free');
    expect(r).toEqual({ requestedId: 'meta-llama/llama-3.3-70b-instruct:free' });
  });

  it('parses a ~family-latest alias: strips ~ for lookup, keeps it for chat', () => {
    const r = parse('~deepseek/family-latest');
    expect(r).toEqual({ requestedId: '~deepseek/family-latest' });
  });

  it('parses a model-page URL, ignoring query, fragment, and trailing slash', () => {
    const r = parse('https://openrouter.ai/deepseek/deepseek-chat?x=1#frag/');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat' });
  });

  it('accepts the www subdomain', () => {
    const r = parse('https://www.openrouter.ai/deepseek/deepseek-chat');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat' });
  });

  it('rejects unrelated hosts', () => {
    const r = parse('https://evil.com/deepseek/deepseek-chat');
    expect(r).toEqual({ error: expect.stringContaining('openrouter.ai') });
  });

  it('rejects reserved paths (catalog, docs, settings)', () => {
    expect(parse('https://openrouter.ai/models')).toMatchObject({ error: expect.any(String) });
    expect(parse('https://openrouter.ai/docs/api')).toMatchObject({ error: expect.any(String) });
  });

  it('rejects malformed values: empty, no slash, too many segments', () => {
    expect(parse('')).toMatchObject({ error: expect.any(String) });
    expect(parse('deepseek')).toMatchObject({ error: expect.any(String) });
    expect(parse('a/b/c')).toMatchObject({ error: expect.any(String) });
  });

  it('trims trailing slashes in the bare form so the chat id is clean', () => {
    const r = parse('deepseek/deepseek-chat/');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat' });
  });

  it('trims leading slashes in the bare form (pasted /author/model)', () => {
    const r = parse('/deepseek/deepseek-chat');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat' });
  });

  it('preserves the ~ alias prefix in the chat id but strips it for the lookup', () => {
    const r = parse('~deepseek/family-latest/');
    expect(r).toEqual({ requestedId: '~deepseek/family-latest' });
  });

  it('collapses internal double slashes so the chat id is clean', () => {
    const r = parse('deepseek//deepseek-chat');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat' });
  });

  it('trims spaces around the slash in the bare form (pasted "author / model")', () => {
    const r = parse('deepseek / deepseek-chat');
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
    const info = normalizeModelViaCatalog(base, 'deepseek/deepseek-chat');
    expect(info.runtimeLimits).toEqual({ contextWindow: 128000, maxOutputTokens: 16000 });
  });

  it('prefers per_request_limits when present (defensive; null in practice)', () => {
    const info = normalizeModelViaCatalog(
      { ...base, per_request_limits: { context_tokens: 4000, completion_tokens: 3000 } },
      'x',
    );
    expect(info.runtimeLimits).toEqual({ contextWindow: 4000, maxOutputTokens: 3000 });
  });

  it('falls back to 10% of the context window (hard-capped) when no completion cap is reported', () => {
    // No max_completion_tokens anywhere — the common catalog case.
    const noCap = normalizeModelViaCatalog(
      { ...base, top_provider: { context_length: 128000 } },
      'x',
    );
    // floor(128000 × 0.1) = 12800 < cap 81920.
    expect(noCap.runtimeLimits).toEqual({ contextWindow: 128000, maxOutputTokens: 12800 });

    // A huge window must still respect the 81920 hard cap (never the full window).
    const huge = normalizeModelViaCatalog(
      { id: 'big/ctx', context_length: 2000000, top_provider: { context_length: 2000000 } },
      'x',
    );
    // floor(2000000 × 0.1) = 200000 > cap 81920 → clamped to 81920.
    expect(huge.runtimeLimits).toEqual({ contextWindow: 2000000, maxOutputTokens: 81920 });
  });

  it('does NOT trust a completion cap at/near the window — falls back to the safe budget (regression: full-window output budget)', () => {
    // Live catalog: ~12% of models report max_completion_tokens >= the window
    // (e.g. dots-studio/dots-3-note-preview:free, z-ai/glm-5.2:free). Trusting
    // that cap set the output budget to the FULL window, which 400s on the first
    // real request (prompt + output > context) — the exact failure the 10%
    // fallback exists to prevent, resurrected through the reported-cap path.
    const atWindow = normalizeModelViaCatalog(
      { id: 'risky/at-window', context_length: 512000, top_provider: { context_length: 512000, max_completion_tokens: 512000 } },
      'x',
    );
    // floor(512000 × 0.1) = 51200 (below the 81920 cap) — never 512000.
    expect(atWindow.runtimeLimits).toEqual({ contextWindow: 512000, maxOutputTokens: 51200 });

    // Near-window cap (95%) is equally degenerate — no input headroom.
    const nearWindow = normalizeModelViaCatalog(
      { id: 'risky/near-window', context_length: 512000, top_provider: { context_length: 512000, max_completion_tokens: 486400 } },
      'x',
    );
    expect(nearWindow.runtimeLimits).toEqual({ contextWindow: 512000, maxOutputTokens: 51200 });
  });

  it('preserves a reported cap that leaves real input headroom (never over-restricted)', () => {
    // A cap well below the window (e.g. 384k on a 1M window — deepseek-v4-pro)
    // leaves genuine room for the prompt and is a real model capability: keep it.
    const headroom = normalizeModelViaCatalog(
      { id: 'deepseek/deepseek-v4-pro-0813', context_length: 1048576, top_provider: { context_length: 1048576, max_completion_tokens: 384000 } },
      'x',
    );
    expect(headroom.runtimeLimits).toEqual({ contextWindow: 1048576, maxOutputTokens: 384000 });
  });

  it('derives estimated per-1M USD rates from per-token pricing strings', () => {
    const info = normalizeModelViaCatalog(base, 'x');
    expect(info.cost).toEqual({
      input: 0.2574,
      output: 1.0287,
      cachedInput: undefined,
      currency: 'USD',
    });
  });

  it('treats -1 (unknown, dynamic routers) and malformed pricing as undefined', () => {
    const info = normalizeModelViaCatalog(
      { ...base, pricing: { prompt: '-1', completion: 'not-a-number', input_cache_read: '' } },
      'x',
    );
    expect(info.cost).toBeUndefined();
  });

  it('throws when no positive context bound is reported', () => {
    expect(() =>
      normalizeModelViaCatalog(
        { ...base, context_length: null, top_provider: { context_length: null } },
        'x',
      ),
    ).toThrow(/no positive context bound/);
  });

  it('derives toolCalling from supported_parameters and imageInput from modalities', () => {
    const info = normalizeModelViaCatalog(
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
    const optional = normalizeModelViaCatalog(
      { ...base, supported_parameters: ['reasoning_effort'], reasoning: { mandatory: false } },
      'x',
    );
    expect(optional.modelModes).toEqual({
      'Think (High)': { reasoning: { enabled: true, effort: 'high' } },
      'No Think': { reasoning: { enabled: false } },
    });
    expect(optional.defaultMode).toBe('Think (High)');

    const mandatory = normalizeModelViaCatalog(
      { ...base, supported_parameters: ['reasoning'], reasoning: { mandatory: true } },
      'x',
    );
    expect(mandatory.modelModes).toEqual({
      'Think (High)': { reasoning: { enabled: true, effort: 'high' } },
    });
    expect('No Think' in (mandatory.modelModes ?? {})).toBe(false);
  });

  it('builds the full effort ladder from supported_efforts (no hardcoded pair)', () => {
    const info = normalizeModelViaCatalog(
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
    const info = normalizeModelViaCatalog(
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
    const info = normalizeModelViaCatalog(
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
    const info = normalizeModelViaCatalog(
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
    const info = normalizeModelViaCatalog(
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
      const info = normalizeModelViaCatalog(
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
    const info = normalizeModelViaCatalog(
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
    const info = normalizeModelViaCatalog(base, 'meta-llama/llama-3.3-70b-instruct:free');
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

  /** Catalog + exact-match normalize — the same composition production runs. */
  const resolveInfo = async (requestedId: string): Promise<OpenRouterModelInfo> =>
    normalizeOpenRouterFromCatalog(await fetchOpenRouterCatalog(), requestedId);

  /** Fresh catalog response per call — Response bodies are single-use. */
  function mockCatalogFetch(): ReturnType<typeof vi.spyOn> {
    fetchSpy.mockImplementation(() => Promise.resolve(catalogResponse()));
    return fetchSpy;
  }

  beforeEach(() => {
    // The catalog memo (and provider-list caches) must not leak across tests:
    // every test stubs its own catalog response and expects a real fetch.
    resetOpenRouterCaches();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves metadata by EXACT catalog id match — a :free pick uses the FREE entry, never the paid one', async () => {
    mockCatalogFetch();

    const info = await resolveInfo('cohere/north-mini-code:free');
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
    const info = await resolveInfo('deepseek/deepseek-chat');
    expect(info.wireModelId).toBe('deepseek/deepseek-chat');
    expect(info.runtimeLimits).toEqual({ contextWindow: 128000, maxOutputTokens: 16000 });
  });

  it('resolves a :free id to the FREE catalog entry (distinct from the base)', async () => {
    mockCatalogFetch();
    const info = await resolveInfo('deepseek/deepseek-chat:free');
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
    await expect(resolveInfo('bad/not-a-real-model')).rejects.toBeInstanceOf(OpenRouterModelNotFoundError);
    await expect(resolveInfo('bad/not-a-real-model')).rejects.toThrow(/not found in the current OpenRouter catalog/);
    await expect(resolveInfo('bad/not-a-real-model')).rejects.not.toBeInstanceOf(PermanentContextError);
  });

  it('classifies a catalog ENTRY with no context bound as PermanentContextError', async () => {
    // The model IS listed, but its entry reports no usable context → genuinely
    // unresolvable, never retried (unlike an absent id).
    const noWindow = [{ id: 'openai/gpt-4', name: 'GPT-4' }]; // no context_length / top_provider
    fetchSpy.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ data: noWindow }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ));
    await expect(resolveInfo('openai/gpt-4')).rejects.toBeInstanceOf(PermanentContextError);
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
    // Driven through the production wrapper (resolveOpenRouterRuntimeLimits) so
    // the contextual error message is production's, not a test mirror's.
    fetchSpy.mockRejectedValue(new Error('Network error: ECONNREFUSED'));
    await expect(resolveOpenRouterRuntimeLimits('deepseek/deepseek-chat')).rejects.toThrow(
      /OpenRouter model "deepseek\/deepseek-chat" lookup failed.*v1\/models/,
    );
  });

  it('resolveOpenRouterRuntimeLimits returns only the limits', async () => {
    mockCatalogFetch();
    const limits = await resolveOpenRouterRuntimeLimits('openai/gpt-4');
    expect(limits).toEqual({ contextWindow: 8192, maxOutputTokens: 4096 });
  });

  it('the catalog memo collapses back-to-back fetches into ONE download (P16-1)', async () => {
    const spy = mockCatalogFetch();
    const [a, b] = await Promise.all([fetchOpenRouterCatalog(), fetchOpenRouterCatalog()]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a.map((m) => m.id)).toContain('openai/gpt-4');
  });

  it('a failed catalog is never memoized: the next call re-fetches live', async () => {
    const spy = mockCatalogFetch();
    spy.mockRejectedValueOnce(new Error('boom'));
    spy.mockRejectedValueOnce(new Error('boom')); // fetchWithRetry's second attempt
    await expect(fetchOpenRouterCatalog()).rejects.toThrow();
    spy.mockImplementation(() => Promise.resolve(catalogResponse()));
    await expect(fetchOpenRouterCatalog()).resolves.toHaveLength(5);
  });
});
