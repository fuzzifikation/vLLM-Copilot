import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChatTransport } from '../src/provider/chatTransport.js';
import type { ServerType } from '../src/config.js';
import type { OpenAIChatMessage, VllmChatOptions } from '../src/types.js';

/**
 * Wire-format canary (formerly chatProtocol.test.ts). The body builder,
 * message validator, and content-type gate are module-private in
 * `chatTransport.ts` (U3: chatProtocol.ts annihilated), so every pin here
 * drives the real `stream()` path with a mocked `fetch` and asserts on the
 * captured request body or the surfaced error. This is the tripwire for:
 * protected keys overwritten by options, vLLM-only flags leaking to other
 * backends, ollama tool_choice, system-message ordering, and JSON/HTML
 * responses masquerading as SSE.
 */

const USER: OpenAIChatMessage[] = [{ role: 'user', content: 'hello' }];

const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
} as any;

function serverConfig(serverType: ServerType = 'vllm') {
  return {
    serverUrl: 'http://test',
    requestHeaders: {},
    streamInactivityTimeout: 0,
    initialResponseTimeoutMs: 0,
    serverType,
  };
}

const sseResponse = () =>
  new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** Drive a full stream; returns the transport's output channel mock. */
async function drain(
  messages: unknown = USER,
  options: Record<string, unknown> = {},
  serverType: ServerType = 'vllm',
  output = { appendLine: vi.fn() } as any,
) {
  for await (const _ of new ChatTransport(output).stream(
    'test-model',
    messages as OpenAIChatMessage[],
    options as VllmChatOptions,
    token,
    serverConfig(serverType),
  )) { /* drain */ }
  return output;
}

/** The JSON body the transport actually sent over the wire. */
async function capturedBody(
  options: Record<string, unknown> = {},
  serverType: ServerType = 'vllm',
): Promise<Record<string, any>> {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(sseResponse()));
  await drain(USER, options, serverType);
  expect(spy).toHaveBeenCalledTimes(1);
  return JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetchResponse(make: () => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(make()));
}

