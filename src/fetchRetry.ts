/**
 * HTTP fetch with retry + header merging.
 *
 * Stable infrastructure — extracted from VllmClient to keep the moat seam
 * (request-body construction) as the only change surface.
 */

import { describeError } from './messageConverter.js';

/** Sleep helper — returns a promise that resolves after ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
 * @param onRetry - Called before a retry attempt, with the error that triggered it.
 * @param onRetrySuccess - Called after a retry attempt succeeds, with the HTTP status.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  requestHeaders: Record<string, string>,
  onRetry?: (error: string) => void,
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
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      onRetry?.(lastError!);
      await sleep(1500);
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
      if (response.status >= 500 && response.status < 600) {
        // Retry once on 5xx transient server errors. Drain the failed body first
        // so the underlying socket can be reused (keep-alive) instead of leaking.
        await response.body?.cancel().catch(() => {});
        lastError = `HTTP ${response.status} from server`;
        continue;
      } else {
        const text = await response.text().catch(() => '');
        const isRetry = attempt > 0;
        throw new Error(`HTTP ${response.status}: ${response.statusText}${text ? ' — ' + text.substring(0, 200) : ''}${isRetry ? ' (after retry)' : ''}`);
      }
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