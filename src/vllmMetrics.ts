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
import { buildEndpoint } from './config.js';
import { buildRequestHeaders } from './fetchRetry.js';

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
  preemptions: number | null;
  evictions: number | null;
  error?: string;
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
    for (const m of modelNames) {
      const a = this.models.get(m)!;
      ttftSum += a.ttftSum;
      ttftCount += a.ttftCount;
      tpotSum += a.tpotSum;
      tpotCount += a.tpotCount;
    }
    const avgTTFTMs = ttftCount > 0 ? (ttftSum / ttftCount) * 1000 : null;
    const avgTPOTMs = tpotCount > 0 ? (tpotSum / tpotCount) * 1000 : null;

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
  /** Array of callbacks so subscribers don't need to coordinate. */
  private callbacks: Array<(aggregated: ServerMetrics, raw: ServerRawData) => void> = [];

  constructor(
    private serverUrl: string,
    private requestHeaders: Record<string, string>,
  ) {}

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

  dispose(): void {
    this._disposed = true;
    this.subscriberCount = 0;
    this.callbacks = [];
    this.stopPolling();
    // Prevent registry from returning this disposed zombie
    if (engineRegistry.get(this.serverUrl) === this) {
      engineRegistry.delete(this.serverUrl);
    }
  }

  private unsubscribe(callback: (aggregated: ServerMetrics, raw: ServerRawData) => void): void {
    const idx = this.callbacks.indexOf(callback);
    if (idx >= 0) this.callbacks.splice(idx, 1);
    this.subscriberCount--;
    if (this.subscriberCount <= 0) {
      this.subscriberCount = 0;
      this.stopPolling();
    }
  }

  /** One fetch cycle: hit all endpoints, parse once, cache both views, notify. */
  private async tick(): Promise<void> {
    if (this._disposed) return;

    try {
      const { aggregated, raw } = await fetchAllEndpoints(this.serverUrl, this.requestHeaders);

      if (this._disposed) return;
      this._lastAggregated = aggregated;
      this._lastRaw = raw;

      // Notify all subscribers
      for (const cb of this.callbacks) {
        try { cb(aggregated, raw); } catch { /* subscriber error — best-effort */ }
      }
    } catch (err) {
      // fetchAllEndpoints is error-proof via safeFetch, so this only fires on
      // programming errors (OOM, JSON bomb, etc.). Log and schedule retry.
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

/** Module-level map of server URL → engine. */
const engineRegistry = new Map<string, ServerMetricsEngine>();

/**
 * Get or create a {@link ServerMetricsEngine} for the given server.
 * Engines are shared across the dashboard and deep-dive views via this registry.
 * The engine is disposed-rece when the last subscriber unsubscribes.
 *
 * When an engine already exists for the given URL, its request headers are
 * updated with the provided values (so auth changes propagate without needing
 * to unsubscribe/resubscribe).
 *
 * @param serverUrl - The vLLM server URL
 * @param requestHeaders - Auth/routing headers for this server
 */
export function getMetricsEngine(
  serverUrl: string,
  requestHeaders?: Record<string, string>,
): ServerMetricsEngine {
  let engine = engineRegistry.get(serverUrl);
  if (!engine) {
    engine = new ServerMetricsEngine(serverUrl, requestHeaders ?? {});
    engineRegistry.set(serverUrl, engine);
  } else if (requestHeaders && Object.keys(requestHeaders).length > 0) {
    // Update headers on re-use so auth changes propagate
    engine.setHeaders(requestHeaders);
  }
  return engine;
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
): Promise<{ aggregated: ServerMetrics; raw: ServerRawData }> {
  const baseUrl = serverUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const headers = buildRequestHeaders(undefined, requestHeaders);

  // Fetch all endpoints in parallel. Read all bodies as text immediately
  // (Response body can only be consumed once).
  const [
    healthRes, modelsText, versionText, metricsText, loadText,
  ] = await Promise.all([
    safeFetch(buildEndpoint(baseUrl, 'health'), { signal: controller.signal, headers }),
    safeFetch(buildEndpoint(baseUrl, 'v1/models'), { signal: controller.signal, headers }).then(r => r.ok ? r.text() : ''),
    safeFetch(buildEndpoint(baseUrl, 'version'), { signal: controller.signal, headers }).then(r => r.ok ? r.text() : ''),
    safeFetch(buildEndpoint(baseUrl, 'metrics'), { signal: controller.signal, headers }).then(r => r.ok ? r.text() : ''),
    safeFetch(buildEndpoint(baseUrl, 'load'), { signal: controller.signal, headers }).then(r => r.ok ? r.text() : ''),
  ]);
  clearTimeout(timer);

  // ── Shared parse helpers ──
  const parseJsonSafe = <T>(text: string): T | undefined => {
    try { return JSON.parse(text) as T; } catch { return undefined; }
  };

  // ── Parse Models (used by both aggregated and raw) ──
  const modelNames: string[] = [];
  let maxModelLen: number | null = null;
  let parsedModels: Array<Record<string, unknown>> = [];
  if (modelsText) {
    const modelsData = parseJsonSafe<{ data?: Array<Record<string, unknown>> }>(modelsText);
    if (modelsData?.data) {
      parsedModels = modelsData.data;
      for (const m of parsedModels) {
        if (typeof m.id === 'string') modelNames.push(m.id);
        if (typeof m.max_model_len === 'number' && m.max_model_len > 0) maxModelLen = m.max_model_len;
      }
    }
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
  const online = healthRes.ok;
  const errorStr = online ? undefined : (healthRes.status === 0 ? 'Cannot connect' : `Health check failed: ${healthRes.status}`);

  // ── Health body (for deep-dive) ──
  const healthBody = online && healthRes.ok ? await healthRes.text() : undefined;

  // ── Build ServerMetrics (aggregated, for dashboard) ──
  const parser = new MetricsParser();
  parser.parse(metricsText);
  const aggregated = parser.aggregate();
  const allModels = [...new Set([...modelNames, ...aggregated.models])];

  const serverMetrics: ServerMetrics = online
    ? { online: true, version, ...aggregated, models: allModels, maxModelLen }
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
    avgTTFTMs: null, avgTPOTMs: null, preemptions: null, evictions: null,
  };
}

/**
 * Parse raw Prometheus text into categorized buckets (gauges, counters, histograms, etc.).
 * This is a simpler parser than MetricsParser — it just categorizes raw entries.
 */
export function parseRawMetrics(rawText: string, metrics: ServerRawData['metrics']): void {
  const lineRe = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE+-]+)$/;
  const typeHints: Record<string, 'gauge' | 'counter' | 'histogram'> = {};
  const helpDesc: Record<string, string> = {};

  // First pass: detect types + descriptions from HELP lines
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    const helpMatch = trimmed.match(/^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(.+)/);
    if (helpMatch) {
      const name = helpMatch[1];
      helpDesc[name] = helpMatch[2].trim();
      if (name.includes('_total') || name.includes('count')) typeHints[name] = 'counter';
      else if (name.includes('_bucket')) typeHints[name] = 'histogram';
      else typeHints[name] = 'gauge';
    }
  }

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
    const bucket = typeHints[name] ?? (name.includes('_bucket') ? 'histogram'
      : name.includes('_total') || name.includes('count') ? 'counter'
      : 'gauge');

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

export function fmtTokens(tokens: number | null): string {
  if (tokens == null) return '—';
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens % 1000 === 0 ? 0 : 1)}K`;
  return String(tokens);
}

export function fmtThroughput(avgTPOTms: number | null): string {
  if (avgTPOTms == null || avgTPOTms <= 0) return '—';
  const tokPerSec = 1000 / avgTPOTms;
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