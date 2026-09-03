/**
 * vLLM metrics — pure data layer.
 *
 * Fetches /health, /version, /v1/models, /metrics from a vLLM server,
 * parses the Prometheus text format, and aggregates into structured metrics.
 * Used by both the sidebar dashboard (dashboard.ts) and the deep-dive webview.
 *
 * ## Polling Engine
 *
 * {@link ServerMetricsEngine} owns the fetch cycle for one server. It is
 * reference-counted: starts polling when the first subscriber joins, stops
 * when the last leaves. Both dashboard and deep-dive subscribe to the same
 * engine via {@link getMetricsEngine}, so one server is never fetched twice
 * per interval.
 */

import * as vscode from 'vscode';
import { buildEndpoint, normalizeServerUrl, sanitizeRequestHeaders, type ServerType } from '../state/config.js';
import { buildRequestHeaders } from '../shared/fetchRetry.js';
import { resolveRuntimeLimits } from '../backends/runtimeLimits.js';
import {
  fetchOpenRouterAccount,
  fetchOpenRouterCredits,
  getOpenRouterModelEndpointsCached,
  normalizeOpenRouterFromCatalog,
  PermanentContextError,
  OpenRouterModelNotFoundError,
  type OpenRouterAccount,
  type OpenRouterCredits,
  type OpenRouterModelData,
  type OpenRouterModelEndpoint,
  parseOpenRouterCatalogData,
} from '../backends/openRouter.js';

// ─── Types ───────────────────────────────────────────────────────────

interface ModelAccumulator {
  kvCacheUsagePerc: number[];
  running: number[];
  waiting: number[];
  preemptions: number[];
  evictions: number[];
  promptTokensTotal: number[];
  promptTokensCached: number[];
  specDraftTokens: number[];
  specAcceptedTokens: number[];
  specDrafts: number[];
  ttftSum: number;
  ttftCount: number;
  tpotSum: number;
  tpotCount: number;
  genTokensSum: number;
  decodeTimeSum: number;
  promptTokensSum: number;
  prefillTimeSum: number;
}

export interface ServerMetrics {
  online: boolean;
  version?: string;
  models: string[];
  maxModelLen: number | null;
  kvCacheUsagePercent: number | null;
  runningRequests: number | null;
  waitingRequests: number | null;
  cacheHitRate: number | null;
  specAcceptanceRate: number | null;
  specDraftsTotal: number | null;
  specDraftDepth: number | null;
  avgTTFTMs: number | null;
  avgTPOTMs: number | null;
  /** Pooled output throughput (tokens/sec) = Σ generation tokens / Σ decode time. */
  avgTputTokPerSec: number | null;
  /** Pooled prefill throughput (tokens/sec) = Σ prompt tokens / Σ prefill time. */
  avgPrefillTputTokPerSec: number | null;
  preemptions: number | null;
  evictions: number | null;
  error?: string;
  /** Per-model context window (non-vLLM only, resolved lazily + cached). modelId → window. */
  contextByModel?: Record<string, number>;
  /**
   * Per-model effective output ceiling (non-vLLM only, resolved lazily + cached
   * with the context window). modelId → reported ceiling. Display-only — the
   * dashboard uses it to flag when the effective output is below the configured
   * `maxOutputTokens` (Attention icon); it is never persisted or clamped further.
   */
  outputByModel?: Record<string, number>;
  /** OpenRouter account/key health from `GET /api/v1/key` (relay node). */
  account?: OpenRouterAccount;
  /** OpenRouter account budget from `GET /api/v1/credits` — total credits & usage. */
  credits?: OpenRouterCredits;
  /** OpenRouter per-model provider lists from `GET /api/v1/models/{id}/endpoints`
   *  (relay nodes). modelId → providers with per-1M pricing, matched by tag. */
  providersByModel?: Record<string, OpenRouterModelEndpoint[]>;
}

// Raw parsed data from /metrics — richer than ServerMetrics
export interface RawMetricEntry {
  name: string;
  labels: Record<string, string>;
  value: number;
  type?: 'gauge' | 'counter' | 'histogram';
  description?: string;
}

export interface ServerRawData {
  version?: Record<string, unknown>;
  healthStatus?: number;
  healthBody?: string;
  serverLoad?: number;
  models: Array<Record<string, unknown>>;
  metrics: {
    gauges: Record<string, RawMetricEntry[]>;
    counters: Record<string, RawMetricEntry[]>;
    histograms: Record<string, RawMetricEntry[]>;
    cache_config: Record<string, unknown>;
    process: Record<string, RawMetricEntry[]>;
    http: Record<string, RawMetricEntry[]>;
  };
}

// ─── Prometheus Parser (dashboard sidebar) ─────────────────────────
export class MetricsParser {
  models = new Map<string, ModelAccumulator>();

  private getAccum(model: string): ModelAccumulator {
    let acc = this.models.get(model);
    if (!acc) {
      acc = {
        kvCacheUsagePerc: [],
        running: [],
        waiting: [],
        preemptions: [],
        evictions: [],
        promptTokensTotal: [],
        promptTokensCached: [],
        specDraftTokens: [],
        specAcceptedTokens: [],
        specDrafts: [],
        ttftSum: 0,
        ttftCount: 0,
        tpotSum: 0,
        tpotCount: 0,
        genTokensSum: 0,
        decodeTimeSum: 0,
        promptTokensSum: 0,
        prefillTimeSum: 0,
      };
      this.models.set(model, acc);
    }
    return acc;
  }

