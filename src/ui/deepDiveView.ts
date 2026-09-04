/**
 * vLLM Deep-Dive — editor-area webview with full server statistics.
 * Right-click server node → "vLLM Deep-Dive".
 *
 * The panel takes ONE reading when it opens and then goes quiet: almost everything
 * it renders (server config, token totals, histograms, the raw dump) only changes
 * when the server restarts, so a panel that kept polling would scrape a server for
 * as long as its tab sat open. Re-invoking the command on an open panel retakes the
 * reading — that is the refresh gesture.
 */

import * as vscode from 'vscode';
import { getMetricsEngine } from './vllmMetrics.js';
import type { ServerRawData, ServerMetrics } from './vllmMetrics.js';
import { normalizeServerUrl, sanitizeRequestHeaders, type ServerType } from '../state/config.js';
import { readServers } from '../state/configStore.js';

interface ReadyMessage {
  type: 'ready';
}

/** Live connection facts for an open panel. The `refresh` closure MUST read
 *  these instead of the values captured when the panel was created:
 *  `getMetricsEngine`'s reuse path overwrites url/headers/type on EVERY
 *  lookup, so a closure holding creation-time credentials would stomp freshly
 *  rotated auth (pushed by Update Auth via `refreshEngineHeaders`, or by a
 *  hand-edited settings.json) back onto the SHARED engine the next time the
 *  command retakes the reading. The command re-reads settings on every
 *  invocation, so these fields are always current. */
interface PanelArgs {
  serverUrl: string;
  requestHeaders: Record<string, string>;
  serverType: ServerType;
}

/** Singleton — only one deep-dive panel per server registry entry at a time.
 *  The key is the entry id (the same key the metrics engine uses); the live
 *  URL/headers/type ride in `args` because `refresh` re-reads them from the
 *  holder on every invocation, and Rename Server retitles the panel through
 *  this same entry-id key. */
const openPanels = new Map<string, { panel: vscode.WebviewPanel; args: PanelArgs; refresh: () => void }>();

/**
 * Retitle one open Deep-Dive panel after Rename Server. Rename addresses
 * exactly one registry entry and panels are keyed by entry id, so the panel
 * lookup is that same key — no URL matching (that belonged to the fan-out
 * era). Falls back to the panel's live URL when the name was cleared.
 */
export function updateDeepDiveTitle(serverId: string, displayName?: string): void {
  const holder = openPanels.get(serverId);
  if (holder) {
    holder.panel.title = `vLLM Deep-Dive: ${displayName || holder.args.serverUrl}`;
  }
}

/**
 * Register the dashboard's "vLLM Deep-Dive" command. Domain logic — registry
 * lookup by entry id, vLLM-only guard, connection-fact normalization — lives
 * in this file, the deep-dive's home, not in an activation-file closure
 * (R7-P5-1). extension.ts just registers it.
 */
export function registerOpenDeepDiveCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.openDeepDive', async (arg?: any) => {
    // The dashboard tree item carries the registry ENTRY id — never match by
    // URL: one URL can host several credential identities, and URL-matching
    // would open the panel with whichever entry happens to be first.
    const entry = readServers().find(s => s.id === arg?.serverId);
    if (!entry) {
      vscode.window.showErrorMessage('Server not found: it may have been removed. Refresh the Dashboard.');
      return;
    }
    const serverType = entry.serverType ?? 'vllm';
    // Deep-Dive is a vLLM metrics view — non-vLLM backends don't expose
    // /metrics, so the panel would be all empty rows. Guard even though the
    // context menu already hides it for non-vLLM servers (defense in depth).
    if (serverType !== 'vllm') {
      vscode.window.showInformationMessage(
        `Deep-Dive is a vLLM-only view. ${serverType} servers don't expose vLLM metrics (KV cache, throughput, TTFT).`
      );
      return;
    }
    // We already hold the entry; normalize it directly instead of looking it
    // up again by id. The guard above admits vLLM entries only, so there is
    // no backend special case here — every server is renamable.
    const serverUrl = normalizeServerUrl(entry.serverUrl);
    const requestHeaders = sanitizeRequestHeaders(entry.requestHeaders ?? {});
    const displayName = entry.displayName?.trim() || undefined;
    openDeepDive(entry.id, serverUrl, requestHeaders, serverType, context, outputChannel, displayName);
  });
}

