import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  detectServerType,
  detectServerTypeFromV1Models,
  resolveRuntimeLimits,
} from '../src/runtimeLimits.js';

/**
 * runtimeLimits.ts: per-backend runtime context-window resolution and server-type
 * detection. Nothing here reads user settings, so the only fixture is fetch.
 */

/** Build a Response-like object. Each call returns a fresh instance because
 *  a Response body can only be consumed once. */
function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Mock fetch implementation that always returns a fresh Response for the given status. */
function alwaysReturn(status: number, body: any = {}) {
  return () => Promise.resolve(jsonResponse(status, body));
}

describe('resolveRuntimeLimits — per-backend limits and retry', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries once then rejects on persistent 503', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(503, { error: 'unavailable' }) as any);
    await expect(resolveRuntimeLimits('vllm', 'http://test', {}, 'test-model')).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('succeeds on second attempt after 502', async () => {
    const calls: Array<Response> = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => {
        if (calls.length === 0) {
          calls.push(jsonResponse(502, { error: 'bad gateway' }));
          return Promise.resolve(calls[calls.length - 1]);
        }
        calls.push(jsonResponse(200, { data: [{ id: 'm1', object: 'model', owned_by: 'test', max_model_len: 4096 }] }));
        return Promise.resolve(calls[calls.length - 1]);
      }
    );
    const ctx = await resolveRuntimeLimits('vllm', 'http://test', {}, 'm1');
    expect(ctx.contextWindow).toBe(4096);
    expect(ctx.maxOutputTokens).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('vllm: reads max_model_len from /v1/models, exactly one call', async () => {
    const calls: Array<string> = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      const u = String(url);
      calls.push(u);
      return Promise.resolve(jsonResponse(200, {
        data: [{ id: 'test-model', object: 'model', owned_by: 'test', max_model_len: 4096 }],
      }));
    });
    const ctx = await resolveRuntimeLimits('vllm', 'http://test', {}, 'test-model');
    expect(ctx.contextWindow).toBe(4096);
    expect(ctx.maxOutputTokens).toBeUndefined();
    expect(calls).toEqual(['http://test/v1/models']);
  });

  it('vllm: throws (no fabrication) when max_model_len is missing or zero', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, {
      data: [{ id: 'test-model', object: 'model', owned_by: 'test' }],
    }) as any);
    await expect(resolveRuntimeLimits('vllm', 'http://test', {}, 'test-model'))
      .rejects.toThrow(/max_model_len/);
    // Error names backend + model + endpoint + field + correction.
    await expect(resolveRuntimeLimits('vllm', 'http://test', {}, 'test-model'))
      .rejects.toThrow(/vLLM model "test-model"/);
  });

  it('openrouter: resolves limits from the model catalog by EXACT id via the module', async () => {
    const calls: Array<string> = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      const u = String(url);
      calls.push(u);
      return Promise.resolve(jsonResponse(200, {
        data: [
          { id: 'deepseek/deepseek-chat', context_length: 163840, top_provider: { context_length: 128000, max_completion_tokens: 16000 }, per_request_limits: null },
        ],
      }));
    });
    const limits = await resolveRuntimeLimits('openrouter', 'ignored', {}, 'deepseek/deepseek-chat');
    expect(limits.contextWindow).toBe(128000);
    expect(limits.maxOutputTokens).toBe(16000);
    // The module owns the OpenRouter API base; `serverUrl` is ignored, and the
    // catalog (/v1/models) is the deterministic metadata source.
    expect(calls).toEqual(['https://openrouter.ai/api/v1/models']);
  });

  it('openrouter: resolves a :free id to the FREE catalog entry by exact match', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      return Promise.resolve(jsonResponse(200, {
        data: [
          { id: 'deepseek/deepseek-chat', context_length: 163840, pricing: { prompt: '0.000000274', completion: '0.0000010287' } },
          { id: 'deepseek/deepseek-chat:free', context_length: 8192, pricing: { prompt: '0', completion: '0' } },
        ],
      }));
    });
    const limits = await resolveRuntimeLimits('openrouter', 'ignored', {}, 'deepseek/deepseek-chat:free');
    expect(limits.contextWindow).toBe(8192); // the FREE entry's window, not the paid model's
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://openrouter.ai/api/v1/models');
  });

  it('lmstudio: reads the live loaded-instance context_length, else max_context_length', async () => {
    const calls: Array<string> = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      const u = String(url);
      calls.push(u);
      return Promise.resolve(jsonResponse(200, {
        models: [{
          key: 'lm-model',
          id: 'lm-model',
          max_context_length: 131072,
          loaded_instances: [{ config: { context_length: 65536 } }],
        }],
      }));
    });
    const ctx = await resolveRuntimeLimits('lmstudio', 'http://test', {}, 'lm-model');
    expect(ctx.contextWindow).toBe(65536); // live loaded-instance window preferred over configured
    expect(calls).toEqual(['http://test/api/v1/models']); // strict switch — no /v1/models probe
  });

  it('lmstudio: throws (no fabrication) when no context_length is reported', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, {
      models: [{ key: 'lm-model', id: 'lm-model' }],
    }) as any);
    await expect(resolveRuntimeLimits('lmstudio', 'http://test', {}, 'lm-model'))
      .rejects.toThrow(/LM Studio model "lm-model"/);
  });

  it('llamacpp: reads /props default_generation_settings.n_ctx with router-mode model param', async () => {
    const calls: Array<string> = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      const u = String(url);
      calls.push(u);
      return Promise.resolve(jsonResponse(200, {
        default_generation_settings: { n_ctx: 8192 },
      }));
    });
    const ctx = await resolveRuntimeLimits('llamacpp', 'http://test', {}, 'my model/name');
    expect(ctx.contextWindow).toBe(8192);
    expect(calls).toEqual(['http://test/props?model=my%20model%2Fname']);
  });

  it('llamacpp: passes auth headers to /props and throws a named error when n_ctx is missing', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, {}) as any);
    await expect(resolveRuntimeLimits('llamacpp', 'http://test', { Authorization: 'Bearer k' }, 'm'))
      .rejects.toThrow(/llama\.cpp model "m"/);
    const headers = (fetchSpy.mock.calls[0][1] as any).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer k');
  });

  it('ollama: reads /api/ps context_length for a loaded model', async () => {
    const calls: Array<string> = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      const u = String(url);
      calls.push(u);
      return Promise.resolve(jsonResponse(200, {
        models: [{ model: 'qwen', name: 'qwen:latest', context_length: 32768 }],
      }));
    });
    const ctx = await resolveRuntimeLimits('ollama', 'http://test', {}, 'qwen');
    expect(ctx.contextWindow).toBe(32768);
    expect(calls).toEqual(['http://test/api/ps']);
  });

  it('ollama: throws (no fabrication) when the model is not loaded', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, { models: [] }) as any);
    await expect(resolveRuntimeLimits('ollama', 'http://test', {}, 'qwen'))
      .rejects.toThrow(/Ollama model "qwen" is not loaded/);
  });

  it('retries once then rejects on persistent 429', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(429, {}) as any);
    await expect(resolveRuntimeLimits('vllm', 'http://test', {}, 'test-model')).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects on non-retryable 400', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(400, { error: 'bad' }) as any);
    await expect(resolveRuntimeLimits('vllm', 'http://test', {}, 'test-model')).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('retries once then rejects on persistent network error', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(resolveRuntimeLimits('vllm', 'http://test', {}, 'test-model')).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('succeeds on retry after initial network error', async () => {
    const calls: Array<Response> = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => {
        if (calls.length === 0) {
          calls.push(jsonResponse(500, {}));
          return Promise.reject(new TypeError('fetch failed'));
        }
        calls.push(jsonResponse(500, {}));
        return Promise.resolve(jsonResponse(200, { data: [{ id: 'm1', object: 'model', owned_by: 'test', max_model_len: 4096 }] }));
      }
    );
    const ctx = await resolveRuntimeLimits('vllm', 'http://test', {}, 'm1');
    expect(ctx.contextWindow).toBe(4096);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects on AbortError (timeout) without retry', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortErr);
    await expect(resolveRuntimeLimits('vllm', 'http://test', {}, 'test-model')).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('includes the model server requestHeaders in the request', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, { data: [{ id: 'test-model', object: 'model', owned_by: 'test', max_model_len: 4096 }] }) as any);
    await resolveRuntimeLimits('vllm', 'http://test', { 'X-Tenant-ID': 'abc123', 'X-Custom': 'hello' }, 'test-model');
    const headers = (fetchSpy.mock.calls[0][1] as any).headers as Record<string, string>;
    expect(headers['X-Tenant-ID']).toBe('abc123');
    expect(headers['X-Custom']).toBe('hello');
  });

  it('passes auth headers from requestHeaders through unchanged', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, { data: [{ id: 'test-model', object: 'model', owned_by: 'test', max_model_len: 4096 }] }) as any);
    await resolveRuntimeLimits('vllm', 'http://test', { 'Authorization': 'Basic my-override', 'X-API-Key': 'k' }, 'test-model');
    const headers = (fetchSpy.mock.calls[0][1] as any).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Basic my-override');
    expect(headers['X-API-Key']).toBe('k');
  });

  it('empty requestHeaders object does not add any headers', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, { data: [{ id: 'test-model', object: 'model', owned_by: 'test', max_model_len: 4096 }] }) as any);
    await resolveRuntimeLimits('vllm', 'http://test', {}, 'test-model');
    const headers = (fetchSpy.mock.calls[0][1] as any).headers as Record<string, string>;
    expect(Object.keys(headers).length).toBe(0);
  });
});

