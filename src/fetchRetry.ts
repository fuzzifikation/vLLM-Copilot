/**
 * HTTP fetch with retry + header merging.
 *
 * Stable infrastructure — extracted from VllmClient to keep the moat seam
 * (request-body construction) as the only change surface.
 */

import { describeError } from './messageConverter.js';

const DEFAULT_RETRY_DELAY_MS = 1500;
const MAX_RETRY_AFTER_MS = 10_000;

/** Parse Retry-After seconds or an HTTP date into a non-negative delay. */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined;
  }
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Abortable retry delay so cancellation never waits behind backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Request cancelled by user'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error('Request cancelled by user'));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Merge headers: the per-model server headers first (base), then caller headers
 * (e.g. Content-Type — always wins). Each model targets its own server, so these
 * are that server's isolated request headers; there is no global auth layer.
 */
export function buildRequestHeaders(
  callerHeaders: Record<string, string> | undefined,
  requestHeaders: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {};

  // Layer 1: the model's own server headers (auth, routing, etc.)
  for (const [k, v] of Object.entries(requestHeaders ?? {})) {
    if (typeof v === 'string') headers[k] = v;
  }

  // Layer 2: caller-specific headers (e.g., Content-Type — always wins)
  for (const [k, v] of Object.entries(callerHeaders ?? {})) {
    if (typeof v === 'string') headers[k] = v;
  }

  return headers;
}

/**
 * Normalize `HeadersInit` (which can be Headers, string[][], or Record) into
 * a plain Record<string, string> so `buildRequestHeaders` can work with a
 * single, well-defined input shape.
 */
function normalizeHeaders(headers: RequestInit['headers']): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (typeof headers === 'object' && !(headers instanceof Headers) && !Array.isArray(headers)) {
    return headers as Record<string, string>;
  }
  const map = new Map<string, string>(headers as Iterable<[string, string]>);
  const result: Record<string, string> = {};
  for (const [k, v] of map) result[k] = v;
  return result;
}

/**
 * Fetch with retry on transient failures.
 *
 * @param url - Request URL
 * @param init - Fetch init options
 * @param requestHeaders - The target model server's isolated request headers
 *   (auth, routing). Each model targets its own server, so these headers are used
 *   as-is — there is no global auth layer to merge or leak across servers.
 * @param onRetry - Called before a retry attempt, with its cause and delay.
 * @param onRetrySuccess - Called after a retry attempt succeeds, with the HTTP status.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  requestHeaders: Record<string, string>,
  onRetry?: (error: string, delayMs: number) => void,
  onRetrySuccess?: (status: number) => void
): Promise<Response> {
  const headers = buildRequestHeaders(normalizeHeaders(init.headers), requestHeaders);
  const callerSignal = init.signal as AbortSignal | undefined;

  if (callerSignal?.aborted) {
    throw new Error('Request cancelled by user');
  }

  // Attempt initial request, then up to one retry on transient failures
  const MAX_ATTEMPTS = 2;
  let lastError: string | undefined;
  let retryDelayMs = DEFAULT_RETRY_DELAY_MS;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      onRetry?.(lastError!, retryDelayMs);
      await sleep(retryDelayMs, callerSignal);
    }

    // If caller already aborted between attempts, stop immediately
    if (callerSignal?.aborted) {
      throw new Error(callerSignal.reason ?? 'Request cancelled by user');
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        signal: callerSignal,
      });
    } catch (err) {
      // Don't retry aborts. A rejected fetch whose signal is aborted is a
      // CANCELLATION (user cancel or a timeout), not a server failure — in
      // Node/undici this rejects with the signal's reason, which is NOT always an
      // AbortError (AbortController.abort('msg') rejects with the raw string;
      // AbortSignal.timeout() rejects with TimeoutError). Retrying would delay a
      // user cancel by the 1.5s sleep and double every metadata timeout.
      // The name check is defensive: an AbortError always implies an aborted
      // signal in practice, but keeping it costs nothing and guards callers that
      // throw a hand-built AbortError.
      if (callerSignal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err;
      }

      // Retry once on network errors
      lastError = `Network error: ${describeError(err)}`;
      continue;
    }

    // Handle non-OK responses
    if (!response.ok) {
      // Read the body ONCE and reuse it for BOTH the retry-warning text and the
      // final thrown error. The 5xx path previously cancelled the body and threw
      // only "HTTP <status> from server" — losing statusText and any error
      // message, so a 502 surfaced as a bare code with no explanation while a
      // 530 (non-5xx path) showed "Bad Gateway"-style text. Both must carry the
      // server's real status line.
      const text = await response.text().catch(() => '');
      const isRetry = attempt > 0;
      const statusLine = `HTTP ${response.status}: ${response.statusText}${text ? ' — ' + text.substring(0, 2000) : ''}`;
      const is5xx = response.status >= 500 && response.status < 600;
      const canRetry = attempt + 1 < MAX_ATTEMPTS;
      if ((response.status === 429 || is5xx) && canRetry) {
        // Retry one pre-stream throttling/transient response. OpenRouter uses
        // Retry-After on 429/503; honor it only when the interactive wait stays
        // within 10s. A longer requested wait is surfaced immediately so chat
        // does not look hung. Missing/invalid values use the existing 1.5s delay.
        retryDelayMs = DEFAULT_RETRY_DELAY_MS;
        if (response.status === 429 || response.status === 503) {
          const requestedDelay = parseRetryAfterMs(response.headers.get('retry-after'));
          if (requestedDelay !== undefined) {
            if (requestedDelay > MAX_RETRY_AFTER_MS) throw new Error(statusLine);
            retryDelayMs = requestedDelay;
          }
        }
        lastError = statusLine;
        continue;
      }
      // Cap the body so a pathological server response can't balloon the error
      // string, but keep enough to carry a real error.message — OpenRouter's
      // credit / max_tokens notices run ~200 chars and were being cut off.
      throw new Error(`${statusLine}${isRetry ? ' (after retry)' : ''}`);
    }

    // Log retry success if applicable
    if (attempt > 0) {
      onRetrySuccess?.(response.status);
    }

    return response;
  }

  // Should not reach here, but satisfy exhaustiveness
  throw new Error(`Request failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}