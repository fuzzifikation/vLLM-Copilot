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
import { buildRequestHeaders, transportErrorCode } from '../shared/fetchRetry.js';
import { listServerModels, resolveRuntimeLimits, type ServerModelEntry } from '../backends/runtimeLimits.js';
import {
  probeOpenRouterKey,
  fetchOpenRouterCredits,
  fetchOpenRouterCatalog,
  getOpenRouterModelEndpointsCached,
  normalizeOpenRouterFromCatalog,
  PermanentContextError,
  OpenRouterModelNotFoundError,
  type OpenRouterAccount,
  type OpenRouterCredits,
  type OpenRouterModelData,
  type OpenRouterModelEndpoint,
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
  /** Accepted-token counts indexed by draft position (the counter's
   *  `position` label). vLLM pre-creates one counter per position up to
   *  `num_speculative_tokens`, so the filled length is the configured depth k. */
  specAcceptedPerPos: number[];
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
  /** True only on the dashboard's pre-first-poll placeholder: "no data yet",
   *  deliberately NOT an offline verdict (CR-25). */
  loading?: boolean;
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
  /** Per-position acceptance in %, index = draft position (shallowest first):
   *  accepted at p / ALL drafts - the cumulative probability that the draft token
   *  at depth p survives verification. Null when the server reports no per-position
   *  counters (spec decode off, or pre-0.10 vLLM). Mean acceptance length is
   *  derivable by the reader as 1 + (Σ rates)/100 - deliberately not stored. */
  specAcceptPerPos: number[] | null;
  avgTTFTMs: number | null;
  avgTPOTMs: number | null;
  /** Pooled output throughput (tokens/sec) = Σ generation tokens / Σ decode time. */
  avgTputTokPerSec: number | null;
  /** Pooled prefill throughput (tokens/sec) = Σ prompt tokens / Σ prefill time. */
  avgPrefillTputTokPerSec: number | null;
  preemptions: number | null;
  evictions: number | null;
  error?: string;
  /**
   * Warning shown while still `online`, from either source: a HELD snapshot
   * (the tick debounce re-publishes the last good metrics after inconclusive
   * probe failures, see {@link OFFLINE_CONFIRM_TICKS}), or degraded OpenRouter
   * relay DATA (the catalog probe failed while the key probe kept the node
   * reachable — the relay answers, its catalog sulked). The dashboard renders
   * a yellow dot with this note, never red Offline.
   */
  staleError?: string;
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
  /**
   * OpenRouter relay: configured wire model ids ABSENT from the catalog this
   * tick parsed successfully — OpenRouter no longer lists them (renamed or
   * removed upstream), so chat requests to these ids will fail and the
   * picker already dropped them. Set only when this tick's catalog was
   * parsed cleanly (absence against a failed/stale download proves nothing);
   * cleared automatically on any catalog data gap. The dashboard flags those
   * model nodes instead of letting a dead id smile from the tree.
   */
  missingModels?: string[];
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
class MetricsParser {
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
        specAcceptedPerPos: [],
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
      case 'vllm:spec_decode_num_accepted_tokens_per_pos_total': {
        // One sample per draft position (position="0" ... "k-1"). Acceptance is
        // a prefix: position p counts the drafts whose (p+1)-th draft token was
        // verified. Accumulated BY POSITION across scrapes and model samples,
        // unlike the sibling push-then-sum counters.
        const pos = Number.parseInt(labels.position ?? '', 10);
        if (Number.isInteger(pos) && pos >= 0) {
          acc.specAcceptedPerPos[pos] = (acc.specAcceptedPerPos[pos] ?? 0) + value;
        }
        break;
      }
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
    // Per-position acceptance divides by ALL drafts (vLLM's convention: a
    // position past a short draft's length counts as a miss), so the curve is
    // monotonic and matches the "Per-position acceptance rate" line vLLM logs.
    const perPosTotals: number[] = [];
    for (const m of modelNames) {
      const arr = this.models.get(m)!.specAcceptedPerPos;
      for (let p = 0; p < arr.length; p++) {
        perPosTotals[p] = (perPosTotals[p] ?? 0) + (arr[p] ?? 0);
      }
    }
    const specAcceptPerPos =
      totalDrafts > 0 && perPosTotals.length > 0
        ? perPosTotals.map(c => (c / totalDrafts) * 100)
        : null;

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
    // Spec decode emits several tokens per step - the generation-token
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
      specAcceptPerPos,
      avgTTFTMs,
      avgTPOTMs,
      avgTputTokPerSec,
      avgPrefillTputTokPerSec,
      preemptions: preemptions > 0 ? preemptions : null,
      evictions: evictions > 0 ? evictions : null,
    };
  }
}

