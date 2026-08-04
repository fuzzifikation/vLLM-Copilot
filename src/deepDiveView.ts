/**
 * vLLM Deep-Dive — editor-area webview with full server statistics.
 * Right-click server node → "vLLM Deep-Dive" → opens panel with live polling.
 */

import * as vscode from 'vscode';
import { getMetricsEngine } from './vllmMetrics.js';
import type { ServerRawData } from './vllmMetrics.js';

interface ReadyMessage {
  type: 'ready';
}

/** Singleton — only one deep-dive panel per server at a time. */
const openPanels = new Map<string, vscode.WebviewPanel>();

export function openDeepDive(
  serverUrl: string,
  requestHeaders: Record<string, string>,
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): void {
  // If a panel for this server is already open, reveal it
  const existing = openPanels.get(serverUrl);
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
      isReady = true;
      const engine = getMetricsEngine(serverUrl, requestHeaders);

      // Push cached data immediately (may be null before first tick completes)
      const cached = engine.getCachedRaw();
      if (cached) pushData(cached);

      // Subscribe — engine starts polling if this is the first subscriber
      engineSubscription = engine.subscribe((_aggregated, raw) => {
        pushData(raw);
      });
    }
  });

  // Single disposable handler for panel close
  panel.onDidDispose(() => {
    disposed = true;
    if (engineSubscription) {
      try { engineSubscription.dispose(); } catch { /* best-effort */ }
      engineSubscription = undefined;
    }
    openPanels.delete(serverUrl);
    msgDisposable.dispose();
  });

  openPanels.set(serverUrl, panel);
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