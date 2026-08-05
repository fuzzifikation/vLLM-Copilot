/**
 * Server Settings Webview View.
 * Per-model settings editor in the vLLM sidebar.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig, buildEndpoint, findModelConfigIndex, type ModelConfig } from './config.js';
import {
  discoverPersonalities,
  ensureGlobalPersonality,
  resolveActivePersonality,
  getGlobalPersonalitiesDir,
} from './personalityStore.js';

// Ordered by frequency of use: common sampling → length → penalties → output control → niche.
const KNOWN_PARAMS: Record<string, { label: string; type: 'number' | 'string' | 'json'; options?: string[] }> = {
  // Sampling (most common)
  temperature: { label: 'Temperature', type: 'number' },
  top_p: { label: 'Top P', type: 'number' },

  // Output length
  max_tokens: { label: 'Max Tokens', type: 'number' },
  min_tokens: { label: 'Min Tokens', type: 'number' },

  // Sampling refinement
  top_k: { label: 'Top K', type: 'number' },
  min_p: { label: 'Min P', type: 'number' },

  // Penalties
  repetition_penalty: { label: 'Repetition Penalty', type: 'number' },
  presence_penalty: { label: 'Presence Penalty', type: 'number' },
  frequency_penalty: { label: 'Frequency Penalty', type: 'number' },

  // Output control
  stop: { label: 'Stop Sequences', type: 'json' },
  response_format: { label: 'Response Format', type: 'json' },
  reasoning_effort: { label: 'Reasoning Effort', type: 'string', options: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },

  // Reproducibility
  seed: { label: 'Seed', type: 'number' },

  // Tool / formatting
  parallel_tool_calls: { label: 'Parallel Tool Calls', type: 'string', options: ['true', 'false'] },
  skip_special_tokens: { label: 'Skip Special Tokens', type: 'string', options: ['true', 'false'] },

  // vLLM-specific (advanced)
  bad_words: { label: 'Bad Words', type: 'json' },
  structured_outputs: { label: 'Structured Outputs', type: 'json' },
  repetition_detection: { label: 'Repetition Detection', type: 'json' },
  chat_template_kwargs: { label: 'Chat Template Kwargs', type: 'json' },
  ignore_eos: { label: 'Ignore EOS', type: 'string', options: ['true', 'false'] },
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

interface ApplyPersonalityMessage {
  type: 'applyPersonality';
  serverUrl: string;
  /** Extension `id` of the target model config (or the server model id when unconfigured). */
  id?: string;
  /** Source personality to apply. Omit (or set `clear`) to remove the personality. */
  sourcePath?: string;
  clear?: boolean;
}

interface WebviewAction {
  type: 'autoConfigure' | 'removeModel';
  serverUrl: string;
  /** Extension `id` of the target model config (or the server model id when unconfigured). */
  id?: string;
}

type FromWebviewMessage = ReadyMessage | SaveMessage | ApplyPersonalityMessage | WebviewAction;

