/**
 * vLLM Deep-Dive — editor-area webview with full server statistics.
 * Right-click server node → "vLLM Deep-Dive" → opens panel with live polling.
 */

import * as vscode from 'vscode';
import { getMetricsEngine } from './vllmMetrics.js';
import type { ServerRawData } from './vllmMetrics.js';
import { normalizeServerUrl, serverFingerprint, serverGroupKey, type ServerType } from './config.js';

interface ReadyMessage {
  type: 'ready';
}

/** Singleton — only one deep-dive panel per server at a time. */
const openPanels = new Map<string, vscode.WebviewPanel>();

export function openDeepDive(
  serverUrl: string,
  requestHeaders: Record<string, string>,
  serverType: ServerType,
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): void {
  // Panels are keyed by server IDENTITY (normalized URL + header fingerprint)
  // so `http://host:8000`, `http://host:8000/`, and `http://host:8000/v1` share
  // one panel — matching the metrics engine — while two identities on one URL
  // (different per-model credentials) get separate panels with their own auth.
  const panelKey = serverGroupKey(serverFingerprint(normalizeServerUrl(serverUrl), requestHeaders));
  // If a panel for this server is already open, reveal it
  const existing = openPanels.get(panelKey);
  if (existing) {
    existing.reveal(vscode.ViewColumn.Beside);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'vllm-copilot.deepDive',
    `vLLM Deep-Dive: ${serverUrl}`,
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

  /** Push raw data to the webview (safely guards disposed state). */
  function pushData(raw: ServerRawData): void {
    if (!isReady || disposed) return;
    panel.webview.postMessage({ type: 'data', raw });
  }

  function pushError(message: string): void {
    if (!isReady || disposed) return;
    panel.webview.postMessage({ type: 'error', message });
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
        engineSubscription = engine.subscribe((_aggregated, raw) => {
          pushData(raw);
        });
      }

      // Push cached data immediately (may be null before the first tick
      // completes). Runs on first ready AND re-ready (reload) so the page never
      // sits on "Loading…" until the next engine tick.
      const cached = engine.getCachedRaw();
      if (cached) pushData(cached);
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

  openPanels.set(panelKey, panel);
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