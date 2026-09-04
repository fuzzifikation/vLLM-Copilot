/**
 * Dashboard as a VS Code Tree View — sidebar UI only.
 * Data layer (fetching, parsing, aggregating) lives in vllmMetrics.ts.
 */

import * as vscode from 'vscode';
import { getConfig, resolveModelSettings, normalizeServerUrl, findModelConfig, resolveVllmModelId, type ModelConfig, type ServerType } from '../state/config.js';
import { readModels, readServers } from '../state/configStore.js';
import { ServerMetrics, getMetricsEngine, emptyMetrics, getPollSettingMs } from './vllmMetrics.js';
import { perMillion, formatUsdRate, type OpenRouterAccount, type OpenRouterCredits, type OpenRouterModelEndpoint } from '../backends/openRouter.js';
import {
  getLastRequest, getServerUsage, getServerCost, hasServerUsage, onUsageStoreDidChange,
  findModelCost, formatCost, formatCostFine, formatCostSummary, emptyCounts,
  getModelStartedAt,
  type UsageCounts, type CostRates, type LastRequestData,
} from '../usage/usageStore.js';
import { firstEntryById } from '../state/serverRegistry.js';

// ─── Tree Items ──────────────────────────────────────────────────────

// ─── Formatting ──────────────────────────────────────────────────────
// Display helpers moved here from vllmMetrics (U7): the tree rows are their
// only consumers; vllmMetrics produces data, not strings.

function fmtPct(v: number | null): string {
  return v == null ? '-' : `${Math.round(v)}%`;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '-';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function fmtN(v: number | null): string {
  return v == null ? '-' : String(v);
}

/** Format a directly-computed tokens/sec value (pooled throughput ratio). */
function fmtTokPerSec(tokPerSec: number | null): string {
  if (tokPerSec == null || tokPerSec <= 0) return '-';
  return tokPerSec >= 100
    ? `${Math.round(tokPerSec)} tok/s`
    : `${tokPerSec.toFixed(1)} tok/s`;
}

/**
 * Abbreviate large token counts for compact dashboard rows: 3883588 -> "3.88M",
 * 836350 -> "836k", 999 -> "999". Thousands are rounded to whole k (sub-1000
 * precision is noise); millions keep 2 decimals, trailing zeros stripped.
 * No space between the number and the unit. Presentation ONLY - the stored
 * counts are never rounded; this runs at render time on already-accumulated
 * integers. Moved from usageStore (cluster finding C-1): the tree rows are its
 * only consumers.
 */
function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1e3) {
    const k = Math.round(n / 1e3);
    if (k >= 1000) { // 999,500 -> 1000k -> "1M"
      const m = k / 1000;
      return `${m.toFixed(2).replace(/\.?0+$/, '')}M`;
    }
    return `${k}k`;
  }
  return String(n);
}

/**
 * Cost in the configured unit for the given counts, from per-1M rates.
 * Fresh input = prompt - cached (cache-read tokens are priced at the cached
 * rate, not the input rate). Undefined when no rates are configured.
 * Render-time derivation, and the dashboard is its only consumer (cluster
 * finding C-1): the store keeps the numbers, the tree does the money math.
 */
