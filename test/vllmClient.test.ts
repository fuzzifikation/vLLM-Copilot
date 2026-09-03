import { describe, it, expect, afterEach, vi } from 'vitest';
import { VllmClient } from '../src/provider/vllmClient.js';
import * as configModule from '../src/state/config.js';
import type { VllmConfig } from '../src/state/config.js';

/**
 * VllmClient is a thin facade over ChatTransport, so these tests only cover what
 * the facade itself is responsible for: owning the configuration cache, passing
 * server type through to the request body, and enforcing the initial request
 * timeout. Pure body construction lives in chatTransport.test.ts; runtime limits
 * in runtimeLimits.test.ts.
 */

/** Build a minimal fake ExtensionContext / OutputChannel for the client. */
function makeContext(): any {
  return { secrets: { get: async () => undefined } };
}
function makeOutput(): any {
  return { appendLine: (s: string) => process.env.VLLM_TEST_TRACE && console.log(s) };
}

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

describe('config cache', () => {
  const config: VllmConfig = { models: [], servers: [], enableFileLogging: false };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads settings once and reuses the cached promise', async () => {
    const getConfig = vi.spyOn(configModule, 'getConfig').mockResolvedValue(config);
    const client = new VllmClient(makeContext(), makeOutput());
    await Promise.all([client.getConfigCached(), client.getConfigCached()]);
    expect(getConfig).toHaveBeenCalledTimes(1);
  });

  it('re-reads settings after invalidateConfigCache', async () => {
    const getConfig = vi.spyOn(configModule, 'getConfig').mockResolvedValue(config);
    const client = new VllmClient(makeContext(), makeOutput());
    await client.getConfigCached();
    client.invalidateConfigCache();
    await client.getConfigCached();
    expect(getConfig).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed read, so the next caller retries', async () => {
    const getConfig = vi.spyOn(configModule, 'getConfig')
      .mockRejectedValueOnce(new Error('bad settings.json'))
      .mockResolvedValue(config);
    const client = new VllmClient(makeContext(), makeOutput());
    await expect(client.getConfigCached()).rejects.toThrow('bad settings.json');
    await expect(client.getConfigCached()).resolves.toBe(config);
    expect(getConfig).toHaveBeenCalledTimes(2);
  });
});

