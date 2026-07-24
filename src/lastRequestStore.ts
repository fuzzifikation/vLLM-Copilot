import type { WireMetrics } from './types.js';

/**
 * In-memory store for the last chat-completion request per server.
 *
 * Populated by `provider.ts` after each stream completes.
 * Read by `dashboard.ts` to display "Last Request" details.
 */

/**
 * Data captured from a single completed request.
 */
export interface LastRequestData {
  /** Server URL this request was sent to. */
  serverUrl: string;
  /** Model ID used for the request. */
  modelId: string;
  /** Timestamp when the request completed. */
  timestamp: number;
  /** Token counts from vLLM usage block. */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Cached tokens (requires `--enable-prompt-tokens-details`). */
  cachedTokens?: number;
  /** Cache creation tokens (requires `--enable-prompt-tokens-details`). */
  createdCacheTokens?: number;
  /** Reasoning tokens, if applicable. */
  reasoningTokens?: number;
  /** Per-request timing (requires `--enable-per-request-metrics`). */
  metrics?: WireMetrics;
  /** Whether --enable-per-request-metrics is available (true if metrics were received). */
  hasMetrics: boolean;
  /** Whether --enable-prompt-tokens-details is available (true if cache details were received). */
  hasCacheDetails: boolean;
  /** Context window (max_model_len from server). */
  maxModelLen: number;
  /** Output budget (max_output_tokens from settings). */
  maxOutputTokens: number;
  /** Time-to-first-token in ms, measured by the provider. Always available. */
  firstTokenTimeMs: number | null;
}

/**
 * Singleton-style in-memory store, keyed by server URL.
 * Each entry holds the most recent request data for that server.
 */
const store: Map<string, LastRequestData> = new Map();

/** Get the last request data for a server URL. */
export function getLastRequest(serverUrl: string): LastRequestData | undefined {
  return store.get(serverUrl);
}

/** Store new request data, replacing any previous entry for the server. */
export function setLastRequest(data: LastRequestData): void {
  store.set(data.serverUrl, data);
}