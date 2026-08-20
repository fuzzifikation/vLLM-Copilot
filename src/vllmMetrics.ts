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
import { buildEndpoint, normalizeServerUrl, serverFingerprint, type ServerType } from './config.js';
import { buildRequestHeaders } from './fetchRetry.js';
import { resolveRuntimeLimits } from './runtimeLimits.js';
import {
  fetchOpenRouterAccount,
  fetchOpenRouterModelEndpoints,
  resolveOpenRouterLimitsFromCatalog,
  PermanentContextError,
  OpenRouterModelNotFoundError,
  type OpenRouterAccount,
  type OpenRouterModelData,
  type OpenRouterModelEndpoint,
} from './openRouter.js';

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
  /** OpenRouter account/key health from `GET /api/v1/key` (relay node). */
  account?: OpenRouterAccount;
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
  private subscriberCount = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
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
  /** Earliest ms timestamp at which a transient context-resolve failure may retry, per model. */
  private contextRetryAtByModel = new Map<string, number>();
  /** Cached per-model provider lists (OpenRouter `/endpoints`). modelId → providers. */
  private providersByModelCache = new Map<string, OpenRouterModelEndpoint[]>();
  /** Earliest ms at which a failed provider fetch may retry, per model. */
  private providersRetryAtByModel = new Map<string, number>();
  /** Array of callbacks so subscribers don't need to coordinate. */
  private callbacks: Array<(aggregated: ServerMetrics, raw: ServerRawData) => void> = [];

  /** Full set of configured wire model ids for this server (relay collection). */
  private modelIds: string[];
  /** Whether the OpenRouter account probe last succeeded — for transition logging. */
  private accountProbeSucceeded: boolean | undefined;

  /** Registry key this engine is registered under (identity fingerprint). */
  private registryKey = '';

  constructor(
    private serverUrl: string,
    private requestHeaders: Record<string, string>,
    private serverType: ServerType = 'vllm',
    modelIds: string[] = [],
    private output?: vscode.OutputChannel,
  ) {
    this.modelIds = [...modelIds];
  }

  /** Set the registry key (called by getMetricsEngine / updateMetricsEngineHeaders). */
  setRegistryKey(key: string): void {
    this.registryKey = key;
  }

  /** The canonical server URL this engine fetches (used for registry re-keying). */
  getServerUrl(): string {
    return this.serverUrl;
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
    this.subscriberCount++;
    if (this.subscriberCount === 1) {
      // First subscriber — start polling immediately
      this.tick();
    }
    return { dispose: () => this.unsubscribe(callback) };
  }

  /** Update request headers in-place (called by getMetricsEngine on re-use). */
  setHeaders(headers: Record<string, string>): void {
    this.requestHeaders = { ...headers };
  }

  /** Update the backend type in-place (called by getMetricsEngine on re-use). */
  setServerType(serverType: ServerType): void {
    this.serverType = serverType;
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
    for (const key of [...this.contextRetryAtByModel.keys()]) {
      if (!active.has(key)) this.contextRetryAtByModel.delete(key);
    }
    for (const key of [...this.providersByModelCache.keys()]) {
      if (!active.has(key)) this.providersByModelCache.delete(key);
    }
    for (const key of [...this.providersRetryAtByModel.keys()]) {
      if (!active.has(key)) this.providersRetryAtByModel.delete(key);
    }
  }

  dispose(): void {
    this._disposed = true;
    this.subscriberCount = 0;
    this.callbacks = [];
    this.stopPolling();
    // Prevent registry from returning this disposed zombie. The registry is
    // keyed by identity (URL + headers), so the engine's own key is used.
    if (this.registryKey && engineRegistry.get(this.registryKey) === this) {
      engineRegistry.delete(this.registryKey);
    }
  }

  private unsubscribe(callback: (aggregated: ServerMetrics, raw: ServerRawData) => void): void {
    const idx = this.callbacks.indexOf(callback);
    if (idx >= 0) this.callbacks.splice(idx, 1);
    this.subscriberCount--;
    if (this.subscriberCount <= 0) {
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
    if (this._disposed) return;

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
        // OpenRouter optimization: the relay's `/v1/models` probe IS the model
        // catalog (every variant is its own full entry). Reuse that SAME
        // response to resolve all models' windows in one pass — no per-model
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
              resolved = openRouterCatalog
                ? resolveOpenRouterLimitsFromCatalog(openRouterCatalog, modelId).contextWindow
                : (await resolveRuntimeLimits(this.serverType, this.serverUrl, this.requestHeaders, modelId)).contextWindow;
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
              } else {
                this.contextRetryAtByModel.set(modelId, Date.now() + CONTEXT_RESOLVE_RETRY_MS); // transient — retry later
              }
              continue;
            }
          }
          if (resolved == null) continue; // cached null (permanent) or unresolvable
          contextByModel[modelId] = resolved;
          if (aggregated.maxModelLen === null) aggregated.maxModelLen = resolved;
        }
        if (Object.keys(contextByModel).length > 0) aggregated.contextByModel = contextByModel;
      }

      // OpenRouter relay: per-model provider pricing from
      // `GET /api/v1/models/{id}/endpoints` (public + unauthenticated — the same
      // call Model Settings uses for the provider dropdown). Fetched ONCE per
      // engine lifetime, like per-model context: pricing is static enough that a
      // slightly stale rate beats hammering N endpoints every poll. A failure
      // retries after the same bounded backoff as context resolution; a missing
      // or empty list yields no row — the dashboard hides pricing rather than
      // fabricating it. Only models with cached lists are exposed, matched by id.
      // The fetches race a 2s bound (same discipline as the account probe) so a
      // hung /endpoints can NEVER stall the metrics cycle behind its 10s timeout —
      // pricing is display-only; a late/slow result is not worth blocking the
      // dashboard, which otherwise refreshes on every poll.
      if (this.serverType === 'openrouter' && aggregated.online && this.modelIds.length > 0) {
        const pending = this.modelIds.filter((id) => {
          if (this.providersByModelCache.has(id)) return false;
          return (this.providersRetryAtByModel.get(id) ?? 0) <= Date.now();
        });
        if (pending.length > 0) {
          const settled = await Promise.race([
            Promise.allSettled(pending.map((id) => fetchOpenRouterModelEndpoints(id))),
            new Promise<PromiseSettledResult<OpenRouterModelEndpoint[]>[]>(
              (resolve) => setTimeout(() => resolve(pending.map(() => ({ status: 'rejected' as const, reason: new Error('timed out') }))), 2000),
            ),
          ]);
          for (let i = 0; i < pending.length; i++) {
            const id = pending[i];
            const s = settled[i];
            if (s.status === 'fulfilled') {
              if (s.value.length > 0) this.providersByModelCache.set(id, s.value);
            } else {
              this.providersRetryAtByModel.set(id, Date.now() + CONTEXT_RESOLVE_RETRY_MS);
            }
          }
        }
        const providersByModel: Record<string, OpenRouterModelEndpoint[]> = {};
        for (const id of this.modelIds) {
          const cached = this.providersByModelCache.get(id);
          if (cached && cached.length > 0) providersByModel[id] = cached;
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

      // Notify all subscribers
      for (const cb of this.callbacks) {
        try { cb(aggregated, raw); } catch { /* subscriber error — best-effort */ }
      }
    } catch (err) {
      // fetchAllEndpoints is error-proof via safeFetch, so this only fires on
      // programming errors (OOM, JSON bomb, etc.). Log to the output channel
      // (user-visible) and schedule retry.
      this.output?.appendLine(`[ERROR] Metrics engine tick failed for ${this.serverUrl}: ${err instanceof Error ? err.message : String(err)}`);
      console.error('[vllm-copilot] metrics engine tick failed:', err);
    } finally {
      // Always schedule next cycle — even on error we retry
      if (!this._disposed && this.subscriberCount > 0) {
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

/** Read the configured poll interval (in ms) from VS Code settings. */
function getPollSettingMs(): number {
  try {
    return vscode.workspace.getConfiguration('vllm-copilot.dashboard').get<number>('pollIntervalMs', DEFAULT_POLL_MS);
  } catch {
    return DEFAULT_POLL_MS;
  }
}

// ─── Engine Registry ────────────────────────────────────────────────

/** Module-level map of server identity → engine. Keyed by URL + header
 * fingerprint, NOT URL alone — headers are per-model, so two models sharing a
 * URL with different credentials/scopes are DIFFERENT logical servers and each
 * gets its own engine (one model's credentials must never drive a sibling's
 * metrics). Hand-edited URL spellings of the same server still share one
 * engine because the fingerprint is computed over the canonical URL. */
const engineRegistry = new Map<string, ServerMetricsEngine>();

/**
 * Get or create a {@link ServerMetricsEngine} for the given server identity.
 * Engines are shared across the dashboard and deep-dive views via this registry.
 * The engine is disposed-rece when the last subscriber unsubscribes.
 *
 * The registry is keyed by URL + header fingerprint, so distinct credentials
 * on one URL get independent engines. Re-use with the SAME identity updates
 * backend type/output in place; a different identity is a separate engine.
 *
 * @param serverUrl - The vLLM server URL
 * @param requestHeaders - Auth/routing headers for this server
 */
export function getMetricsEngine(
  serverUrl: string,
  requestHeaders?: Record<string, string>,
  serverType: ServerType = 'vllm',
  modelIds?: string[],
  output?: vscode.OutputChannel,
): ServerMetricsEngine {
  // Key engines by the canonical server URL (scheme added, trailing slash and
  // trailing /v1 stripped) so hand-edited variants of the same server — e.g.
  // `http://host:8000`, `http://host:8000/`, `http://host:8000/v1` — share one
  // engine, plus the header fingerprint so different credential sets on one URL
  // stay separate. The engine stores the canonical URL for fetching; the key is
  // its registry identity.
  const canonical = normalizeServerUrl(serverUrl);
  const key = serverFingerprint(canonical, requestHeaders ?? {});
  let engine = engineRegistry.get(key);
  if (!engine) {
    engine = new ServerMetricsEngine(canonical, requestHeaders ?? {}, serverType, modelIds, output);
    engine.setRegistryKey(key);
    engineRegistry.set(key, engine);
  } else {
    if (requestHeaders && Object.keys(requestHeaders).length > 0) {
      // Update headers on re-use so auth changes propagate (same identity)
      engine.setHeaders(requestHeaders);
    }
    // Update backend type on re-use so a dashboard/deep-dive opened for a
    // non-vLLM server probes online via that backend's own endpoint, even if the
    // engine was first created before the type was known.
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
 * Update request headers on existing metrics engines for this server, if any.
 * Unlike {@link getMetricsEngine}, this never creates an engine — it exists so
 * header-only updates (e.g. Update Auth) don't leak a zero-subscriber registry
 * entry. No-op when no engine exists.
 *
 * Update Auth converges ALL models on a URL to the same headers, so every
 * engine registered for that URL is updated in place and re-keyed to the new
 * identity. (Two pre-update identities on one URL become one identity.)
 *
 * @param serverUrl - The vLLM server URL (canonicalized internally)
 * @param requestHeaders - New auth/routing headers
 */
export function updateMetricsEngineHeaders(serverUrl: string, requestHeaders: Record<string, string>): void {
  const canonical = normalizeServerUrl(serverUrl);
  const newKey = serverFingerprint(canonical, requestHeaders ?? {});
  // Collect first — we mutate the map while iterating.
  const targets: Array<[string, ServerMetricsEngine]> = [];
  for (const [key, engine] of engineRegistry) {
    if (normalizeServerUrl(engine.getServerUrl()) === canonical) targets.push([key, engine]);
  }
  for (const [oldKey, engine] of targets) {
    engine.setHeaders(requestHeaders ?? {});
    engine.setRegistryKey(newKey);
    if (oldKey !== newKey) {
      engineRegistry.delete(oldKey);
      engineRegistry.set(newKey, engine);
    }
  }
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
  // rows rather than fabricating credits.
  const accountPromise = serverType === 'openrouter'
    ? fetchOpenRouterAccount(requestHeaders)
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
        safeFetch(buildEndpoint(baseUrl, 'version'), { signal: controller.signal, headers }).then(r => r.ok ? r.text() : ''),
        safeFetch(buildEndpoint(baseUrl, 'metrics'), { signal: controller.signal, headers }).then(r => r.ok ? r.text() : ''),
        safeFetch(buildEndpoint(baseUrl, 'load'), { signal: controller.signal, headers }).then(r => r.ok ? r.text() : ''),
      ])
    : await Promise.all([
        Promise.resolve(new Response(null, { status: 404 })), // no /health for non-vLLM
        safeFetch(buildEndpoint(baseUrl, 'v1/models'), { signal: controller.signal, headers }),
        Promise.resolve(''), // no /version
        Promise.resolve(''), // no /metrics
        Promise.resolve(''), // no /load
      ]);
  clearTimeout(timer);
  const modelsText = v1ModelsRes.ok ? await v1ModelsRes.text() : '';

  // ── Shared parse helpers ──
  const parseJsonSafe = <T>(text: string): T | undefined => {
    try { return JSON.parse(text) as T; } catch { return undefined; }
  };

  // ── Parse Models (used by both aggregated and raw) ──
  const modelNames: string[] = [];
  let maxModelLen: number | null = null;
  let parsedModels: Array<Record<string, unknown>> = [];
  let malformedOpenRouterCatalog = false;
  if (serverType === 'openrouter' && v1ModelsRes.ok) {
    // OpenRouter's /v1/models IS the authoritative catalog. Apply the same
    // boundary as fetchOpenRouterCatalog() to EVERY successful response,
    // including an empty body: a 200/204 that is not `{ data: [...] }` is a
    // malformed protocol response, never a healthy empty catalog — otherwise a
    // broken relay body would read as an online server with no models. Entries
    // without a string id are dropped (they can never match an exact id).
    let data: unknown;
    if (modelsText) {
      data = parseJsonSafe<{ data?: unknown }>(modelsText)?.data;
    }
    if (!Array.isArray(data)) {
      malformedOpenRouterCatalog = true;
    } else {
      parsedModels = (data as Array<Record<string, unknown>>).filter(
        (m) => !!m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string',
      );
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
  // A reachable OpenRouter relay that returns a malformed catalog is NOT a
  // healthy server — report it as an error instead of an online empty catalog.
  const online = isVllm ? probeRes.ok : (probeRes.ok && !malformedOpenRouterCatalog);
  const errorStr = online
    ? undefined
    : malformedOpenRouterCatalog
      ? `OpenRouter /v1/models returned a malformed catalog (expected { data: [...] })`
      : probeRes.status === 0
        ? 'Cannot connect'
        : isVllm
          ? `Health check failed: ${probeRes.status}`
          : `${serverType} /v1/models failed: ${probeRes.status}`;

  // ── Health body (for deep-dive) ──
  const healthBody = online && healthRes.ok ? await healthRes.text() : undefined;

  // ── OpenRouter relay: account/key health (awaited here so the endpoint
  // ── fetches above ran in parallel — never a serial stall). The probe is
  // display-only and re-runs every tick, so a late/slow result is worthless:
  // bound it below the poll interval so a hung /api/v1/key can't stretch the
  // cadence. (The probe never rejects — it returns undefined on failure.)
  const account = await Promise.race([
    accountPromise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
  ]);

  // ── Build ServerMetrics (aggregated, for dashboard) ──
  const parser = new MetricsParser();
  parser.parse(metricsText);
  const aggregated = parser.aggregate();
  const allModels = [...new Set([...modelNames, ...aggregated.models])];

  const serverMetrics: ServerMetrics = online
    ? { online: true, version, ...aggregated, models: allModels, maxModelLen, account }
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
  if (online) {
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

/** Fetch wrapper that never throws — returns a Response with status 0 on failure. */
async function safeFetch(url: string, options: RequestInit): Promise<Response> {
  try { return await fetch(url, options); }
  catch { return new Response(null, { status: 0 }); }
}

/** Build an empty/error ServerMetrics. */
function emptyMetrics(error: string): ServerMetrics {
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
export function parseRawMetrics(rawText: string, metrics: ServerRawData['metrics']): void {
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

// ─── Formatting ──────────────────────────────────────────────────────

export function fmtPct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v)}%`;
}

export function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function fmtN(v: number | null): string {
  return v == null ? '—' : String(v);
}

export function fmtThroughput(avgTPOTms: number | null): string {
  if (avgTPOTms == null || avgTPOTms <= 0) return '—';
  return fmtTokPerSec(1000 / avgTPOTms);
}

/** Format a directly-computed tokens/sec value (pooled throughput ratio). */
export function fmtTokPerSec(tokPerSec: number | null): string {
  if (tokPerSec == null || tokPerSec <= 0) return '—';
  return tokPerSec >= 100
    ? `${Math.round(tokPerSec)} tok/s`
    : `${tokPerSec.toFixed(1)} tok/s`;
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port}`;
  } catch {
    return url.replace(/\/+$/, '');
  }
}