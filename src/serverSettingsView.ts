/**
 * Server Settings Webview View.
 * Per-model settings editor in the vLLM sidebar.
 */

import * as vscode from 'vscode';
import { getConfig, buildEndpoint, type ModelConfig } from './config.js';

const KNOWN_PARAMS: Record<string, { label: string; type: 'number' | 'string' | 'json' }> = {
  temperature: { label: 'Temperature', type: 'number' },
  top_p: { label: 'Top P', type: 'number' },
  top_k: { label: 'Top K', type: 'number' },
  min_p: { label: 'Min P', type: 'number' },
  presence_penalty: { label: 'Presence Penalty', type: 'number' },
  frequency_penalty: { label: 'Frequency Penalty', type: 'number' },
  repetition_penalty: { label: 'Repetition Penalty', type: 'number' },
  max_tokens: { label: 'Max Tokens', type: 'number' },
  chat_template_kwargs: { label: 'Chat Template Kwargs', type: 'json' },
  stop: { label: 'Stop Sequences', type: 'json' },
  reasoning_effort: { label: 'Reasoning Effort', type: 'string' },
};

interface ServerGroup {
  url: string;
  models: ModelConfig[];
  serverModelIds: string[];
}

interface ReadyMessage {
  type: 'ready';
}

interface SaveMessage {
  type: 'save';
  config: Partial<ModelConfig>;
}

interface SetPersonalityMessage {
  type: 'setPersonality';
}

type FromWebviewMessage = ReadyMessage | SaveMessage | SetPersonalityMessage;

export class ServerSettingsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private isWebviewReady = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.isWebviewReady = false;
    this.outputChannel.appendLine('[SETTINGS] resolveWebviewView called');

    // Resolve paths to external JS/CSS files
    const resourcesUri = vscode.Uri.joinPath(this.context.extensionUri, 'resources');
    const scriptPath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'serverSettings.js');
    const stylePath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'serverSettings.css');
    const scriptUri = webviewView.webview.asWebviewUri(scriptPath);
    const styleUri = webviewView.webview.asWebviewUri(stylePath);

    webviewView.webview.options = { enableScripts: true, localResourceRoots: [resourcesUri] };

    webviewView.webview.onDidReceiveMessage(
      async (msg: FromWebviewMessage) => {
        if (msg.type === 'ready') {
          this.isWebviewReady = true;
          await this.refreshWebview();
        } else if (msg.type === 'save' && msg.config) {
          await this.saveModelConfig(msg.config);
        } else if (msg.type === 'setPersonality') {
          await vscode.commands.executeCommand('vllm-copilot.setModelPersonality');
        }
      },
      undefined,
      this.context.subscriptions,
    );

    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('vllm-copilot.models')) {
          this.refreshWebview();
        }
      }),
    );

    // Set HTML synchronously - references external files
    webviewView.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webviewView.webview.cspSource}; script-src ${webviewView.webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>
  <div id="root"><p class="empty-state">Loading...</p></div>
  <div class="modal-overlay" id="modal"><div class="modal-box" id="modalBody"></div></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;

    this.outputChannel.appendLine('[SETTINGS] HTML set with external resources');
  }

  private async refreshWebview(): Promise<void> {
    if (!this.view || !this.isWebviewReady) return;
    const config = await getConfig(this.context);
    const serverMap = new Map<string, ModelConfig[]>();
    for (const model of config.models) {
      if (!model.serverUrl) continue;
      let existing = serverMap.get(model.serverUrl);
      if (!existing) { existing = []; serverMap.set(model.serverUrl, existing); }
      existing.push(model);
    }
    const servers: ServerGroup[] = await Promise.all(
      Array.from(serverMap.entries()).map(async ([url, models]) => {
        // Fetch server model IDs from /v1/models
        const serverModelIds: string[] = [];
        try {
          const headers = models[0]?.requestHeaders ?? {};
          const resp = await fetch(buildEndpoint(url, 'v1/models'), { headers, signal: AbortSignal.timeout(5000) });
          if (resp.ok) {
            const data = await resp.json() as { data?: Array<{ id?: string }> };
            for (const m of data.data ?? []) {
              if (m.id) serverModelIds.push(m.id);
            }
          }
        } catch { /* non-critical */ }
        return { url, models, serverModelIds };
      }),
    );
    const firstServer = servers[0];
    const firstModel = firstServer?.models[0]?.vllmModelId || firstServer?.models[0]?.id || '';

    this.view.webview.postMessage({
      type: 'data',
      servers,
      selectedServerUrl: firstServer?.url || '',
      selectedModelVllmId: firstModel,
      knownParams: KNOWN_PARAMS,
    });
    this.outputChannel.appendLine(`[SETTINGS] Data sent via postMessage, ${servers.length} servers`);
  }

  private async saveModelConfig(updates: Partial<ModelConfig>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('vllm-copilot');
    const models: ModelConfig[] = cfg.get<ModelConfig[]>('models') || [];
    const targetVllmId = updates.vllmModelId || updates.id || '';
    const targetServer = updates.serverUrl || '';
    const idx = models.findIndex(m => {
      const mVllmId = m.vllmModelId || m.id || '';
      return mVllmId === targetVllmId && m.serverUrl === targetServer;
    });
    if (idx < 0) {
      // New model entry - add to config
      const newEntry: ModelConfig = {
        ...(updates as ModelConfig),
        vllmModelId: targetVllmId,
        id: targetVllmId,
        serverUrl: targetServer,
      };
      models.push(newEntry);
    } else {
      const existing = models[idx];
      models[idx] = { ...existing, ...updates };
    }
    await cfg.update('models', models, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Settings saved for "${updates.displayName || targetVllmId}"`);
    this.outputChannel.appendLine(`[SETTINGS] Saved config for ${targetVllmId}`);
    this.refreshWebview();
  }
}