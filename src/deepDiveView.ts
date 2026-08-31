/**
 * vLLM Deep-Dive — editor-area webview with full server statistics.
 * Right-click server node → "vLLM Deep-Dive" → opens panel with live polling.
 */

import * as vscode from 'vscode';
import { getMetricsEngine } from './vllmMetrics.js';
import type { ServerRawData, ServerMetrics } from './vllmMetrics.js';
import { normalizeServerUrl, serverGroupKey, serverIdentity, type ServerType } from './config.js';

interface ReadyMessage {
  type: 'ready';
}

/** Singleton — only one deep-dive panel per server at a time. The URL rides
 *  alongside so a rename can retitle every panel of that server by URL match
 *  (the map key is a one-way identity hash, not reversible to a URL). */
const openPanels = new Map<string, { panel: vscode.WebviewPanel; url: string }>();

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
  serverUrl: string,
  requestHeaders: Record<string, string>,
  serverType: ServerType,
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
  /** User-set server label — used in the panel title instead of the raw URL. */
  displayName?: string,
): void {
  // Panels are keyed by server IDENTITY (normalized URL + header fingerprint)
  // so `http://host:8000`, `http://host:8000/`, and `http://host:8000/v1` share
  // one panel — matching the metrics engine — while two identities on one URL
  // (different per-model credentials) get separate panels with their own auth.
  const panelKey = serverGroupKey(serverIdentity(serverUrl, requestHeaders).fingerprint);
  // If a panel for this server is already open, reveal it. Update the title as
  // well — the title is only set at creation, so a rename while the panel stays
  // open (retainContextWhenHidden) would otherwise show the stale label.
  const existing = openPanels.get(panelKey);
  if (existing) {
    existing.panel.title = `vLLM Deep-Dive: ${displayName || serverUrl}`;
    existing.panel.reveal(vscode.ViewColumn.Beside);
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
  let engineSubscription: { dispose: () => void } | undefined;

  /** Push raw data to the webview (safely guards disposed state). `error` is the
   *  probe failure reason — it lives on the aggregated metrics, never in the raw
   *  payload, so without it an unreachable server renders as a blank panel. */
  function pushData(raw: ServerRawData, error?: string): void {
    if (!isReady || disposed) return;
    panel.webview.postMessage({ type: 'data', raw, error });
  }

  // Message handler — disposed when panel closes
  const msgDisposable = panel.webview.onDidReceiveMessage(async (msg: ReadyMessage) => {
    if (msg.type === 'ready') {
      // The panel may have been closed between the webview posting `ready` and
      // this handler running. If so, `onDidDispose` already ran with
      // `engineSubscription === undefined` — subscribing now would create a
      // metrics poller that is never disposed (leaks for the session).
      if (disposed) return;
      const engine = getMetricsEngine(serverUrl, requestHeaders, serverType, undefined, outputChannel);

      // Subscribe only on the FIRST ready. A second `ready` (webview recycle /
      // manual reload) must not orphan the first subscription: it is still live
      // and pushes to this panel, so re-subscribing would leak the first
      // callback forever. isReady must be set BEFORE any push — pushData guards
      // on it.
      if (!isReady) {
        isReady = true;
        engineSubscription = engine.subscribe((aggregated, raw) => {
          pushData(raw, offlineError(aggregated));
        });
      }

      // Push cached data immediately (may be null before the first tick
      // completes). Runs on first ready AND re-ready (reload) so the page never
      // sits on "Loading…" until the next engine tick.
      const cached = engine.getCachedRaw();
      if (cached) pushData(cached, offlineError(engine.getCachedAggregated()));
    }
  });

  // Single disposable handler for panel close
  panel.onDidDispose(() => {
    disposed = true;
    if (engineSubscription) {
      try { engineSubscription.dispose(); } catch { /* best-effort */ }
      engineSubscription = undefined;
    }
    openPanels.delete(panelKey);
    msgDisposable.dispose();
  });

  openPanels.set(panelKey, { panel, url: serverUrl });
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