  parseLine(line: string): void {
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)$/);
    if (!m) return;
    const [, name, labelsRaw, valueRaw] = m;
    const labels = parseLabels(labelsRaw);
    const value = parseFloat(valueRaw);
    if (isNaN(value)) return;

    const model = labels.model_name ?? 'unknown';
    const acc = this.getAccum(model);

    switch (name) {
      case 'vllm:kv_cache_usage_perc':
        acc.kvCacheUsagePerc.push(value);
        break;
      case 'vllm:num_requests_running':
        acc.running.push(value);
        break;
      case 'vllm:num_requests_waiting':
        acc.waiting.push(value);
        break;
      case 'vllm:num_preemptions_total':
        acc.preemptions.push(value);
        break;
      case 'vllm:request_eviction_total':
        acc.evictions.push(value);
        break;
      case 'vllm:prompt_tokens_total':
        acc.promptTokensTotal.push(value);
        break;
      case 'vllm:prompt_tokens_cached_total':
        acc.promptTokensCached.push(value);
        break;
      case 'vllm:spec_decode_num_draft_tokens_total':
        acc.specDraftTokens.push(value);
        break;
      case 'vllm:spec_decode_num_accepted_tokens_total':
        acc.specAcceptedTokens.push(value);
        break;
      case 'vllm:spec_decode_num_drafts_total':
        acc.specDrafts.push(value);
        break;
    }

    if (name === 'vllm:time_to_first_token_seconds_sum') {
      acc.ttftSum += value;
    } else if (name === 'vllm:time_to_first_token_seconds_count') {
      acc.ttftCount += value;
    } else if (name === 'vllm:inter_token_latency_seconds_sum') {
      acc.tpotSum += value;
    } else if (name === 'vllm:inter_token_latency_seconds_count') {
      acc.tpotCount += value;
    } else if (name === 'vllm:request_generation_tokens_sum') {
      acc.genTokensSum += value;
    } else if (name === 'vllm:request_decode_time_seconds_sum') {
      acc.decodeTimeSum += value;
    } else if (name === 'vllm:request_prompt_tokens_sum') {
      acc.promptTokensSum += value;
    } else if (name === 'vllm:request_prefill_time_seconds_sum') {
      acc.prefillTimeSum += value;
    }
  }

  parse(text: string): void {
    for (const line of text.split('\n')) {
      const trimmed = line.trimStart();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      this.parseLine(trimmed);
    }
  }

  aggregate(): Omit<ServerMetrics, 'online' | 'version' | 'error'> {
    const modelNames = [...this.models.keys()];

    const sumAll = <T extends number>(fn: (a: ModelAccumulator) => T[]) => {
      let total = 0;
      for (const m of modelNames) {
        for (const v of fn(this.models.get(m)!)) total += v;
      }
      return total;
    };

    const avgAll = <T extends number>(fn: (a: ModelAccumulator) => T[]) => {
      const values: number[] = [];
      for (const m of modelNames) {
        const arr = fn(this.models.get(m)!);
        if (arr.length > 0) {
          values.push(arr.reduce((s, v) => s + v, 0) / arr.length);
        }
      }
      return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
    };

    const running = sumAll(a => a.running);
    const waiting = sumAll(a => a.waiting);
    const preemptions = sumAll(a => a.preemptions);
    const evictions = sumAll(a => a.evictions);
    const kvCache = avgAll(a => a.kvCacheUsagePerc);

    const totalPrompt = sumAll(a => a.promptTokensTotal);
    const totalCached = sumAll(a => a.promptTokensCached);
    const cacheHitRate = totalPrompt > 0 ? (totalCached / totalPrompt) * 100 : null;

    const totalDraft = sumAll(a => a.specDraftTokens);
    const totalAccepted = sumAll(a => a.specAcceptedTokens);
    const totalDrafts = sumAll(a => a.specDrafts);
    const specAcceptanceRate = totalDraft > 0 ? (totalAccepted / totalDraft) * 100 : null;
    const specDraftDepth = totalDrafts > 0 ? totalDraft / totalDrafts : null;

    let ttftSum = 0, ttftCount = 0;
    let tpotSum = 0, tpotCount = 0;
    let genTokensSum = 0, decodeTimeSum = 0;
    let promptTokensSum = 0, prefillTimeSum = 0;
    for (const m of modelNames) {
      const a = this.models.get(m)!;
      ttftSum += a.ttftSum;
      ttftCount += a.ttftCount;
      tpotSum += a.tpotSum;
      tpotCount += a.tpotCount;
      genTokensSum += a.genTokensSum;
      decodeTimeSum += a.decodeTimeSum;
      promptTokensSum += a.promptTokensSum;
      prefillTimeSum += a.prefillTimeSum;
    }
    const avgTTFTMs = ttftCount > 0 ? (ttftSum / ttftCount) * 1000 : null;
    const avgTPOTMs = tpotCount > 0 ? (tpotSum / tpotCount) * 1000 : null;
    // Pooled output throughput: Σ generation tokens across all finished
    // requests ÷ Σ decode time (first output token → last output token). Unlike
    // TPOT — which records one sample per engine step and undercounts when
    // MTP/spec-decode emits several tokens per step — the generation-token
    // count includes every emitted token, so the rate is honest under
    // speculative decoding. Decode time (not inference time) so long-prompt
    // prefill isn't charged against the output-token numerator.
    const avgTputTokPerSec =
      decodeTimeSum > 0 ? genTokensSum / decodeTimeSum : null;
    // Pooled prefill throughput: Σ prompt tokens ÷ Σ prefill phase time.
    // Symmetric to output. Note: the prompt-token count includes cache-served
    // tokens, so with heavy prefix caching this reads higher than the raw
    // compute rate — the KV Cache Hit row explains the gap.
    const avgPrefillTputTokPerSec =
      prefillTimeSum > 0 ? promptTokensSum / prefillTimeSum : null;

    return {
      models: modelNames.filter(m => m !== 'unknown'),
      maxModelLen: null,
      kvCacheUsagePercent: kvCache != null ? kvCache * 100 : null,
      runningRequests: modelNames.length > 0 ? running : null,
      waitingRequests: modelNames.length > 0 ? waiting : null,
      cacheHitRate,
      specAcceptanceRate,
      specDraftsTotal: totalDrafts > 0 ? totalDrafts : null,
      specDraftDepth,
      avgTTFTMs,
      avgTPOTMs,
      avgTputTokPerSec,
      avgPrefillTputTokPerSec,
      preemptions: preemptions > 0 ? preemptions : null,
      evictions: evictions > 0 ? evictions : null,
    };
  }
}

