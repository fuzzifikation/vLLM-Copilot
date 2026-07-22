/**
 * vLLM Deep-Dive — editor-area webview with full server statistics.
 * Right-click server node → "vLLM Deep-Dive" → opens panel with live polling.
 */

import * as vscode from 'vscode';
import { fetchServerRawData } from './vllmMetrics.js';

interface ReadyMessage {
  type: 'ready';
}

/** Singleton — only one deep-dive panel per server at a time. */
const openPanels = new Map<string, vscode.WebviewPanel>();

function getPollInterval(): number {
  return vscode.workspace.getConfiguration('vllm-copilot.dashboard').get<number>('pollIntervalMs', 15000);
}

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
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  function startPolling(): void {
    if (pollTimer) clearTimeout(pollTimer);
    // Use recursive setTimeout so getPollInterval() is re-read on each cycle
    pollTimer = setTimeout(tick, getPollInterval());
  }

  function tick(): void {
    if (disposed) return;
    fetchData().finally(() => {
      if (!disposed) pollTimer = setTimeout(tick, getPollInterval());
    });
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  }

  async function fetchData(): Promise<void> {
    if (!isReady || disposed) return;
    try {
      const raw = await fetchServerRawData(serverUrl, requestHeaders);
      if (disposed) return; // guard against post-dispose postMessage
      panel.webview.postMessage({ type: 'data', raw });
    } catch (err) {
      if (disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      outputChannel.appendLine(`[DEEP-DIVE] Fetch error for ${serverUrl}: ${message}`);
      panel.webview.postMessage({ type: 'error', message });
    }
  }

  // Message handler — disposed when panel closes
  const msgDisposable = panel.webview.onDidReceiveMessage(async (msg: ReadyMessage) => {
    if (msg.type === 'ready') {
      isReady = true;
      await fetchData();
      startPolling();
    }
  });

  // Single disposable handler for panel close
  panel.onDidDispose(() => {
    disposed = true;
    stopPolling();
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