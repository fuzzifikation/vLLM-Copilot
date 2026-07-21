import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VllmClient } from '../src/vllmClient.js';
import { resolveServerConfig } from '../src/config.js';
import * as configModule from '../src/config.js';

/** Build a minimal fake ExtensionContext / OutputChannel for the client. */
function makeContext(): any {
  return { secrets: { get: async () => undefined } };
}
function makeOutput(): any {
  return { appendLine: (s: string) => process.env.VLLM_TEST_TRACE && console.log(s) };
}

/**
 * Stub getConfig so VllmClient uses deterministic config.
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
    streamInactivityTimeout: 0,
    autoContinueRetries: 1,
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

// ── sanitizeRequestHeaders (via resolveServerConfig) ──────────────────────

describe('sanitizeRequestHeaders', () => {
  beforeEach(() => {
    vscode.workspace._mockConfig = { get: vi.fn() } as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Sanitization now happens per-model inside resolveServerConfig. Feed the raw
   * headers as a model's requestHeaders and read back the sanitized result.
   */
  function getConfigRequestHeaders(rawHeaders: Record<string, string>): Record<string, string> {
    const { requestHeaders } = resolveServerConfig({
      id: 'm',
      serverUrl: 'http://localhost:8000',
      requestHeaders: rawHeaders,
    });
    return requestHeaders;
  }

  it('allows valid custom headers', () => {
    const headers = getConfigRequestHeaders({ 'X-Tenant-ID': 'abc123', 'X-Custom': 'hello' });
    expect(headers['X-Tenant-ID']).toBe('abc123');
    expect(headers['X-Custom']).toBe('hello');
  });

  it('strips blocked header: host', () => {
    const headers = getConfigRequestHeaders({ 'host': 'evil.com' });
    expect(headers['host']).toBeUndefined();
  });

  it('strips blocked header: Host (case insensitive)', () => {
    const headers = getConfigRequestHeaders({ 'Host': 'evil.com' });
    expect(headers['Host']).toBeUndefined();
  });

  it('strips blocked header: cookie', () => {
    const headers = getConfigRequestHeaders({ 'cookie': 'session=abc' });
    expect(headers['cookie']).toBeUndefined();
  });

  it('strips blocked header: origin', () => {
    const headers = getConfigRequestHeaders({ 'origin': 'https://evil.com' });
    expect(headers['origin']).toBeUndefined();
  });

  it('strips blocked header: connection', () => {
    const headers = getConfigRequestHeaders({ 'connection': 'keep-alive' });
    expect(headers['connection']).toBeUndefined();
  });

  it('strips blocked header: content-length', () => {
    const headers = getConfigRequestHeaders({ 'content-length': '0' });
    expect(headers['content-length']).toBeUndefined();
  });

  it('strips blocked header: transfer-encoding', async () => {
    const headers = await getConfigRequestHeaders({ 'transfer-encoding': 'chunked' });
    expect(headers['transfer-encoding']).toBeUndefined();
  });

  it('strips blocked header: upgrade', async () => {
    const headers = await getConfigRequestHeaders({ 'upgrade': 'websocket' });
    expect(headers['upgrade']).toBeUndefined();
  });

  it('strips blocked header: te', async () => {
    const headers = await getConfigRequestHeaders({ 'te': 'trailers' });
    expect(headers['te']).toBeUndefined();
  });

  it('strips blocked header: trailer', async () => {
    const headers = await getConfigRequestHeaders({ 'trailer': 'Max-Forwards' });
    expect(headers['trailer']).toBeUndefined();
  });

  it('rejects header values with carriage return (CRLF injection)', async () => {
    const headers = await getConfigRequestHeaders({ 'X-Bad': 'value\r\nX-Injected: evil' });
    expect(headers['X-Bad']).toBeUndefined();
  });

  it('rejects header values with newline', async () => {
    const headers = await getConfigRequestHeaders({ 'X-Bad': 'value\nX-Injected: evil' });
    expect(headers['X-Bad']).toBeUndefined();
  });

  it('rejects header names with invalid characters', async () => {
    const headers = await getConfigRequestHeaders({ 'X Bad Header': 'value' });
    expect(headers['X Bad Header']).toBeUndefined();
  });

  it('allows header names with valid special characters', async () => {
    const headers = await getConfigRequestHeaders({ 'X-Custom-Header': 'value' });
    expect(headers['X-Custom-Header']).toBe('value');
  });

  it('strips multiple blocked headers but keeps valid ones', async () => {
    const headers = await getConfigRequestHeaders({
      'host': 'evil.com',
      'X-Tenant': 'good',
      'cookie': 'session=123',
      'X-Proxy': 'also-good',
    });
    expect(headers['host']).toBeUndefined();
    expect(headers['cookie']).toBeUndefined();
    expect(headers['X-Tenant']).toBe('good');
    expect(headers['X-Proxy']).toBe('also-good');
  });
});

// ── buildChatBody protected keys ──────────────────────────────────────────