export function parseLabels(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const m of raw.matchAll(/(\w+)="([^"]*)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

// Re-export for testing
export type { ModelAccumulator };

// ─── Polling Engine ─────────────────────────────────────────────────

/**
 * Default poll interval for metrics fetching.
 * Used when reading vllm-copilot.dashboard.pollIntervalMs returns undefined.
 */
const DEFAULT_POLL_MS = 15000;

/**
 * Polling engine for a single vLLM server.
 *
 * Reference-counted: starts polling on first {@link subscribe}, stops on last
 * unsubscribe. Produces both aggregated (dashboard) and raw (deep-dive) data
 * from the same fetch cycle — one server is never fetched twice per interval.
 *
 * Uses recursive setTimeout so the interval setting is re-read on every cycle.
 * Callers get cached data synchronously via {@link getCachedAggregated} and
 * {@link getCachedRaw}, and receive push notifications on each completed cycle.
 */
export class ServerMetricsEngine {
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether a fetch cycle is currently running — `tick()` reschedules itself in
   *  its `finally`, so a second concurrent cycle would spawn a second timer chain. */
  private inFlight = false;
  private _lastAggregated: ServerMetrics | null = null;
  private _lastRaw: ServerRawData | null = null;
  private _disposed = false;
  /**
   * Cached per-backend context window, per model (non-vLLM only).
   * modelId → `undefined` = not yet attempted (or transient failure awaiting
   * retry); `null` = permanently unresolvable (a catalog entry that reports no
   * usable window — never retried); number = resolved value. OpenRouter is a
   * relay: each configured model has its OWN context window, so this is a map,
   * not a scalar. For OpenRouter, an id ABSENT from the current catalog is not
   * cached at all (`undefined`) — the catalog is re-fetched every poll, so the
   * engine rechecks it next tick instead of caching a permanent miss.
   */
  private resolvedContextByModel = new Map<string, number | null | undefined>();
  /**
   * Cached per-model effective output ceiling (resolved together with context
   * from the same limits lookup). Same lifecycle/caching discipline as
   * `resolvedContextByModel`. `undefined` = not attempted; `null` = permanent
   * failure (never retried); a number = the reported ceiling (or the safe
   * fallback when the backend reports none — see the resolver).
   */
  private resolvedOutputByModel = new Map<string, number | null | undefined>();
  /** Earliest ms timestamp at which a transient context-resolve failure may retry, per model. */
  private contextRetryAtByModel = new Map<string, number>();
  /** Array of callbacks so subscribers don't need to coordinate. */
  private callbacks: Array<(aggregated: ServerMetrics, raw: ServerRawData) => void> = [];

  /** Full set of configured wire model ids for this server (relay collection). */
  private modelIds: string[];
  /** Whether the OpenRouter account probe last succeeded — for transition logging. */
  private accountProbeSucceeded: boolean | undefined;

  /** Registry entry id this engine polls (the engine-registry key). */
  private serverId = '';

  constructor(
    private serverUrl: string,
    private requestHeaders: Record<string, string>,
    private serverType: ServerType = 'vllm',
    modelIds: string[] = [],
    private output?: vscode.OutputChannel,
  ) {
    this.modelIds = [...modelIds];
  }

  /** Claim the registry slot (called by getMetricsEngine on creation). */
  setServerId(serverId: string): void {
    this.serverId = serverId;
  }

  /**
   * Repoint this engine at the entry's current canonical URL. The engine
   * registry is keyed by ENTRY ID, which survives a hand-edited `serverUrl`,
   * so the reuse path must push the URL too — otherwise an entry moved to a
   * different box in settings keeps getting polled at its old address.
   */
  setUrl(serverUrl: string): void {
    if (this.serverUrl === serverUrl) return;
    this.serverUrl = serverUrl;
    // A different box may serve the same wire id with a different context
    // window: per-model resolutions are per-box truth, not per-entry truth.
    this.clearResolvedLimits();
  }

  /** Latest aggregated metrics (synchronous, may be null before first poll). */
  getCachedAggregated(): ServerMetrics | null { return this._lastAggregated; }

  /** Latest raw server data (synchronous, may be null before first poll). */
  getCachedRaw(): ServerRawData | null { return this._lastRaw; }

  /**
   * Subscribe to poll updates. The callback is invoked after each successful
   * fetch cycle with both the aggregated and raw data.
   * Returns a Disposable — dispose to unsubscribe.
   */
  subscribe(callback: (aggregated: ServerMetrics, raw: ServerRawData) => void): { dispose: () => void } {
    this.callbacks.push(callback);
    // The callback list IS the reference count — a separate counter can drift if
    // a disposable is disposed twice and then kill a subscriber still watching.
    if (this.callbacks.length === 1) {
      // First subscriber — start polling immediately
      void this.tick();
    }
    return { dispose: () => this.unsubscribe(callback) };
  }

  /**
   * Fetch immediately instead of waiting for the next interval, for a view that
   * just opened and wants a current reading. Safe to call any time: the pending
   * tick is dropped and {@link tick} reschedules itself when the cycle ends, so
   * the server never ends up on two polling chains.
   */
  pollNow(): void {
    if (this._disposed) return;
    this.stopPolling();
    void this.tick();
  }

  /** Update request headers in-place (called by getMetricsEngine on re-use). */
  setHeaders(headers: Record<string, string>): void {
    this.requestHeaders = { ...headers };
  }

  /** Update the backend type in-place (called by getMetricsEngine on re-use). */
  setServerType(serverType: ServerType): void {
    if (this.serverType === serverType) return;
    this.serverType = serverType;
    // A different backend resolves limits on an entirely different endpoint.
    this.clearResolvedLimits();
  }

