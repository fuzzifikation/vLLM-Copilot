/**
 * Dashboard as a VS Code Tree View — sidebar UI only.
 * Data layer (fetching, parsing, aggregating) lives in vllmMetrics.ts.
 */

import * as vscode from 'vscode';
import { getConfig, resolveServerConfig, normalizeServerUrl, findModelConfig, type ModelConfig } from './config.js';
import { ServerMetrics, fmtPct, fmtMs, fmtN, fmtTokens, fmtThroughput, shortUrl, getMetricsEngine } from './vllmMetrics.js';
import {
  getLastRequest, getServerUsage, hasServerUsage, onUsageStoreDidChange,
  computeCost, findModelCost, formatCost, formatCostSummary, fmtCount, emptyCounts,
  getModelStartedAt,
  type UsageCounts,
} from './usageStore.js';

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

/** Collapsible "Token Usage and Cost" node — cumulative token/cost usage per server. */
class TokenUsageTreeItem extends vscode.TreeItem {
  constructor(
    public readonly serverUrl: string,
  ) {
    super('Token Usage and Cost', vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('credit-card');
    this.id = `tokenUsage:${serverUrl}`;
    this.contextValue = 'tokenUsage';
    this.tooltip = new vscode.MarkdownString('Cumulative token & cost usage per model for this server. Click to expand. Right-click → Set Cost… / Reset Usage.');
  }
}

/** Collapsible per-model usage node — children are Today and Overall. */
class ModelUsageTreeItem extends vscode.TreeItem {
  constructor(
    public readonly serverUrl: string,
    public readonly modelId: string,
    public readonly modelLabel: string,
    todayCost?: string,
  ) {
    super(modelLabel, vscode.TreeItemCollapsibleState.Collapsed);
    if (todayCost) this.description = todayCost;
    this.id = `modelUsage:${serverUrl}:${modelId}`;
    this.iconPath = new vscode.ThemeIcon('symbol-class');
    this.tooltip = new vscode.MarkdownString(`Today's usage for ${modelLabel}. Click to expand for the Today / Overall breakdown.`);
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
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * One-line usage summary: PRICE-FIRST when cost is configured (`$price · in ·
 * cached · out`), then the token split (in EXCLUDES cache; in + cached = total
 * input), optionally suffixed with `· started X ago` for the Overall row.
 * k/M-abbreviated; presentation only, the stored counts are never rounded.
 */
function usageLine(counts: UsageCounts, cost?: number, currency?: string, since?: number): string {
  const fresh = Math.max(0, counts.prompt - counts.cached);
  const tokens = counts.cached > 0
    ? `${fmtCount(fresh)} in · ${fmtCount(counts.cached)} cached · ${fmtCount(counts.completion)} out`
    : `${fmtCount(counts.prompt)} in · ${fmtCount(counts.completion)} out`;
  const costPart = cost !== undefined ? `${formatCost(cost, currency)} · ` : '';
  const sincePart = since !== undefined ? ` · started ${timeAgo(since)}` : '';
  return `${costPart}${tokens}${sincePart}`;
}

// ─── Tree Data Provider ──────────────────────────────────────────────

export class DashboardTreeProvider implements vscode.TreeDataProvider<ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem | LastRequestTreeItem | RequestMetricTreeItem | FlagHintTreeItem | TokenUsageTreeItem | ModelUsageTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem | LastRequestTreeItem | RequestMetricTreeItem | FlagHintTreeItem | TokenUsageTreeItem | ModelUsageTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Active engine subscriptions: serverUrl → { metrics, dispose } */
  private subscriptions: Array<{ serverUrl: string; metrics: ServerMetrics; dispose: () => void }> = [];
  private outputChannel: vscode.OutputChannel;
  /** Flag to coalesce multiple per-server updates into one tree re-render. */
  private refreshScheduled = false;
  /** Whether the sidebar is currently visible. `refreshSubscriptions` is async
   *  (awaits `getConfig`); this flag guards the continuation against a hide or
   *  dispose that happened while the await was in flight, so a hidden sidebar
   *  is never left polling. */
  private visible = false;
  /** Monotonic refresh token. Each `refreshSubscriptions` captures the current
   *  value and its continuation aborts if a newer refresh has since started.
   *  Without this, two overlapping refreshes (e.g. a config change racing a
   *  `setVisible(true)`) both pass the visibility check and both subscribe,
   *  double-polling the servers until the next toggle. */
  private refreshEpoch = 0;

  constructor(
    private context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
  ) {
    this.outputChannel = outputChannel;
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('vllm-copilot')) {
          this.refreshSubscriptions();
          this.fireTreeUpdate();
        }
      }),
    );
    // Live updates: the usage store fires after every recorded request or reset,
    // so both the "Last Request" and "Token Usage" nodes re-render immediately
    // instead of waiting for the next metrics poll tick. fireTreeUpdate coalesces
    // rapid events (e.g. auto-continue retries) into a single re-render.
    this.context.subscriptions.push(
      onUsageStoreDidChange(() => this.fireTreeUpdate()),
    );
  }

  /** Schedule a single tree update, coalescing multiple rapid requests. */
  private fireTreeUpdate(): void {
    if (!this.refreshScheduled) {
      this.refreshScheduled = true;
      queueMicrotask(() => {
        this.refreshScheduled = false;
        this._onDidChangeTreeData.fire();
      });
    }
  }

  /** Call when the tree view becomes visible or hidden */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.refreshSubscriptions();
      this.fireTreeUpdate(); // refresh on show
    } else {
      this.disposeSubscriptions();
    }
  }

  private async refreshSubscriptions(): Promise<void> {
    const epoch = ++this.refreshEpoch;
    this.disposeSubscriptions();
    try {
      const config = await getConfig(this.context);
      // The await above is a genuine suspension point. Abort the continuation if
      // either condition held while getConfig was resolving:
      //  - the sidebar was hidden or the provider disposed (visible flag);
      //  - a newer refresh started (epoch mismatch) and will subscribe itself.
      // In both cases subscribing here would create orphaned or duplicated
      // engine pollers.
      if (!this.visible || epoch !== this.refreshEpoch) {
        return;
      }
      // Group models by server URL
      const serverMap = new Map<string, Record<string, string>>();
      for (const model of config.models) {
        if (!model.serverUrl) continue;
        if (!serverMap.has(model.serverUrl)) {
          const serverConfig = resolveServerConfig(model);
          serverMap.set(model.serverUrl, serverConfig.requestHeaders);
        }
      }

      for (const [url, headers] of serverMap) {
        const engine = getMetricsEngine(url, headers);
        const sub = engine.subscribe((aggregated) => {
          // Update cached metrics and schedule a single re-render
          const entry = this.subscriptions.find(s => s.serverUrl === url);
          if (entry) entry.metrics = aggregated;
          this.fireTreeUpdate();
        });
        this.subscriptions.push({
          serverUrl: url,
          metrics: engine.getCachedAggregated() ?? emptyFallbackMetrics(),
          dispose: sub.dispose,
        });
      }
    } catch (err) {
      this.outputChannel.appendLine(`[DASHBOARD] refreshSubscriptions failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private disposeSubscriptions(): void {
    for (const sub of this.subscriptions) {
      try { sub.dispose(); } catch { /* best-effort */ }
    }
    this.subscriptions = [];
  }

  private getPollIntervalTreeItem(): PollIntervalTreeItem {
    const intervalMs = vscode.workspace.getConfiguration('vllm-copilot.dashboard').get<number>('pollIntervalMs', 15000);
    const label = intervalMs < 60000 ? `${intervalMs / 1000}s` : `${Math.round(intervalMs / 1000)}s`;
    return new PollIntervalTreeItem(label);
  }

  getTreeItem(element: ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem | LastRequestTreeItem | RequestMetricTreeItem | FlagHintTreeItem | TokenUsageTreeItem | ModelUsageTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem | LastRequestTreeItem | RequestMetricTreeItem | FlagHintTreeItem | TokenUsageTreeItem | ModelUsageTreeItem): Promise<(ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem | LastRequestTreeItem | RequestMetricTreeItem | FlagHintTreeItem | TokenUsageTreeItem | ModelUsageTreeItem)[]> {
    if (!element) {
      const items: (ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem)[] = [this.getPollIntervalTreeItem()];
      const servers = this.subscriptions.map(sub =>
        new ServerTreeItem(sub.serverUrl, sub.metrics),
      );
      return [...items, ...servers, new AddServerTreeItem(), new TestRefreshTreeItem()];
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

    if (element instanceof TokenUsageTreeItem) {
      return this.getTokenUsageChildren(element);
    }

    if (element instanceof ModelUsageTreeItem) {
      return this.getModelUsageChildren(element);
    }

    return [];
  }

  private getServerMetricsChildren(m: ServerMetrics, serverUrl?: string): (MetricTreeItem | ModelsTreeItem | LastRequestTreeItem | FlagHintTreeItem | TokenUsageTreeItem)[] {
    const items: (MetricTreeItem | ModelsTreeItem | LastRequestTreeItem | FlagHintTreeItem | TokenUsageTreeItem)[] = [];
    if (!m.online) {
      return [new MetricTreeItem('Error', m.error || 'Connection failed', 'error')];
    }

    // Basic info
    if (m.version) {
      // vLLM's /version endpoint already returns the version with a leading
      // "v" (e.g. "v0.6.0"), so prepending another "v" would render "vv0.6.0".
      items.push(new MetricTreeItem('vLLM Version', m.version, 'server'));
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
      // consumeStream writes the store keyed by the NORMALIZED server URL
      // (resolveServerConfig → normalizeServerUrl). The dashboard's serverUrl
      // here is the raw `model.serverUrl` — a config may legally use a
      // scheme-less, trailing-slash, or /v1 form — so normalize before the
      // lookup, otherwise the Last Request node silently vanishes for those
      // forms.
      const lastRequest = getLastRequest(normalizeServerUrl(serverUrl));
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

      // Cumulative Token Usage — live via onUsageStoreDidChange (see constructor).
      // `serverUrl` here is the raw `model.serverUrl`; the store keys by the
      // NORMALIZED URL (same as the Last Request lookup above), so normalize
      // before the read or the node silently vanishes for scheme-less/slash/v1 forms.
      const normalizedUrl = normalizeServerUrl(serverUrl);
      if (hasServerUsage(normalizedUrl)) {
        items.push(new TokenUsageTreeItem(normalizedUrl));
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
        `${fmtCount(e.totalTokens)}  ·  ${pct}% of context`,
        'symbol-numeric',
        'Total tokens consumed (input + output) as a percentage of the model\'s context window.',
      ));
    }

    // 2. Input Tokens — always available from usage block; cache % needs --enable-prompt-tokens-details
    if (e.cachedTokens != null && e.cachedTokens > 0) {
      // Input split: 'in' excludes cache; in + cached = total prompt.
      const fresh = Math.max(0, e.promptTokens - e.cachedTokens);
      items.push(new RequestMetricTreeItem(
        'Input Tokens',
        `${fmtCount(fresh)} in · ${fmtCount(e.cachedTokens)} cached`,
        'symbol-parameter',
        "Input split: 'in' excludes cache; 'cached' was served from KV cache (not recomputed). in + cached = total prompt.",
      ));
    } else {
      items.push(new RequestMetricTreeItem(
        'Input Tokens',
        fmtCount(e.promptTokens),
        'symbol-parameter',
        'Tokens in the prompt.',
      ));
    }

    // 3. Output Tokens — always available from usage block; budget % always available from settings
    if (e.maxOutputTokens > 0) {
      const pct = ((e.completionTokens / e.maxOutputTokens) * 100).toFixed(1);
      items.push(new RequestMetricTreeItem(
        'Output Tokens',
        `${fmtCount(e.completionTokens)}  ·  ${pct}% of max output`,
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

    // 7. Cost — derived from the model's per-1M cost config (never stored).
    //    Only shown when the model has cost rates configured.
    const models = this.readConfiguredModels();
    const rates = findModelCost(models, e.serverUrl, e.modelId);
    const requestCounts: UsageCounts = {
      prompt: e.promptTokens,
      completion: e.completionTokens,
      cached: e.cachedTokens ?? 0,
      reasoning: e.reasoningTokens ?? 0,
    };
    const cost = computeCost(requestCounts, rates);
    if (cost !== undefined) {
      items.push(new RequestMetricTreeItem(
        'Cost',
        formatCost(cost, rates?.currency),
        'credit-card',
        'Estimated cost of this request from the model\'s configured per-1M cost rates. Shown per-prompt for money verification.',
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

  /** Children of the Token Usage node: one collapsible node per model. */
  private getTokenUsageChildren(e: TokenUsageTreeItem): ModelUsageTreeItem[] {
    const models = this.readConfiguredModels();
    const usage = getServerUsage(e.serverUrl);
    // Union of models with any today or all-time usage (a model used yesterday
    // still needs its Overall row visible).
    const modelIds = Array.from(new Set([...Object.keys(usage.today), ...Object.keys(usage.allTime)])).sort();
    return modelIds.map(modelId => {
      const entry = findModelConfig(models, e.serverUrl, modelId);
      const label = entry?.displayName || entry?.id || modelId;
      // Collapsed description: "$11.51 today and $31.13 in 3.1 days" — today's
      // cost plus the all-time cost over the recording window (startedAt).
      const summary = formatCostSummary(
        computeCost(usage.today[modelId] ?? emptyCounts(), entry?.cost),
        computeCost(usage.allTime[modelId] ?? emptyCounts(), entry?.cost),
        entry?.cost?.currency,
        getModelStartedAt(e.serverUrl, modelId),
      );
      return new ModelUsageTreeItem(e.serverUrl, modelId, label, summary);
    });
  }

  /** Children of a model node: Today and Overall, price-first. */
  private getModelUsageChildren(e: ModelUsageTreeItem): MetricTreeItem[] {
    const models = this.readConfiguredModels();
    const usage = getServerUsage(e.serverUrl);
    const entry = findModelConfig(models, e.serverUrl, e.modelId);
    const currency = entry?.cost?.currency;
    const today = usage.today[e.modelId] ?? emptyCounts();
    const overall = usage.allTime[e.modelId] ?? emptyCounts();
    const since = getModelStartedAt(e.serverUrl, e.modelId);
    return [
      new MetricTreeItem(
        'Today',
        usageLine(today, computeCost(today, entry?.cost), currency),
        'calendar',
        `Today's usage for ${e.modelLabel}. Input is split: 'in' excludes cache; in + cached = total input.`,
      ),
      new MetricTreeItem(
        'Overall',
        usageLine(overall, computeCost(overall, entry?.cost), currency, since),
        'history',
        `All-time usage for ${e.modelLabel}${since !== undefined ? `; recording started ${timeAgo(since)}.` : '.'}`,
      ),
    ];
  }

  /** Read the configured model entries (sync settings read) for cost lookups. */
  private readConfiguredModels(): ModelConfig[] {
    return vscode.workspace.getConfiguration('vllm-copilot').get<ModelConfig[]>('models') || [];
  }

  async refresh(): Promise<void> {
    await this.refreshSubscriptions();
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    this.visible = false;
    this.disposeSubscriptions();
    this._onDidChangeTreeData.dispose();
  }
}

/** Fallback metrics for a server before first data arrives. */
function emptyFallbackMetrics(): ServerMetrics {
  return {
    online: false, error: 'Loading…',
    models: [], maxModelLen: null, kvCacheUsagePercent: null, runningRequests: null, waitingRequests: null,
    cacheHitRate: null, specAcceptanceRate: null, specDraftsTotal: null, specDraftDepth: null,
    avgTTFTMs: null, avgTPOTMs: null, preemptions: null, evictions: null,
  };
}
