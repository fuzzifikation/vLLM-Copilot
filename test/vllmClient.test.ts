import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VllmClient, detectServerType, detectServerTypeFromV1Models } from '../src/vllmClient.js';
import * as configModule from '../src/config.js';

/** Build a minimal fake ExtensionContext / OutputChannel for the client. */
function makeContext(): any {
  return { secrets: { get: async () => undefined } };
}
function makeOutput(): any {
  return { appendLine: (s: string) => process.env.VLLM_TEST_TRACE && console.log(s) };
}

/**
 * Stub getConfig so VllmClient returns deterministic config.
 * apiKey is empty so we don't pollute Authorization assertions.
 */
function stubConfig(overrides: Partial<any> = {}) {
  vi.spyOn(configModule, 'getConfig').mockResolvedValue({
    serverUrl: 'http://test',
    apiKey: '',
    models: [],
    temperature: 0,
    topP: 1,
    topK: -1,
    minP: 0,
    repetitionPenalty: 1,
    maxOutputTokens: 100,
    presencePenalty: 0,
    frequencyPenalty: 0,
    seed: -1,
    stopSequences: [],
    minOutputTokens: 0,
    requestHeaders: {},
    enableFileLogging: false,
    estimateCharsPerToken: 3.5,
    badWords: [],
    ignoreEos: false,
    repetitionDetection: null,
    structuredOutput: null,
    ...overrides,
  } as any);
}

/** Build a Response-like object. Each call returns a fresh instance because
 *  a Response body can only be consumed once. */
function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Mock fetch implementation that always returns a fresh Response for the given status. */
function alwaysReturn(status: number, body: any = {}) {
  return () => Promise.resolve(jsonResponse(status, body));
}

describe('VllmClient retry logic (via getModelContextWindow)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stubConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries once then rejects on persistent 503', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(503, { error: 'unavailable' }) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    await expect(client.getModelContextWindow('vllm', 'http://test', {}, 'test-model')).rejects.toThrow();
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
    const client = new VllmClient(makeContext(), makeOutput());
    const ctx = await client.getModelContextWindow('vllm', 'http://test', {}, 'm1');
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
    const client = new VllmClient(makeContext(), makeOutput());
    const ctx = await client.getModelContextWindow('vllm', 'http://test', {}, 'test-model');
    expect(ctx.contextWindow).toBe(4096);
    expect(ctx.maxOutputTokens).toBeUndefined();
    expect(calls).toEqual(['http://test/v1/models']);
  });

  it('vllm: throws (no fabrication) when max_model_len is missing or zero', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, {
      data: [{ id: 'test-model', object: 'model', owned_by: 'test' }],
    }) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    await expect(client.getModelContextWindow('vllm', 'http://test', {}, 'test-model'))
      .rejects.toThrow(/max_model_len/);
    // Error names backend + model + endpoint + field + correction.
    await expect(client.getModelContextWindow('vllm', 'http://test', {}, 'test-model'))
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
    const client = new VllmClient(makeContext(), makeOutput());
    const limits = await client.getModelContextWindow('openrouter', 'ignored', {}, 'deepseek/deepseek-chat');
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
    const client = new VllmClient(makeContext(), makeOutput());
    const limits = await client.getModelContextWindow('openrouter', 'ignored', {}, 'deepseek/deepseek-chat:free');
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
    const client = new VllmClient(makeContext(), makeOutput());
    const ctx = await client.getModelContextWindow('lmstudio', 'http://test', {}, 'lm-model');
    expect(ctx.contextWindow).toBe(65536); // live loaded-instance window preferred over configured
    expect(calls).toEqual(['http://test/api/v1/models']); // strict switch — no /v1/models probe
  });

  it('lmstudio: throws (no fabrication) when no context_length is reported', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, {
      models: [{ key: 'lm-model', id: 'lm-model' }],
    }) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    await expect(client.getModelContextWindow('lmstudio', 'http://test', {}, 'lm-model'))
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
    const client = new VllmClient(makeContext(), makeOutput());
    const ctx = await client.getModelContextWindow('llamacpp', 'http://test', {}, 'my model/name');
    expect(ctx.contextWindow).toBe(8192);
    expect(calls).toEqual(['http://test/props?model=my%20model%2Fname']);
  });

  it('llamacpp: passes auth headers to /props and throws a named error when n_ctx is missing', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, {}) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    await expect(client.getModelContextWindow('llamacpp', 'http://test', { Authorization: 'Bearer k' }, 'm'))
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
    const client = new VllmClient(makeContext(), makeOutput());
    const ctx = await client.getModelContextWindow('ollama', 'http://test', {}, 'qwen');
    expect(ctx.contextWindow).toBe(32768);
    expect(calls).toEqual(['http://test/api/ps']);
  });

  it('ollama: throws (no fabrication) when the model is not loaded', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, { models: [] }) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    await expect(client.getModelContextWindow('ollama', 'http://test', {}, 'qwen'))
      .rejects.toThrow(/Ollama model "qwen" is not loaded/);
  });

  it('retries once then rejects on persistent 429', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(429, {}) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    await expect(client.getModelContextWindow('vllm', 'http://test', {}, 'test-model')).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects on non-retryable 400', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(400, { error: 'bad' }) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    await expect(client.getModelContextWindow('vllm', 'http://test', {}, 'test-model')).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('retries once then rejects on persistent network error', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const client = new VllmClient(makeContext(), makeOutput());
    await expect(client.getModelContextWindow('vllm', 'http://test', {}, 'test-model')).rejects.toThrow();
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
    const client = new VllmClient(makeContext(), makeOutput());
    const ctx = await client.getModelContextWindow('vllm', 'http://test', {}, 'm1');
    expect(ctx.contextWindow).toBe(4096);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects on AbortError (timeout) without retry', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortErr);
    const client = new VllmClient(makeContext(), makeOutput());
    await expect(client.getModelContextWindow('vllm', 'http://test', {}, 'test-model')).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('includes the model server requestHeaders in the request', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, { data: [{ id: 'test-model', object: 'model', owned_by: 'test', max_model_len: 4096 }] }) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    await client.getModelContextWindow('vllm', 'http://test', { 'X-Tenant-ID': 'abc123', 'X-Custom': 'hello' }, 'test-model');
    const headers = (fetchSpy.mock.calls[0][1] as any).headers as Record<string, string>;
    expect(headers['X-Tenant-ID']).toBe('abc123');
    expect(headers['X-Custom']).toBe('hello');
  });

  it('passes auth headers from requestHeaders through unchanged', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, { data: [{ id: 'test-model', object: 'model', owned_by: 'test', max_model_len: 4096 }] }) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    await client.getModelContextWindow('vllm', 'http://test', { 'Authorization': 'Basic my-override', 'X-API-Key': 'k' }, 'test-model');
    const headers = (fetchSpy.mock.calls[0][1] as any).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Basic my-override');
    expect(headers['X-API-Key']).toBe('k');
  });

  it('empty requestHeaders object does not add any headers', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, { data: [{ id: 'test-model', object: 'model', owned_by: 'test', max_model_len: 4096 }] }) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    await client.getModelContextWindow('vllm', 'http://test', {}, 'test-model');
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

