/**
 * Dashboard view for the vLLM sidebar.
 * Shows server status and basic metrics.
 */

import * as vscode from 'vscode';
import { getConfig, resolveServerConfig } from './config.js';
import type { ModelConfig } from './config.js';

/** Parsed metrics from vLLM's /metrics endpoint */
interface ServerMetrics {
  online: boolean;
  version?: string;
  uptimeSeconds?: number;
  gpuMemoryTotal?: number; // bytes
  gpuMemoryUsed?: number; // bytes
  kvCacheUsagePercent?: number;
  runningRequests?: number;
  waitingRequests?: number;
  error?: string;
}

/** Server connection info with auth headers */
interface ServerConnection {
  url: string;
  requestHeaders: Record<string, string>;
}

/**
 * Parses the Prometheus text format from vLLM's /metrics endpoint.
 * Lightweight parser — handles the specific metrics we care about.
 */
function parseMetrics(text: string): Partial<ServerMetrics> {
  const result: Partial<ServerMetrics> = {};

  for (const line of text.split('\n')) {
    // Skip comments
    if (line.startsWith('#')) continue;

    // Parse metric lines: metric_name{labels} value
    const match = line.match(/^(\w+)\{(.*)\}\s+(.+)$/);
    if (!match) continue;

    const [, name, labelsStr, value] = match;
    const labels: Record<string, string> = {};

    for (const labelMatch of labelsStr.matchAll(/(\w+)="([^"]*)"/g)) {
      labels[labelMatch[1]] = labelMatch[2];
    }

    const numValue = parseFloat(value);

    switch (name) {
      case 'vllm:gpu_cache_usage_perc':
        result.kvCacheUsagePercent = numValue * 100;
        break;
      case 'vllm:gpu_memory_config':
        if (labels.name === 'gpu_memory_percent') {
          result.gpuMemoryUsed = numValue * 100; // stored as percent
        }
        break;
      case 'vllm:num_requests_running':
        result.runningRequests = numValue;
        break;
      case 'vllm:num_requests_waiting':
        result.waitingRequests = numValue;
        break;
    }
  }

  return result;
}

/**
 * Fetches server info and metrics from a vLLM server.
 * Uses per-model requestHeaders for authentication.
 */
