import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildChatBody, checkResponseContentType, validateMessages } from '../src/provider/chatProtocol.js';
import type { ServerType } from '../src/config.js';
import type { OpenAIChatMessage, VllmChatOptions } from '../src/types.js';

const USER: OpenAIChatMessage[] = [{ role: 'user', content: 'hello' } as OpenAIChatMessage];
const noop = () => {};

/** buildChatBody with the defaults every test here shares. */
function body(options: Record<string, unknown>, serverType: ServerType = 'vllm', onWarn = noop) {
  return buildChatBody('test-model', USER, options as VllmChatOptions, serverType, onWarn);
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('checkResponseContentType', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts an SSE content type without error', async () => {
    const r = new Response('data: {}', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    await expect(checkResponseContentType(r)).resolves.toBeUndefined();
  });

  it('throws on a JSON body without an error envelope', async () => {
    await expect(checkResponseContentType(jsonResponse({ ok: true }))).rejects.toThrow(/unexpected JSON response/);
  });

  it('throws the simple server error message', async () => {
    const r = jsonResponse({ error: { message: 'This model maximum context length is 4096 tokens' } });
    await expect(checkResponseContentType(r)).rejects.toThrow(
      'Server error (mid-stream): This model maximum context length is 4096 tokens'
    );
  });

  it('recovers the real reason from an OpenRouter error.metadata.raw envelope', async () => {
    const r = jsonResponse({
      error: {
        message: 'Provider returned error',
        metadata: { raw: 'Rate limit exceeded for the provider deepseek' },
      },
    });
    await expect(checkResponseContentType(r)).rejects.toThrow(/Rate limit exceeded for the provider deepseek/);
  });

  it('throws a string-form error', async () => {
    const r = jsonResponse({ error: 'internal server error' });
    await expect(checkResponseContentType(r)).rejects.toThrow('Server error (mid-stream): internal server error');
  });

  it('throws HTML bodies as a reverse-proxy error', async () => {
    const r = new Response('<html><body>Gateway Timeout</body></html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });
    await expect(checkResponseContentType(r)).rejects.toThrow(/HTML instead of SSE stream/);
  });
});

describe('buildChatBody — protected keys', () => {
  it('sets required fields: model, messages, stream, stream_options', () => {
    const b = body({});
    expect(b.model).toBe('test-model');
    expect(b.messages).toEqual(USER);
    expect(b.stream).toBe(true);
    expect(b.stream_options).toEqual({ include_usage: true });
  });

  it.each([
    ['model', { model: 'hacked-model' }, 'test-model'],
    ['stream', { stream: false }, true],
    ['stream_options', { stream_options: { include_usage: false } }, { include_usage: true }],
  ])('never lets options overwrite %s', (_key, options, expected) => {
    expect(body(options as Record<string, unknown>)[_key]).toEqual(expected);
  });

  it('never lets options overwrite messages', () => {
    const b = body({ messages: [{ role: 'system', content: 'hacked' }] });
    expect(b.messages).toEqual(USER);
  });

  it('allows valid sampling options (temperature, top_p, etc.)', () => {
    const b = body({ temperature: 0.5, top_p: 0.9, max_tokens: 512 });
    expect(b.temperature).toBe(0.5);
    expect(b.top_p).toBe(0.9);
    expect(b.max_tokens).toBe(512);
  });

  it('filters out undefined option values', () => {
    const b = body({ temperature: undefined, top_p: 0.9 });
    expect('temperature' in b).toBe(false);
    expect(b.top_p).toBe(0.9);
  });

  it('keeps vLLM-specific options for a vLLM server', () => {
    const b = body({ continue_final_message: true, add_generation_prompt: false });
    expect(b.continue_final_message).toBe(true);
    expect(b.add_generation_prompt).toBe(false);
  });

  it.each(['lmstudio', 'llamacpp', 'openrouter', 'ollama'] as const)('strips vLLM-only chat-template options for %s', serverType => {
    const b = body({ continue_final_message: true, add_generation_prompt: false }, serverType);
    expect('continue_final_message' in b).toBe(false);
    expect('add_generation_prompt' in b).toBe(false);
  });

  it('keeps vLLM-specific P0 params (bad_words, ignore_eos, repetition_detection)', () => {
    const b = body({
      bad_words: ['badword1', 'badword2'],
      ignore_eos: true,
      repetition_detection: { max_pattern_size: 10, min_count: 3, min_pattern_size: 2 },
    });
    expect(b.bad_words).toEqual(['badword1', 'badword2']);
    expect(b.ignore_eos).toBe(true);
    expect(b.repetition_detection).toEqual({ max_pattern_size: 10, min_count: 3, min_pattern_size: 2 });
  });

  it('drops tool_choice on Ollama and reports it once', () => {
    const onRemoved = vi.fn();
    const b = body({ tool_choice: 'auto' }, 'ollama', onRemoved);
    expect('tool_choice' in b).toBe(false);
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it('keeps tool_choice on every other backend', () => {
    expect(body({ tool_choice: 'auto' }, 'vllm').tool_choice).toBe('auto');
    expect(body({ tool_choice: 'auto' }, 'openrouter').tool_choice).toBe('auto');
  });
});

describe('validateMessages', () => {
  it('accepts a valid message array', () => {
    expect(() => validateMessages([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }])).not.toThrow();
  });

  it('accepts several system messages as long as they all come first', () => {
    expect(() => validateMessages([
      { role: 'system', content: 'be nice' },
      { role: 'system', content: 'extra system block' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])).not.toThrow();
  });

  it('throws when messages is not an array', () => {
    expect(() => validateMessages('not an array')).toThrow(/Invalid messages.*expected array/);
  });

  it('throws when a message object has no role', () => {
    expect(() => validateMessages([{ content: 'hello' }])).toThrow(/Invalid message at index 0/);
  });

  it('throws when a message role is not a string', () => {
    expect(() => validateMessages([{ role: 123, content: 'hello' }])).toThrow(/Invalid message at index 0/);
  });

  it('throws when a message is null', () => {
    expect(() => validateMessages([null])).toThrow(/Invalid message at index 0/);
  });

  it('throws when a system message follows a user/assistant message', () => {
    expect(() => validateMessages([
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'too late' },
    ])).toThrow(/ordering violation: system message at index 1/);
  });
});
