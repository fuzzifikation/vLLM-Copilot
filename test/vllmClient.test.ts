import { describe, it, expect, afterEach, vi } from 'vitest';
import { VllmClient } from '../src/provider/vllmClient.js';
import { ChatTransport } from '../src/provider/chatTransport.js';
import * as configModule from '../src/state/config.js';
import type { VllmConfig } from '../src/state/config.js';

/**
 * VllmClient is a thin facade over ChatTransport, so these tests only cover what
 * the facade itself owns: the configuration cache, argument-faithful delegation
 * to ChatTransport.stream, and the initial request timeout. Body construction
 * and per-backend adaptation are pinned once in chatTransport.test.ts; runtime
 * limits in runtimeLimits.test.ts.
 */

/** Build a minimal fake OutputChannel for the client. */
function makeOutput(): any {
  return { appendLine: (s: string) => process.env.VLLM_TEST_TRACE && console.log(s) };
}

describe('chatCompletionStream facade delegation', () => {
  /**
   * The facade's ONLY job is not losing an argument on the way through:
   * `chatCompletionStream` is byte-for-byte `yield*` into ChatTransport.stream,
   * so every body-shape pin (vLLM continuation controls, per-backend strips,
   * the ollama tool_choice WARN, the 200-JSON error-response marker) lives once in
   * chatTransport.test.ts — the four copies this replaced pinned the same
   * branches twice and contradicted this file's own header (CR-103). Drop
   * `serverType` here and every backend silently speaks vLLM: that is the
   * breakage this pin catches.
   */
  // Restore explicitly, not just via the file's other describe: an un-restored
  // prototype spy silently swallows the timeout suite's real transport.
  afterEach(() => vi.restoreAllMocks());

  it('threads model, messages, options, token and the full serverConfig into ChatTransport.stream', async () => {
    const streamSpy = vi.spyOn(ChatTransport.prototype, 'stream').mockImplementation(
      async function* () {}
    );
    const client = new VllmClient(makeOutput());
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any;
    const serverConfig = { serverUrl: 'http://test', requestHeaders: {}, streamInactivityTimeout: 0, initialResponseTimeoutMs: 60000, serverType: 'ollama' } as const;
    // Consume the generator to completion so the facade's timeout machinery
    // unwinds cleanly (a half-iterated generator leaks a rejection into the
    // next test in this file).
    for await (const _ of client.chatCompletionStream('m', [] as any, { tool_choice: 'auto' } as any, token, serverConfig)) { /* empty stream */ }
    expect(streamSpy).toHaveBeenCalledWith(
      'm', [], expect.objectContaining({ tool_choice: 'auto' }), token, serverConfig,
    );
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
    const client = new VllmClient(makeOutput());
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
    const client = new VllmClient(makeOutput());
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
    const client = new VllmClient(makeOutput());
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
    const client = new VllmClient(makeOutput());
    await Promise.all([client.getConfigCached(), client.getConfigCached()]);
    expect(getConfig).toHaveBeenCalledTimes(1);
  });

  it('re-reads settings after invalidateConfigCache', async () => {
    const getConfig = vi.spyOn(configModule, 'getConfig').mockResolvedValue(config);
    const client = new VllmClient(makeOutput());
    await client.getConfigCached();
    client.invalidateConfigCache();
    await client.getConfigCached();
    expect(getConfig).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed read, so the next caller retries', async () => {
    const getConfig = vi.spyOn(configModule, 'getConfig')
      .mockRejectedValueOnce(new Error('bad settings.json'))
      .mockResolvedValue(config);
    const client = new VllmClient(makeOutput());
    await expect(client.getConfigCached()).rejects.toThrow('bad settings.json');
    await expect(client.getConfigCached()).resolves.toBe(config);
    expect(getConfig).toHaveBeenCalledTimes(2);
  });
});