function parseLabels(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const m of raw.matchAll(/(\w+)="([^"]*)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

// ─── Polling Engine ─────────────────────────────────────────────────

/**
 * Default poll interval for metrics fetching.
 * Used when reading vllm-copilot.dashboard.pollIntervalMs returns undefined.
 */
const DEFAULT_POLL_MS = 15000;

/** Classification of an OFFLINE verdict — decides whether the engine may hold
 *  the last good reading instead of painting a healthy server red:
 *  - `answered`: the probe returned an HTTP status. The server is by
 *    definition REACHABLE (a 429 literally means "alive, rate-limited"); an
 *    offline verdict from a status code is never a death certificate.
 *  - `dead`: the request failed with a conclusive transport code (connection
 *    refused, unknown host) — nothing is listening at that address.
 *  - `transient`: failed without an answer but inconclusively (cycle timeout,
 *    socket reset) — grumpiness, not death. */
type OfflineKind = 'answered' | 'dead' | 'transient';

/** Consecutive inconclusive failed ticks the engine holds the last good
 *  reading before conceding Offline (~45 s at the default 15 s poll). Without
 *  this debounce, ONE slow or rate-limited probe of the fat `/v1/models`
 *  catalog (OpenRouter, ~1 MB, routinely over the 5 s cycle deadline while
 *  chat works fine) replaced a healthy dashboard with red "Offline" and
 *  wiped every model row (user report 2026-09-17). */
const OFFLINE_CONFIRM_TICKS = 3;

/** Transport codes that ARE a conclusive death certificate: nothing accepts
 *  connections at that address, or the name does not resolve. These go Offline
 *  immediately; every other no-answer failure is debounced like a timeout. */