describe('buildChatBody — protected keys', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stubConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Intercept fetch call and return the parsed request body. */
  async function getBodyViaSpy(messages: any, options: Record<string, unknown>): Promise<Record<string, unknown>> {
    let capturedBody: Record<string, unknown> | null = null;

    stubConfig();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      // Capture body from the fetch arguments
      const fetchArgs = fetchSpy.mock.calls[0] as any[];
      const bodyStr = fetchArgs[1]?.body as string;
      capturedBody = bodyStr ? JSON.parse(bodyStr) : null;

      // Return a valid SSE response
      return new Response('data: {"choices": [{"delta": {"content": "hi"}}]}\ndata: [DONE]\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as any;

    const client = new VllmClient(makeContext(), makeOutput());
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any;
    const generator = client.chatCompletionStream('test-model', messages, options, token);
    try {
      await generator.next();
    } catch {
      // May throw — body was captured before streaming started
    }
    await generator.return?.();
    if (!capturedBody) throw new Error('Body was not captured');
    return capturedBody;
  }

  it('sets required fields: model, messages, stream, stream_options', async () => {
    const body = await getBodyViaSpy([{ role: 'user', content: 'hello' }], {});
    expect(body.model).toBe('test-model');
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('never lets options overwrite model', async () => {
    const body = await getBodyViaSpy([{ role: 'user', content: 'hello' }], {
      model: 'hacked-model',
    });
    expect(body.model).toBe('test-model');
  });

  it('never lets options overwrite messages', async () => {
    const body = await getBodyViaSpy([{ role: 'user', content: 'hello' }], {
      messages: [{ role: 'system', content: 'hacked' }],
    });
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('never lets options overwrite stream', async () => {
    const body = await getBodyViaSpy([{ role: 'user', content: 'hello' }], {
      stream: false,
    });
    expect(body.stream).toBe(true);
  });

  it('never lets options overwrite stream_options', async () => {
    const body = await getBodyViaSpy([{ role: 'user', content: 'hello' }], {
      stream_options: { include_usage: false },
    });
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('allows valid sampling options (temperature, top_p, etc.)', async () => {
    const body = await getBodyViaSpy([{ role: 'user', content: 'hello' }], {
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 512,
    });
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.9);
    expect(body.max_tokens).toBe(512);
  });

  it('filters out undefined option values', async () => {
    const body = await getBodyViaSpy([{ role: 'user', content: 'hello' }], {
      temperature: undefined,
      top_p: 0.9,
    });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBe(0.9);
  });

  it('allows vLLM-specific options (continue_final_message, add_generation_prompt)', async () => {
    const body = await getBodyViaSpy([{ role: 'user', content: 'hello' }], {
      continue_final_message: true,
      add_generation_prompt: false,
    });
    expect(body.continue_final_message).toBe(true);
    expect(body.add_generation_prompt).toBe(false);
  });

  it('allows vLLM-specific P0 params (bad_words, ignore_eos, repetition_detection)', async () => {
    const body = await getBodyViaSpy([{ role: 'user', content: 'hello' }], {
      bad_words: ['badword1', 'badword2'],
      ignore_eos: true,
      repetition_detection: {
        max_pattern_size: 10,
        min_count: 3,
        min_pattern_size: 2,
      },
    });
    expect(body.bad_words).toEqual(['badword1', 'badword2']);
    expect(body.ignore_eos).toBe(true);
    expect(body.repetition_detection).toEqual({
      max_pattern_size: 10,
      min_count: 3,
      min_pattern_size: 2,
    });
  });
});

// ── validateMessages ──────────────────────────────────────────────────────

describe('validateMessages', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stubConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function chatWithMessages(messages: unknown) {
    // Return an SSE response so checkResponseContentType passes and validateMessages runs
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('data: {"choices": [{"delta": {"content": "hi"}}]}\ndata: [DONE]\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    ) as any;
    const client = new VllmClient(makeContext(), makeOutput());
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any;
    const generator = client.chatCompletionStream('test-model', messages as any, {}, token);
    try {
      await generator.next();
      return { ok: true as const };
    } catch (err: any) {
      return { ok: false as const, error: err.message };
    }
  }

  it('accepts valid message array', async () => {
    const result = await chatWithMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(result.ok).toBe(true);
  });

  it('throws when messages is not an array', async () => {
    const result = await chatWithMessages('not an array');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid messages.*expected array/);
  });

  it('throws when message object has no role', async () => {
    const result = await chatWithMessages([{ content: 'hello' }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid message at index 0/);
  });

  it('throws when message role is not a string', async () => {
    const result = await chatWithMessages([{ role: 123, content: 'hello' }]);
    expect(result.ok).toBe(false);
  });

  it('throws when message is null', async () => {
    const result = await chatWithMessages([null]);
    expect(result.ok).toBe(false);
  });
});

// ── checkResponseContentType ──────────────────────────────────────────────

describe('checkResponseContentType', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stubConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function chatWithResponse(response: Response) {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any);
    const client = new VllmClient(makeContext(), makeOutput());
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any;
    const generator = client.chatCompletionStream('test-model', [], {}, token);
    try {
      await generator.next();
      return { ok: true as const };
    } catch (err: any) {
      return { ok: false as const, error: err.message };
    }
  }

  it('throws with error message for JSON error response', async () => {
    const res = new Response(JSON.stringify({ error: { message: 'context length exceeded' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const result = await chatWithResponse(res);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Server returned JSON error.*context length exceeded/);
  });

  it('throws generic message for JSON response without error key', async () => {
    const res = new Response(JSON.stringify({ foo: 'bar' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const result = await chatWithResponse(res);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unexpected JSON response/);
  });

  it('throws with HTML snippet for HTML response', async () => {
    const res = new Response('<!DOCTYPE HTML><html><body>502 Bad Gateway</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const result = await chatWithResponse(res);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTML instead of SSE/);
    expect(result.error).toMatch(/502 Bad Gateway/);
  });
});
