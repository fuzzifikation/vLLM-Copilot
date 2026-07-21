import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VllmClient } from '../src/vllmClient.js';
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

  it('retries once then returns undefined on persistent 503', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(503, { error: 'unavailable' }) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    const result = await client.getModelContextWindow('http://test', {}, 'test-model');
    expect(result).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('succeeds on second attempt after 502', async () => {
    const calls: Array<Response> = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => {
        if (calls.length === 0) {
          calls.push(jsonResponse(502, { error: 'bad gateway' }));
          return calls[calls.length - 1];
        }
        calls.push(jsonResponse(200, { data: [{ id: 'm1', object: 'model', owned_by: 'test', max_model_len: 4096 }] }));
        return calls[calls.length - 1];
      }
    ) as any;
    const client = new VllmClient(makeContext(), makeOutput());
    const ctx = await client.getModelContextWindow('http://test', {}, 'm1');
    expect(ctx).toBe(4096);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns undefined on 429 (not retryable)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(429, {}) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    const result = await client.getModelContextWindow('http://test', {}, 'test-model');
    expect(result).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns undefined on non-retryable 400', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(400, { error: 'bad' }) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    const result = await client.getModelContextWindow('http://test', {}, 'test-model');
    expect(result).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('retries once then returns undefined on persistent network error', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const client = new VllmClient(makeContext(), makeOutput());
    const result = await client.getModelContextWindow('http://test', {}, 'test-model');
    expect(result).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('succeeds on retry after initial network error', async () => {
    const calls: Array<Response> = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => {
        if (calls.length === 0) {
          calls.push(Promise.resolve());
          return Promise.reject(new TypeError('fetch failed'));
        }
        calls.push(Promise.resolve());
        return Promise.resolve(jsonResponse(200, { data: [{ id: 'm1', object: 'model', owned_by: 'test', max_model_len: 4096 }] }));
      }
    ) as any;
    const client = new VllmClient(makeContext(), makeOutput());
    const ctx = await client.getModelContextWindow('http://test', {}, 'm1');
    expect(ctx).toBe(4096);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns undefined on AbortError (timeout) without retry', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortErr);
    const client = new VllmClient(makeContext(), makeOutput());
    const result = await client.getModelContextWindow('http://test', {}, 'test-model');
    expect(result).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('includes the model server requestHeaders in the request', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, { data: [] }) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    await client.getModelContextWindow('http://test', { 'X-Tenant-ID': 'abc123', 'X-Custom': 'hello' }, 'test-model');
    const headers = (fetchSpy.mock.calls[0][1] as any).headers as Record<string, string>;
    expect(headers['X-Tenant-ID']).toBe('abc123');
    expect(headers['X-Custom']).toBe('hello');
  });

  it('passes auth headers from requestHeaders through unchanged', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, { data: [] }) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    await client.getModelContextWindow('http://test', { 'Authorization': 'Basic my-override', 'X-API-Key': 'k' }, 'test-model');
    const headers = (fetchSpy.mock.calls[0][1] as any).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Basic my-override');
    expect(headers['X-API-Key']).toBe('k');
  });

  it('empty requestHeaders object does not add any headers', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(alwaysReturn(200, { data: [] }) as any);
    const client = new VllmClient(makeContext(), makeOutput());
    await client.getModelContextWindow('http://test', {}, 'test-model');
    const headers = (fetchSpy.mock.calls[0][1] as any).headers as Record<string, string>;
    expect(Object.keys(headers).length).toBe(0);
  });
});
