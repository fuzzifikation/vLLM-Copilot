/**
 * Dashboard as a VS Code Tree View — sidebar UI only.
 * Data layer (fetching, parsing, aggregating) lives in vllmMetrics.ts.
 */

import * as vscode from 'vscode';
import { getConfig, resolveServerConfig } from './config.js';
import { ServerMetrics, fetchServerMetrics, fmtPct, fmtMs, fmtN, fmtTokens, fmtThroughput, shortUrl } from './vllmMetrics.js';

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
  constructor(label: string, value: string, icon?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
    this.tooltip = `${label}: ${value}`;
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

// ─── Tree Data Provider ──────────────────────────────────────────────

export class DashboardTreeProvider implements vscode.TreeDataProvider<ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem | undefined | void>();
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

  getTreeItem(element: ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem): Promise<(ServerTreeItem | ModelsTreeItem | ModelTreeItem | MetricTreeItem | PollIntervalTreeItem | AddServerTreeItem | TestRefreshTreeItem)[]> {
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

    // Basic info
    if (m.version) {
      items.push(new MetricTreeItem('vLLM Version', 'v' + m.version, 'server'));
    }
    if (m.models.length > 0) {
      items.push(new ModelsTreeItem(m.models));
    }
    items.push(new MetricTreeItem('Context Window', fmtTokens(m.maxModelLen), 'layers'));

    // Server stats
    items.push(new MetricTreeItem('KV Cache', fmtPct(m.kvCacheUsagePercent), 'graph'));
    items.push(new MetricTreeItem('KV Cache Hit', fmtPct(m.cacheHitRate), 'check-all'));
    items.push(new MetricTreeItem('Avg TTFT', fmtMs(m.avgTTFTMs), 'clock'));
    items.push(new MetricTreeItem('Throughput', fmtThroughput(m.avgTPOTMs), 'rocket'));

    // Queue position
    items.push(new MetricTreeItem('Running', fmtN(m.runningRequests), 'play'));
    items.push(new MetricTreeItem('Waiting', fmtN(m.waitingRequests), 'debug-pause'));

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