  /** Per-model resolved limits describe the PREVIOUS url/backend: drop them. */
  private clearResolvedLimits(): void {
    this.resolvedContextByModel.clear();
    this.resolvedOutputByModel.clear();
    this.contextRetryAtByModel.clear();
  }

  /** Attach/refresh the output channel (called by getMetricsEngine on re-use). */
  setOutput(output?: vscode.OutputChannel): void {
    this.output = output;
  }

  /**
   * Update the full set of wire model ids for this server (relay model
   * collection). Each configured model's context window resolves independently
   * (OpenRouter models can have different windows). Prunes the per-model caches
   * of ids that are no longer configured, so a REMOVED model stops being
   * resolved (and a permanent `null` cache can't stick to a re-added id).
   */
  setModelIds(modelIds: string[]): void {
    this.modelIds = [...modelIds];
    const active = new Set(this.modelIds);
    for (const key of [...this.resolvedContextByModel.keys()]) {
      if (!active.has(key)) this.resolvedContextByModel.delete(key);
    }
    for (const key of [...this.resolvedOutputByModel.keys()]) {
      if (!active.has(key)) this.resolvedOutputByModel.delete(key);
    }
    for (const key of [...this.contextRetryAtByModel.keys()]) {
      if (!active.has(key)) this.contextRetryAtByModel.delete(key);
    }
  }

  dispose(): void {
    this._disposed = true;
    this.callbacks = [];
    this.stopPolling();
    // Prevent registry from returning this disposed zombie. The registry is
    // keyed by registry entry id, so the engine's own id is used.
    if (this.serverId && engineRegistry.get(this.serverId) === this) {
      engineRegistry.delete(this.serverId);
    }
  }

  private unsubscribe(callback: (aggregated: ServerMetrics, raw: ServerRawData) => void): void {
    const idx = this.callbacks.indexOf(callback);
    // Idempotent: a second dispose of the SAME subscription must not be counted
    // against the others, or it would tear the engine down under a viewer that is
    // still watching.
    if (idx < 0) return;
    this.callbacks.splice(idx, 1);
    if (this.callbacks.length === 0) {
      // Last subscriber left: release the engine entirely. This stops polling
      // AND removes it from the registry (via dispose), so a server whose
      // dashboard/deep-dive views are all closed stops being scraped and is
      // not kept alive in the module-level map. Without this, engines
      // accumulate for every URL ever opened.
      this.dispose();
    }
  }