describe('stream response content-type gate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('streams normally on an SSE content type', async () => {
    const spy = mockFetchResponse(sseResponse);
    await drain();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('throws on a JSON body without an error envelope', async () => {
    mockFetchResponse(() => jsonResponse({ ok: true }));
    await expect(drain()).rejects.toThrow(/unexpected JSON response/);
  });

  it('throws the simple server error message', async () => {
    mockFetchResponse(() => jsonResponse({ error: { message: 'This model maximum context length is 4096 tokens' } }));
    await expect(drain()).rejects.toThrow(
      'Server error (mid-stream): This model maximum context length is 4096 tokens'
    );
  });

  it('recovers the real reason from an OpenRouter error.metadata.raw envelope', async () => {
    mockFetchResponse(() => jsonResponse({
      error: {
        message: 'Provider returned error',
        metadata: { raw: 'Rate limit exceeded for the provider deepseek' },
      },
    }));
    await expect(drain()).rejects.toThrow(/Rate limit exceeded for the provider deepseek/);
  });

  it('throws a string-form error', async () => {
    mockFetchResponse(() => jsonResponse({ error: 'internal server error' }));
    await expect(drain()).rejects.toThrow('Server error (mid-stream): internal server error');
  });

  it('throws HTML bodies as a reverse-proxy error', async () => {
    mockFetchResponse(() => new Response('<html><body>Gateway Timeout</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    await expect(drain()).rejects.toThrow(/HTML instead of SSE stream/);
  });
});

describe('request body — protected keys', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sets required fields: model, messages, stream, stream_options', async () => {
    const b = await capturedBody();
    expect(b.model).toBe('test-model');
    expect(b.messages).toEqual(USER);
    expect(b.stream).toBe(true);
    expect(b.stream_options).toEqual({ include_usage: true });
  });

  it.each([
    ['model', { model: 'hacked-model' }, 'test-model'],
    ['stream', { stream: false }, true],
    ['stream_options', { stream_options: { include_usage: false } }, { include_usage: true }],
  ])('never lets options overwrite %s', async (key, options, expected) => {
    expect((await capturedBody(options))[key as string]).toEqual(expected);
  });

  it('never lets options overwrite messages', async () => {
    const b = await capturedBody({ messages: [{ role: 'system', content: 'hacked' }] });
    expect(b.messages).toEqual(USER);
  });

  it('allows valid sampling options (temperature, top_p, etc.)', async () => {
    const b = await capturedBody({ temperature: 0.5, top_p: 0.9, max_tokens: 512 });
    expect(b.temperature).toBe(0.5);
    expect(b.top_p).toBe(0.9);
    expect(b.max_tokens).toBe(512);
  });

  it('filters out undefined option values', async () => {
    const b = await capturedBody({ temperature: undefined, top_p: 0.9 });
    expect('temperature' in b).toBe(false);
    expect(b.top_p).toBe(0.9);
  });

  it('keeps vLLM-specific options for a vLLM server', async () => {
    const b = await capturedBody({ continue_final_message: true, add_generation_prompt: false });
    expect(b.continue_final_message).toBe(true);
    expect(b.add_generation_prompt).toBe(false);
  });

  it.each(['lmstudio', 'llamacpp', 'openrouter', 'ollama'] as const)('strips vLLM-only chat-template options for %s', async serverType => {
    const b = await capturedBody({ continue_final_message: true, add_generation_prompt: false }, serverType);
    expect('continue_final_message' in b).toBe(false);
    expect('add_generation_prompt' in b).toBe(false);
  });

  it('keeps vLLM-specific P0 params (bad_words, ignore_eos, repetition_detection)', async () => {
    const b = await capturedBody({
      bad_words: ['badword1', 'badword2'],
      ignore_eos: true,
      repetition_detection: { max_pattern_size: 10, min_count: 3, min_pattern_size: 2 },
    });
    expect(b.bad_words).toEqual(['badword1', 'badword2']);
    expect(b.ignore_eos).toBe(true);
    expect(b.repetition_detection).toEqual({ max_pattern_size: 10, min_count: 3, min_pattern_size: 2 });
  });

  it('drops tool_choice on Ollama and reports it once per transport', async () => {
    const spy = mockFetchResponse(sseResponse);
    const output = { appendLine: vi.fn() } as any;
    const transport = new ChatTransport(output);
    const call = async () => {
      for await (const _ of transport.stream(
        'test-model', USER, { tool_choice: 'auto' } as VllmChatOptions, token, serverConfig('ollama'),
      )) { /* drain */ }
    };
    await call();
    await call();

    const bodyJson = JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));
    expect('tool_choice' in bodyJson).toBe(false);
    const warns = output.appendLine.mock.calls.filter((c: unknown[]) => String(c[0]).includes('Ollama does not support tool_choice'));
    expect(warns).toHaveLength(1);
  });

  it('keeps tool_choice on every other backend', async () => {
    expect((await capturedBody({ tool_choice: 'auto' }, 'vllm')).tool_choice).toBe('auto');
    vi.restoreAllMocks();
    expect((await capturedBody({ tool_choice: 'auto' }, 'openrouter')).tool_choice).toBe('auto');
  });
});

describe('request body — message validation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts system messages as long as they all come first', async () => {
    const spy = mockFetchResponse(sseResponse);
    await drain([
      { role: 'system', content: 'be nice' },
      { role: 'system', content: 'extra system block' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(spy).toHaveBeenCalledTimes(1); // validation passed, request went out
  });

  it('throws when messages is not an array', async () => {
    await expect(drain('not an array')).rejects.toThrow(/Invalid messages.*expected array/);
  });

  it('throws when a system message appears after conversation turns', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(drain([
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'sneaky mid-stream system prompt' },
    ])).rejects.toThrow(/Message ordering violation/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws when a message object has no role', async () => {
    await expect(drain([{ content: 'hello' }])).rejects.toThrow(/Invalid message at index 0/);
  });

  it('throws when a message role is not a string', async () => {
    await expect(drain([{ role: 123, content: 'hello' }])).rejects.toThrow(/Invalid message at index 0/);
  });
});
