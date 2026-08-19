import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseOpenRouterModelRef,
  parseOpenRouterBranchInput,
  normalizeOpenRouterModel,
  fetchOpenRouterModel,
  resolveOpenRouterRuntimeLimits,
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