async function fetchServerMetrics(
  serverUrl: string,
  requestHeaders: Record<string, string>,
  timeout = 5000
): Promise<ServerMetrics> {
  const baseUrl = serverUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // Build headers object from per-model config
  const headers = { ...requestHeaders };

  try {
    // Health check - vLLM returns 200 with no body, not JSON
    const healthRes = await fetch(`${baseUrl}/health`, {
      signal: controller.signal,
      headers,
    });

    if (!healthRes.ok) {
      return { online: false, error: `Health check failed: ${healthRes.status}` };
    }

    // Server is online
    const result: ServerMetrics = {
      online: true,
    };

    // Try to get version from /version
    try {
      const versionRes = await fetch(`${baseUrl}/version`, {
        signal: controller.signal,
        headers,
      });
      if (versionRes.ok) {
        const versionData = await versionRes.json() as { version?: string };
        result.version = versionData.version;
      }
    } catch {
      // Version endpoint might not exist
    }

    // Try to get metrics
    try {
      const metricsRes = await fetch(`${baseUrl}/metrics`, {
        signal: controller.signal,
        headers,
      });
      if (metricsRes.ok) {
        const metricsText = await metricsRes.text();
        Object.assign(result, parseMetrics(metricsText));
      }
    } catch {
      // Metrics endpoint might be disabled
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { online: false, error: `Cannot connect: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generates HTML for the dashboard webview.
 */
function generateDashboardHtml(
  webview: vscode.Webview,
  servers: string[],
  selectedServer: string | null,
  metrics: ServerMetrics | null,
  pollingInterval: number,
  isPolling: boolean
): string {
  const serverOptions = servers.map(url => {
    const selected = url === selectedServer ? 'selected' : '';
    return `<option value="${url}" ${selected}>${url}</option>`;
  }).join('\n');

  const noServersMessage = servers.length === 0
    ? `<div class="no-servers">
        <p>No servers configured.</p>
        <button id="addServerBtn">Add Server &amp; Model</button>
      </div>`
    : '';

  let metricsHtml = '';
  if (selectedServer && metrics) {
    const statusColor = metrics.online ? '#4ec9b0' : '#f48771';
    const statusText = metrics.online ? 'Online' : 'Offline';

    if (metrics.online) {
      const kvCache = metrics.kvCacheUsagePercent != null
        ? formatPercentage(metrics.kvCacheUsagePercent)
        : 'N/A';

      const gpuMemory = metrics.gpuMemoryUsed != null
        ? formatPercentage(metrics.gpuMemoryUsed)
        : 'N/A';

      const version = metrics.version ? `<span class="metric-value">${metrics.version}</span>` : '<span class="metric-value">unknown</span>';
      const uptime = metrics.uptimeSeconds != null
        ? `<span class="metric-value">${formatUptime(metrics.uptimeSeconds)}</span>`
        : '<span class="metric-value">N/A</span>';

      const running = metrics.runningRequests != null
        ? `<span class="metric-value">${metrics.runningRequests}</span>`
        : '<span class="metric-value">N/A</span>';

      const waiting = metrics.waitingRequests != null
        ? `<span class="metric-value">${metrics.waitingRequests}</span>`
        : '<span class="metric-value">N/A</span>';

      metricsHtml = `
        <div class="metrics-panel">
          <div class="metric-row">
            <span class="metric-label">Version</span>
            ${version}
          </div>
          <div class="metric-row">
            <span class="metric-label">Uptime</span>
            ${uptime}
          </div>
          <div class="metric-row">
            <span class="metric-label">GPU Memory</span>
            <span class="metric-value">${gpuMemory}</span>
          </div>
          <div class="metric-row">
            <span class="metric-label">KV Cache</span>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${metrics.kvCacheUsagePercent || 0}%"></div>
            </div>
            <span class="metric-value">${kvCache}</span>
          </div>
          <div class="metric-row">
            <span class="metric-label">Running</span>
            ${running}
          </div>
          <div class="metric-row">
            <span class="metric-label">Waiting</span>
            ${waiting}
          </div>
        </div>
      `;
    } else {
      metricsHtml = `
        <div class="error-panel">
          <p>${metrics.error || 'Server is offline'}</p>
        </div>
      `;
    }

    metricsHtml = `
      <div class="server-status" style="color: ${statusColor}">
        <span class="status-dot"></span> ${statusText}
      </div>
      ${metricsHtml}
    `;
  }

  const pollingBadge = isPolling ? '<span class="polling-indicator">●</span>' : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'inline'; script-src ${webview.cspSource};">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
    .server-selector { margin-bottom: 12px; }
    .server-selector select {
      width: 100%;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
    }
    .server-status {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 0;
      font-weight: 600;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
      display: inline-block;
    }
    .metrics-panel { margin-top: 8px; }
    .metric-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .metric-label { color: var(--vscode-descriptionForeground); }
    .metric-value { font-weight: 500; }
    .progress-bar {
      height: 4px;
      background: var(--vscode-input-background);
      border-radius: 2px;
      margin: 4px 0;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: var(--vscode-progressBar-background);
      transition: width 0.3s;
    }
    .error-panel {
      margin-top: 8px;
      padding: 8px;
      background: rgba(244, 135, 113, 0.1);
      border-radius: 4px;
      font-size: 0.9em;
    }
    .no-servers {
      text-align: center;
      padding: 24px 0;
      color: var(--vscode-descriptionForeground);
    }
    .no-servers button {
      margin-top: 12px;
      padding: 6px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    .no-servers button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .configure-btn {
      margin-top: 12px;
      width: 100%;
      padding: 6px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    .configure-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .polling-indicator {
      color: var(--vscode-descriptionForeground);
      font-size: 0.8em;
      margin-left: 4px;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    .actions { margin-top: 12px; }
  </style>
</head>
<body>
  <div class="server-selector">
    <select id="serverSelect">
      ${servers.length > 0 ? serverOptions : '<option>No servers</option>'}
    </select>
    ${pollingBadge}
  </div>
  ${noServersMessage}
  ${metricsHtml}
  <div class="actions">
    <button class="configure-btn" id="configureBtn">Configure Server</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const serverSelect = document.getElementById('serverSelect');
    const configureBtn = document.getElementById('configureBtn');
    const addServerBtn = document.getElementById('addServerBtn');

    serverSelect?.addEventListener('change', (e) => {
      vscode.postMessage({ type: 'selectServer', serverUrl: e.target.value });
    });

    configureBtn?.addEventListener('click', () => {
      vscode.postMessage({ type: 'configureServer' });
    });

    addServerBtn?.addEventListener('click', () => {
      vscode.postMessage({ type: 'addServer' });
    });
  </script>
</body>
</html>`;
}

function formatPercentage(value: number): string {
  return `${Math.round(value)}%`;
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
}

/**
 * Provider for the vLLM Dashboard webview.
 */
export class DashboardViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private selectedServer: string | null = null;
  private servers: ServerConnection[] = [];

  constructor(
    private extensionContext: vscode.ExtensionContext,
    private outputChannel: vscode.OutputChannel
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'selectServer':
          this.selectedServer = message.serverUrl;
          await this.refresh();
          break;
        case 'configureServer':
          vscode.commands.executeCommand('vllm-copilot.configureServer', this.selectedServer);
          break;
        case 'addServer':
          vscode.commands.executeCommand('vllm-copilot.addServerModel');
          break;
      }
    });

    this.startPolling();
    this.refresh();
  }

  private startPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    const config = vscode.workspace.getConfiguration('vllm-copilot.dashboard');
    const pollInterval = config.get<number>('pollIntervalMs', 15000);

    this.pollTimer = setInterval(async () => {
      if (this.view?.visible) {
        await this.refresh();
      }
    }, pollInterval);
  }

  private async refresh(): Promise<void> {
    try {
      const config = await getConfig(this.extensionContext);

      // Build server connections: group by serverUrl, take requestHeaders from first model per server
      const serverMap = new Map<string, Record<string, string>>();
      for (const model of config.models) {
        if (!model.serverUrl) continue;
        if (!serverMap.has(model.serverUrl)) {
          const serverConfig = resolveServerConfig(model);
          serverMap.set(model.serverUrl, serverConfig.requestHeaders);
        }
      }

      this.servers = Array.from(serverMap.entries()).map(([url, requestHeaders]) => ({
        url,
        requestHeaders,
      }));

      // Auto-select first server if none selected
      if (!this.selectedServer && this.servers.length > 0) {
        this.selectedServer = this.servers[0].url;
      }

      // If selected server is no longer in config, reset
      if (this.selectedServer && !this.servers.some(s => s.url === this.selectedServer)) {
        this.selectedServer = this.servers[0]?.url || null;
      }

      let metrics: ServerMetrics | null = null;
      if (this.selectedServer) {
        const connection = this.servers.find(s => s.url === this.selectedServer);
        if (connection) {
          metrics = await fetchServerMetrics(connection.url, connection.requestHeaders);
        }
      }

      if (this.view) {
        const dashboardConfig = vscode.workspace.getConfiguration('vllm-copilot.dashboard');
        const pollInterval = dashboardConfig.get<number>('pollIntervalMs', 15000);
        const isEnabled = dashboardConfig.get<boolean>('enabled', true);

        this.view.webview.html = generateDashboardHtml(
          this.view.webview,
          this.servers.map(s => s.url),
          this.selectedServer,
          metrics,
          pollInterval,
          isEnabled
        );
      }
    } catch (err) {
      this.outputChannel.appendLine(`[ERROR] Dashboard refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}