const DEAD_TRANSPORT_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL', 'ENOTFOUND']);

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
class ServerMetricsEngine {
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether a fetch cycle is currently running — `tick()` reschedules itself in
   *  its `finally`, so a second concurrent cycle would spawn a second timer chain. */
  private inFlight = false;
  /** Consecutive inconclusive offline ticks currently held against the last
   *  good reading (see {@link OFFLINE_CONFIRM_TICKS}). Any published result —
   *  online, or a confirmed offline — resets it. */
  private transientOfflineTicks = 0;
  private _lastAggregated: ServerMetrics | null = null;
  private _lastRaw: ServerRawData | null = null;
  /**
   * Server-reported model rows from the last authoritative read (see
   * {@link getServerModels}) — the single fetched list every display surface
   * reads. Session-scoped on purpose: model lists change when servers change,
   * not every poll interval (2026-09-18 — re-downloading OpenRouter's ~700 KB
   * catalog every 15 s per entry was pure hammering, and self-hosted list
   * probes cost nothing but proved nothing new).
   */
  private _lastModelRows: Array<Record<string, unknown>> = [];
  /** Epoch ms of the last cache fill (`_lastAggregated`/`_lastRaw`), 0 before
   *  the first completed cycle. The Deep-Dive panel stamps a pushed cache with
   *  this instead of the render time, so a stale snapshot never wears a fresh
   *  timestamp. */
  private _lastSnapshotAt = 0;
  private _disposed = false;
  /**
   * Cached per-backend context window, per model (non-vLLM only).
   * modelId → `undefined` = not yet attempted (or transient failure awaiting
   * retry); `null` = permanently unresolvable (a catalog entry that reports no
   * usable window — never retried); number = resolved value. OpenRouter is a
   * relay: each configured model has its OWN context window, so this is a map,
   * not a scalar. For OpenRouter, an id ABSENT from the current catalog is not
   * cached at all (`undefined`) — the catalog is session-scoped (refetched on a
   * reset, not every poll), so the engine rechecks it against whatever catalog
   * is live rather than caching a permanent miss.
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
  /**
   * modelId → configured `contextWindow` fallback (vLLM only). Applied at tick
   * time to rows that THEMSELVES lack a positive max_model_len: a
   * server-reported window always wins, and a fallback never resurrects a row
   * absent from /v1/models — the exact resolver contract, kept display-only.
   * Read live on every refresh, NOT through the resolved-limits cache, so a
   * settings edit takes effect on the next tick without invalidation.
   */
  private contextWindowFallbacks: Record<string, number> = {};
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
    // Rows describe the OLD box's served list — re-read on the next tick.
    this._lastModelRows = [];
  }

  /** Latest aggregated metrics (synchronous, may be null before first poll). */
  getCachedAggregated(): ServerMetrics | null { return this._lastAggregated; }

  /**
   * The latest server-reported model rows — the same authoritative id space
   * the runtime resolver and Test & Refresh match against. EMPTY while the
   * last published verdict is not online: callers must read that as
   * "unknown", never as "this server hosts nothing" (the exact display
   * policy of the one-shot probe this replaced).
   */
  getServerModels(): ServerModelEntry[] {
    if (!this._lastAggregated?.online) return [];
    return this._lastModelRows.flatMap((m): ServerModelEntry[] =>
      typeof m.id === 'string'
        ? [{
            id: m.id,
            ownedBy: typeof m.owned_by === 'string' ? m.owned_by : undefined,
            maxModelLen: typeof m.max_model_len === 'number' ? m.max_model_len : undefined,
          }]
        : [],
    );
  }

  /** Latest raw server data (synchronous, may be null before first poll). */
  getCachedRaw(): ServerRawData | null { return this._lastRaw; }

  /** Epoch ms when the cached data was captured (0 before the first cycle). */
  getCachedSnapshotAt(): number { return this._lastSnapshotAt; }

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
    // …and lists its models on one — the cached rows describe another backend.
    this._lastModelRows = [];
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

  /** Replace the configured context-window fallbacks (called by getMetricsEngine). */
  setContextWindowFallbacks(fallbacks: Record<string, number>): void {
    this.contextWindowFallbacks = { ...fallbacks };
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
      const { aggregated, raw, offlineKind } = await fetchAllEndpoints(this.serverUrl, this.requestHeaders, this.serverType);

      if (this._disposed) return;

      // A failed probe is NOT a death certificate. An inconclusive offline
      // verdict (HTTP 429/5xx answer, timeout, socket reset) must not wipe a
      // healthy reading over one bad tick — the OpenRouter relay routinely
      // fails the fat catalog probe for a cycle or two while chat works
      // fine. Hold and re-publish the last good reading, stale-flagged, until
      // the verdict is confirmed. Conclusive transport death
      // (`offlineKind === 'dead'`) and the first-ever observation pass
      // straight through.
      if (!aggregated.online && offlineKind !== 'dead' && this._lastAggregated?.online) {
        this.transientOfflineTicks++;
        if (this.transientOfflineTicks < OFFLINE_CONFIRM_TICKS) {
          const held: ServerMetrics = {
            ...this._lastAggregated,
            staleError: `${aggregated.error ?? 'connection check failed'} - showing last known good data`,
          };
          this._lastAggregated = held;
          const heldRaw = this._lastRaw ?? raw;
          for (const cb of [...this.callbacks]) {
            try { cb(held, heldRaw); } catch { /* subscriber error — best-effort */ }
          }
          return;
        }
      }
      this.transientOfflineTicks = 0;

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
              // The resolver's contract IS the guarantee: contextWindow is a
              // positive number (every backend arm checks it) and the output
              // ceiling is finite or absent. Cache both directly — `null` in
              // the output map means "resolver reports no ceiling", `undefined`
              // stays "not attempted".
              this.resolvedContextByModel.set(modelId, resolved);
              this.resolvedOutputByModel.set(modelId, limits.maxOutputTokens ?? null);
            } catch (err) {
              if (err instanceof OpenRouterModelNotFoundError) {
                // Absent from THIS catalog snapshot. Leave it uncached rather
                // than a permanent miss — the catalog is session-scoped, so it
                // is re-served (from the memo, no extra HTTP) every tick and
                // refetched on a reset; a model that appears in a later catalog
                // must still resolve, so context is never permanently disabled.
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
          if (typeof resolvedOutput === 'number') outputByModel[modelId] = resolvedOutput;
        }
        if (Object.keys(contextByModel).length > 0) aggregated.contextByModel = contextByModel;
        if (Object.keys(outputByModel).length > 0) aggregated.outputByModel = outputByModel;
      } else if (Object.keys(this.contextWindowFallbacks).length > 0) {
        // vLLM: the server's rows own the context windows. The hidden fallback
        // surfaces ONLY on a row that itself lacks a positive max_model_len
        // (metadata-stripping gateway) — same contract as the runtime resolver.
        // Offline / no rows ⇒ nothing matched ⇒ no fallback, never a ghost.
        const contextByModel: Record<string, number> = {};
        for (const [modelId, fallback] of Object.entries(this.contextWindowFallbacks)) {
          const row = raw.models.find((m) => m.id === modelId || m.root === modelId);
          if (row && !(typeof row.max_model_len === 'number' && row.max_model_len > 0)) {
            contextByModel[modelId] = fallback;
            if (aggregated.maxModelLen === null) aggregated.maxModelLen = fallback;
          }
        }
        if (Object.keys(contextByModel).length > 0) aggregated.contextByModel = contextByModel;
      }

      // Missing-model marker: a configured wire id absent from THIS tick's
      // cleanly parsed catalog is OpenRouter's own statement that the id is
      // gone (renamed or removed). Absence is only an accusation when the
      // catalog itself answered: `online` with no data note means the
      // response arrived and parsed, and a NON-EMPTY listing is what makes
      // absence mean anything — while the session's first catalog is still
      // downloading (the 2 s race in fetchAllEndpoints yields no rows) or
      // reported nothing, there is no listing to be absent from. On any
      // catalog gap the flag stays unset — a sulked download must never
      // accuse 400 healthy models of dying.
      if (this.serverType === 'openrouter' && aggregated.online && aggregated.staleError === undefined && raw.models.length > 0 && this.modelIds.length > 0) {
        const listed = new Set(raw.models.map((m) => m.id));
        const missing = this.modelIds.filter((id) => !listed.has(id));
        if (missing.length > 0) aggregated.missingModels = missing;
      }

      // OpenRouter relay: per-model provider pricing from
      // `GET /api/v1/models/{id}/endpoints` (the same
      // call Model Settings uses for the provider dropdown; the cache sends it
      // with the OR entry's auth so perf stats come populated). Provider lists come
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

      // Server-reported model rows — the shared list every display surface
      // reads (dashboard Models node, Model Settings picker). `/v1/models`-
      // served backends (vLLM, llama.cpp) and the OpenRouter relay (whose rows
      // are the session catalog — fetched once, see fetchAllEndpoints) already
      // hold them in this cycle's `raw.models`, so this is a pure re-map, no
      // extra HTTP. LM Studio and Ollama are authoritative on their NATIVE
      // endpoints (model keys / loaded models — the ids the resolver and Test &
      // Refresh use), so the shared memoized lister fetches those, and
      // `aggregated.models` adopts them: the dashboard tree, Model Settings and
      // Test & Refresh can no longer disagree on what a server hosts. A failed
      // lister leaves the rows EMPTY (unknown, never stale); the dashboard keeps
      // the `/v1/models` ids this tick parsed.
      if (aggregated.online) {
        if (this.serverType === 'lmstudio' || this.serverType === 'ollama') {
          try {
            const listed = await listServerModels(this.serverType, this.serverUrl, this.requestHeaders);
            this._lastModelRows = listed.map((m) => ({ id: m.id }));
            aggregated.models = listed.map((m) => m.id);
          } catch {
            this._lastModelRows = [];
          }
        } else {
          this._lastModelRows = raw.models;
        }
      }

      this._lastAggregated = aggregated;
      this._lastRaw = raw;
      this._lastSnapshotAt = Date.now();

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
            this.output?.appendLine(`[WARN] OpenRouter account probe failed for ${this.serverUrl} - credits/limits hidden. Check the API key.`);
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