export function openDeepDive(
  /** Registry entry id — the panel key and the metrics-engine key. */
  serverId: string,
  /** Normalized server URL (caller normalizes; panels display it). */
  serverUrl: string,
  /** Sanitized auth headers for this entry's credential. */
  requestHeaders: Record<string, string>,
  serverType: ServerType,
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
  /** User-set server label — used in the panel title instead of the raw URL. */
  displayName?: string,
): void {
  // Panels are keyed by the registry ENTRY id — the same key the metrics
  // engine uses — so one entry gets exactly one panel and one engine, and two
  // entries pointing at one URL (different credentials) get separate panels.
  const panelKey = serverId;
  // If a panel for this server is already open, reveal it. Update the title as
  // well — the title is only set at creation, so a rename while the panel stays
  // open (retainContextWhenHidden) would otherwise show the stale label.
  const existing = openPanels.get(panelKey);
  if (existing) {
    // The command re-reads settings on every invocation, so these args are
    // live: fold a rotated key, an edited URL, or a changed backend type into
    // the holder BEFORE retaking the reading. `refresh` reads them from the
    // holder — that is the only way the engine sees current credentials.
    existing.args.serverUrl = serverUrl;
    existing.args.requestHeaders = requestHeaders;
    existing.args.serverType = serverType;
    existing.panel.title = `vLLM Deep-Dive: ${displayName || serverUrl}`;
    existing.panel.reveal(vscode.ViewColumn.Beside);
    existing.refresh();
    return;
  }

  /** Mutable holder read by `refresh` on every reading (see PanelArgs). */
  const args: PanelArgs = { serverUrl, requestHeaders, serverType };

  const panel = vscode.window.createWebviewPanel(
    'vllm-copilot.deepDive',
    `vLLM Deep-Dive: ${displayName || serverUrl}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  // Resolve external JS/CSS paths
  const resourcesUri = vscode.Uri.joinPath(context.extensionUri, 'resources');
  const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'resources', 'deepDive.js'));
  const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'resources', 'deepDive.css'));

  panel.webview.options = { enableScripts: true, localResourceRoots: [resourcesUri] };
  panel.webview.html = buildHtml(panel.webview, scriptUri, styleUri);

  let isReady = false;
  let disposed = false;
  /** In-flight one-shot subscription, if a reading is pending. */
  let reading: { dispose: () => void } | undefined;

  /** `error` is the probe failure reason — it lives on the aggregated metrics,
   *  never in the raw payload, so without it an unreachable server renders as a
   *  blank panel. */
  /** `snapshotAt` is when the payload was captured (epoch ms), not when it is
   *  rendered — the cache push carries the engine's fill time so an offline
   *  panel stamps the snapshot's real age under the failure banner. */
  function pushData(raw: ServerRawData, error?: string, snapshotAt?: number): void {
    panel.webview.postMessage({ type: 'data', raw, error, snapshotAt });
  }

  /** Take exactly one reading: whatever the engine already holds, plus the next
   *  completed poll cycle — then unsubscribe again. */
  function refresh(): void {
    // `isReady` doubles as "the webview script is listening": a message posted
    // before it posts `ready` is dropped and the panel would sit on "Loading…".
    // `disposed` covers a panel closed between the webview posting `ready` and
    // this handler running — subscribing then would leave a poller nobody owns.
    if (!isReady || disposed) return;
    // A re-take while one is pending (double click) replaces it, so the earlier
    // subscription can't be orphaned by the second `subscribe`.
    reading?.dispose();
    reading = undefined;

    // Read the LIVE holder, never the creation-time parameters — see PanelArgs.
    const engine = getMetricsEngine(serverId, args.serverUrl, args.requestHeaders, args.serverType, undefined, outputChannel);
    // Cache first so the panel paints instantly; it can still be stale (or
    // missing), so the live cycle below is what actually refreshes the view.
    const cached = engine.getCachedRaw();
    if (cached) pushData(cached, offlineError(engine.getCachedAggregated()), engine.getCachedSnapshotAt());

    // The callback disposes its OWN subscription, never whatever `reading` holds
    // at the time — a re-take may already have replaced it.
    const sub = engine.subscribe((aggregated, raw) => {
      // One cycle only — this leaves the engine, and it stops polling once this
      // panel was the last viewer (the engine is reference-counted).
      sub.dispose();
      if (reading === sub) reading = undefined;
      pushData(raw, offlineError(aggregated), Date.now());
    });
    reading = sub;
    // The engine may already be polling for the dashboard, whose next tick can be
    // a full interval away. Ask for a cycle now so re-opening really refreshes;
    // while a cycle is already running this is a no-op and we just await it.
    engine.pollNow();
  }

  // Message handler — disposed when panel closes. `ready` arrives on the initial
  // load and again after a webview reload/recycle, which retakes the reading.
  const msgDisposable = panel.webview.onDidReceiveMessage((msg: ReadyMessage) => {
    if (msg.type === 'ready') {
      isReady = true;
      refresh();
    }
  });

  // Single disposable handler for panel close
  panel.onDidDispose(() => {
    disposed = true;
    reading?.dispose();
    openPanels.delete(panelKey);
    msgDisposable.dispose();
  });

  openPanels.set(panelKey, { panel, args, refresh });
}

/** Why the probe produced nothing, or undefined when it succeeded. The message
 *  (e.g. "Health check failed: 500") exists only on the aggregated metrics. */
function offlineError(metrics: ServerMetrics | null): string | undefined {
  return metrics && !metrics.online ? metrics.error : undefined;
}

function buildHtml(webview: vscode.Webview, scriptUri: vscode.Uri, styleUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>
  <header>
    <h1>vLLM Deep-Dive</h1>
    <span class="refresh-info" id="lastUpdated">Loading…</span>
  </header>
  <div id="content"><div class="loading">Fetching vLLM server data…</div></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}