export class ServerSettingsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private isWebviewReady = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly clearCache?: () => void,
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

    // View-scoped disposables — torn down with this view, NOT the whole extension.
    // `context.subscriptions` lives for the extension lifetime, so pushing the
    // message and config listeners there would leak one of each on every
    // re-resolution of the view (dispose + re-show). The workspace config
    // listener is the real leak — it outlives the webview and would fire
    // `refreshWebview` against a disposed (or stale) view.
    const msgDisposable = webviewView.webview.onDidReceiveMessage(
      async (msg: FromWebviewMessage) => {
        if (msg.type === 'ready') {
          this.isWebviewReady = true;
          await this.refreshWebview();
        } else if (msg.type === 'save' && msg.config) {
          await this.saveModelConfig(msg.config);
        } else if (msg.type === 'applyPersonality') {
          await this.applyPersonality(msg);
        } else if (msg.type === 'autoConfigure') {
          await vscode.commands.executeCommand('vllm-copilot.autoConfigureModel', {
            serverUrl: msg.serverUrl,
            id: msg.id,
          });
        } else if (msg.type === 'removeModel') {
          await vscode.commands.executeCommand('vllm-copilot.removeModel', {
            serverUrl: msg.serverUrl,
            id: msg.id,
            skipConfirm: true,
          });
        }
      },
    );

    const configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('vllm-copilot.models')) {
        this.refreshWebview();
      }
    });

    webviewView.onDidDispose(() => {
      msgDisposable.dispose();
      configDisposable.dispose();
    });

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
    const firstModel = firstServer?.models[0]?.id || firstServer?.models[0]?.vllmModelId || '';

    // Personality list + the active personality per configured model (keyed by the
    // extension `id` — never the vLLM wire id, since several presets may share one).
    // A custom replacements file that isn't a known personality falls back to its raw path.
    // `targetPath` is where applying this personality will materialize it in global
    // storage (deterministic per basename) — the webview uses it so a "Save All
    // Changes" right after changing the dropdown writes the same value.
    const globalDir = getGlobalPersonalitiesDir(this.context);
    const personalities = (await discoverPersonalities(this.context)).map(p => ({
      name: p.name,
      description: p.description,
      sourcePath: p.sourcePath,
      source: p.source,
      targetPath: path.join(globalDir, path.basename(p.sourcePath)),
    }));
    const activePersonalities: Record<string, string | null> = {};
    for (const sv of servers) {
      for (const m of sv.models) {
        const key = m.id || m.vllmModelId || '';
        if (!key) continue;
        const file = (m.systemMessageReplacementsFile || '').trim();
        activePersonalities[key] = file
          ? (await resolveActivePersonality(this.context, file, personalities))?.name ?? file
          : null;
      }
    }

    this.view.webview.postMessage({
      type: 'data',
      servers,
      selectedServerUrl: firstServer?.url || '',
      selectedModelId: firstModel,
      knownParams: KNOWN_PARAMS,
      personalities,
      activePersonalities,
    });
    this.outputChannel.appendLine(`[SETTINGS] Data sent via postMessage, ${servers.length} servers`);
  }

  /**
   * Apply (or clear) a personality for the selected model, immediately.
   * Applying materializes the personality as a user-owned copy in global storage.
   */
  private async applyPersonality(msg: ApplyPersonalityMessage): Promise<void> {
    const targetId = msg.id || '';
    if (!targetId || !msg.serverUrl) return;

    const cfg = vscode.workspace.getConfiguration('vllm-copilot');
    const models: ModelConfig[] = cfg.get<ModelConfig[]>('models') || [];
    const idx = findModelConfigIndex(models, targetId, msg.serverUrl);
    if (idx < 0) return;
    const model = models[idx];

    let replacementsFile = '';
    if (!msg.clear && msg.sourcePath) {
      try {
        replacementsFile = await ensureGlobalPersonality(this.context, msg.sourcePath);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to apply personality: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
    }

    await this.saveModelConfig({
      ...model,
      vllmModelId: model.vllmModelId || targetId,
      id: model.id || targetId,
      serverUrl: model.serverUrl,
      systemMessageReplacementsFile: replacementsFile,
    });
  }

  private async saveModelConfig(updates: Partial<ModelConfig>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('vllm-copilot');
    const models: ModelConfig[] = cfg.get<ModelConfig[]>('models') || [];
    const targetId = updates.id || updates.vllmModelId || '';
    const targetServer = updates.serverUrl || '';
    const idx = targetId && targetServer
      ? findModelConfigIndex(models, targetId, targetServer)
      : -1;
    if (idx < 0) {
      // New model entry - add to config
      const newEntry: ModelConfig = {
        ...(updates as ModelConfig),
        vllmModelId: updates.vllmModelId || targetId,
        id: updates.id || targetId,
        serverUrl: targetServer,
      };
      models.push(newEntry);
    } else {
      const existing = models[idx];
      models[idx] = { ...existing, ...updates };
    }
    await cfg.update('models', models, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Settings saved for "${updates.displayName || targetId}"`);
    this.outputChannel.appendLine(`[SETTINGS] Saved config for ${targetId}`);
    this.clearCache?.();
    this.refreshWebview();
  }
}
