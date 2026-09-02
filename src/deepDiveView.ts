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
import { normalizeServerUrl, type ServerType } from './config.js';

interface ReadyMessage {
  type: 'ready';
}

/** Singleton — only one deep-dive panel per server registry entry at a time.
 *  The key is the entry id (the same key the metrics engine uses); the URL
 *  rides alongside so a rename can retitle every panel whose entry shares the
 *  URL (§5 fans the display name out per URL), and `refresh` lets the command
 *  retake the reading of an already-open panel. */
const openPanels = new Map<string, { panel: vscode.WebviewPanel; url: string; refresh: () => void }>();

/**
 * Retitle every open Deep-Dive panel for a server (matched by normalized URL).
 * Called after Rename Server so panels that stay open across the rename
 * (`retainContextWhenHidden`) don't keep a stale label until reopened.
 */
export function updateDeepDiveTitle(serverUrl: string, displayName?: string): void {
  const normalized = normalizeServerUrl(serverUrl);
  for (const entry of openPanels.values()) {
    if (normalizeServerUrl(entry.url) === normalized) {
      entry.panel.title = `vLLM Deep-Dive: ${displayName || entry.url}`;
    }
  }
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
    existing.panel.title = `vLLM Deep-Dive: ${displayName || serverUrl}`;
    existing.panel.reveal(vscode.ViewColumn.Beside);
    existing.refresh();
    return;
  }

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
  function pushData(raw: ServerRawData, error?: string): void {
    panel.webview.postMessage({ type: 'data', raw, error });
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

    const engine = getMetricsEngine(serverId, serverUrl, requestHeaders, serverType, undefined, outputChannel);
    // Cache first so the panel paints instantly; it can still be stale (or
    // missing), so the live cycle below is what actually refreshes the view.
    const cached = engine.getCachedRaw();
    if (cached) pushData(cached, offlineError(engine.getCachedAggregated()));

    // The callback disposes its OWN subscription, never whatever `reading` holds
    // at the time — a re-take may already have replaced it.
    const sub = engine.subscribe((aggregated, raw) => {
      // One cycle only — this leaves the engine, and it stops polling once this
      // panel was the last viewer (the engine is reference-counted).
      sub.dispose();
      if (reading === sub) reading = undefined;
      pushData(raw, offlineError(aggregated));
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

  openPanels.set(panelKey, { panel, url: serverUrl, refresh });
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