describe('detectServerType', () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('classifies vLLM from a matching max_model_len, first', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => Promise.resolve(jsonResponse({ data: [{ id: 'm', object: 'model', owned_by: 'org', max_model_len: 8192 }] }))
    );
    expect(await detectServerType('http://test', {}, 'm')).toBe('vllm');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // first signature hit — no further probes
  });

  it('classifies OpenRouter by host (API base) without probing local signatures', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [] }));
    expect(await detectServerType('https://openrouter.ai/api', {}, 'nvidia/nemotron-3.5-lightning:free')).toBe('openrouter');
    expect(fetchSpy).not.toHaveBeenCalled(); // host arm short-circuits — no probes
  });

  it('classifies OpenRouter by host (model-page URL) without probing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [] }));
    expect(await detectServerType('https://openrouter.ai/nvidia/nemotron-3.5-lightning:free', {}, 'nvidia/nemotron-3.5-lightning:free')).toBe('openrouter');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not treat a non-openrouter host as OpenRouter', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => Promise.resolve(jsonResponse({ data: [{ id: 'm', object: 'model', owned_by: 'mystery' }] }))
    );
    await expect(detectServerType('https://openrouter.example.com', {}, 'm')).rejects.toThrow(/Unsupported server/);
    expect(fetchSpy).toHaveBeenCalled(); // fell through to the probe path
  });

  it('classifies llama.cpp from owned_by "llamacpp"', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => Promise.resolve(jsonResponse({ data: [{ id: 'm', object: 'model', owned_by: 'llamacpp' }] }))
    );
    expect(await detectServerType('http://test', {}, 'm')).toBe('llamacpp');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('classifies LM Studio via /api/v1/models models[].key shape', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      if (String(url).includes('/api/v1/models')) {
        return Promise.resolve(jsonResponse({ models: [{ key: 'm', id: 'm' }] }));
      }
      return Promise.resolve(jsonResponse({ data: [{ id: 'm', object: 'model', owned_by: 'organization_owner' }] }));
    });
    expect(await detectServerType('http://test', {}, 'm')).toBe('lmstudio');
    const urls = fetchSpy.mock.calls.map((c: any) => String(c[0]));
    expect(urls).toEqual(['http://test/v1/models', 'http://test/api/v1/models']);
  });

  it('classifies Ollama via /api/ps {models:[...]} even when owned_by is a username (not "library")', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      if (String(url).includes('/api/ps')) {
        return Promise.resolve(jsonResponse({ models: [{ name: 'm', model: 'm:latest', context_length: 4096 }] }));
      }
      if (String(url).includes('/api/v1/models')) {
        return Promise.resolve(jsonResponse({ error: 'nope' }, 404));
      }
      return Promise.resolve(jsonResponse({ data: [{ id: 'm', object: 'model', owned_by: 'some-user' }] }));
    });
    expect(await detectServerType('http://test', {}, 'm')).toBe('ollama');
    const urls = fetchSpy.mock.calls.map((c: any) => String(c[0]));
    expect(urls).toEqual(['http://test/v1/models', 'http://test/api/v1/models', 'http://test/api/ps']);
  });

  it('continues on 404 for a probe endpoint instead of throwing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      if (String(url).includes('/api/ps')) {
        return Promise.resolve(jsonResponse({ models: [{ name: 'm' }] }));
      }
      return Promise.resolve(jsonResponse({ error: 'nope' }, 404));
    });
    expect(await detectServerType('http://test', {}, 'm')).toBe('ollama');
    const urls = fetchSpy.mock.calls.map((c: any) => String(c[0]));
    expect(urls).toEqual(['http://test/v1/models', 'http://test/api/v1/models', 'http://test/api/ps']);
  });

  it('rejects a 200-invalid-shape signature and keeps probing', async () => {
    // /api/v1/models returns 200 but NOT the LM Studio models[].key shape.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      if (String(url).includes('/api/ps')) {
        return Promise.resolve(jsonResponse({ models: [{ name: 'm' }] }));
      }
      if (String(url).includes('/api/v1/models')) {
        return Promise.resolve(jsonResponse({ data: [{ id: 'm' }] }));
      }
      return Promise.resolve(jsonResponse({ data: [{ id: 'm', object: 'model', owned_by: 'other' }] }));
    });
    expect(await detectServerType('http://test', {}, 'm')).toBe('ollama');
    const urls = fetchSpy.mock.calls.map((c: any) => String(c[0]));
    expect(urls).toEqual(['http://test/v1/models', 'http://test/api/v1/models', 'http://test/api/ps']);
  });

  it('treats a 200 non-JSON probe body as invalid-signature and keeps probing', async () => {
    // /api/v1/models returns 200 with HTML — invalid signature, NOT an error.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      if (String(url).includes('/api/ps')) {
        return Promise.resolve(jsonResponse({ models: [{ name: 'm' }] }));
      }
      return Promise.resolve(new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    });
    expect(await detectServerType('http://test', {}, 'm')).toBe('ollama');
    const urls = fetchSpy.mock.calls.map((c: any) => String(c[0]));
    expect(urls).toEqual(['http://test/v1/models', 'http://test/api/v1/models', 'http://test/api/ps']);
  });

  it('throws "unsupported server" naming every expected signature when nothing matches', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => Promise.resolve(jsonResponse({ data: [{ id: 'm', object: 'model', owned_by: 'mystery' }] }))
    );
    await expect(detectServerType('http://test', {}, 'm')).rejects.toThrow(/Unsupported server/);
    await expect(detectServerType('http://test', {}, 'm')).rejects.toThrow(/vLLM/);
    await expect(detectServerType('http://test', {}, 'm')).rejects.toThrow(/LM Studio/);
    await expect(detectServerType('http://test', {}, 'm')).rejects.toThrow(/Ollama/);
  });

  it('throws immediately on auth failure (never treats it as "not this signature")', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } }))
    );
    await expect(detectServerType('http://test', {}, 'm')).rejects.toThrow(/HTTP 403/);
  });
});

describe('detectServerTypeFromV1Models', () => {
  it('returns vllm when any entry has a positive max_model_len', () => {
    expect(detectServerTypeFromV1Models([{ owned_by: 'llamacpp' }, { owned_by: 'vllm', max_model_len: 262144 }])).toBe('vllm');
  });

  it('returns llamacpp when entries have owned_by llamacpp and no positive max_model_len', () => {
    expect(detectServerTypeFromV1Models([{ owned_by: 'llamacpp' }, { owned_by: 'llamacpp' }])).toBe('llamacpp');
  });

  it('returns undefined when there is no documented /v1/models signal', () => {
    expect(detectServerTypeFromV1Models([{ owned_by: 'mystery' }, { owned_by: 'unknown' }])).toBeUndefined();
    expect(detectServerTypeFromV1Models([])).toBeUndefined();
  });

  it('does not treat a zero max_model_len as a vLLM signal', () => {
    expect(detectServerTypeFromV1Models([{ owned_by: 'llamacpp', max_model_len: 0 }])).toBe('llamacpp');
  });
});
