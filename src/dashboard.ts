/**
 * Dashboard as a VS Code Tree View — sidebar UI only.
 * Data layer (fetching, parsing, aggregating) lives in vllmMetrics.ts.
 */

import * as vscode from 'vscode';
import { getConfig, resolveServerConfig } from './config.js';
import { ServerMetrics, fetchServerMetrics, fmtPct, fmtMs, fmtN, fmtTokens, fmtThroughput, shortUrl } from './vllmMetrics.js';
import { getLastRequest } from './lastRequestStore.js';

// ─── Tree Items ──────────────────────────────────────────────────────

/** Build a compact one-line summary for the collapsed server node description */
function summaryLine(m: ServerMetrics): string {
  const parts: string[] = [];
  if (m.runningRequests != null) parts.push(`${m.runningRequests} running`);
  if (m.waitingRequests != null && m.waitingRequests > 0) parts.push(`${m.waitingRequests} waiting`);
  return parts.join('  ·  ') || 'idle';
}

/** A server node in the tree (collapsible, shows metrics as children) */
class ServerTreeItem extends vscode.TreeItem {
  constructor(
    public readonly serverUrl: string,
    public readonly metrics: ServerMetrics,
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

/** Collapsible "Model IDs" node with each model as a child */
class ModelsTreeItem extends vscode.TreeItem {
  constructor(public readonly modelNames: string[]) {
    super('Model IDs', vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${modelNames.length}`;
    this.iconPath = new vscode.ThemeIcon('copilot');
    this.tooltip = modelNames.join('\n');
  }
}

/** A single model name under the Model IDs node */
class ModelTreeItem extends vscode.TreeItem {
  constructor(modelName: string) {
    super(modelName, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('symbol-class');
    this.tooltip = modelName;
  }
}

/** A metric row (label: value) */
class MetricTreeItem extends vscode.TreeItem {
  constructor(label: string, value: string, icon?: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
    this.tooltip = tooltip ?? `${label}: ${value}`;
  }
}

/** Clickable poll-interval row at the top of the tree */
class PollIntervalTreeItem extends vscode.TreeItem {
  constructor(intervalLabel: string) {
    super('Refresh Interval', vscode.TreeItemCollapsibleState.None);
    this.description = intervalLabel;
    this.iconPath = new vscode.ThemeIcon('refresh');
    this.command = { command: 'vllm-copilot.setPollInterval', title: 'Set Poll Interval' };
    this.tooltip = new vscode.MarkdownString('Click to change polling interval');
  }
}

/** Clickable "Add or Reconfigure Server/Model" action item */
class AddServerTreeItem extends vscode.TreeItem {
  constructor() {
    super('Add or Reconfigure Server/Model', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('vm-running');
    this.command = { command: 'vllm-copilot.addServerModel', title: 'Add or Reconfigure Server/Model' };
    this.tooltip = new vscode.MarkdownString('Add a new server, add a model to an existing server, or reconfigure auth');
  }
}

/** Clickable "Test & Refresh Models" action item */
class TestRefreshTreeItem extends vscode.TreeItem {
  constructor() {
    super('Test & Refresh Models', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('vm-running');
    this.command = { command: 'vllm-copilot.testAndRefreshModels', title: 'Test & Refresh Models' };
    this.tooltip = new vscode.MarkdownString('Test the vLLM server connection and reload the model list');
  }
}

/** Collapsible "Last Request" node showing per-request details */
class LastRequestTreeItem extends vscode.TreeItem {
  constructor(
    public readonly serverUrl: string,
    public readonly modelId: string,
    public readonly timestamp: number,
    public readonly promptTokens: number,
    public readonly completionTokens: number,
    public readonly totalTokens: number,
    public readonly cachedTokens?: number,
    public readonly createdCacheTokens?: number,
    public readonly reasoningTokens?: number,
    public readonly hasMetrics: boolean = false,
    public readonly hasCacheDetails: boolean = false,
    public readonly ttftMs?: number,
    public readonly generationMs?: number,
    public readonly queueMs?: number,
    public readonly maxModelLen: number = 0,
    public readonly maxOutputTokens: number = 0,
    public readonly firstTokenTimeMs: number | null = null,
  ) {
    super('Last Request', vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('info');
    this.id = `lastRequest:${serverUrl}`;
    const ago = timeAgo(this.timestamp);
    this.description = `${ago} · ${modelId}`;
    this.tooltip = new vscode.MarkdownString(
      `Model: ${modelId}\nTime: ${ago}\nTokens: ${promptTokens} in → ${completionTokens} out`
    );
  }
}

/** A metric row under Last Request (label: value) */
class RequestMetricTreeItem extends vscode.TreeItem {
  constructor(label: string, value: string, icon?: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
    this.tooltip = tooltip ?? `${label}: ${value}`;
  }
}

/** Hint row suggesting vLLM server flags for more data */
class FlagHintTreeItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('lightbulb', new vscode.ThemeColor('charts.yellow'));
    this.tooltip = message;
  }
}

/** Format a relative time string from a timestamp */
function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

// ─── Tree Data Provider ──────────────────────────────────────────────

export class DashboardTreeProvider implements vscode.TreeDataProvider<ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem | LastRequestTreeItem | RequestMetricTreeItem | FlagHintTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem | LastRequestTreeItem | RequestMetricTreeItem | FlagHintTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private isVisible = false;
  private outputChannel: vscode.OutputChannel;

  constructor(
    private context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
  ) {
    this.outputChannel = outputChannel;
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('vllm-copilot.dashboard.pollIntervalMs')) {
          this.startPolling();
          this._onDidChangeTreeData.fire();
        }
      }),
    );
  }

  /** Call when the tree view becomes visible or hidden */
  setVisible(visible: boolean): void {
    this.isVisible = visible;
    if (visible) {
      this.startPolling();
      this._onDidChangeTreeData.fire(); // refresh on show
    } else {
      this.stopPolling();
    }
  }

  private getPollInterval(): number {
    return vscode.workspace.getConfiguration('vllm-copilot.dashboard').get<number>('pollIntervalMs', 15000);
  }

  private getPollIntervalTreeItem(): PollIntervalTreeItem {
    const intervalMs = this.getPollInterval();
    const label = intervalMs < 60000 ? `${intervalMs / 1000}s` : `${Math.round(intervalMs / 1000)}s`;
    return new PollIntervalTreeItem(label);
  }

  getTreeItem(element: ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem | LastRequestTreeItem | RequestMetricTreeItem | FlagHintTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem | LastRequestTreeItem | RequestMetricTreeItem | FlagHintTreeItem): Promise<(ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem | LastRequestTreeItem | RequestMetricTreeItem | FlagHintTreeItem)[]> {
    if (!element) {
      const items: (ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem)[] = [this.getPollIntervalTreeItem()];
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

        const servers = Array.from(serverMap.entries()).map(([url, entry], i) =>
          new ServerTreeItem(url, results[i]),
        );
        return [...items, ...servers, new AddServerTreeItem(), new TestRefreshTreeItem()];
      } catch (err) {
        this.outputChannel.appendLine(`[DASHBOARD] getChildren failed: ${err instanceof Error ? err.message : String(err)}`);
        return [...items, new AddServerTreeItem(), new TestRefreshTreeItem()];
      }
    }

    if (element instanceof ServerTreeItem) {
      return this.getServerMetricsChildren(element.metrics, element.serverUrl);
    }

    if (element instanceof ModelsTreeItem) {
      return element.modelNames.map(name => new ModelTreeItem(name));
    }

    if (element instanceof LastRequestTreeItem) {
      return this.getLastRequestChildren(element);
    }

    return [];
  }

  private getServerMetricsChildren(m: ServerMetrics, serverUrl?: string): (MetricTreeItem | ModelsTreeItem | LastRequestTreeItem | FlagHintTreeItem)[] {
    const items: (MetricTreeItem | ModelsTreeItem | LastRequestTreeItem | FlagHintTreeItem)[] = [];
    if (!m.online) {
      return [new MetricTreeItem('Error', m.error || 'Connection failed', 'error')];
    }

    // Basic info
    if (m.version) {
      items.push(new MetricTreeItem('vLLM Version', 'v' + m.version, 'server'));
    }
    if (m.models.length > 0) {
      items.push(new ModelsTreeItem(m.models));
    }
    items.push(new MetricTreeItem(
      'Context Window',
      fmtTokens(m.maxModelLen),
      'layers',
      'Maximum context length (input + output combined) for this model.',
    ));

    // Server stats
    items.push(new MetricTreeItem(
      'KV Cache',
      fmtPct(m.kvCacheUsagePercent),
      'graph',
      'Current KV cache utilization. High usage means less headroom for concurrent requests.',
    ));
    items.push(new MetricTreeItem(
      'KV Cache Hit',
      fmtPct(m.cacheHitRate),
      'check-all',
      'Percentage of input tokens served from cache (prefill skipped). Higher = faster prompts.',
    ));
    items.push(new MetricTreeItem(
      'Avg TTFT',
      fmtMs(m.avgTTFTMs),
      'clock',
      'Average time to first token across recent requests (queue + prompt processing).',
    ));
    items.push(new MetricTreeItem(
      'Throughput',
      fmtThroughput(m.avgTPOTMs),
      'rocket',
      'Average token generation throughput (inverse of time per output token).',
    ));

    // Queue position
    items.push(new MetricTreeItem(
      'Running',
      fmtN(m.runningRequests),
      'play',
      'Number of requests currently being processed by the GPU.',
    ));
    items.push(new MetricTreeItem(
      'Waiting',
      fmtN(m.waitingRequests),
      'debug-pause',
      'Number of requests queued, waiting for GPU resources.',
    ));

    // Speculative decoding
    {
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
        items.push(new MetricTreeItem(
          'MTP',
          parts.join('  ·  '),
          'lightbulb',
          'Multi-Token Prediction (speculative decoding). Acceptance rate = percentage of draft tokens accepted without verification.',
        ));
      }
    }

    // Pressure indicators (only if > 0)
    if (m.preemptions != null) {
      items.push(new MetricTreeItem(
        'Preemptions',
        String(m.preemptions),
        'warning',
        'Number of requests preempted (evicted from KV cache) due to memory pressure. High values indicate cache contention.',
      ));
    }
    if (m.evictions != null) {
      items.push(new MetricTreeItem(
        'Evictions',
        String(m.evictions),
        'error',
        'Number of requests evicted from the queue without being processed due to resource exhaustion.',
      ));
    }

    // Last request details (if we have data for this server)
    if (serverUrl) {
      const lastRequest = getLastRequest(serverUrl);
      if (lastRequest) {
        items.push(new LastRequestTreeItem(
          lastRequest.serverUrl,
          lastRequest.modelId,
          lastRequest.timestamp,
          lastRequest.promptTokens,
          lastRequest.completionTokens,
          lastRequest.totalTokens,
          lastRequest.cachedTokens,
          lastRequest.createdCacheTokens,
          lastRequest.reasoningTokens,
          lastRequest.hasMetrics,
          lastRequest.hasCacheDetails,
          lastRequest.metrics?.time_to_first_token_ms,
          lastRequest.metrics?.generation_time_ms,
          lastRequest.metrics?.queue_time_ms,
          lastRequest.maxModelLen,
          lastRequest.maxOutputTokens,
          lastRequest.firstTokenTimeMs,
        ));
      }
    }

    return items;
  }

  private getLastRequestChildren(e: LastRequestTreeItem): (RequestMetricTreeItem | FlagHintTreeItem)[] {
    const items: (RequestMetricTreeItem | FlagHintTreeItem)[] = [];

    // 1. Total Tokens — context window usage (always available)
    if (e.maxModelLen > 0) {
      const pct = ((e.totalTokens / e.maxModelLen) * 100).toFixed(1);
      items.push(new RequestMetricTreeItem(
        'Total Tokens',
        `${fmtTokens(e.totalTokens)}  ·  ${pct}% of context`,
        'symbol-numeric',
        'Total tokens consumed (input + output) as a percentage of the model\'s context window.',
      ));
    }

    // 2. Input Tokens — always available from usage block; cache % needs --enable-prompt-tokens-details
    if (e.cachedTokens != null && e.cachedTokens > 0) {
      const cachedPct = ((e.cachedTokens / e.promptTokens) * 100).toFixed(1);
      items.push(new RequestMetricTreeItem(
        'Input Tokens',
        `${fmtTokens(e.promptTokens)}  ·  ${cachedPct}% cached`,
        'symbol-parameter',
        'Tokens in the prompt. Cached tokens were served from KV cache (not recomputed).',
      ));
    } else {
      items.push(new RequestMetricTreeItem(
        'Input Tokens',
        fmtTokens(e.promptTokens),
        'symbol-parameter',
        'Tokens in the prompt.',
      ));
    }

    // 3. Output Tokens — always available from usage block; budget % always available from settings
    if (e.maxOutputTokens > 0) {
      const pct = ((e.completionTokens / e.maxOutputTokens) * 100).toFixed(1);
      items.push(new RequestMetricTreeItem(
        'Output Tokens',
        `${fmtTokens(e.completionTokens)}  ·  ${pct}% of max output`,
        'code',
        'Tokens generated by the model. Max output = configured output budget from settings.',
      ));
    }

    // 4. Generation time + throughput (requires --enable-per-request-metrics)
    if (e.hasMetrics && e.generationMs != null && e.generationMs > 0) {
      const sec = (e.generationMs / 1000).toFixed(2);
      const tokPerSec = ((e.completionTokens / e.generationMs) * 1000).toFixed(1);
      items.push(new RequestMetricTreeItem(
        'Generation',
        `${sec}s  ·  ${tokPerSec} tok/s`,
        'rocket',
        'Time to generate all output tokens. Throughput = output tokens / generation time.',
      ));
    }

    // 5. Queue Time (requires --enable-per-request-metrics)
    if (e.hasMetrics && e.queueMs != null && e.queueMs > 0) {
      items.push(new RequestMetricTreeItem(
        'Queue Time',
        `${fmtMs(e.queueMs)}`,
        'debug-pause',
        'Time spent waiting in vLLM\'s request queue before processing started.',
      ));
    }

    // 6. TTFT — always shown (provider-measured); also show server-reported when available.
    // The difference is client overhead + network latency (config, request build, HTTP handshake, SSE parse).
    if (e.ttftMs != null && e.firstTokenTimeMs != null) {
      const overheadMs = Math.max(0, e.firstTokenTimeMs - e.ttftMs);
      items.push(new RequestMetricTreeItem(
        'TTFT',
        `reported: ${(e.ttftMs / 1000).toFixed(2)}s  ·  measured: ${(e.firstTokenTimeMs / 1000).toFixed(2)}s  ·  overhead: ${fmtMs(overheadMs)}`,
        'clock',
        'Time to first token. Reported = server\'s queue+prompt time. Measured = client wall-clock. Overhead = difference (network + client processing).',
      ));
    } else if (e.ttftMs != null) {
      items.push(new RequestMetricTreeItem(
        'TTFT',
        `${fmtMs(e.ttftMs)}`,
        'clock',
        'Time to first token (server-reported: queue + prompt processing).',
      ));
    } else if (e.firstTokenTimeMs != null) {
      items.push(new RequestMetricTreeItem(
        'TTFT',
        `${fmtMs(e.firstTokenTimeMs)}`,
        'clock',
        'Time to first token (client-measured wall-clock: includes network + server processing).',
      ));
    }

    // Hints for missing data
    const missingFlags: string[] = [];
    if (!e.hasCacheDetails) missingFlags.push('--enable-prompt-tokens-details');
    if (!e.hasMetrics) missingFlags.push('--enable-per-request-metrics');
    if (missingFlags.length > 0) {
      items.push(new FlagHintTreeItem(
        `⚡ More data with ${missingFlags.join(' & ')}`
      ));
      // The flag hint already has a tooltip set to the message itself,
      // which is fine — it reiterates the action needed.
    }
    return items;
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (!this.isVisible) return;
    this.pollTimer = setInterval(() => {
      this._onDidChangeTreeData.fire();
    }, this.getPollInterval());
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  async refresh(): Promise<void> {
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    this.stopPolling();
  }
}