function computeCost(counts: UsageCounts, rates: CostRates | undefined): number | undefined {
  if (!rates) return undefined;
  const input = rates.input ?? 0;
  const output = rates.output ?? 0;
  const cachedInput = rates.cachedInput ?? 0;
  if (input === 0 && output === 0 && cachedInput === 0) return undefined;
  const freshInput = Math.max(0, counts.prompt - counts.cached);
  return (freshInput / 1e6) * input
    + (counts.cached / 1e6) * cachedInput
    + (counts.completion / 1e6) * output;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    // Omit the port when it's empty (URL constructor leaves `:` for a stripped
    // default port like 443) — `openrouter.ai` should render without a trailing
    // colon, not `openrouter.ai:`.
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url.replace(/\/+$/, '');
  }
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
   * @param serverId - Registry entry id. The entry IS the server identity: the
   *   tree id, the engine key, and the Deep-Dive panel key are all this value.
   * @param displayLabel - Optional disambiguated label (e.g. `s:8000 (identity 2)`) when
   *   several entries point at one URL; defaults to `shortUrl(serverUrl)`.
   */
  constructor(
    public readonly serverUrl: string,
    public readonly serverId: string,
    public readonly metrics: ServerMetrics,
    public readonly serverType?: ServerType,
    displayLabel?: string,
  ) {
    const displayName = displayLabel ?? shortUrl(serverUrl);
    // CR-25: the pre-first-poll placeholder means "no data yet", NOT offline.
    // Painting it red "Offline" made every healthy server announce its own
    // death for up to a full connect timeout on every dashboard show.
    const loading = metrics.loading === true && !metrics.online;
    const statusIcon = metrics.online
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
      : loading
        ? new vscode.ThemeIcon('loading~spin')
        : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
    // Compact one-line summary for the collapsed description (absorbed from
    // the former summaryLine helper — this constructor was its only caller).
    const summaryParts: string[] = [];
    if (metrics.runningRequests != null) summaryParts.push(`${metrics.runningRequests} running`);
    if (metrics.waitingRequests != null && metrics.waitingRequests > 0) summaryParts.push(`${metrics.waitingRequests} waiting`);
    const summary = summaryParts.join('  ·  ') || 'idle';

    super(displayName, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = statusIcon;
    this.id = `server:${serverId}`;
    // OpenRouter is a relay, not a server: /v1/models is the whole catalog (not
    // "the server's models") and any context window here is one arbitrary
    // configured model's — wrong scope to present as server-wide. Suppress both
    // until the model-collection restructure (Phase 2) lands. Also: a relay has
    // no running/waiting-request gauges, so "idle" would be a fabricated stat —
    // show NO description behind an online OpenRouter server.
    const isOpenRouterRelay = serverType === 'openrouter';
    // No "degraded" label — every backend is a first-class dashboard citizen.
    this.description = metrics.online
      ? (isOpenRouterRelay ? undefined : summary)
      : loading ? 'Loading' : 'Offline';
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
    // OpenRouter relays get their own context-value pair: Deep-Dive is hidden
    // there (a relay has no vLLM engine metrics to show). Rename is NOT part
    // of the exclusion — every backend is renamable, because the label names
    // the entry, and one relay URL can host several entries.
    this.contextValue = isVllm ? state
      : isOpenRouterRelay ? `${state}Relay`
      : `${state}NoDive`;
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

/** OpenRouter relay: collapsible "Account" node — credits/limits from /api/v1/key. */
class OpenRouterAccountTreeItem extends vscode.TreeItem {
  constructor(
    public readonly account: OpenRouterAccount,
    /** Total-budget info from /api/v1/credits (may be undefined on a failed probe). */
    public readonly credits: OpenRouterCredits | undefined,
    /** Registry entry id — the account belongs to this entry's credential. */
    public readonly serverId: string,
  ) {
    super('Account', vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('account');
    this.id = `openRouterAccount:${serverId}`;
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
    /** Registry entry id — the model belongs to this entry's models. */
    public readonly serverId: string,
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
    this.id = `openRouterModel:${serverId}:${modelId}`;
    // `clamped` requires at least one numeric binding cause, and every cause sets
    // `effectiveOutput` (catalog → the ceiling; provider → min with it), so both
    // numbers are always present when clamped. Defensive: if that invariant ever
    // breaks, fall back to the normal tooltip rather than showing a half-truth.
    this.tooltip = clamped && configuredOutput !== undefined && effectiveOutput !== undefined
      ? new vscode.MarkdownString(this.buildClampTooltip(modelLabel, configuredOutput, effectiveOutput, clampCauses))
      : new vscode.MarkdownString(`${modelLabel} - click for model-level detail (provider, pricing, context, capabilities, usage).`);
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
        return `- **${exact}** (the model's output ceiling) - output is silently clamped; you'll get shorter replies.`;
      }
      return `- **${exact}** (pinned provider ${c.providerName ?? 'cap'}) - requests over this cap may **fail**. Unpin or lower the setting.`;
    });
    return `${modelLabel} - output budget clamped.\n\nConfigured maxOutputTokens **${configuredOutput.toLocaleString('en-US')}** → effective **${effectiveOutput.toLocaleString('en-US')}**.\n\nBinding constraints:\n${lines.join('\n')}`;
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

/** Collapsible "Last Request" node showing per-request details.
 *
 * Carries the store record whole (audit PF-2: the 21-parameter constructor
 * was the caller unpacking one object field by field). The three
 * server-reported timing values are derived from `data.metrics` here; only
 * `serverType` comes from the tree context. */
class LastRequestTreeItem extends vscode.TreeItem {
  /** Server-reported timings (need --enable-per-request-metrics), derived at construction. */
  public readonly ttftMs?: number;
  public readonly generationMs?: number;
  public readonly queueMs?: number;

  constructor(
    public readonly data: LastRequestData,
    public readonly serverType?: ServerType,
    /** Registry entry id, folded into the tree id: two entries may share one
     *  URL (the documented "identity N" case), and tree ids must be unique. */
    public readonly serverId?: string,
  ) {
    super('Last Request', vscode.TreeItemCollapsibleState.Collapsed);
    this.ttftMs = data.metrics?.time_to_first_token_ms;
    this.generationMs = data.metrics?.generation_time_ms;
    this.queueMs = data.metrics?.queue_time_ms;
    this.iconPath = new vscode.ThemeIcon('info');
    this.id = `lastRequest:${serverId ?? ''}:${data.serverUrl}`;
    const ago = timeAgo(data.timestamp);
    this.description = `${ago} · ${data.modelId}`;
    this.tooltip = new vscode.MarkdownString(
      `Model: ${data.modelId}\nTime: ${ago}\nTokens: ${data.promptTokens} in → ${data.completionTokens} out`
    );
  }
}
/** Collapsible "Token Usage and Cost" node — cumulative token/cost usage per server. */
class TokenUsageTreeItem extends vscode.TreeItem {
  constructor(
    public readonly serverUrl: string,
    /** Registry entry id, folded into the tree id (unique-per-URL is not
     *  unique-per-entry — the dashboard renders that scenario itself). */
    public readonly serverId?: string,
  ) {
    super('Token Usage and Cost', vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('credit-card');
    this.id = `tokenUsage:${serverId ?? ''}:${serverUrl}`;
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
    /** Registry entry id, folded into the tree id (see TokenUsageTreeItem). */
    public readonly serverId?: string,
  ) {
    super(modelLabel, vscode.TreeItemCollapsibleState.Collapsed);
    if (todayCost) this.description = todayCost;
    this.id = `modelUsage:${serverId ?? ''}:${serverUrl}:${modelId}`;
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

  /** Active engine subscriptions: one per server registry entry. */
  private subscriptions: Array<{
    /** Registry entry id — node id, engine key, and what Deep-Dive resolves. */
    serverId: string;
    /** Normalized URL, for the shared-URL label suffix only. */
    url: string;
    serverType?: ServerType;
    /** User-set server label (first non-empty among the group's models), or undefined. */
    serverDisplayName?: string;
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
        // Scoped to the dashboard's data plane: registry entries, models, and
        // its own settings (the poll-interval badge). Unrelated toggles
        // (personalities, logging, prompts) must not tear down and rebuild
        // every metrics poller.
        if (
          e.affectsConfiguration('vllm-copilot.servers') ||
          e.affectsConfiguration('vllm-copilot.models') ||
          e.affectsConfiguration('vllm-copilot.dashboard')
        ) {
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
      const config = await getConfig();
      // The await above is a genuine suspension point. Abort the continuation if
      // either condition held while getConfig was resolving:
      //  - the sidebar was hidden or the provider disposed (visible flag);
      //  - a newer refresh started (epoch mismatch) and will subscribe itself.
      // In both cases subscribing here would create orphaned or duplicated
      // engine pollers.
      if (!this.visible || epoch !== this.refreshEpoch) {
        return;
      }
      // The dashboard is a projection of the server REGISTRY: every entry is a
      // node, whether or not any model references it (that is what "Add Server
      // (no model)" promises). Nodes key by ENTRY ID — the registry's unique
      // identity — iterating servers[] in array order so node order follows
      // settings order. No URL/header grouping: an entry IS a server. A model
      // whose `server` ref does not resolve is skipped here; `validateConfig`
      // (activation) and discovery (every refresh) name it.
      const servers = config.servers || [];
      // First entry wins per id — the shared rule next to the runtime
      // resolver (`resolveServer` uses `servers.find`). A hand-edited registry
      // with duplicate ids is reported by `validateConfig`; the dashboard must
      // never attach a model to a shadowed duplicate the requests ignore.
      const entriesById = firstEntryById(servers);
      // entry id → accumulated wire ids (models resolving to this entry).
      const modelIdsByEntry = new Map<string, string[]>();
      for (const model of config.models) {
        const entry = entriesById.get(model.server);
        if (!entry) continue;
        const wireId = resolveVllmModelId(model);
        if (!wireId) continue;
        let list = modelIdsByEntry.get(entry.id);
        if (!list) { list = []; modelIdsByEntry.set(entry.id, list); }
        list.push(wireId);
      }

      // One engine, one node, per ENTRY (first-wins per id), in servers[] array
      // order. The engine registry is keyed by entry id — no hashing, no
      // grouping, and an Update Auth header change can never orphan a poller.
      for (const entry of entriesById.values()) {
        // Node label from the entry: trimmed, one rule for every backend,
        // relays included. Whitespace-only never renders.
        const name = entry.displayName?.trim();
        const engine = getMetricsEngine(
          entry.id,
          entry.serverUrl,
          entry.requestHeaders,
          entry.serverType ?? 'vllm',
          modelIdsByEntry.get(entry.id) ?? [],
          this.outputChannel,
        );
        const sub = engine.subscribe((aggregated) => {
          // Update cached metrics and schedule a single re-render
          const live = this.subscriptions.find(s => s.serverId === entry.id);
          if (live) live.metrics = aggregated;
          this.fireTreeUpdate();
        });
        this.subscriptions.push({
          serverId: entry.id,
          url: normalizeServerUrl(entry.serverUrl),
          serverType: entry.serverType,
          serverDisplayName: name || undefined,
          metrics: engine.getCachedAggregated() ?? emptyMetrics('Loading…'),
          dispose: sub.dispose,
        });
      }
      // Repaint once the nodes exist. fireTreeUpdate() coalesces, so this is
      // usually folded into the repaint the caller already scheduled — but if
      // getConfig() resolves later than that microtask, the earlier repaint drew
      // an empty list and nothing else would repaint until a cycle COMPLETES (up
      // to the 5s timeout when a server is down).
      this.fireTreeUpdate();
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

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      // Clickable poll-interval row (absorbed from getPollIntervalTreeItem +
      // PollIntervalTreeItem). Reads through the engine's own getPollSettingMs
      // — same setting, same default, same catch (P11-1).
      const intervalMs = getPollSettingMs();
      const pollItem = new vscode.TreeItem('Refresh Interval', vscode.TreeItemCollapsibleState.None);
      pollItem.description = intervalMs < 60000 ? `${intervalMs / 1000}s` : `${Math.round(intervalMs / 1000)}s`;
      pollItem.iconPath = new vscode.ThemeIcon('refresh');
      pollItem.command = { command: 'vllm-copilot.setPollInterval', title: 'Set Poll Interval' };
      pollItem.tooltip = new vscode.MarkdownString('Click to change polling interval');
      const items: vscode.TreeItem[] = [pollItem];
      // Label precedence: user-set serverDisplayName first, else shortUrl. The
      // `(identity N)` suffix keys off URL-sharing ENTRIES ONLY — never off
      // label equality — so two identically-NAMED entries on one URL stay
      // distinguishable instead of collapsing back into look-alike nodes.
      const urlCount = new Map<string, number>();
      for (const sub of this.subscriptions) urlCount.set(sub.url, (urlCount.get(sub.url) ?? 0) + 1);
      const urlSeen = new Map<string, number>();
      const servers = this.subscriptions.map(sub => {
        const n = (urlSeen.get(sub.url) ?? 0) + 1;
        urlSeen.set(sub.url, n);
        const shared = (urlCount.get(sub.url) ?? 1) > 1;
        const base = sub.serverDisplayName ?? shortUrl(sub.url);
        // Always pass the computed base: with a single identity there is no
        // suffix, and passing undefined here would make ServerTreeItem fall
        // back to shortUrl — silently dropping a configured display name.
        const label = shared ? `${base} (identity ${n})` : base;
        return new ServerTreeItem(sub.url, sub.serverId, sub.metrics, sub.serverType, label);
      });
      // Action rows (absorbed from AddServerTreeItem/TestRefreshTreeItem —
      // one construction site each).
      const addItem = new vscode.TreeItem('Add or Reconfigure Server/Model', vscode.TreeItemCollapsibleState.None);
      addItem.iconPath = new vscode.ThemeIcon('vm-running');
      addItem.command = { command: 'vllm-copilot.addServerModel', title: 'Add or Reconfigure Server/Model' };
      addItem.tooltip = new vscode.MarkdownString('Add a new server, add a model to an existing server, or reconfigure auth');
      const testItem = new vscode.TreeItem('Test & Refresh Models', vscode.TreeItemCollapsibleState.None);
      testItem.iconPath = new vscode.ThemeIcon('vm-running');
      testItem.command = { command: 'vllm-copilot.testAndRefreshModels', title: 'Test & Refresh Models' };
      testItem.tooltip = new vscode.MarkdownString('Test every configured server and reload the model lists');
      return [...items, ...servers, addItem, testItem];
    }

    if (element instanceof ServerTreeItem) {
      return this.getServerMetricsChildren(element.metrics, element.serverUrl, element.serverType, element.serverId);
    }

    if (element instanceof ModelsTreeItem) {
      // Model rows (absorbed from ModelTreeItem — single construction site).
      return element.modelNames.map(name => {
        const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('symbol-class');
        item.tooltip = name;
        return item;
      });
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

  private getServerMetricsChildren(m: ServerMetrics, serverUrl?: string, serverType?: ServerType, serverId?: string): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = [];
    if (m.loading && !m.online) {
      return [new MetricTreeItem('Status', 'First poll pending', 'server')];
    }
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
        items.push(new OpenRouterAccountTreeItem(m.account, m.credits, serverId ?? ''));
      }
      items.push(...this.getRelayModelTreeItems(serverUrl ?? '', serverId ?? ''));
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
      const outSpeed = m.avgTputTokPerSec != null
        ? fmtTokPerSec(m.avgTputTokPerSec)
        // Zero-guard kept from the absorbed fmtThroughput (R-2): without the
        // `> 0` check, 1000/0 prints "Infinity tok/s" at zero TPOT.
        : m.avgTPOTMs != null && m.avgTPOTMs > 0
          ? fmtTokPerSec(1000 / m.avgTPOTMs)
          : '-';
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
        else parts.push('-');
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
      // is a registry entry's URL — usually already normalized, but hand-edited
      // entries may legally use a scheme-less, trailing-slash, or /v1 form —
      // so normalize before the lookup, otherwise the Last Request node
      // silently vanishes for those forms.
      const lastRequest = getLastRequest(normalizeServerUrl(serverUrl));
      if (lastRequest) {
        items.push(new LastRequestTreeItem(lastRequest, serverType, serverId));
      }

      // Cumulative Token Usage — live via onUsageStoreDidChange (see constructor).
      // `serverUrl` here is a registry entry's URL; the store keys by the
      // NORMALIZED URL (same as the Last Request lookup above), so normalize
      // before the read or the node silently vanishes for scheme-less/slash/v1 forms.
      const normalizedUrl = normalizeServerUrl(serverUrl);
      // OpenRouter suppresses the aggregate node: every relay model already shows
      // its own token/cost rows in its expanded details (actual usage.cost), so a
      // server-level sum would be pure duplication.
      if (!isOpenRouterRelay && hasServerUsage(normalizedUrl)) {
        items.push(new TokenUsageTreeItem(normalizedUrl, serverId));
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
      items.push(new MetricTreeItem('Available', formatCost(Math.max(0, c.total_credits - c.total_usage), 'USD'), 'pulse', 'Invested total minus total usage (floor 0) - what you can still spend.'));
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
      items.push(new MetricTreeItem('Free Tier', 'yes', 'star', 'This account has never paid - subject to free-tier rate limits.'));
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
  private getRelayModelTreeItems(serverUrl: string, serverId: string): OpenRouterModelTreeItem[] {
    const models = this.getRelayModels(serverId);
    const seen = new Set<string>();
    const items: OpenRouterModelTreeItem[] = [];
    for (const model of models) {
      const modelId = resolveVllmModelId(model);
      if (!modelId || seen.has(modelId)) continue; // dedupe shared wire ids
      seen.add(modelId);
      const label = model.displayName || model.id || modelId;
      // Collapsed description: the pinned provider's name (or nothing). The
      // provider is the routing identity — the context window is not intuitive
      // as a one-liner, so show it only in the expanded Context+Output row.
      const pinnedProvider = model.provider;
      let providerLabel: string | undefined;
      if (pinnedProvider) {
        const endpoints = this.relayProviders(serverId, modelId);
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
      // Cached effective output ceiling for this relay model (inline lookup —
      // absorbed from the single-caller relayEffectiveOutput helper).
      const catalogCeiling = this.subscriptions
        .find(s => s.serverId === serverId)
        ?.metrics.outputByModel?.[modelId];
      const clampCauses: OutputClampCause[] = [];
      let effectiveOutput = catalogCeiling;
      if (catalogCeiling !== undefined && catalogCeiling < configuredOutput) {
        clampCauses.push({ kind: 'catalog', ceiling: catalogCeiling });
      }
      if (pinnedProvider) {
        const endpoints = this.relayProviders(serverId, modelId);
        const pinned = endpoints?.find(ep => ep.tag === pinnedProvider);
        const providerCap = pinned?.maxCompletionTokens;
        if (typeof providerCap === 'number' && providerCap > 0 && providerCap < configuredOutput) {
          clampCauses.push({ kind: 'provider', ceiling: providerCap, providerName: pinned?.providerName });
          // The provider cap is a real constraint on the request — it binds below
          // the catalog ceiling when smaller (effective output = min of both).
          if (effectiveOutput === undefined || providerCap < effectiveOutput) effectiveOutput = providerCap;
        }
      }
      items.push(new OpenRouterModelTreeItem(serverUrl, modelId, label, providerLabel, serverId, configuredOutput, effectiveOutput, clampCauses));
    }
    return items;
  }

  /** Children of an OpenRouter model node: provider, pricing, context, caps, modes, cost, usage. */
  private getOpenRouterModelChildren(e: OpenRouterModelTreeItem): MetricTreeItem[] {
    const items: MetricTreeItem[] = [];
    const entry = this.getRelayModels(e.serverId)
      .find(m => resolveVllmModelId(m) === e.modelId);

    // Provider — the exact provider OpenRouter routes to (pinned in Model
    // Settings), matched by tag against the `/endpoints` list. FIRST row: the
    // routing identity is the most important fact about the model.
    const pinnedProvider = entry?.provider;
    const endpoints = this.relayProviders(e.serverId, e.modelId);
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
          `A pinned provider with a smaller window or output cap than the general model envelope serves only that - ` +
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
    // Per-model context window from the engine resolve (inline lookup —
    // absorbed from the single-caller relayContextWindow helper).
    const contextWindow = this.subscriptions
      .find(s => s.serverId === e.serverId)
      ?.metrics.contextByModel?.[e.modelId];
    // maxOutputTokens may be a vector (Output length menu) — the head is the
    // advertised budget; the rest are pickable options, shown in the tooltip.
    const maxOutputRaw = entry?.maxOutputTokens;
    const maxOutputMenu = Array.isArray(maxOutputRaw) ? maxOutputRaw : undefined;
    const maxOutput = maxOutputMenu?.[0] ?? (typeof maxOutputRaw === 'number' ? maxOutputRaw : undefined);
    if (contextWindow !== undefined && maxOutput != null) {
      items.push(new MetricTreeItem(
        'Context Window',
        `Total ${fmtCount(contextWindow)}  ·  Output ${fmtCount(maxOutput)}${maxOutputMenu && maxOutputMenu.length > 1 ? ` (${maxOutputMenu.length} picks)` : ''}`,
        'layers',
        maxOutputMenu && maxOutputMenu.length > 1
          ? `Total context length (input + output) and the configured output ceiling. Output Length picker offers: ${maxOutputMenu.map(n => n.toLocaleString('en-US')).join(' / ')}.`
          : 'Total context length (input + output) and the configured output ceiling.',
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
    // formatCostSummary yields undefined exactly when BOTH figures are absent,
    // so this check IS the "has any cost" gate. Honest: show exactly what the
    // API/store reports — today and/or total, never a fabricated window rate.
    const costSummary = formatCostSummary(todayCost, overallCost, currency);
    if (costSummary !== undefined) {
      items.push(new MetricTreeItem(
        'Cost',
        costSummary,
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

  private getLastRequestChildren(e: LastRequestTreeItem): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = [];

    // Store-record fields are read off `d` (the item now carries the record whole);
    // e keeps the derived timings and the tree-context serverType.
    const d = e.data;

    // 1. Total Tokens — context window usage (always available)
    if (d.maxModelLen > 0) {
      const pct = ((d.totalTokens / d.maxModelLen) * 100).toFixed(1);
      items.push(new MetricTreeItem(
        'Total Tokens',
        `${fmtCount(d.totalTokens)}  ·  ${pct}% of context`,
        'symbol-numeric',
        'Total tokens consumed (input + output) as a percentage of the model\'s context window.',
      ));
    }

    // 2. Input Tokens — always available from usage block; cache % needs --enable-prompt-tokens-details
    if (d.cachedTokens != null && d.cachedTokens > 0) {
      // Input split: 'in' excludes cache; in + cached = total prompt.
      const fresh = Math.max(0, d.promptTokens - d.cachedTokens);
      items.push(new MetricTreeItem(
        'Input Tokens',
        `${fmtCount(fresh)} in · ${fmtCount(d.cachedTokens)} cached`,
        'symbol-parameter',
        "Input split: 'in' excludes cache; 'cached' was served from KV cache (not recomputed). in + cached = total prompt.",
      ));
    } else {
      items.push(new MetricTreeItem(
        'Input Tokens',
        fmtCount(d.promptTokens),
        'symbol-parameter',
        'Tokens in the prompt.',
      ));
    }

    // 3. Output Tokens — always available from usage block; budget % always available from settings
    if (d.maxOutputTokens > 0) {
      const pct = ((d.completionTokens / d.maxOutputTokens) * 100).toFixed(1);
      items.push(new MetricTreeItem(
        'Output Tokens',
        `${fmtCount(d.completionTokens)}  ·  ${pct}% of max output`,
        'code',
        'Tokens generated by the model. Max output = configured output budget from settings.',
      ));
    }

    // 4. Generation time + throughput.
    //    Preferred: server-reported (requires --enable-per-request-metrics).
    //    Fallback: measured client-side — output tokens / (total time − TTFT).
    //    The fallback covers non-vLLM backends (no per-request metrics at all)
    //    and vLLM servers without --enable-per-request-metrics.
    if (d.hasMetrics && e.generationMs != null && e.generationMs > 0) {
      const sec = (e.generationMs / 1000).toFixed(2);
      const tokPerSec = ((d.completionTokens / e.generationMs) * 1000).toFixed(1);
      items.push(new MetricTreeItem(
        'Generation',
        `${sec}s  ·  ${tokPerSec} tok/s`,
        'rocket',
        'Time to generate all output tokens. Throughput = output tokens / generation time.',
      ));
    } else if (d.completionTokens > 1 && d.firstTokenTimeMs != null && d.totalTimeMs != null && d.totalTimeMs > d.firstTokenTimeMs) {
      const decodeMs = Math.max(d.totalTimeMs - d.firstTokenTimeMs, 1);
      // The decode window [firstTokenTimeMs, totalTimeMs] covers tokens 2..N —
      // the first token arrived at firstTokenTimeMs. Dividing by all N tokens
      // overstates the rate (doubling a 2-token response) and invents a rate
      // for a 1-token response that had no measured decode interval.
      const decodeTokens = d.completionTokens - 1;
      const sec = (decodeMs / 1000).toFixed(2);
      const tokPerSec = ((decodeTokens / decodeMs) * 1000).toFixed(1);
      items.push(new MetricTreeItem(
        'Generation (measured)',
        `${sec}s  ·  ${tokPerSec} tok/s`,
        'rocket',
        'Time to generate output, measured client-side (total request time minus time-to-first-token). Used when the server reports no per-request metrics (non-vLLM backend, or vLLM without --enable-per-request-metrics).',
      ));
    }

    // 5. Queue Time (requires --enable-per-request-metrics)
    if (d.hasMetrics && e.queueMs != null && e.queueMs > 0) {
      items.push(new MetricTreeItem(
        'Queue Time',
        `${fmtMs(e.queueMs)}`,
        'debug-pause',
        'Time spent waiting in vLLM\'s request queue before processing started.',
      ));
    }

    // 6. TTFT — always shown (provider-measured); also show server-reported when available.
    // The difference is client overhead + network latency (config, request build, HTTP handshake, SSE parse).
    if (e.ttftMs != null && d.firstTokenTimeMs != null) {
      const overheadMs = Math.max(0, d.firstTokenTimeMs - e.ttftMs);
      items.push(new MetricTreeItem(
        'TTFT',
        `reported: ${(e.ttftMs / 1000).toFixed(2)}s  ·  measured: ${(d.firstTokenTimeMs / 1000).toFixed(2)}s  ·  overhead: ${fmtMs(overheadMs)}`,
        'clock',
        'Time to first token. Reported = server\'s queue+prompt time. Measured = client wall-clock. Overhead = difference (network + client processing).',
      ));
    } else if (e.ttftMs != null) {
      items.push(new MetricTreeItem(
        'TTFT',
        `${fmtMs(e.ttftMs)}`,
        'clock',
        'Time to first token (server-reported: queue + prompt processing).',
      ));
    } else if (d.firstTokenTimeMs != null) {
      items.push(new MetricTreeItem(
        'TTFT',
        `${fmtMs(d.firstTokenTimeMs)}`,
        'clock',
        'Time to first token (client-measured wall-clock: includes network + server processing).',
      ));
    }

    // 7. Cost — actual reported cost (OpenRouter) when present, else derived
    //    from the model's per-1M cost config. Never both: actual is server
    //    truth, the estimate is a fallback for backends that don't report cost.
    if (d.actualCost !== undefined) {
      items.push(new MetricTreeItem(
        'Cost',
        formatCostFine(d.actualCost, 'USD'),
        'credit-card',
        'Actual cost reported by the backend (OpenRouter `usage.cost`, USD). Shown per-prompt for money verification.',
      ));
      if (d.usedByok) {
        items.push(new MetricTreeItem(
          'BYOK',
          'upstream key',
          'key',
          'This request was served using your own upstream provider key (billed directly by that provider, not OpenRouter credits).',
        ));
      }
    } else {
      const models = readModels();
      const rates = findModelCost(models, d.serverUrl, d.modelId);
      const requestCounts: UsageCounts = {
        prompt: d.promptTokens,
        completion: d.completionTokens,
        cached: d.cachedTokens ?? 0,
        reasoning: d.reasoningTokens ?? 0,
      };
      const cost = computeCost(requestCounts, rates);
      if (cost !== undefined) {
        items.push(new MetricTreeItem(
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
      if (!d.hasCacheDetails) missingFlags.push('--enable-prompt-tokens-details');
      if (!d.hasMetrics) missingFlags.push('--enable-per-request-metrics');
    }
    if (missingFlags.length > 0) {
      // Flag-hint row (absorbed from FlagHintTreeItem — single site). Tooltip
      // repeats the message — it reiterates the action needed.
      const hintMsg = `⚡ More data with ${missingFlags.join(' & ')}`;
      const hint = new vscode.TreeItem(hintMsg, vscode.TreeItemCollapsibleState.None);
      hint.iconPath = new vscode.ThemeIcon('lightbulb', new vscode.ThemeColor('charts.yellow'));
      hint.tooltip = hintMsg;
      items.push(hint);
    }
    return items;
  }

  /** Children of the Token Usage node: one collapsible node per model. */
  private getTokenUsageChildren(e: TokenUsageTreeItem): ModelUsageTreeItem[] {
    const models = readModels();
    const usage = getServerUsage(e.serverUrl);
    // Union of models with any today or all-time usage (a model used yesterday
    // still needs its Overall row visible).
    const modelIds = Array.from(new Set([...Object.keys(usage.today), ...Object.keys(usage.allTime)])).sort();
    return modelIds.map(modelId => {
      const entry = findModelConfig(models, readServers(), e.serverUrl, modelId);
      const label = entry?.displayName || entry?.id || modelId;
      // Cost: actual reported (OpenRouter) when present, else the per-1M estimate.
      const { today, overall, currency } = this.modelCostFor(e.serverUrl, modelId, entry?.cost);
      // Collapsed description: "$X today and $Y total" — exactly what the
      // API/store reports, never a fabricated window rate.
      const summary = formatCostSummary(today, overall, currency);
      return new ModelUsageTreeItem(e.serverUrl, modelId, label, summary, e.serverId);
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

  /** Configured models referencing this relay ENTRY (models point at the
   *  registry by `server`, so this is a plain reference lookup). */
  private getRelayModels(serverId: string): ModelConfig[] {
    return readModels().filter(m => m.server === serverId);
  }

  /** The cached provider list (with per-1M pricing) for a relay model, if fetched. */
  private relayProviders(serverId: string, modelId: string): OpenRouterModelEndpoint[] | undefined {
    return this.subscriptions
      .find(s => s.serverId === serverId)
      ?.metrics.providersByModel?.[modelId];
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

  dispose(): void {
    this.visible = false;
    this.disposeSubscriptions();
    this._onDidChangeTreeData.dispose();
  }
}
