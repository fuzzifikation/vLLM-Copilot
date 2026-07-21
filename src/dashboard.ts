/**
 * Dashboard as a VS Code Tree View + Status Bar.
 * Replaces the previous webview approach with native sidebar UI.
 */

import * as vscode from 'vscode';
import { getConfig, resolveServerConfig } from './config.js';

// ─── Types ───────────────────────────────────────────────────────────

interface ServerConnection {
  url: string;
  requestHeaders: Record<string, string>;
  configModelIds: string[];
}

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

interface ServerMetrics {
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
      return {
        online: false, error: `Health check failed: ${healthRes.status}`,
        models: [], maxModelLen: null, kvCacheUsagePercent: null, runningRequests: null, waitingRequests: null,
        cacheHitRate: null, specAcceptanceRate: null, specDraftsTotal: null, specDraftDepth: null,
        avgTTFTMs: null, avgTPOTMs: null, preemptions: null, evictions: null,
      };
    }

    // /v1/models returns all served models (base + aliases): { object: "list", data: [{ id, max_model_len, ... }] }
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

    // Merge: config model IDs + /v1/models + metrics
    const allModels = [...new Set([...configModelIds, ...modelNames, ...aggregated.models])];
    return { online: true, version, ...aggregated, models: allModels, maxModelLen };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      online: false, error: `Cannot connect: ${message}`,
      models: [], maxModelLen: null, kvCacheUsagePercent: null, runningRequests: null, waitingRequests: null,
      cacheHitRate: null, specAcceptanceRate: null, specDraftsTotal: null, specDraftDepth: null,
      avgTTFTMs: null, avgTPOTMs: null, preemptions: null, evictions: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Formatting ──────────────────────────────────────────────────────

function fmtPct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v)}%`;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function fmtN(v: number | null): string {
  return v == null ? '—' : String(v);
}

function fmtTokens(tokens: number | null): string {
  if (tokens == null) return '—';
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens % 1000 === 0 ? 0 : 1)}K`;
  return String(tokens);
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port}`;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

// ─── Tree Items ──────────────────────────────────────────────────────

/** Build a compact one-line summary for the collapsed server node description */
function summaryLine(m: ServerMetrics): string {
  const parts: string[] = [];
  if (m.version) parts.push(`v${m.version}`);
  if (m.maxModelLen != null) parts.push(`${fmtTokens(m.maxModelLen)} ctx`);
  if (m.kvCacheUsagePercent != null) parts.push(`${Math.round(m.kvCacheUsagePercent)}% KV`);
  if (m.runningRequests != null) parts.push(`${m.runningRequests} running`);
  if (m.waitingRequests != null && m.waitingRequests > 0) parts.push(`${m.waitingRequests} waiting`);
  return parts.join('  ·  ');
}

/** A server node in the tree (collapsible, shows metrics as children) */
class ServerTreeItem extends vscode.TreeItem {
  constructor(
    public readonly serverUrl: string,
    public readonly metrics: ServerMetrics,
    public readonly requestHeaders: Record<string, string>,
  ) {
    const displayName = shortUrl(serverUrl);
    const statusIcon = metrics.online
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));

    super(displayName, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = statusIcon;
    this.id = `server:${serverUrl}`;
    this.description = metrics.online ? summaryLine(metrics) : 'Offline';
    this.tooltip = new vscode.MarkdownString(`${serverUrl}\n*${metrics.models.join(', ') || 'no models'}*`);
    this.contextValue = metrics.online ? 'serverOnline' : 'serverOffline';
  }
}

/** Collapsible "Models" node with each model as a child */
class ModelsTreeItem extends vscode.TreeItem {
  constructor(public readonly modelNames: string[]) {
    super('Models', vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${modelNames.length}`;
    this.iconPath = new vscode.ThemeIcon('library');
    this.tooltip = modelNames.join('\n');
  }
}

/** A single model name under the Models node */
class ModelTreeItem extends vscode.TreeItem {
  constructor(modelName: string) {
    super(modelName, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('symbol-class');
    this.tooltip = modelName;
  }
}

/** A metric row (label: value) */
class MetricTreeItem extends vscode.TreeItem {
  constructor(label: string, value: string, icon?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
    this.tooltip = `${label}: ${value}`;
  }
}

// ─── Tree Data Provider ──────────────────────────────────────────────

export class DashboardTreeProvider implements vscode.TreeDataProvider<ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private outputChannel: vscode.OutputChannel;

  constructor(
    private context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
  ) {
    this.outputChannel = outputChannel;
    this.startPolling();
  }

