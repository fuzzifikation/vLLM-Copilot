/**
 * Dashboard as a VS Code Tree View — sidebar UI only.
 * Data layer (fetching, parsing, aggregating) lives in vllmMetrics.ts.
 */

import * as vscode from 'vscode';
import { getConfig, resolveServerConfig, resolveModelSettings, normalizeServerUrl, findModelConfig, serverFingerprint, serverGroupKey, type ModelConfig, type ServerType } from './config.js';
import { ServerMetrics, fmtPct, fmtMs, fmtN, fmtThroughput, fmtTokPerSec, shortUrl, getMetricsEngine } from './vllmMetrics.js';
import { perMillion, formatUsdRate, type OpenRouterAccount, type OpenRouterCredits, type OpenRouterModelEndpoint } from './openRouter.js';
import {
  getLastRequest, getServerUsage, getServerCost, hasServerUsage, onUsageStoreDidChange,
  computeCost, findModelCost, formatCost, formatCostFine, formatCostSummary, fmtCount, emptyCounts,
  getModelStartedAt,
  type UsageCounts, type CostRates,
} from './usageStore.js';

// ─── Tree Items ──────────────────────────────────────────────────────

/** Build a compact one-line summary for the collapsed server node description */
function summaryLine(m: ServerMetrics): string {
  const parts: string[] = [];
  if (m.runningRequests != null) parts.push(`${m.runningRequests} running`);
  if (m.waitingRequests != null && m.waitingRequests > 0) parts.push(`${m.waitingRequests} waiting`);
  return parts.join('  ·  ') || 'idle';
}

/** Deterministic ISO date (YYYY-MM-DD) — locale-independent, unlike toLocaleDateString. */
function isoDate(value?: string | null): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

