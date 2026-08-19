import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseOpenRouterModelRef,
  parseOpenRouterBranchInput,
  normalizeOpenRouterModel,
  fetchOpenRouterModel,
  fetchOpenRouterAccount,
  resolveOpenRouterRuntimeLimits,
  autoConfigureOpenRouterModel,
  PermanentContextError,
  OPENROUTER_API_BASE,
  type OpenRouterModelData,
} from '../src/openRouter.js';

// ── parseOpenRouterBranchInput ─────────────────────────────────────────────

describe('parseOpenRouterBranchInput', () => {
  it('passes a fully-qualified model-page URL straight through', () => {
    const r = parseOpenRouterBranchInput('https://openrouter.ai/nvidia/nemotron-3.5-lightning:free');
    expect(r).toEqual({
      requestedId: 'nvidia/nemotron-3.5-lightning:free',
      author: 'nvidia',
      slug: 'nemotron-3.5-lightning',
    });
  });

  it('treats a scheme-less openrouter.ai base as a base reference (error → catalog picker)', () => {
    // "openrouter.ai/api" must NOT parse as a bare slug (author "openrouter.ai").
    const r = parseOpenRouterBranchInput('openrouter.ai/api');
    expect('error' in r).toBe(true);
  });

  it('resolves a scheme-less openrouter.ai model-page URL as a URL, not a bare slug', () => {
    const r = parseOpenRouterBranchInput('openrouter.ai/nvidia/nemotron-3.5-lightning:free');
    expect(r).toEqual({
      requestedId: 'nvidia/nemotron-3.5-lightning:free',
      author: 'nvidia',
      slug: 'nemotron-3.5-lightning',
    });
  });

  it('leaves a bare author/slug on a non-openrouter host on the slug path', () => {
    const r = parseOpenRouterBranchInput('nvidia/nemotron-3.5-lightning:free');
    expect(r).toEqual({
      requestedId: 'nvidia/nemotron-3.5-lightning:free',
      author: 'nvidia',
      slug: 'nemotron-3.5-lightning',
    });
  });
});

// ── parseOpenRouterModelRef ────────────────────────────────────────────────