  getTreeItem(element: ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem): Promise<(ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem)[]> {
    if (!element) {
      try {
        const config = await getConfig(this.context);
        // [url] -> { requestHeaders, configModelIds }
        const serverMap = new Map<string, { requestHeaders: Record<string, string>; configModelIds: string[] }>();
        for (const model of config.models) {
          if (!model.serverUrl) continue;
          if (!serverMap.has(model.serverUrl)) {
            const serverConfig = resolveServerConfig(model);
            serverMap.set(model.serverUrl, { requestHeaders: serverConfig.requestHeaders, configModelIds: [] });
          }
          const entry = serverMap.get(model.serverUrl)!;
          const modelIdentifier = model.vllmModelId || model.id;
          if (modelIdentifier && !entry.configModelIds.includes(modelIdentifier)) {
            entry.configModelIds.push(modelIdentifier);
          }
        }

        // Fetch metrics for each server in parallel
        const results = await Promise.all(
          Array.from(serverMap.entries()).map(async ([url, entry]) => {
            try {
              return await fetchServerMetrics(url, entry.requestHeaders, entry.configModelIds);
            } catch {
              return {
                online: false, error: 'Fetch failed',
                models: [], maxModelLen: null, kvCacheUsagePercent: null, runningRequests: null, waitingRequests: null,
                cacheHitRate: null, specAcceptanceRate: null, specDraftsTotal: null, specDraftDepth: null,
                avgTTFTMs: null, avgTPOTMs: null, preemptions: null, evictions: null,
              };
            }
          }),
        );

        return Array.from(serverMap.entries()).map(([url, entry], i) =>
          new ServerTreeItem(url, results[i], entry.requestHeaders),
        );
      } catch (err) {
        this.outputChannel.appendLine(`[DASHBOARD] getChildren failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    }

    if (element instanceof ServerTreeItem) {
      return this.getServerMetricsChildren(element.metrics);
    }

    if (element instanceof ModelsTreeItem) {
      return element.modelNames.map(name => new ModelTreeItem(name));
    }

    return [];
  }

  private getServerMetricsChildren(m: ServerMetrics): MetricTreeItem[] {
    const items: MetricTreeItem[] = [];
    if (!m.online) {
      return [new MetricTreeItem('Error', m.error || 'Connection failed', 'error')];
    }

    if (m.models.length > 0) {
      items.push(new ModelsTreeItem(m.models));
    }
    items.push(new MetricTreeItem('Context Window', fmtTokens(m.maxModelLen), 'layers'));
    items.push(new MetricTreeItem('KV Cache', fmtPct(m.kvCacheUsagePercent), 'graph'));
    items.push(new MetricTreeItem('Running', fmtN(m.runningRequests), 'play'));
    items.push(new MetricTreeItem('Waiting', fmtN(m.waitingRequests), 'debug-pause'));
    items.push(new MetricTreeItem('Avg TTFT', fmtMs(m.avgTTFTMs), 'clock'));
    items.push(new MetricTreeItem('Avg TPOT', fmtMs(m.avgTPOTMs), 'diff-added'));
    items.push(new MetricTreeItem('Cache Hit', fmtPct(m.cacheHitRate), 'check-all'));
    {
      // MTP (speculative decoding): always show when any spec decode metrics exist
      const hasSpecMetrics =
        m.specAcceptanceRate != null ||
        m.specDraftsTotal != null ||
        m.specDraftDepth != null;
      if (hasSpecMetrics) {
        const parts: string[] = [];
        if (m.specAcceptanceRate != null) parts.push(`${Math.round(m.specAcceptanceRate)}%`);
        else parts.push('—');
        if (m.specDraftDepth != null) parts.push(`depth ${m.specDraftDepth.toFixed(1)}`);
        if (m.specDraftsTotal != null) parts.push(`${m.specDraftsTotal} drafts`);
        items.push(new MetricTreeItem('MTP', parts.join('  ·  '), 'lightbulb'));
      }
    }

    // Pressure indicators (only if > 0)
    if (m.preemptions != null) {
      items.push(new MetricTreeItem('Preemptions', String(m.preemptions), 'warning'));
    }
    if (m.evictions != null) {
      items.push(new MetricTreeItem('Evictions', String(m.evictions), 'error'));
    }

    return items;
  }

  private startPolling(): void {
    const cfg = vscode.workspace.getConfiguration('vllm-copilot.dashboard');
    const pollInterval = cfg.get<number>('pollIntervalMs', 15000);

    this.pollTimer = setInterval(() => {
      this._onDidChangeTreeData.fire();
    }, pollInterval);
  }

  async refresh(): Promise<void> {
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}