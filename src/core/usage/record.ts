/**
 * The canonical completed-request record — the accounting vocabulary shared
 * by the execution core (which BUILDS it from sanitized wire usage) and
 * whichever ledger/consumer persists it. Plain data on purpose: no wire
 * format, no editor object, no storage. Lives outside `core/types.ts`
 * because it is request/accounting contract, not a wire format.
 */
import type { WireMetrics } from '../types.js';

/** Data captured from a single completed request. */
export interface LastRequestData {
  /** Server URL this request was sent to (normalized). */
  serverUrl: string;
  /** Model ID used for the request (wire id). */
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
  /** Actual reported cost in USD (OpenRouter `usage.cost`). Absent on vLLM/local. */
  actualCost?: number;
  /** OpenRouter: served with the user's own upstream key (`usage.is_byok`). */
  usedByok?: boolean;
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
  /** Total wall-clock request time in ms, measured by the provider. Always available. */
  totalTimeMs: number | null;
}