  /** One fetch cycle: hit all endpoints, parse once, cache both views, notify. */
  private async tick(): Promise<void> {
    // One cycle at a time: a first `subscribe` and `pollNow` can both knock while
    // a cycle is already running, and overlapping cycles would each schedule
    // their own next tick (two chains polling the same server forever).
    if (this._disposed || this.inFlight) return;
    this.inFlight = true;

    try {
      const { aggregated, raw } = await fetchAllEndpoints(this.serverUrl, this.requestHeaders, this.serverType);

      if (this._disposed) return;

      // Resolve the per-backend context window(s), only for non-vLLM backends
      // and only while the server is online. A loaded model's context window is
      // static, so a SUCCESSFUL resolve is cached for the engine's lifetime —
      // never re-resolve it every poll (that would hammer llama.cpp /props or
      // Ollama /api/ps forever). Failures are classified:
      //   - validation failure (model reports no window) → permanent, never retry;
      //   - transient failure (network, 429/5xx, timeout) → retry after a bounded
      //     backoff so a one-off blip doesn't disable context for the session.
      // OpenRouter is a relay: every configured model resolves its own window
      // (a model collection can span models with different context lengths).
      // `maxModelLen` stays the first RESOLVED model's window — the server-level
      // row/tooltip; per-model windows ride in `contextByModel`.
      if (this.serverType !== 'vllm') {
        const contextByModel: Record<string, number> = {};
        const outputByModel: Record<string, number> = {};
        // OpenRouter optimization: the relay's `/v1/models` probe IS the model
        // catalog (every variant is its own full entry). Reuse that SAME
        // response to resolve all models' limits in one pass — no per-model
        // catalog re-download (the catalog is ~500KB for ~415 models).
        const openRouterCatalog = this.serverType === 'openrouter'
          ? raw.models as OpenRouterModelData[]
          : undefined;
        for (const modelId of this.modelIds) {
          const cached = this.resolvedContextByModel.get(modelId);
          let resolved = cached;
          if (cached === undefined) {
            const retryAt = this.contextRetryAtByModel.get(modelId) ?? 0;
            if (!aggregated.online || Date.now() < retryAt) continue;
            try {
              // Resolve BOTH limits in one call. OpenRouter resolves from the
              // shared catalog (context + output ceiling); the other backends
              // resolve context only (no output ceiling). The effective output
              // is captured here so the dashboard can flag when it is below the
              // configured budget — single authority for runtime limits, no
              // re-derivation in the view layer.
              const limits = openRouterCatalog
                ? normalizeOpenRouterFromCatalog(openRouterCatalog, modelId).runtimeLimits
                : await resolveRuntimeLimits(this.serverType, this.serverUrl, this.requestHeaders, modelId);
              resolved = limits.contextWindow;
              // Cache the output ceiling with the same discipline as context:
              // `undefined` = not attempted (skip); a number = the effective
              // ceiling; a resolver that returns no ceiling leaves output absent.
              // The resolver already guarantees a positive finite value or
              // undefined, so the guard mirrors the context path below.
              if (limits.maxOutputTokens !== undefined && limits.maxOutputTokens > 0) {
                this.resolvedOutputByModel.set(modelId, limits.maxOutputTokens);
              } else {
                this.resolvedOutputByModel.set(modelId, null);
              }
              // Defend the cache against a resolver that returns a non-number
              // without throwing: storing `undefined` would look like "not
              // attempted" and re-fire every tick, skipping the backoff.
              if (typeof resolved === 'number' && resolved > 0) {
                this.resolvedContextByModel.set(modelId, resolved);
              } else {
                this.resolvedContextByModel.set(modelId, null);
              }
            } catch (err) {
              if (err instanceof OpenRouterModelNotFoundError) {
                // Absent from THIS catalog snapshot. The catalog is already
                // re-fetched every poll, so recheck next tick rather than
                // caching a permanent miss — a transiently incomplete catalog
                // or propagation delay must not disable context. No extra HTTP.
                continue;
              }
              if (isPermanentContextError(err)) {
                this.resolvedContextByModel.set(modelId, null); // entry reports no window — unresolvable, stop retrying
                this.resolvedOutputByModel.set(modelId, null);
              } else {
                this.contextRetryAtByModel.set(modelId, Date.now() + CONTEXT_RESOLVE_RETRY_MS); // transient — retry later
              }
              continue;
            }
          }
          if (resolved == null) continue; // cached null (permanent) or unresolvable
          contextByModel[modelId] = resolved;
          if (aggregated.maxModelLen === null) aggregated.maxModelLen = resolved;
          const resolvedOutput = this.resolvedOutputByModel.get(modelId);
          if (typeof resolvedOutput === 'number' && resolvedOutput > 0) outputByModel[modelId] = resolvedOutput;
        }
        if (Object.keys(contextByModel).length > 0) aggregated.contextByModel = contextByModel;
        if (Object.keys(outputByModel).length > 0) aggregated.outputByModel = outputByModel;
      }

      // OpenRouter relay: per-model provider pricing from
      // `GET /api/v1/models/{id}/endpoints` (public + unauthenticated — the same
      // call Model Settings uses for the provider dropdown). Provider lists come
      // from the SHARED per-session cache (`getOpenRouterModelEndpointsCached`)
      // so the dashboard and Model Settings can never drift, and the cache owns
      // the display bound (2s abort on the real fetch — nothing runs orphaned),
      // in-flight dedup, TTL, and failure backoff. A missing or empty list
      // yields no row — the dashboard hides pricing rather than fabricating it.
      if (this.serverType === 'openrouter' && aggregated.online && this.modelIds.length > 0) {
        const settled = await Promise.allSettled(this.modelIds.map((id) => getOpenRouterModelEndpointsCached(id)));
        const providersByModel: Record<string, OpenRouterModelEndpoint[]> = {};
        for (let i = 0; i < this.modelIds.length; i++) {
          const s = settled[i];
          if (s.status === 'fulfilled' && s.value.length > 0) providersByModel[this.modelIds[i]] = s.value;
        }
        if (Object.keys(providersByModel).length > 0) aggregated.providersByModel = providersByModel;
      }

      this._lastAggregated = aggregated;
      this._lastRaw = raw;

      // Surface the OpenRouter account-probe failure in the output channel ONCE
      // per state transition (ok→fail), not on every 15s poll — repeated identical
      // warnings are noise, not clarity. Recovery (fail→ok) is logged as INFO.
      // Gated on the server being ONLINE: an offline server already reports its
      // own error and has no account data — blaming the account probe would be a
      // false attribution. The first observation (undefined → ok/fail) is recorded
      // silently — "recovered" on a fresh engine would be a false positive.
      if (this.serverType === 'openrouter' && aggregated.online) {
        const ok = aggregated.account !== undefined;
        if (this.accountProbeSucceeded !== undefined && ok !== this.accountProbeSucceeded) {
          if (ok) {
            this.output?.appendLine(`[INFO] OpenRouter account probe recovered for ${this.serverUrl}.`);
          } else {
            this.output?.appendLine(`[WARN] OpenRouter account probe failed for ${this.serverUrl} — credits/limits hidden. Check the API key.`);
          }
        }
        this.accountProbeSucceeded = ok;
      }

      // Notify all subscribers over a COPY: a one-shot subscriber (the Deep-Dive
      // panel) unsubscribes from inside its own callback, and splicing the live
      // array mid-iteration would shift later callbacks past the cursor.
      for (const cb of [...this.callbacks]) {
        try { cb(aggregated, raw); } catch { /* subscriber error — best-effort */ }
      }
    } catch (err) {
      // fetchAllEndpoints is error-proof via safeFetch, so this only fires on
      // programming errors (OOM, JSON bomb, etc.). Log to the output channel
      // (user-visible) and schedule retry.
      this.output?.appendLine(`[ERROR] Metrics engine tick failed for ${this.serverUrl}: ${err instanceof Error ? err.message : String(err)}`);
      console.error('[vllm-copilot] metrics engine tick failed:', err);
    } finally {
      this.inFlight = false;
      // Always schedule next cycle — even on error we retry
      if (!this._disposed && this.callbacks.length > 0) {
        this.pollTimer = setTimeout(() => this.tick(), getPollSettingMs());
      }
    }
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}

/** Read the configured poll interval (in ms) from VS Code settings.
 * Exported so the dashboard's Refresh-Interval row reads the SAME value
 * through the SAME default+catch instead of duplicating the lookup (P11-1). */
export function getPollSettingMs(): number {
  try {
    return vscode.workspace.getConfiguration('vllm-copilot.dashboard').get<number>('pollIntervalMs', DEFAULT_POLL_MS);
  } catch {
    return DEFAULT_POLL_MS;
  }
}

// ─── Engine Registry ────────────────────────────────────────────────

/** Module-level map of registry entry id → engine (see {@link
 * getMetricsEngine}). One engine per `vllm-copilot.servers` entry, never
 * shared across entries: two entries describing the same box are polled
 * separately, each with its own credentials — one entry's auth must never
 * drive another's metrics. */
const engineRegistry = new Map<string, ServerMetricsEngine>();

/**
 * Get or create the {@link ServerMetricsEngine} for one server registry entry.
 * Engines are shared across the dashboard and deep-dive views via this registry.
 * The engine is disposed when the last subscriber unsubscribes.
 *
 * The registry is keyed by the `vllm-copilot.servers` ENTRY ID — the registry's
 * unique, user-facing identifier. No URL/header hashing: an entry IS a server,
 * its id IS its identity, and two entries describing the same box are two
 * entries (each polled honestly). Re-use refreshes headers/backend type/output
 * in place, so an Update Auth write lands on the live engine without any
 * re-keying: the id never moves.
 *
 * @param serverId - Registry entry id (the engine-registry key)
 * @param serverUrl - The server URL (canonicalized internally for fetching)
 * @param requestHeaders - Auth/routing headers for this server
 */
export function getMetricsEngine(
  serverId: string,
  serverUrl: string,
  requestHeaders?: Record<string, string>,
  serverType: ServerType = 'vllm',
  modelIds?: string[],
  output?: vscode.OutputChannel,
): ServerMetricsEngine {
  const canonical = normalizeServerUrl(serverUrl);
  const headers = sanitizeRequestHeaders(requestHeaders ?? {});
  let engine = engineRegistry.get(serverId);
  if (!engine) {
    engine = new ServerMetricsEngine(canonical, headers, serverType, modelIds, output);
    engine.setServerId(serverId);
    engineRegistry.set(serverId, engine);
  } else {
    // The entry id is the key, so every field behind it is ordinary mutable
    // state: push the caller's set on every lookup. Update Auth writes
    // settings, then any view refresh or explicit refreshEngineHeaders carries
    // the new auth; a hand-edited serverUrl/serverType follows on the next
    // refresh the same way. No re-keying — the id never moves.
    engine.setUrl(canonical);
    engine.setHeaders(headers);
    engine.setServerType(serverType);
    engine.setOutput(output);
  }
  // modelIds is the sole source of truth; `undefined` = caller doesn't manage
  // the set (leave as-is), an explicit [] = clear.
  if (modelIds !== undefined) {
    engine.setModelIds(modelIds);
  }
  return engine;
}

/**
 * Push freshly rotated credentials into the engine of one registry entry, if it
 * exists. Update Auth must never CREATE a zero-subscriber engine (an engine only
 * exists while a dashboard/deep-dive is subscribed), so this is update-if-present
 * by entry id — no old-identity lookup, no re-keying: the id is stable across
 * any header change.
 */
export function refreshEngineHeaders(
  serverId: string,
  nextHeaders: Record<string, string>,
): void {
  const engine = engineRegistry.get(serverId);
  if (engine) engine.setHeaders(sanitizeRequestHeaders(nextHeaders));
}

// ─── Unified Fetch ──────────────────────────────────────────────────

/**
 * Fetch all vLLM endpoints and produce both ServerMetrics and ServerRawData.
 *
 * This is the single HTTP cycle shared by dashboard and deep-dive. The
 * Prometheus text is parsed twice (once for aggregates, once for raw buckets)
 * — the HTTP cost dwarfs the CPU cost, so the unified fetch is the important
 * optimization.
 *
 * Response bodies are read once and cached as text to avoid double-consumption
 * errors (Response body can only be read once).
 */
async function fetchAllEndpoints(
  serverUrl: string,
  requestHeaders: Record<string, string>,
  serverType: ServerType = 'vllm',
): Promise<{ aggregated: ServerMetrics; raw: ServerRawData }> {
  const baseUrl = serverUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const headers = buildRequestHeaders(undefined, requestHeaders);

  // OpenRouter relay: account/key health via `GET /api/v1/key`. Fired
  // CONCURRENTLY with the endpoint fetches — it has its own timeout and must
  // never stall the metrics cycle behind a slow /api/v1/key. Fails silently
  // (bad/missing key, transient) → undefined → the dashboard hides the account
  // rows rather than fabricating credits. Same for the account budget
  // (`GET /api/v1/credits`), fired alongside.
  const accountPromise = serverType === 'openrouter'
    ? fetchOpenRouterAccount(requestHeaders)
    : Promise.resolve(undefined);
  const creditsPromise = serverType === 'openrouter'
    ? fetchOpenRouterCredits(requestHeaders)
    : Promise.resolve(undefined);

  // Vary the inquiry by backend. vLLM exposes the full set: /health, /v1/models,
  // /version, /metrics, /load. Non-vLLM backends (LM Studio, llama.cpp, Ollama,
  // OpenRouter) share only the OpenAI-compatible /v1/models — the other endpoints
  // 404 / don't exist, so probing them is pointless. /v1/models doubles as the
  // reachability probe for those backends (chat already relies on it).
  const isVllm = serverType === 'vllm';
  const [healthRes, v1ModelsRes, versionText, metricsText, loadText] = isVllm
    ? await Promise.all([
        safeFetch(buildEndpoint(baseUrl, 'health'), { signal: controller.signal, headers }),
        safeFetch(buildEndpoint(baseUrl, 'v1/models'), { signal: controller.signal, headers }),
        safeFetch(buildEndpoint(baseUrl, 'version'), { signal: controller.signal, headers }).then(r => r?.ok ? r.text() : ''),
        safeFetch(buildEndpoint(baseUrl, 'metrics'), { signal: controller.signal, headers }).then(r => r?.ok ? r.text() : ''),
        safeFetch(buildEndpoint(baseUrl, 'load'), { signal: controller.signal, headers }).then(r => r?.ok ? r.text() : ''),
      ])
    : await Promise.all([
        Promise.resolve(new Response(null, { status: 404 })), // no /health for non-vLLM
        safeFetch(buildEndpoint(baseUrl, 'v1/models'), { signal: controller.signal, headers }),
        Promise.resolve(''), // no /version
        Promise.resolve(''), // no /metrics
        Promise.resolve(''), // no /load
      ]);
  clearTimeout(timer);
  const modelsText = v1ModelsRes?.ok ? await v1ModelsRes.text() : '';

  // ── Shared parse helpers ──
  const parseJsonSafe = <T>(text: string): T | undefined => {
    try { return JSON.parse(text) as T; } catch { return undefined; }
  };

  // ── Parse Models (used by both aggregated and raw) ──
  const modelNames: string[] = [];
  let maxModelLen: number | null = null;
  let parsedModels: Array<Record<string, unknown>> = [];
  let malformedOpenRouterCatalog = false;
  if (serverType === 'openrouter' && v1ModelsRes?.ok) {
    // OpenRouter's /v1/models IS the authoritative catalog. The SAME boundary
    // as fetchOpenRouterCatalog() applies to EVERY successful response,
    // including an empty body (shared parser, audit P16-2 — this rule used to
    // be sync'd by comment, one drift from a lying dashboard): a 200/204 that
    // is not `{ data: [...] }` is a malformed protocol response, never a
    // healthy empty catalog — otherwise a broken relay body would read as an
    // online server with no models. Entries without a string id are dropped.
    const catalog = modelsText
      ? parseOpenRouterCatalogData<Record<string, unknown>>(parseJsonSafe<unknown>(modelsText))
      : undefined;
    if (catalog === undefined) {
      malformedOpenRouterCatalog = true;
    } else {
      parsedModels = catalog;
    }
  } else if (modelsText) {
    const modelsData = parseJsonSafe<{ data?: Array<Record<string, unknown>> }>(modelsText);
    if (Array.isArray(modelsData?.data)) {
      parsedModels = modelsData.data;
    }
  }
  for (const m of parsedModels) {
    if (typeof m.id === 'string') modelNames.push(m.id);
    if (typeof m.max_model_len === 'number' && m.max_model_len > 0) maxModelLen = m.max_model_len;
  }

  // ── Parse Version (used by both aggregated and raw) ──
  let version: string | undefined;
  let parsedVersion: Record<string, unknown> | undefined;
  if (versionText) {
    parsedVersion = parseJsonSafe<Record<string, unknown>>(versionText);
    version = parsedVersion?.version as string | undefined;
  }

  // ── Parse Server Load (only for deep-dive) ──
  let serverLoad: number | undefined;
  if (loadText) {
    const loadData = parseJsonSafe<{ server_load?: number }>(loadText);
    serverLoad = loadData?.server_load;
  }

  // ── Online check ──
  // vLLM documents `/health`; LM Studio, llama.cpp, and Ollama do not (their
  // OpenAI-compatible `/v1/models` is the reachability signal, and it's the
  // endpoint the chat path actually uses). Gating online solely on `/health` made
  // every non-vLLM server appear offline — hiding the degraded notice, measured
  // throughput, Last Request, and Token Usage nodes even though chat works.
  const probeRes = isVllm ? healthRes : v1ModelsRes;
  // `null` = the request never got an answer (unreachable / timed out), which is
  // a different reason than "answered, but with an error status".
  const probeOk = probeRes?.ok === true;
  // A reachable OpenRouter relay that returns a malformed catalog is NOT a
  // healthy server — report it as an error instead of an online empty catalog.
  const online = isVllm ? probeOk : (probeOk && !malformedOpenRouterCatalog);
  const errorStr = online
    ? undefined
    : malformedOpenRouterCatalog
      ? `OpenRouter /v1/models returned a malformed catalog (expected { data: [...] })`
      : !probeRes
        ? 'Cannot connect'
        : isVllm
          ? `Health check failed: ${probeRes.status}`
          : `${serverType} /v1/models failed: ${probeRes.status}`;

  // ── Health body (for deep-dive) ──
  const healthBody = online && healthRes?.ok ? await healthRes.text() : undefined;

  // ── OpenRouter relay: account/key health + budget (awaited here so the
  // ── endpoint fetches above ran in parallel — never a serial stall). The probes
  // are display-only and re-run every tick, so a late/slow result is worthless:
  // bound them below the poll interval so a hung endpoint can't stretch the
  // cadence. (The probes never reject — they return undefined on failure.)
  const [account, credits] = await Promise.all([
    Promise.race([
      accountPromise,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
    ]),
    Promise.race([
      creditsPromise,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
    ]),
  ]);

  // ── Build ServerMetrics (aggregated, for dashboard) ──
  const parser = new MetricsParser();
  parser.parse(metricsText);
  const aggregated = parser.aggregate();
  const allModels = [...new Set([...modelNames, ...aggregated.models])];

  const serverMetrics: ServerMetrics = online
    ? { online: true, version, ...aggregated, models: allModels, maxModelLen, account, credits }
    : emptyMetrics(errorStr ?? 'Unknown error');

  // ── Build ServerRawData (raw, for deep-dive) ──
  const raw: ServerRawData = {
    models: parsedModels,
    metrics: {
      gauges: {},
      counters: {},
      histograms: {},
      cache_config: {},
      process: {},
      http: {},
    },
  };
  if (online && healthRes) {
    raw.healthStatus = healthRes.status;
    if (healthBody) raw.healthBody = healthBody;
    if (parsedVersion) raw.version = parsedVersion;
    if (serverLoad != null) raw.serverLoad = serverLoad;
    if (metricsText) {
      try { parseRawMetrics(metricsText, raw.metrics); } catch { /* non-critical */ }
    }
  }

  return { aggregated: serverMetrics, raw };
}

/**
 * Fetch wrapper that never throws — returns `null` when the request itself
 * failed (unreachable, refused, aborted by the cycle timeout). `null` is
 * distinct from "answered with an error status", which stays a real Response.
 * (A synthetic `new Response(null, {status: 0})` is NOT constructible — the
 * Response constructor requires 200..599 — so a status-0 sentinel would throw
 * right back out of the catch and take the whole cycle down with it.)
 */
async function safeFetch(url: string, options: RequestInit): Promise<Response | null> {
  try { return await fetch(url, options); }
  catch { return null; }
}

/** Build an empty/error ServerMetrics. Exported for the dashboard's
 * pre-first-poll fallback (one literal, not a per-module twin). */
export function emptyMetrics(error: string): ServerMetrics {
  return {
    online: false, error,
    models: [], maxModelLen: null, kvCacheUsagePercent: null, runningRequests: null, waitingRequests: null,
    cacheHitRate: null, specAcceptanceRate: null, specDraftsTotal: null, specDraftDepth: null,
    avgTTFTMs: null, avgTPOTMs: null, avgTputTokPerSec: null, avgPrefillTputTokPerSec: null, preemptions: null, evictions: null,
  };
}

/** Bounded backoff before retrying a TRANSIENT context-resolve failure. */
const CONTEXT_RESOLVE_RETRY_MS = 60_000;

/**
 * True when a context-resolve error is a PERMANENT validation failure — the
 * backend reported a response but the model genuinely has no usable context
 * bound (retrying can never change that). Everything else (network errors,
 * HTTP 429/5xx, timeouts) is transient and retryable. The OpenRouter resolver
 * throws a typed {@link PermanentContextError}; the other backends' resolvers
 * throw plain Errors whose messages carry the marker strings below.
 */
function isPermanentContextError(err: unknown): boolean {
  if (err instanceof PermanentContextError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('has no runtime context window') ||
    msg.includes('has no context window') ||
    msg.includes('is not loaded (or reports no context_length)') ||
    msg.includes('reports no positive context bound')
  );
}

/**
 * Parse raw Prometheus text into categorized buckets (gauges, counters, histograms, etc.).
 * This is a simpler parser than MetricsParser — it just categorizes raw entries.
 */
function parseRawMetrics(rawText: string, metrics: ServerRawData['metrics']): void {
  const lineRe = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE+-]+)$/;
  const typeHints: Record<string, 'gauge' | 'counter' | 'histogram'> = {};
  const helpDesc: Record<string, string> = {};

  // First pass: detect types from TYPE lines (authoritative) + descriptions from HELP lines.
  // Prometheus emits `# TYPE <name> <gauge|counter|histogram>` before the samples. Rely on it
  // rather than string-matching suffixes: the histogram family emits `_bucket`, `_sum`, and
  // `_count` lines, and suffix matching misclassifies `_sum` as a gauge and `_count` as a counter.
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    const typeMatch = trimmed.match(/^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(gauge|counter|histogram)\s*$/);
    if (typeMatch) {
      typeHints[typeMatch[1]] = typeMatch[2] as 'gauge' | 'counter' | 'histogram';
      continue;
    }
    const helpMatch = trimmed.match(/^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(.+)/);
    if (helpMatch) helpDesc[helpMatch[1]] = helpMatch[2].trim();
  }

  /**
   * Classify a sample by its family type. Histogram families emit `_bucket`/`_sum`/`_count`
   * suffixes on the same family — strip the suffix and look up the base name. Falls back to
   * string heuristics only when no `# TYPE` line is present (process_/http_/cache_config paths).
   */
  const classify = (name: string): 'gauge' | 'counter' | 'histogram' => {
    const family = typeHints[name] ?? typeHints[name.replace(/_bucket$/, '').replace(/_sum$/, '').replace(/_count$/, '')];
    if (family) return family;
    if (name.includes('_bucket')) return 'histogram';
    if (name.includes('_total') || name.includes('_count')) return 'counter';
    return 'gauge';
  };

  // Second pass: parse data lines
  for (const line of rawText.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const m = trimmed.match(lineRe);
    if (!m) continue;

    const [, name, labelsRaw, valueRaw] = m;
    const labels = parseLabels(labelsRaw);
    const value = parseFloat(valueRaw);
    if (isNaN(value)) continue;

    // Skip Prometheus auto-generated _created timestamps — noise, not data
    if (name.endsWith('_created')) continue;

    const entry: RawMetricEntry = { name, labels, value };
    const bucket = classify(name);

    entry.type = bucket;

    // Attach description from HELP line (use base name for _bucket/_sum/_count suffixes)
    const baseName = name.replace(/_bucket$/, '').replace(/_sum$/, '').replace(/_count$/, '');
    if (helpDesc[name]) entry.description = helpDesc[name];
    else if (helpDesc[baseName]) entry.description = helpDesc[baseName];

    // Cache config: handle both old vllm:cache_config_<key> and new vllm:cache_config_info{labels}
    if (name.startsWith('vllm:') && name.includes('cache_config')) {
      const shortName = name.replace('vllm:cache_config_', '');
      if (shortName === 'info' && Object.keys(labels).length > 0) {
        // New format: vllm:cache_config_info{kv_cache_max_concurrency="2.5",block_size="16",...} 1.0
        // Labels ARE the config values
        for (const [k, v] of Object.entries(labels)) {
          metrics.cache_config[k] = v;
        }
      } else if (shortName !== 'info') {
        // Old format: vllm:cache_config_block_size 16
        metrics.cache_config[shortName] = value;
      }
    } else if (name.startsWith('process_')) {
      const arr = (metrics.process[name] = metrics.process[name] || []);
      arr.push(entry);
    } else if (name.startsWith('http_')) {
      const arr = (metrics.http[name] = metrics.http[name] || []);
      arr.push(entry);
    } else if (name.startsWith('vllm:') && bucket === 'histogram') {
      const shortName = name.replace('vllm:', '');
      const arr = (metrics.histograms[shortName] = metrics.histograms[shortName] || []);
      arr.push(entry);
    } else if (name.startsWith('vllm:') && bucket === 'counter') {
      const shortName = name.replace('vllm:', '');
      const arr = (metrics.counters[shortName] = metrics.counters[shortName] || []);
      arr.push(entry);
    } else if (name.startsWith('vllm:')) {
      const shortName = name.replace('vllm:', '');
      const arr = (metrics.gauges[shortName] = metrics.gauges[shortName] || []);
      arr.push(entry);
    }
  }
}

// Formatting helpers live in dashboard.ts (its tree rows are the only
// consumers — U7). This module produces DATA, not display strings.