describe('parseOpenRouterModelRef', () => {
  it('parses a plain author/slug and preserves it as the requested id', () => {
    const r = parseOpenRouterModelRef('deepseek/deepseek-chat');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat', author: 'deepseek', slug: 'deepseek-chat' });
  });

  it('strips a variant suffix for the LOOKUP but preserves the full id for CHAT', () => {
    const r = parseOpenRouterModelRef('meta-llama/llama-3.3-70b-instruct:free');
    expect(r).toEqual({
      requestedId: 'meta-llama/llama-3.3-70b-instruct:free',
      author: 'meta-llama',
      slug: 'llama-3.3-70b-instruct',
    });
  });

  it('parses a ~family-latest alias: strips ~ for lookup, keeps it for chat', () => {
    const r = parseOpenRouterModelRef('~deepseek/family-latest');
    expect(r).toEqual({ requestedId: '~deepseek/family-latest', author: 'deepseek', slug: 'family-latest' });
  });

  it('parses a model-page URL, ignoring query, fragment, and trailing slash', () => {
    const r = parseOpenRouterModelRef('https://openrouter.ai/deepseek/deepseek-chat?x=1#frag/');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat', author: 'deepseek', slug: 'deepseek-chat' });
  });

  it('accepts the www subdomain', () => {
    const r = parseOpenRouterModelRef('https://www.openrouter.ai/deepseek/deepseek-chat');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat', author: 'deepseek', slug: 'deepseek-chat' });
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
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat', author: 'deepseek', slug: 'deepseek-chat' });
  });

  it('trims leading slashes in the bare form (pasted /author/model)', () => {
    const r = parseOpenRouterModelRef('/deepseek/deepseek-chat');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat', author: 'deepseek', slug: 'deepseek-chat' });
  });

  it('preserves the ~ alias prefix in the chat id but strips it for the lookup', () => {
    const r = parseOpenRouterModelRef('~deepseek/family-latest/');
    expect(r).toEqual({ requestedId: '~deepseek/family-latest', author: 'deepseek', slug: 'family-latest' });
  });

  it('collapses internal double slashes so the chat id is clean', () => {
    const r = parseOpenRouterModelRef('deepseek//deepseek-chat');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat', author: 'deepseek', slug: 'deepseek-chat' });
  });

  it('trims spaces around the slash in the bare form (pasted "author / model")', () => {
    const r = parseOpenRouterModelRef('deepseek / deepseek-chat');
    expect(r).toEqual({ requestedId: 'deepseek/deepseek-chat', author: 'deepseek', slug: 'deepseek-chat' });
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

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the exact-model endpoint with the base slug and unwraps data', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          id: 'deepseek/deepseek-chat',
          name: 'DeepSeek V3',
          context_length: 163840,
          top_provider: { context_length: 128000, max_completion_tokens: 16000 },
          per_request_limits: null,
        },
      }),
    );

    const info = await fetchOpenRouterModel('deepseek/deepseek-chat:free');
    expect(fetchSpy).toHaveBeenCalledWith(
      `${OPENROUTER_API_BASE}/v1/model/deepseek/deepseek-chat`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(info.runtimeLimits).toEqual({ contextWindow: 128000, maxOutputTokens: 16000 });
    expect(info.wireModelId).toBe('deepseek/deepseek-chat:free');
  });

  it('throws an actionable error when the payload has no data object', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: null }));
    await expect(fetchOpenRouterModel('deepseek/deepseek-chat')).rejects.toThrow(/no data payload/);
  });

  it('classifies a 404 as a PermanentContextError (wrong slug — never retryable)', async () => {
    fetchSpy.mockRejectedValue(new Error('HTTP 404: Not Found — {"error":{"message":"Model not found"}}'));
    await expect(fetchOpenRouterModel('bad/not-a-real-model')).rejects.toBeInstanceOf(PermanentContextError);
  });

  it('classifies a missing data payload as a PermanentContextError', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: null }));
    await expect(fetchOpenRouterModel('deepseek/deepseek-chat')).rejects.toBeInstanceOf(PermanentContextError);
  });

  it('wraps a fetch/HTTP failure with model + lookup URL context', async () => {
    // fetchWithRetry retries once on a network error, so reject BOTH attempts.
    fetchSpy.mockRejectedValue(new Error('HTTP 404: Not Found — {"error":{"message":"Model not found"}}'));
    await expect(fetchOpenRouterModel('deepseek/deepseek-chat')).rejects.toThrow(
      /OpenRouter model "deepseek\/deepseek-chat" lookup failed.*deepseek-chat.*Model not found/,
    );
  });

  it('resolveOpenRouterRuntimeLimits returns only the limits', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: { context_length: 8192, top_provider: { max_completion_tokens: 4096 } },
      }),
    );
    const limits = await resolveOpenRouterRuntimeLimits('openai/gpt-4');
    expect(limits).toEqual({ contextWindow: 8192, maxOutputTokens: 4096 });
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

  it('builds config + summary from the reasoning object (grok-like mandatory ladder)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
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
      }),
    );

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
    // Authoritative ceiling (no API max_completion_tokens → clamps to context).
    expect(modelConfig.maxOutputTokens).toBe(500000);
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

  it('passes per-model headers to the lookup and preserves variant chat ids', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          id: 'meta-llama/llama-3.3-70b-instruct',
          context_length: 131072,
          top_provider: { context_length: 131072 },
        },
      }),
    );
    const headers = { Authorization: 'Bearer sk-test' };

    const { modelConfig } = await autoConfigureOpenRouterModel('meta-llama/llama-3.3-70b-instruct:free', headers);

    // Lookup uses the base slug; the chat id keeps the variant.
    expect(fetchSpy).toHaveBeenCalledWith(
      `${OPENROUTER_API_BASE}/v1/model/meta-llama/llama-3.3-70b-instruct`,
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