/** A server node in the tree (collapsible, shows metrics as children) */
class ServerTreeItem extends vscode.TreeItem {
  /**
   * @param key - Stable identity key (URL + header fingerprint hash). Two models
   *   sharing a URL with different credentials get distinct keys — the tree id
   *   and metrics are per identity.
   * @param requestHeaders - This identity's exact credentials, carried so the
   *   Deep-Dive command uses the right ones (never the first model's).
   * @param displayLabel - Optional disambiguated label (e.g. `s:8000 (identity 2)`) when
   *   multiple identities share one URL; defaults to `shortUrl(serverUrl)`.
   */
  constructor(
    public readonly key: string,
    /** Identity fingerprint (URL + headers) — matches the engine registry key. */
    public readonly fp: string,
    public readonly serverUrl: string,
    public readonly requestHeaders: Record<string, string>,
    public readonly metrics: ServerMetrics,
    public readonly serverType?: ServerType,
    displayLabel?: string,
  ) {
    const displayName = displayLabel ?? shortUrl(serverUrl);
    const statusIcon = metrics.online
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));

    super(displayName, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = statusIcon;
    this.id = `server:${key}`;
    // OpenRouter is a relay, not a server: /v1/models is the whole catalog (not
    // "the server's models") and any context window here is one arbitrary
    // configured model's — wrong scope to present as server-wide. Suppress both
    // until the model-collection restructure (Phase 2) lands. Also: a relay has
    // no running/waiting-request gauges, so "idle" would be a fabricated stat —
    // show NO description behind an online OpenRouter server.
    const isOpenRouterRelay = serverType === 'openrouter';
    // No "degraded" label — every backend is a first-class dashboard citizen.
    this.description = metrics.online
      ? (isOpenRouterRelay ? undefined : summaryLine(metrics))
      : 'Offline';
    const modelsLine = isOpenRouterRelay ? '' : `\n*${metrics.models.join(', ') || 'no models'}*`;
    const contextLine = isOpenRouterRelay || metrics.maxModelLen == null
      ? ''
      : `\n\n**Context window:** ${fmtCount(metrics.maxModelLen)}`;
    this.tooltip = new vscode.MarkdownString(
      `${serverUrl}${modelsLine}${contextLine}` +
      (serverType ? `\n**Backend:** ${serverType}` : '')
    );
    // Context value encodes whether deep-dive applies: vLLM-only. Non-vLLM
    // servers expose auth/remove but not the vLLM metrics deep-dive.
    const isVllm = serverType === undefined || serverType === 'vllm';
    const state = metrics.online ? 'serverOnline' : 'serverOffline';
    this.contextValue = isVllm ? state : `${state}NoDive`;
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

/** OpenRouter relay: collapsible "Account" node — credits/limits from /api/v1/key. */
class OpenRouterAccountTreeItem extends vscode.TreeItem {
  constructor(
    public readonly serverUrl: string,
    public readonly account: OpenRouterAccount,
    /** Total-budget info from /api/v1/credits (may be undefined on a failed probe). */
    public readonly credits: OpenRouterCredits | undefined,
    /** Identity fingerprint — the account is per-key, so two identities on one URL differ. */
    public readonly fp: string,
  ) {
    super('Account', vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('account');
    this.id = `openRouterAccount:${serverGroupKey(fp)}`;
    const remaining = account.limit_remaining;
    // Prefer the real budget (credits loaded − used) for the one-liner; fall back
    // to the per-key remaining / free-tier / monthly usage when that's absent.
    const budgetRemaining = credits?.total_credits != null && credits?.total_usage != null
      ? Math.max(0, credits.total_credits - credits.total_usage)
      : undefined;
    this.description = budgetRemaining != null
      ? `${formatCost(budgetRemaining, 'USD')} available`
      : remaining != null
        ? `${formatCost(remaining, 'USD')} remaining`
        : account.is_free_tier
          ? 'free tier'
          : account.usage_monthly != null
            ? `usage ${formatCost(account.usage_monthly, 'USD')}/mo`
            : undefined;
    this.tooltip = new vscode.MarkdownString('OpenRouter account/key health. Reflects the credential this server was configured with.');
  }
}

/**
 * Why the model's effective output is below the configured budget. One entry per
 * binding constraint, so the tooltip can tell the truth about each — a catalog
 * clamp is silently shorter output, a pinned-provider cap is "requests may fail".
 */
interface OutputClampCause {
  /** Constraint kind — for honest wording. */
  kind: 'catalog' | 'provider';
  /** The ceiling this constraint imposes. */
  ceiling: number;
  /** Provider name (only when kind === 'provider'). */
  providerName?: string;
}

/** OpenRouter relay: one configured model with its own model-level rows. */
class OpenRouterModelTreeItem extends vscode.TreeItem {
  constructor(
    public readonly serverUrl: string,
    public readonly modelId: string,
    modelLabel: string,
    /** Pinned provider label shown as the collapsed description — or undefined (nothing). */
    providerLabel: string | undefined,
    /** Identity fingerprint — the model belongs to exactly one credential identity. */
    public readonly fp: string,
    /** The configured output budget (for the tooltip when clamped). */
    configuredOutput?: number,
    /** The effective (clamped) output ceiling after ALL binding constraints. */
    effectiveOutput?: number,
    /** The constraint(s) that pushed the effective output below the configured budget. */
    clampCauses: OutputClampCause[] = [],
  ) {
    super(modelLabel, vscode.TreeItemCollapsibleState.Collapsed);
    // Collapsed one-liner: "<Model> run by <Provider>" — the routing identity
    // tells who actually serves this model. Nothing when no provider is pinned.
    if (providerLabel) this.description = `run by ${providerLabel}`;
    const clamped = clampCauses.length > 0;
    this.iconPath = clamped
      ? new vscode.ThemeIcon('alert', new vscode.ThemeColor('charts.yellow'))
      : new vscode.ThemeIcon('symbol-class');
    this.id = `openRouterModel:${serverGroupKey(fp)}:${modelId}`;
    // `clamped` requires at least one numeric binding cause, and every cause sets
    // `effectiveOutput` (catalog → the ceiling; provider → min with it), so both
    // numbers are always present when clamped. Defensive: if that invariant ever
    // breaks, fall back to the normal tooltip rather than showing a half-truth.
    this.tooltip = clamped && configuredOutput !== undefined && effectiveOutput !== undefined
      ? new vscode.MarkdownString(this.buildClampTooltip(modelLabel, configuredOutput, effectiveOutput, clampCauses))
      : new vscode.MarkdownString(`${modelLabel} — click for model-level detail (provider, pricing, context, capabilities, usage).`);
  }

  /** Honest tooltip: what binds, and whether that's a silent clamp or a hard failure. */
  private buildClampTooltip(
    modelLabel: string,
    configuredOutput: number,
    effectiveOutput: number,
    causes: OutputClampCause[],
  ): string {
    const lines = causes.map((c) => {
      const exact = c.ceiling.toLocaleString('en-US');
      if (c.kind === 'catalog') {
        return `- **${exact}** (the model's output ceiling) — output is silently clamped; you'll get shorter replies.`;
      }
      return `- **${exact}** (pinned provider ${c.providerName ?? 'cap'}) — requests over this cap may **fail**. Unpin or lower the setting.`;
    });
    return `${modelLabel} — output budget clamped.\n\nConfigured maxOutputTokens **${configuredOutput.toLocaleString('en-US')}** → effective **${effectiveOutput.toLocaleString('en-US')}**.\n\nBinding constraints:\n${lines.join('\n')}`;
  }
}

/** A metric row (label: value) */
class MetricTreeItem extends vscode.TreeItem {
  constructor(label: string, value: string, icon?: string, tooltip?: string, iconColor?: vscode.ThemeColor) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    if (icon) {
      this.iconPath = iconColor
        ? new vscode.ThemeIcon(icon, iconColor)
        : new vscode.ThemeIcon(icon);
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
    public readonly totalTimeMs: number | null = null,
    public readonly serverType?: ServerType,
    public readonly actualCost?: number,
    public readonly usedByok?: boolean,
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
 * One-line usage row: the token split (in EXCLUDES cache; in + cached = total
 * input), optionally suffixed with `· started X ago` for the Overall row.
 * Token-only — the price lives on the model line above. k/M-abbreviated;
 * presentation only, the stored counts are never rounded.
 */
function usageLine(counts: UsageCounts, since?: number): string {
  const fresh = Math.max(0, counts.prompt - counts.cached);
  const tokens = counts.cached > 0
    ? `${fmtCount(fresh)} in · ${fmtCount(counts.cached)} cached · ${fmtCount(counts.completion)} out`
    : `${fmtCount(counts.prompt)} in · ${fmtCount(counts.completion)} out`;
  const sincePart = since !== undefined ? ` · started ${timeAgo(since)}` : '';
  return `${tokens}${sincePart}`;
}

// ─── Tree Data Provider ──────────────────────────────────────────────

export class DashboardTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Active engine subscriptions: one per server identity (URL + headers). */
  private subscriptions: Array<{
    key: string;
    /** Identity fingerprint (URL + headers) — matches the engine registry key. */
    fp: string;
    url: string;
    requestHeaders: Record<string, string>;
    serverType?: ServerType;
    metrics: ServerMetrics;
    dispose: () => void;
  }> = [];
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
      // Group models by server IDENTITY (URL + header fingerprint), not URL
      // alone. Headers are per-model in this project — two models sharing a URL
      // with different credentials/scopes are DIFFERENT logical servers and each
      // gets its own engine, poller, and tree node (one model's credentials must
      // never drive a sibling's metrics). Collect ALL wire ids per identity — the
      // engine needs them to resolve the per-backend context window (non-vLLM
      // only; OpenRouter relay models can have different windows).
      const identityMap = new Map<string, {
        url: string;
        requestHeaders: Record<string, string>;
        modelIds: string[];
        serverType?: ServerType;
      }>();
      for (const model of config.models) {
        if (!model.serverUrl) continue;
        const resolved = resolveServerConfig(model);
        if (!resolved.serverUrl) continue;
        const fp = serverFingerprint(resolved.serverUrl, resolved.requestHeaders);
        let group = identityMap.get(fp);
        if (!group) {
          group = { url: resolved.serverUrl, requestHeaders: resolved.requestHeaders, modelIds: [], serverType: model.serverType };
          identityMap.set(fp, group);
        }
        const wireId = model.vllmModelId ?? model.id;
        if (wireId) group.modelIds.push(wireId);
        if (!group.serverType && model.serverType) group.serverType = model.serverType;
      }

      for (const [fp, group] of identityMap) {
        const key = serverGroupKey(fp);
        const engine = getMetricsEngine(group.url, group.requestHeaders, group.serverType ?? 'vllm', group.modelIds, this.outputChannel);
        const sub = engine.subscribe((aggregated) => {
          // Update cached metrics and schedule a single re-render
          const entry = this.subscriptions.find(s => s.key === key);
          if (entry) entry.metrics = aggregated;
          this.fireTreeUpdate();
        });
        this.subscriptions.push({
          key,
          fp,
          url: group.url,
          requestHeaders: group.requestHeaders,
          serverType: group.serverType,
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

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      const items: vscode.TreeItem[] = [this.getPollIntervalTreeItem()];
      // Disambiguate labels when multiple identities share one URL so each
      // credential set is visibly its own node.
      const urlCount = new Map<string, number>();
      for (const sub of this.subscriptions) urlCount.set(sub.url, (urlCount.get(sub.url) ?? 0) + 1);
      const urlSeen = new Map<string, number>();
      const servers = this.subscriptions.map(sub => {
        const n = (urlSeen.get(sub.url) ?? 0) + 1;
        urlSeen.set(sub.url, n);
        const label = (urlCount.get(sub.url) ?? 1) > 1 ? `${shortUrl(sub.url)} (identity ${n})` : undefined;
        return new ServerTreeItem(sub.key, sub.fp, sub.url, sub.requestHeaders, sub.metrics, sub.serverType, label);
      });
      return [...items, ...servers, new AddServerTreeItem(), new TestRefreshTreeItem()];
    }

    if (element instanceof ServerTreeItem) {
      return this.getServerMetricsChildren(element.metrics, element.serverUrl, element.serverType, element.fp);
    }

    if (element instanceof ModelsTreeItem) {
      return element.modelNames.map(name => new ModelTreeItem(name));
    }

    if (element instanceof OpenRouterAccountTreeItem) {
      return this.getOpenRouterAccountChildren(element);
    }

    if (element instanceof OpenRouterModelTreeItem) {
      return this.getOpenRouterModelChildren(element);
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

  private getServerMetricsChildren(m: ServerMetrics, serverUrl?: string, serverType?: ServerType, fp?: string): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = [];
    if (!m.online) {
      return [new MetricTreeItem('Error', m.error || 'Connection failed', 'error')];
    }

    // Basic info
    if (m.version) {
      // vLLM's /version endpoint already returns the version with a leading
      // "v" (e.g. "v0.6.0"), so prepending another "v" would render "vv0.6.0".
      items.push(new MetricTreeItem('vLLM Version', m.version, 'server'));
    }
    // OpenRouter relay: render as a MODEL COLLECTION (Option A). /v1/models is
    // the whole catalog (not "the server's models") and each configured model
    // has its own context window — so instead of the vLLM "Model IDs" node and
    // a single server Context Window row, show account health (from /api/v1/key)
    // plus one collapsible node PER configured model (each with its own context
    // in the description and model-level rows on expand).
    const isOpenRouterRelay = serverType === 'openrouter';
    if (isOpenRouterRelay) {
      if (m.account) {
        items.push(new OpenRouterAccountTreeItem(serverUrl ?? '', m.account, m.credits, fp ?? ''));
      }
      items.push(...this.getRelayModelTreeItems(serverUrl ?? '', fp ?? ''));
    } else {
      if (m.models.length > 0) {
        items.push(new ModelsTreeItem(m.models));
      }
      // Context window — only when resolved. vLLM from /v1/models max_model_len;
      // non-vLLM from the per-backend resolver (LM Studio context_length, llama.cpp
      // n_ctx, Ollama /api/ps, OpenRouter exact-model). No data → no row.
      if (m.maxModelLen != null) {
        items.push(new MetricTreeItem(
          'Context Window',
          fmtCount(m.maxModelLen),
          'layers',
          'Maximum context length (input + output combined) for this model.',
        ));
      }
    }

    // Server stats — each row only when the backend reports the value. vLLM-only
    // metrics are simply absent for non-vLLM backends; no dash placeholders.
    if (m.kvCacheUsagePercent != null) {
      items.push(new MetricTreeItem(
        'KV Cache',
        fmtPct(m.kvCacheUsagePercent),
        'graph',
        'Current KV cache utilization. High usage means less headroom for concurrent requests.',
      ));
    }
    if (m.cacheHitRate != null) {
      items.push(new MetricTreeItem(
        'KV Cache Hit',
        fmtPct(m.cacheHitRate),
        'check-all',
        'Percentage of input tokens served from cache (prefill skipped). Higher = faster prompts.',
      ));
    }
    if (m.avgTTFTMs != null) {
      items.push(new MetricTreeItem(
        'Avg TTFT',
        fmtMs(m.avgTTFTMs),
        'clock',
        'Average time to first token across recent requests (queue + prompt processing).',
      ));
    }
    if (m.avgTputTokPerSec != null || m.avgTPOTMs != null) {
      const outSpeed = m.avgTputTokPerSec != null ? fmtTokPerSec(m.avgTputTokPerSec) : fmtThroughput(m.avgTPOTMs);
      const prefillSpeed = m.avgPrefillTputTokPerSec != null ? fmtTokPerSec(m.avgPrefillTputTokPerSec) : null;
      items.push(new MetricTreeItem(
        'Speed',
        prefillSpeed != null ? `Output ${outSpeed} · Prefill ${prefillSpeed}` : `Output ${outSpeed}`,
        'rocket',
        m.avgTputTokPerSec != null
          ? 'Pooled throughput across requests. Output = Σ generation tokens ÷ Σ decode time (output-only; counts every emitted token, so MTP/spec-decode stays honest). Prefill = Σ prompt tokens ÷ Σ prefill time (includes cache-served tokens).'
          : 'Average token generation throughput (inverse of time per output token).',
      ));
    }

    // Queue position
    if (m.runningRequests != null) {
      items.push(new MetricTreeItem(
        'Running',
        fmtN(m.runningRequests),
        'play',
        'Number of requests currently being processed by the GPU.',
      ));
    }
    if (m.waitingRequests != null) {
      items.push(new MetricTreeItem(
        'Waiting',
        fmtN(m.waitingRequests),
        'debug-pause',
        'Number of requests queued, waiting for GPU resources.',
      ));
    }

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
          lastRequest.totalTimeMs,
          serverType,
          lastRequest.actualCost,
          lastRequest.usedByok,
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

  /** Children of the OpenRouter Account node: credit/limit/free-tier rows. */
  private getOpenRouterAccountChildren(e: OpenRouterAccountTreeItem): MetricTreeItem[] {
    const items: MetricTreeItem[] = [];
    const a = e.account;
    // ── Account budget (from /api/v1/credits) — the account-level money, present
    // even when the per-key limit is null (unlimited). `total_credits` = money
    // ever loaded (Invested Total); available = loaded − spent (the API's
    // total_usage), floored at 0. "Total Used" is deliberately NOT shown — it is
    // pure arithmetic (Invested − Available) and would be redundant noise.
    const c = e.credits;
    if (c?.total_credits != null) {
      items.push(new MetricTreeItem('Invested Total', formatCost(c.total_credits, 'USD'), 'credit-card', 'Total credits ever loaded into this account (all top-ups), from /api/v1/credits.'));
    }
    if (c?.total_credits != null && c?.total_usage != null) {
      items.push(new MetricTreeItem('Available', formatCost(Math.max(0, c.total_credits - c.total_usage), 'USD'), 'pulse', 'Invested total minus total usage (floor 0) — what you can still spend.'));
    }
    if (a.limit_remaining != null) {
      items.push(new MetricTreeItem('Credits Remaining', formatCost(a.limit_remaining, 'USD'), 'credit-card', 'OpenRouter credits available on this key.'));
    }
    if (a.limit != null) {
      items.push(new MetricTreeItem('Credit Limit', formatCost(a.limit, 'USD'), 'pulse', 'Credit limit on this key (null = unlimited).'));
    }
    if (a.usage != null) {
      items.push(new MetricTreeItem('Usage (all-time)', formatCost(a.usage, 'USD'), 'history', 'Total OpenRouter credits used on this key.'));
    }
    if (a.usage_monthly != null) {
      items.push(new MetricTreeItem('Usage (monthly)', formatCost(a.usage_monthly, 'USD'), 'calendar', 'Credits used this UTC month.'));
    }
    if (a.usage_weekly != null) {
      items.push(new MetricTreeItem('Usage (weekly)', formatCost(a.usage_weekly, 'USD'), 'calendar', 'Credits used this UTC week.'));
    }
    if (a.usage_daily != null) {
      items.push(new MetricTreeItem('Usage (today)', formatCost(a.usage_daily, 'USD'), 'calendar', 'Credits used today (UTC).'));
    }
    if (a.byok_usage != null) {
      items.push(new MetricTreeItem('BYOK Usage', formatCost(a.byok_usage, 'USD'), 'key', 'Usage billed directly to your upstream provider (BYOK), not OpenRouter credits.'));
    }
    if (a.byok_usage_monthly != null) {
      items.push(new MetricTreeItem('BYOK Usage (monthly)', formatCost(a.byok_usage_monthly, 'USD'), 'key', 'BYOK usage billed this UTC month.'));
    }
    if (a.is_free_tier) {
      items.push(new MetricTreeItem('Free Tier', 'yes', 'star', 'This account has never paid — subject to free-tier rate limits.'));
    }
    if (a.is_management_key || a.is_provisioning_key) {
      const kind = a.is_management_key ? 'Management' : 'Provisioning';
      items.push(new MetricTreeItem('Key Type', kind, 'key', 'Key role: Management keys control the account; Provisioning keys are for automated provisioning. Standard keys have no role.'));
    }
    const expiry = isoDate(a.expires_at);
    if (expiry) {
      items.push(new MetricTreeItem('Key Expires', expiry, 'calendar', 'This API key expires on this date. Rotate before then.'));
    }
    const limitReset = isoDate(a.limit_reset);
    if (limitReset) {
      items.push(new MetricTreeItem('Limit Resets', limitReset, 'refresh', 'The credit limit resets to its full value on this date.'));
    }
    if (a.label) {
      items.push(new MetricTreeItem('Key Label', a.label, 'tag', 'The label OpenRouter stores for this API key.'));
    }
    return items;
  }

  /** One collapsible node per configured relay model (direct children of the
   *  OpenRouter server node). Each shows its own context window in the
   *  description and model-level rows on expand. */
  private getRelayModelTreeItems(serverUrl: string, fp: string): OpenRouterModelTreeItem[] {
    const models = this.getRelayModels(fp);
    const seen = new Set<string>();
    const items: OpenRouterModelTreeItem[] = [];
    for (const model of models) {
      const modelId = model.vllmModelId ?? model.id;
      if (!modelId || seen.has(modelId)) continue; // dedupe shared wire ids
      seen.add(modelId);
      const label = model.displayName || model.id || modelId;
      // Collapsed description: the pinned provider's name (or nothing). The
      // provider is the routing identity — the context window is not intuitive
      // as a one-liner, so show it only in the expanded Context+Output row.
      const pinnedProvider = model.provider;
      let providerLabel: string | undefined;
      if (pinnedProvider) {
        const endpoints = this.relayProviders(fp, modelId);
        const pinned = endpoints?.find(ep => ep.tag === pinnedProvider);
        providerLabel = pinned
          ? pinned.providerName + (pinned.quantization && pinned.quantization !== 'unknown' ? ` (${pinned.quantization})` : '')
          : pinnedProvider; // list not loaded — the tag itself, never invented
      }
      // Output-budget attention — SYMMETRIC across all binding constraints. The
      // effective output is the min of EVERY ceiling that applies: the general
      // catalog ceiling (from the engine) and the pinned provider's own cap (from
      // `/endpoints`). Whoever clamps below the configured budget shows the
      // Attention icon + honest tooltip. Display-only — settings never rewritten.
      const configuredOutput = resolveModelSettings(model).maxOutputTokens;
      const catalogCeiling = this.relayEffectiveOutput(fp, modelId);
      const clampCauses: OutputClampCause[] = [];
      let effectiveOutput = catalogCeiling;
      if (catalogCeiling !== undefined && catalogCeiling < configuredOutput) {
        clampCauses.push({ kind: 'catalog', ceiling: catalogCeiling });
      }
      if (pinnedProvider) {
        const endpoints = this.relayProviders(fp, modelId);
        const pinned = endpoints?.find(ep => ep.tag === pinnedProvider);
        const providerCap = pinned?.maxCompletionTokens;
        if (typeof providerCap === 'number' && providerCap > 0 && providerCap < configuredOutput) {
          clampCauses.push({ kind: 'provider', ceiling: providerCap, providerName: pinned?.providerName });
          // The provider cap is a real constraint on the request — it binds below
          // the catalog ceiling when smaller (effective output = min of both).
          if (effectiveOutput === undefined || providerCap < effectiveOutput) effectiveOutput = providerCap;
        }
      }
      const clamped = clampCauses.length > 0;
      items.push(new OpenRouterModelTreeItem(serverUrl, modelId, label, providerLabel, fp, configuredOutput, effectiveOutput, clampCauses));
    }
    return items;
  }

  /** Children of an OpenRouter model node: provider, pricing, context, caps, modes, cost, usage. */
  private getOpenRouterModelChildren(e: OpenRouterModelTreeItem): MetricTreeItem[] {
    const items: MetricTreeItem[] = [];
    const entry = this.getRelayModels(e.fp)
      .find(m => (m.vllmModelId ?? m.id) === e.modelId);

    // Provider — the exact provider OpenRouter routes to (pinned in Model
    // Settings), matched by tag against the `/endpoints` list. FIRST row: the
    // routing identity is the most important fact about the model.
    const pinnedProvider = entry?.provider;
    const endpoints = this.relayProviders(e.fp, e.modelId);
    const pinned = pinnedProvider
      ? endpoints?.find(ep => ep.tag === pinnedProvider)
      : undefined;
    if (pinnedProvider) {
      const label = pinned
        ? pinned.providerName + (pinned.quantization && pinned.quantization !== 'unknown' ? ` (${pinned.quantization})` : '')
        : pinnedProvider; // list not loaded — the tag itself, never invented
      // Provider health dot + uptime — mirror the server node's colored circle.
      // status: 0 = operational (green), -2 = degraded (red); uptime_last_1d is
      // a percentage 0-100. Only when the provider list is loaded (pinned defined).
      const status = pinned?.status;
      const uptime = pinned?.uptimeLast1d;
      let statusIcon: string | undefined;
      let statusColor: vscode.ThemeColor | undefined;
      if (status !== undefined) {
        statusIcon = 'circle-filled';
        statusColor = status === 0
          ? new vscode.ThemeColor('charts.green')
          : new vscode.ThemeColor('charts.red');
      }
      const value = uptime !== undefined
        ? `${label}  ·  ${uptime.toFixed(2)}% uptime`
        : label;
      // The pinned provider's own limits (context window + output cap) — the
      // real envelope this provider serves, which can differ from the general
      // catalog envelope (display-only; never persisted, never clamped). Only
      // when the provider list is loaded.
      const providerLimits: string[] = [];
      if (pinned?.contextLength && pinned.contextLength > 0) providerLimits.push(`${fmtCount(pinned.contextLength)} ctx`);
      if (pinned?.maxCompletionTokens && pinned.maxCompletionTokens > 0) providerLimits.push(`${fmtCount(pinned.maxCompletionTokens)} out`);
      const limitsSuffix = providerLimits.length > 0 ? `  ·  ${providerLimits.join('  ·  ')}` : '';
      // Exact numbers for the tooltip — the compact description abbreviates, the
      // hover is precise (same discipline as the Model Settings provider dropdown).
      const exactLimits: string[] = [];
      if (pinned?.contextLength && pinned.contextLength > 0) exactLimits.push(`${pinned.contextLength.toLocaleString('en-US')} context`);
      if (pinned?.maxCompletionTokens && pinned.maxCompletionTokens > 0) exactLimits.push(`${pinned.maxCompletionTokens.toLocaleString('en-US')} max output`);
      const limitsTooltip = exactLimits.length > 0
        ? `\n\nPinned provider limits (reported by OpenRouter): ${exactLimits.join(', ')}. ` +
          `A pinned provider with a smaller window or output cap than the general model envelope serves only that — ` +
          `requests that exceed it are filtered or fail. Unpin the provider to route normally.`
        : '';
      items.push(new MetricTreeItem(
        'Provider',
        value + limitsSuffix,
        statusIcon ?? 'cloud',
        'Routing pinned to this provider via `provider: { only: [tag] }` (set in Model Settings). Status + 1-day uptime reported by OpenRouter.' + limitsTooltip,
        statusColor,
      ));
    }

    // Pricing (1M) — the pinned provider's reported per-1M rates from
    // `/endpoints`; Auto falls back to the model's configured catalog rates as
    // an estimate. All values come from the API/config verbatim — never derived.
    // The row label carries the "(1M)" so the per-price `/1M` suffix is dropped.
    let priceParts: string[] | undefined;
    let priceSource = '';
    if (pinned?.pricing) {
      const inRate = perMillion(pinned.pricing.prompt);
      const outRate = perMillion(pinned.pricing.completion);
      const cacheRate = perMillion(pinned.pricing.input_cache_read);
      const parts: string[] = [];
      if (inRate !== undefined) parts.push(`in ${formatUsdRate(inRate)}`);
      if (outRate !== undefined) parts.push(`out ${formatUsdRate(outRate)}`);
      if (cacheRate !== undefined) parts.push(`cached ${formatUsdRate(cacheRate)}`);
      if (parts.length > 0) {
        priceParts = parts;
        priceSource = `Per-1M rates reported by the pinned provider "${pinned.tag}" (${pinned.providerName}).`;
      }
    }
    if (!priceParts && entry?.cost) {
      const parts: string[] = [];
      if (entry.cost.input !== undefined) parts.push(`in ${formatUsdRate(entry.cost.input)}`);
      if (entry.cost.output !== undefined) parts.push(`out ${formatUsdRate(entry.cost.output)}`);
      if (entry.cost.cachedInput !== undefined) parts.push(`cached ${formatUsdRate(entry.cost.cachedInput)}`);
      if (parts.length > 0) {
        priceParts = parts;
        priceSource = pinnedProvider
          ? 'Per-1M rates from the model config (provider list not loaded).'
          : 'Per-1M estimated rates from the model config (Auto routing).';
      }
    }
    if (priceParts) {
      items.push(new MetricTreeItem('Pricing (1M)', priceParts.join('  ·  '), 'credit-card', priceSource));
    }

    // Context Window + Output — one row combining the per-model context window
    // (from the engine resolve) and the saved output budget. Both belong together:
    // they define the model's usable envelope. "Total" prefixes the context so it
    // balances the following "Output" (Total context vs output budget).
    const contextWindow = this.relayContextWindow(e.fp, e.modelId);
    const maxOutput = entry?.maxOutputTokens;
    if (contextWindow !== undefined && maxOutput != null) {
      items.push(new MetricTreeItem(
        'Context Window',
        `Total ${fmtCount(contextWindow)}  ·  Output ${fmtCount(maxOutput)}`,
        'layers',
        'Total context length (input + output) and the configured output ceiling.',
      ));
    } else if (contextWindow !== undefined) {
      items.push(new MetricTreeItem('Context Window', `Total ${fmtCount(contextWindow)}`, 'layers', 'Total context length (input + output) this model reports.'));
    } else if (maxOutput != null) {
      items.push(new MetricTreeItem('Max Output', fmtCount(maxOutput), 'symbol-parameter', 'Model\'s reported output ceiling.'));
    }

    // Capabilities — from the model config (saved at onboarding).
    if (entry?.capabilities) {
      const caps = entry.capabilities;
      if (caps.toolCalling != null || caps.imageInput != null) {
        const parts: string[] = [];
        if (caps.toolCalling != null) parts.push(`tools: ${caps.toolCalling ? 'yes' : 'no'}`);
        if (caps.imageInput != null) parts.push(`image: ${caps.imageInput ? 'yes' : 'no'}`);
        items.push(new MetricTreeItem('Capabilities', parts.join('  ·  '), 'wrench', 'Model capabilities reported by OpenRouter.'));
      }
    }

    // Reasoning modes — from the model config (modelModes built from reasoning metadata).
    const modeKeys = Object.keys(entry?.modelModes ?? {});
    if (modeKeys.length > 0) {
      items.push(new MetricTreeItem('Modes', modeKeys.join('  ·  '), 'lightbulb', 'Reasoning modes this model supports (from its `reasoning` metadata).'));
    }

    // Cost — estimated per-1M rates from config (fallback) OR actual reported
    // cost when present. Never both.
    const { today: todayCost, overall: overallCost, currency, hasActual } =
      this.modelCostFor(e.serverUrl, e.modelId, entry?.cost);
    if (todayCost !== undefined || overallCost !== undefined) {
      // Honest: show exactly what the API/store reports — today and/or total,
      // never a fabricated window rate.
      const value = formatCostSummary(todayCost, overallCost, currency)
        ?? formatCostFine(todayCost ?? overallCost!, currency);
      items.push(new MetricTreeItem(
        'Cost',
        value,
        'credit-card',
        hasActual
          ? 'Actual OpenRouter cost (usage.cost) where reported; per-1M estimate for slots without reported spend.'
          : 'Estimated cost from the model\'s configured per-1M rates.',
      ));
    }

    // Token usage — today + overall (same split as the Token Usage node).
    const usage = getServerUsage(normalizeServerUrl(e.serverUrl));
    const todayCounts = usage.today[e.modelId] ?? emptyCounts();
    const overallCounts = usage.allTime[e.modelId] ?? emptyCounts();
    const since = getModelStartedAt(normalizeServerUrl(e.serverUrl), e.modelId);
    if (todayCounts.prompt > 0 || todayCounts.completion > 0) {
      items.push(new MetricTreeItem('Tokens Today', usageLine(todayCounts), 'calendar', 'Token usage for this model today.'));
    }
    if (overallCounts.prompt > 0 || overallCounts.completion > 0) {
      items.push(new MetricTreeItem('Tokens Overall', usageLine(overallCounts, since), 'history', 'All-time token usage for this model.'));
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

    // 4. Generation time + throughput.
    //    Preferred: server-reported (requires --enable-per-request-metrics).
    //    Fallback: measured client-side — output tokens / (total time − TTFT).
    //    The fallback covers non-vLLM backends (no per-request metrics at all)
    //    and vLLM servers without --enable-per-request-metrics.
    if (e.hasMetrics && e.generationMs != null && e.generationMs > 0) {
      const sec = (e.generationMs / 1000).toFixed(2);
      const tokPerSec = ((e.completionTokens / e.generationMs) * 1000).toFixed(1);
      items.push(new RequestMetricTreeItem(
        'Generation',
        `${sec}s  ·  ${tokPerSec} tok/s`,
        'rocket',
        'Time to generate all output tokens. Throughput = output tokens / generation time.',
      ));
    } else if (e.completionTokens > 1 && e.firstTokenTimeMs != null && e.totalTimeMs != null && e.totalTimeMs > e.firstTokenTimeMs) {
      const decodeMs = Math.max(e.totalTimeMs - e.firstTokenTimeMs, 1);
      // The decode window [firstTokenTimeMs, totalTimeMs] covers tokens 2..N —
      // the first token arrived at firstTokenTimeMs. Dividing by all N tokens
      // overstates the rate (doubling a 2-token response) and invents a rate
      // for a 1-token response that had no measured decode interval.
      const decodeTokens = e.completionTokens - 1;
      const sec = (decodeMs / 1000).toFixed(2);
      const tokPerSec = ((decodeTokens / decodeMs) * 1000).toFixed(1);
      items.push(new RequestMetricTreeItem(
        'Generation (measured)',
        `${sec}s  ·  ${tokPerSec} tok/s`,
        'rocket',
        'Time to generate output, measured client-side (total request time minus time-to-first-token). Used when the server reports no per-request metrics (non-vLLM backend, or vLLM without --enable-per-request-metrics).',
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

    // 7. Cost — actual reported cost (OpenRouter) when present, else derived
    //    from the model's per-1M cost config. Never both: actual is server
    //    truth, the estimate is a fallback for backends that don't report cost.
    if (e.actualCost !== undefined) {
      items.push(new RequestMetricTreeItem(
        'Cost',
        formatCostFine(e.actualCost, 'USD'),
        'credit-card',
        'Actual cost reported by the backend (OpenRouter `usage.cost`, USD). Shown per-prompt for money verification.',
      ));
      if (e.usedByok) {
        items.push(new RequestMetricTreeItem(
          'BYOK',
          'upstream key',
          'key',
          'This request was served using your own upstream provider key (billed directly by that provider, not OpenRouter credits).',
        ));
      }
    } else {
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
          formatCostFine(cost, rates?.currency),
          'credit-card',
          'Estimated cost of this request from the model\'s configured per-1M cost rates. Shown per-prompt for money verification.',
        ));
      }
    }

    // Hints for missing data — vLLM-only launch flags are meaningless for non-vLLM
    // backends, so only suggest them when the server is vLLM (or type unknown).
    const missingFlags: string[] = [];
    if (e.serverType === undefined || e.serverType === 'vllm') {
      if (!e.hasCacheDetails) missingFlags.push('--enable-prompt-tokens-details');
      if (!e.hasMetrics) missingFlags.push('--enable-per-request-metrics');
    }
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
      // Cost: actual reported (OpenRouter) when present, else the per-1M estimate.
      const { today, overall, currency } = this.modelCostFor(e.serverUrl, modelId, entry?.cost);
      // Collapsed description: "$X today and $Y total" — exactly what the
      // API/store reports, never a fabricated window rate.
      const summary = formatCostSummary(today, overall, currency);
      return new ModelUsageTreeItem(e.serverUrl, modelId, label, summary);
    });
  }

  /** Children of a model node: Today and Overall — token-only (price is on the model line above). */
  private getModelUsageChildren(e: ModelUsageTreeItem): MetricTreeItem[] {
    const usage = getServerUsage(e.serverUrl);
    const today = usage.today[e.modelId] ?? emptyCounts();
    const overall = usage.allTime[e.modelId] ?? emptyCounts();
    const since = getModelStartedAt(e.serverUrl, e.modelId);
    return [
      new MetricTreeItem(
        'Today',
        usageLine(today),
        'calendar',
        `Today's usage for ${e.modelLabel}. Input is split: 'in' excludes cache; in + cached = total input.`,
      ),
      new MetricTreeItem(
        'Overall',
        usageLine(overall, since),
        'history',
        `All-time usage for ${e.modelLabel}${since !== undefined ? `; recording started ${timeAgo(since)}.` : '.'}`,
      ),
    ];
  }

  /** Read the configured model entries (sync settings read) for cost lookups. */
  private readConfiguredModels(): ModelConfig[] {
    return vscode.workspace.getConfiguration('vllm-copilot').get<ModelConfig[]>('models') || [];
  }

  /** Configured OpenRouter models for a relay server IDENTITY (URL + headers).
   *  Two identities sharing a URL have different credentials, so each model
   *  belongs to exactly one identity and appears only under its own node. */
  private getRelayModels(fp: string): ModelConfig[] {
    return this.readConfiguredModels()
      .filter(m => m.serverType === 'openrouter')
      .filter(m => {
        const resolved = resolveServerConfig(m);
        return !!resolved.serverUrl && serverFingerprint(resolved.serverUrl, resolved.requestHeaders) === fp;
      });
  }

  /** The cached per-model context window for a relay model, if resolved. */
  private relayContextWindow(fp: string, modelId: string): number | undefined {
    return this.subscriptions
      .find(s => s.fp === fp)
      ?.metrics.contextByModel?.[modelId];
  }

  /** The cached provider list (with per-1M pricing) for a relay model, if fetched. */
  private relayProviders(fp: string, modelId: string): OpenRouterModelEndpoint[] | undefined {
    return this.subscriptions
      .find(s => s.fp === fp)
      ?.metrics.providersByModel?.[modelId];
  }

  /** The cached effective output ceiling for a relay model, if resolved. */
  private relayEffectiveOutput(fp: string, modelId: string): number | undefined {
    return this.subscriptions
      .find(s => s.fp === fp)
      ?.metrics.outputByModel?.[modelId];
  }

  /**
   * Cost per model, preferring actual reported cost (OpenRouter usage.cost)
   * when the model has any, else the per-1M estimate. Per-slot fallback on
   * absence — never a sum of actual + estimate. `hasActual` tells callers which
   * path produced the numbers (for honest labeling).
   */
  private modelCostFor(
    serverUrl: string,
    modelId: string,
    rates: CostRates | undefined,
  ): { today: number | undefined; overall: number | undefined; currency: string | undefined; hasActual: boolean } {
    const key = normalizeServerUrl(serverUrl);
    const usage = getServerUsage(key);
    const cost = getServerCost(key);
    const actualToday = cost.today[modelId];
    const actualOverall = cost.allTime[modelId];
    const hasActual = actualToday !== undefined || actualOverall !== undefined;
    const estToday = computeCost(usage.today[modelId] ?? emptyCounts(), rates);
    const estOverall = computeCost(usage.allTime[modelId] ?? emptyCounts(), rates);
    return {
      today: hasActual ? actualToday ?? estToday : estToday,
      overall: hasActual ? actualOverall ?? estOverall : estOverall,
      currency: hasActual ? 'USD' : rates?.currency,
      hasActual,
    };
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
    avgTTFTMs: null, avgTPOTMs: null, avgTputTokPerSec: null, avgPrefillTputTokPerSec: null, preemptions: null, evictions: null,
  };
}