/** Command "vLLM-Copilot: Set Poll Interval": parse an interval ("15s"/"1m",
 * ≥ 1s floor) and persist vllm-copilot.dashboard.pollIntervalMs. Lives next
 * to {@link getPollSettingMs} so the key's reader and writer share one file
 * (R7-P5-2); the dashboard's Refresh-Interval row invokes it by command id. */
export function registerSetPollIntervalCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.setPollInterval', async () => {
    const current = getPollSettingMs();
    const input = await vscode.window.showInputBox({
      prompt: 'Set polling interval (e.g. 15s, 30s, 1m)',
      ignoreFocusOut: true,
      value: `${current / 1000}s`,
      validateInput: (val: string) => {
        const s = val.replace(/s$/, '');
        const m = val.replace(/m$/, '');
        if (!isNaN(Number(s)) && Number(s) > 0) return undefined;
        if (!isNaN(Number(m)) && Number(m) > 0) return undefined;
        return 'Enter a valid interval (e.g. 15s, 30s, 1m)';
      },
    });
    if (!input) return;
    let ms: number;
    if (input.endsWith('m')) {
      ms = Number(input.slice(0, -1)) * 60 * 1000;
    } else {
      ms = Number(input.replace(/s$/, '')) * 1000;
    }
    if (ms < 1000) {
      vscode.window.showErrorMessage('Polling interval must be at least 1s');
      return;
    }
    await vscode.workspace.getConfiguration('vllm-copilot.dashboard').update('pollIntervalMs', ms, vscode.ConfigurationTarget.Global);
  });
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
  contextWindowFallbacks?: Record<string, number>,
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
  // Same semantics for the configured context-window fallbacks: `undefined` =
  // caller doesn't manage them, an explicit {} clears (a deleted settings
  // field must stop showing on the next tick).
  if (contextWindowFallbacks !== undefined) {
    engine.setContextWindowFallbacks(contextWindowFallbacks);
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
): Promise<{ aggregated: ServerMetrics; raw: ServerRawData; offlineKind?: OfflineKind }> {
  const baseUrl = serverUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const headers = buildRequestHeaders(undefined, requestHeaders);

  // OpenRouter relay: the authenticated key probe (`GET /api/v1/key`) is the
  // relay's HEALTH signal and the account row source. Fired CONCURRENTLY with
  // the endpoint fetches — it has its own timeout and must never stall the
  // metrics cycle. It replaced the fat catalog as the verdict source: any
  // HTTP answer means the relay is reachable (see the Online check). The
  // account budget (`GET /api/v1/credits`) rides along, display-only.
  const keyProbePromise = serverType === 'openrouter'
    ? probeOpenRouterKey(requestHeaders)
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
  const isRelay = serverType === 'openrouter';
  // The OpenRouter catalog is fetched ONCE per session via the shared memo
  // (2026-09-18: it used to be re-downloaded here — ~700 KB per entry every
  // poll interval, ~5,700 downloads a day per relay — exactly the hammering
  // that risks a rate-limit lockout). The memo serves the cached snapshot on
  // every tick at zero network cost; only the first tick of a session (or a
  // Test & Refresh reset) pays the download. It runs CONCURRENTLY with the
  // key probe below. A failure yields no rows and a data-gap note — never a
  // lie about an empty relay; the memo's 30 s backoff absorbs a dead
  // OpenRouter instead of re-downloading every tick.
  const catalogPromise = isRelay
    ? fetchOpenRouterCatalog().then((data) => ({ ok: true as const, data }))
        .catch(() => ({ ok: false as const }))
    : Promise.resolve(undefined);
  // Probe transport sink: records the error code when a probe fetch itself
  // fails, so an offline verdict can separate a conclusive death
  // (ECONNREFUSED/ENOTFOUND) from a timeout. Both probe candidates report
  // here; the first failure wins.
  const probeTransport: { code?: string } = {};
  const [healthRes, v1ModelsRes, versionText, metricsText, loadText] = isVllm
    ? await Promise.all([
        safeFetch(buildEndpoint(baseUrl, 'health'), { signal: controller.signal, headers }, probeTransport),
        safeFetch(buildEndpoint(baseUrl, 'v1/models'), { signal: controller.signal, headers }, probeTransport),
        safeFetch(buildEndpoint(baseUrl, 'version'), { signal: controller.signal, headers }).then(r => r?.ok ? r.text() : ''),
        safeFetch(buildEndpoint(baseUrl, 'metrics'), { signal: controller.signal, headers }).then(r => r?.ok ? r.text() : ''),
        safeFetch(buildEndpoint(baseUrl, 'load'), { signal: controller.signal, headers }).then(r => r?.ok ? r.text() : ''),
      ])
    : await Promise.all([
        Promise.resolve(new Response(null, { status: 404 })), // no /health for non-vLLM
        // Relay: no per-tick /v1/models — the catalog comes from the session
        // memo above. The key probe (below) is the relay's liveness signal.
        isRelay
          ? Promise.resolve<Response | null>(null)
          : safeFetch(buildEndpoint(baseUrl, 'v1/models'), { signal: controller.signal, headers }, probeTransport),
        Promise.resolve(''), // no /version
        Promise.resolve(''), // no /metrics
        Promise.resolve(''), // no /load
      ]);
  // The 5 s deadline stays ARMED across the remaining body reads (CR-41):
  // Promise.all on fetch resolves at HEADERS, and clearing the timer here left
  // the `/v1/models` and `/health` body reads with no deadline whatsoever. A
  // server that answers headers then stalls the body hung those awaits forever,
  // freezing the poll engine behind tick()'s in-flight guard — stale dashboard
  // data served silently, a poller that dies without dying. The request signal
  // rejects in-flight body reads, so the timer now covers the whole exchange;
  // `/health` is read here too and its parse site consumes the stored text.
  let modelsText = '';
  let healthResText = '';
  try {
    [modelsText, healthResText] = await Promise.all([
      v1ModelsRes?.ok ? v1ModelsRes.text() : Promise.resolve(''),
      healthRes?.ok ? healthRes.text() : Promise.resolve(''),
    ]);
  } finally {
    clearTimeout(timer);
  }

  // ── Shared parse helpers ──
  const parseJsonSafe = <T>(text: string): T | undefined => {
    try { return JSON.parse(text) as T; } catch { return undefined; }
  };

  // ── Parse Models (used by both aggregated and raw) ──
  const modelNames: string[] = [];
  let maxModelLen: number | null = null;
  let parsedModels: Array<Record<string, unknown>> = [];
  let catalogFetchFailed = false;
  if (isRelay) {
    // OpenRouter's catalog IS the authoritative model list, read from the
    // session memo (see catalogPromise). fetchOpenRouterCatalog already
    // validated the payload ({ data: [...] }), so a failure here is the
    // session's first download failing (or its backoff re-throwing) —
    // recorded as a data gap, never a healthy empty catalog. The read races
    // on the SAME 2 s probe cap the key probe uses below: in steady state
    // the memo is already settled and this costs nothing, but a cold
    // download still in flight can never stall the health verdict (the rows
    // arrive next tick, once the memo settles). 'pending' is neither data
    // nor failure — no rows this tick, no gap note.
    const cat = await Promise.race([
      catalogPromise,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 2000)),
    ]);
    if (cat !== 'pending') {
      if (cat?.ok) {
        parsedModels = cat.data as unknown as Array<Record<string, unknown>>;
      } else {
        catalogFetchFailed = true;
      }
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

  // ── OpenRouter relay probes — awaited BEFORE the verdict: for a relay the
  // key probe IS the health signal (see Online check), so the verdict waits
  // for it. The endpoint fetches above ran in parallel, never a serial stall.
  // The 2 s cap stays: a probe slower than the poll interval is worthless for
  // freshness. (Neither probe ever rejects.)
  const [keyProbe, credits] = await Promise.all([
    Promise.race([
      keyProbePromise,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
    ]),
    Promise.race([
      creditsPromise,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
    ]),
  ]);
  const account = keyProbe?.data;

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
  // A proxy that forwards only `/v1/*` answers 404 on `/health` — that is an
  // ANSWER, and a 200 `/v1/models` behind it proves the box is alive and
  // serving. Painting that Offline made metadata-stripping gateways look dead
  // while chat worked fine. Any other `/health` status stays a real verdict
  // (503 = vLLM itself says it is sick; 401 = the proxy is guarding it).
  const relayOnline = isVllm && healthRes?.status === 404 && v1ModelsRes?.ok === true;
  // OpenRouter relay: the SMALL AUTHENTICATED key probe owns the verdict,
  // alone. It costs a few hundred bytes and proves exactly the claim the node
  // makes — "reachable, with THIS entry's credential". The public catalog is
  // DATA, never health, and is fetched once per session (not per tick), so it
  // is not a liveness witness here. Any key-probe HTTP status is an answer:
  // 200 alive, 401 alive-but-your-key-is-dead, 429
  // alive-and-telling-you-to-wait; the offline-confirm debounce absorbs a
  // one-off slow probe. (2026-09-17/18: the ~1 MB catalog blew the cycle
  // deadline and, downloaded every poll, courted a rate-limit lockout.)
  const relayReachable = keyProbe?.responded === true;
  const online = isVllm
    ? (probeOk || relayOnline)
    : isRelay
      ? relayReachable
      : probeOk;
  const errorStr = online
    ? undefined
    : !probeRes
      ? 'Cannot connect'
      : isVllm
        ? `Health check failed: ${probeRes.status}`
        : `${serverType} /v1/models failed: ${probeRes.status}`;
  // Relay DATA health rides separately from relay HEALTH: a catalog that
  // failed, answered an error, or came back malformed keeps the node online
  // (the relay DID answer) and notes itself — the dashboard renders the
  // yellow stale warning instead of a false death verdict.
  let relayDataNote: string | undefined;
  if (online && isRelay && catalogFetchFailed) {
    relayDataNote = 'OpenRouter catalog fetch failed - model data may be stale';
  }
  // Classify the offline verdict for the engine's hold/debounce decision.
  // Any HTTP answer proves reachability (a 429 literally means "alive, rate
  // limited"); only a no-answer failure carrying a conclusive transport code
  // is treated as death. Both witnesses report their transport codes.
  // See {@link OfflineKind}.
  const offlineKind: OfflineKind | undefined = online
    ? undefined
    : (probeRes !== null || keyProbe?.responded === true)
      ? 'answered'
      : (keyProbe?.transportCode !== undefined && DEAD_TRANSPORT_CODES.has(keyProbe.transportCode))
        || (probeTransport.code !== undefined && DEAD_TRANSPORT_CODES.has(probeTransport.code))
        ? 'dead'
        : 'transient';

  // ── Health body (for deep-dive) — text already read under the deadline above. ──
  const healthBody = online && healthRes?.ok ? healthResText : undefined;

  // ── Build ServerMetrics (aggregated, for dashboard) ──
  const parser = new MetricsParser();
  parser.parse(metricsText);
  const aggregated = parser.aggregate();
  const allModels = [...new Set([...modelNames, ...aggregated.models])];

  // The offline result is a REAL verdict, not the pre-first-poll sentinel: it
  // must clear `loading`, or the dashboard renders a dead server as an eternal
  // "Loading" spinner and the red "Offline" never appears (CR-25 fixed the
  // placeholder, this path inherited the sentinel by reuse).
  const serverMetrics: ServerMetrics = online
    ? { online: true, version, ...aggregated, models: allModels, maxModelLen, account, credits, staleError: relayDataNote }
    : { ...emptyMetrics(errorStr ?? 'Unknown error'), loading: false };

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

  return { aggregated: serverMetrics, raw, offlineKind };
}

