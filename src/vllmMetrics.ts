/**
 * vLLM metrics — pure data layer.
 *
 * Fetches /health, /version, /v1/models, /metrics from a vLLM server,
 * parses the Prometheus text format, and aggregates into structured metrics.
 * Used by both the sidebar dashboard (dashboard.ts) and the deep-dive webview.
 */

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
}

export interface ServerRawData {
  version?: Record<string, unknown>;
  health?: string;
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

// ─── Prometheus Parser ───────────────────────────────────────────────

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

function parseLabels(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const m of raw.matchAll(/(\w+)="([^"]*)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

// ─── Fetch ───────────────────────────────────────────────────────────

export async function fetchServerMetrics(
  serverUrl: string,
  requestHeaders: Record<string, string>,
  configModelIds: string[] = [],
  timeout = 5000,
): Promise<ServerMetrics> {
  const baseUrl = serverUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = { ...requestHeaders };

  try {
    const healthRes = await fetch(`${baseUrl}/health`, { signal: controller.signal, headers });
    if (!healthRes.ok) {
      return emptyMetrics(`Health check failed: ${healthRes.status}`);
    }

    const modelNames: string[] = [];
    let maxModelLen: number | null = null;
    try {
      const modelsRes = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal, headers });
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json() as { data?: Array<{ id?: string; max_model_len?: number | null }> };
        for (const m of modelsData.data ?? []) {
          if (m.id) modelNames.push(m.id);
          if (m.max_model_len != null && m.max_model_len > 0) maxModelLen = m.max_model_len;
        }
      }
    } catch { /* non-critical */ }

    let version: string | undefined;
    try {
      const verRes = await fetch(`${baseUrl}/version`, { signal: controller.signal, headers });
      if (verRes.ok) {
        const data = await verRes.json() as { version?: string };
        version = data.version;
      }
    } catch { /* optional */ }

    let rawMetrics = '';
    try {
      const metRes = await fetch(`${baseUrl}/metrics`, { signal: controller.signal, headers });
      if (metRes.ok) {
        rawMetrics = await metRes.text();
      }
    } catch { /* metrics may be disabled */ }

    const parser = new MetricsParser();
    parser.parse(rawMetrics);
    const aggregated = parser.aggregate();

    const allModels = [...new Set([...configModelIds, ...modelNames, ...aggregated.models])];
    return { online: true, version, ...aggregated, models: allModels, maxModelLen };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return emptyMetrics(`Cannot connect: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

function emptyMetrics(error: string): ServerMetrics {
  return {
    online: false, error,
    models: [], maxModelLen: null, kvCacheUsagePercent: null, runningRequests: null, waitingRequests: null,
    cacheHitRate: null, specAcceptanceRate: null, specDraftsTotal: null, specDraftDepth: null,
    avgTTFTMs: null, avgTPOTMs: null, preemptions: null, evictions: null,
  };
}

// ─── Fetch Raw Data (for deep-dive webview) ──────────────────────────

/**
 * Fetch raw, unaggregated data from all vLLM endpoints.
 * Returns structured data suitable for rich rendering (tables, histograms).
 */
export async function fetchServerRawData(
  serverUrl: string,
  requestHeaders: Record<string, string>,
  timeout = 5000,
): Promise<ServerRawData> {
  const baseUrl = serverUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = { ...requestHeaders };

  const result: ServerRawData = {
    models: [],
    metrics: {
      gauges: {},
      counters: {},
      histograms: {},
      cache_config: {},
      process: {},
      http: {},
    },
  };

  // Fetch all endpoints in parallel
  const [healthRes, versionRes, modelsRes, metricsRes] = await Promise.all([
    safeFetch(`${baseUrl}/health`, { signal: controller.signal, headers }),
    safeFetch(`${baseUrl}/version`, { signal: controller.signal, headers }),
    safeFetch(`${baseUrl}/v1/models`, { signal: controller.signal, headers }),
    safeFetch(`${baseUrl}/metrics`, { signal: controller.signal, headers }),
  ]);
  clearTimeout(timer);

  // Health
  if (healthRes.ok) {
    result.health = await healthRes.text();
  }

  // Version
  if (versionRes.ok) {
    try { result.version = (await versionRes.json()) as Record<string, unknown>; } catch { /* ignore */ }
  }

  // Models
  if (modelsRes.ok) {
    try {
      const data = await modelsRes.json() as { data?: Array<Record<string, unknown>> };
      result.models = data.data ?? [];
    } catch { /* ignore */ }
  }

  // Metrics — parse raw Prometheus text into structured buckets
  if (metricsRes.ok) {
    try {
      const rawText = await metricsRes.text();
      parseRawMetrics(rawText, result.metrics);
    } catch { /* ignore */ }
  }

  return result;
}

async function safeFetch(url: string, options: RequestInit): Promise<Response> {
  try { return await fetch(url, options); }
  catch { return new Response(null, { status: 0 }); }
}

/**
 * Parse raw Prometheus text into categorized buckets (gauges, counters, histograms, etc.).
 * This is a simpler parser than MetricsParser — it just categorizes raw entries.
 */
function parseRawMetrics(rawText: string, metrics: ServerRawData['metrics']): void {
  const lineRe = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE+-]+)$/;
  const typeHints: Record<string, 'gauge' | 'counter' | 'histogram'> = {};

  // First pass: detect types from HELP lines
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    const helpMatch = trimmed.match(/^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*)/);
    if (helpMatch) {
      const name = helpMatch[1];
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

    const entry: RawMetricEntry = { name, labels, value };
    const bucket = typeHints[name] ?? name.includes('_bucket') ? 'histogram'
      : name.includes('_total') || name.includes('count') ? 'counter'
      : 'gauge';

    entry.type = bucket;

    if (name.startsWith('vllm:') && name.includes('cache_config')) {
      const shortName = name.replace('vllm:cache_config_', '');
      metrics.cache_config[shortName] = value;
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