describe('chatCompletionStream backend adaptation (via buildChatBody)', () => {
  const sseResponse = () =>
    new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function streamResult(fetchSpy: ReturnType<typeof vi.fn>) {
    const url = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][0];
    const init = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][1] as any;
    return JSON.parse(init.body) as Record<string, any>;
  }

  it('vllm: preserves continue_final_message/add_generation_prompt and tool_choice (byte-identical)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => Promise.resolve(sseResponse())
    );
    const client = new VllmClient(makeContext(), makeOutput());
    const options = { continue_final_message: true, add_generation_prompt: false, tool_choice: 'auto' as const, temperature: 0.7 };
    await client.chatCompletionStream('m', [], options as any, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any, { serverUrl: 'http://test', requestHeaders: {}, streamInactivityTimeout: 0, initialResponseTimeoutMs: 60000, serverType: 'vllm' }).next();
    const body = streamResult(fetchSpy);
    expect(body.continue_final_message).toBe(true);
    expect(body.add_generation_prompt).toBe(false);
    expect(body.tool_choice).toBe('auto');
    expect(body.temperature).toBe(0.7);
  });

  it('llamacpp: strips vLLM-only continuation controls but keeps the prefill message', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => Promise.resolve(sseResponse())
    );
    const client = new VllmClient(makeContext(), makeOutput());
    const options = { continue_final_message: true, add_generation_prompt: false };
    const messages = [{ role: 'user' as const, content: 'hi' }, { role: 'assistant' as const, content: 'prefill' }];
    await client.chatCompletionStream('m', messages as any, options as any, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any, { serverUrl: 'http://test', requestHeaders: {}, streamInactivityTimeout: 0, initialResponseTimeoutMs: 60000, serverType: 'llamacpp' }).next();
    const body = streamResult(fetchSpy);
    expect(body.continue_final_message).toBeUndefined();
    expect(body.add_generation_prompt).toBeUndefined();
    expect(body.messages).toContainEqual({ role: 'assistant', content: 'prefill' });
  });

  it('ollama: removes tool_choice with one [WARN] but keeps tools', async () => {
    const calls: string[] = [];
    const output = { appendLine: (s: string) => { calls.push(s); } };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => Promise.resolve(sseResponse())
    );
    const client = new VllmClient(makeContext(), output as any);
    const options = { tool_choice: 'required' as const, tools: [{ type: 'function' as const, function: { name: 'f' } }] };
    const serverConfig = { serverUrl: 'http://test', requestHeaders: {}, streamInactivityTimeout: 0, initialResponseTimeoutMs: 60000, serverType: 'ollama' } as const;
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any;
    // Two requests with tool_choice — the WARN fires exactly ONCE (per session),
    // not per request. The misleading "ONE [WARN]" comment once described a
    // per-request append; it is now actually once.
    await client.chatCompletionStream('m', [] as any, options as any, token, serverConfig).next();
    await client.chatCompletionStream('m', [] as any, options as any, token, serverConfig).next();
    const body = streamResult(fetchSpy);
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools).toHaveLength(1);
    const warns = calls.filter((s) => s.includes('[WARN]') && s.includes('tool_choice'));
    expect(warns).toHaveLength(1);
  });

  it('throws the backend-neutral mid-stream marker when the server returns a 200 JSON error body', async () => {
    // A 200 response with a JSON error object instead of an SSE stream — no HTTP
    // status to classify on, so formatError relies on this exact marker.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify({ error: { message: 'model is overloaded' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    );
    const client = new VllmClient(makeContext(), makeOutput());
    const gen = client.chatCompletionStream('m', [] as any, {} as any,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any,
      { serverUrl: 'http://test', requestHeaders: {}, streamInactivityTimeout: 0, initialResponseTimeoutMs: 60000, serverType: 'vllm' });
    await expect(gen.next()).rejects.toThrow('Server error (mid-stream): model is overloaded');
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe('chatCompletionStream initial request timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('aborts a POST whose server accepts the connection but never sends headers (no infinite hang)', async () => {
    vi.useFakeTimers();
    // A fetch that only settles when the caller's signal aborts — simulates a server
    // that accepts TCP/TLS but never returns response headers (the case that previously
    // hung forever: no deadline covers the initial POST).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          const onAbort = () => reject(Object.assign(new Error(String(signal.reason)), { name: 'AbortError' }));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        })
    );
    const client = new VllmClient(makeContext(), makeOutput());
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
    const gen = client.chatCompletionStream(
      'm', [], {} as any, token as any,
      { serverUrl: 'http://test', requestHeaders: {}, streamInactivityTimeout: 0, initialResponseTimeoutMs: 60000, serverType: 'vllm' },
    );
    const nextPromise = gen.next();
    // Attach the rejection handler BEFORE firing the timer — the generator rejects
    // during advanceTimersByTimeAsync's microtask flush, and a handler attached after
    // would leave the rejection unhandled for that turn (false-positive warning).
    const assertion = expect(nextPromise).rejects.toThrow(/timed out/i);

    // Fire the 60s initial-response budget → controller.abort → fetch rejects.
    await vi.advanceTimersByTimeAsync(60001);

    await assertion;
    // AbortError is not retried — a single attempt, then the hang is broken.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('honors a per-model initialResponseTimeoutMs (aborts at the configured time, message carries it)', async () => {
    vi.useFakeTimers();
    let abortReason: unknown;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          const onAbort = () => {
            abortReason = signal.reason;
            reject(Object.assign(new Error(String(signal.reason)), { name: 'AbortError' }));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        })
    );
    const client = new VllmClient(makeContext(), makeOutput());
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
    const gen = client.chatCompletionStream(
      'm', [], {} as any, token as any,
      { serverUrl: 'http://test', requestHeaders: {}, streamInactivityTimeout: 0, initialResponseTimeoutMs: 3000, serverType: 'vllm' },
    );
    const nextPromise = gen.next();
    const assertion = expect(nextPromise).rejects.toThrow(/3000ms/);

    // The configured 3s budget (NOT the 60s default) aborts the request, and the
    // abort reason carries the configured value so the user message is accurate.
    await vi.advanceTimersByTimeAsync(3001);
    await assertion;
    expect(abortReason).toContain('3000ms');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not arm an initial-response timer when initialResponseTimeoutMs is 0 (disabled)', async () => {
    vi.useFakeTimers();
    let abortReason: unknown;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          const onAbort = () => {
            abortReason = signal.reason;
            reject(Object.assign(new Error(String(signal.reason)), { name: 'AbortError' }));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        })
    );
    const client = new VllmClient(makeContext(), makeOutput());
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
    const gen = client.chatCompletionStream(
      'm', [], {} as any, token as any,
      { serverUrl: 'http://test', requestHeaders: {}, streamInactivityTimeout: 0, initialResponseTimeoutMs: 0, serverType: 'vllm' },
    );
    const nextPromise = gen.next(); // start the generator (fetch is invoked, request stays pending)
    // Wait well past the default 60s — with 0 the timer is never armed, so no abort.
    await vi.advanceTimersByTimeAsync(120000);
    expect(abortReason).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Nothing aborts the pending request — the generator's return promise would
    // also never settle (the underlying fetch never resolves), so do not await it.
    gen.return(undefined);
    void nextPromise.catch(() => {});
  });
});