/**
 * Fetch wrapper that never throws — returns `null` when the request itself
 * failed (unreachable, refused, aborted by the cycle timeout). `null` is
 * distinct from "answered with an error status", which stays a real Response.
 * (A synthetic `new Response(null, {status: 0})` is NOT constructible — the
 * Response constructor requires 200..599 — so a status-0 sentinel would throw
 * right back out of the catch and take the whole cycle down with it.)
 *
 * When a `transportSink` is passed (the probe calls), the first failed
 * request records its error code there, so the offline verdict can tell a
 * conclusive dead transport from a grumpy timeout — see {@link OfflineKind}.
 */
async function safeFetch(
  url: string,
  options: RequestInit,
  transportSink?: { code?: string },
): Promise<Response | null> {
  try { return await fetch(url, options); }
  catch (err) {
    if (transportSink && transportSink.code === undefined) transportSink.code = transportErrorCode(err);
    return null;
  }
}

/** Build the dashboard's pre-first-poll placeholder (a loading sentinel, not
 * an offline verdict — CR-25). Exported for the dashboard so there is one
 * literal, not a per-module twin. */
export function emptyMetrics(error: string): ServerMetrics {
  return {
    online: false, loading: true, error,
    models: [], maxModelLen: null, kvCacheUsagePercent: null, runningRequests: null, waitingRequests: null,
    cacheHitRate: null, specAcceptanceRate: null, specDraftsTotal: null, specDraftDepth: null,
    specAcceptPerPos: null,
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