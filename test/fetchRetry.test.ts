import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithRetry } from '../src/fetchRetry.js';

/**
 * fetchWithRetry retry classification. Regression tests for the real Node/undici
 * abort shapes, which are NOT plain `AbortError` instances:
 *   - AbortController.abort('reason')  → the fetch rejects with the raw REASON
 *     string (a string, not an Error — `err instanceof Error` is false).
 *   - AbortSignal.timeout(ms)         → the fetch rejects with a TimeoutError.
 * Neither may enter the retry path (which would sleep 1.5s and double every
 * metadata timeout / delay every user cancel).
 */

const okResponse = () => new Response('ok', { status: 200 });

describe('fetchWithRetry abort handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT retry when the signal aborts with a raw string reason', async () => {
    const controller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url: unknown, init: any) =>
        new Promise<Response>((_, reject) => {
          // Node/undici rejects with the abort reason (the raw string).
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    );

    const p = fetchWithRetry('http://test', { signal: controller.signal }, {});
    controller.abort('User cancelled');

    await expect(p).rejects.toBe('User cancelled');
    // A single attempt — no retry warning/sleep, no second fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when AbortSignal.timeout rejects with a TimeoutError', async () => {
    const signal = AbortSignal.timeout(5);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url: unknown, init: any) =>
        new Promise<Response>((_, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    );

    await expect(fetchWithRetry('http://test', { signal }, {})).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('still retries once on a genuine network error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okResponse());

    const res = await fetchWithRetry('http://test', {}, {});
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('still retries once on a 5xx server error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(okResponse());

    const res = await fetchWithRetry('http://test', {}, {});
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('passes the FULL status line to onRetry and throws it after retries are exhausted', async () => {
    // The 5xx retry path must carry status + statusText + body (from the real
    // response), not a bare "HTTP <status> from server" — so a 502/503 surfaces
    // its code AND message to the user.
    const retryWarnings: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('upstream down', { status: 502, statusText: 'Bad Gateway' }))
      .mockResolvedValueOnce(new Response('upstream down', { status: 502, statusText: 'Bad Gateway' }));

    await expect(fetchWithRetry('http://test', {}, {}, (w) => retryWarnings.push(w)))
      .rejects.toThrow('Request failed after 2 attempts: HTTP 502: Bad Gateway — upstream down');

    expect(retryWarnings).toEqual(['HTTP 502: Bad Gateway — upstream down']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
