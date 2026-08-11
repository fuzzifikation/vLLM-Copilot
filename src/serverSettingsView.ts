/**
 * Server Settings Webview View.
 * Per-model settings editor in the vLLM sidebar.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig, buildEndpoint, findModelConfigIndex, type ModelConfig } from './config.js';
import { patchModelConfig, type ModelIdentity } from './configStore.js';
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

interface SetSystemMessageCaptureMessage {
  type: 'setSystemMessageCapture';
  enabled: boolean;
}

interface WebviewAction {
  type: 'autoConfigure' | 'removeModel';
  serverUrl: string;
  /** Extension `id` of the target model config (or the server model id when unconfigured). */
  id?: string;
}

type FromWebviewMessage = ReadyMessage | SaveMessage | ApplyPersonalityMessage | SetSystemMessageCaptureMessage | WebviewAction;

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
        try {
          if (msg.type === 'ready') {
            this.isWebviewReady = true;
            await this.refreshWebview();
          } else if (msg.type === 'save' && msg.config) {
            await this.saveModelConfig(msg.config);
          } else if (msg.type === 'applyPersonality') {
            await this.applyPersonality(msg);
          } else if (msg.type === 'setSystemMessageCapture') {
            await this.setSystemMessageCapture(msg.enabled);
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
        } catch (err) {
          // Error boundary — a failing handler must never become an unhandled
          // rejection (VS Code would only log it invisibly).
          this.outputChannel.appendLine(
            `[ERROR] Server Settings message "${msg.type}" failed: ${err instanceof Error ? err.message : String(err)}`
          );
          vscode.window.showErrorMessage(
            `Server Settings: ${err instanceof Error ? err.message : String(err)}`
          );
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
      // Drop the stale view reference so an in-flight refreshWebview (which
      // passed the entry guard before awaiting getConfig) can't postMessage to
      // a dead webview. resolveWebviewView re-creates both on re-show.
      this.view = undefined;
      this.isWebviewReady = false;
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
    // Global Diagnostics toggle surfaced in the webview so recording can be
    // triggered without hand-editing settings.json.
    const systemMessageCapture = vscode.workspace
      .getConfiguration('vllm-copilot')
      .get<boolean>('systemMessageCapture', false);
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

    // The view may have been disposed during the awaits above (entry guard
    // passed, then the config/server/personality fetches ran). Posting to a
    // dead webview throws, so re-check before the single postMessage.
    if (!this.view || !this.isWebviewReady) return;
    this.view.webview.postMessage({
      type: 'data',
      servers,
      selectedServerUrl: firstServer?.url || '',
      selectedModelId: firstModel,
      knownParams: KNOWN_PARAMS,
      personalities,
      activePersonalities,
      systemMessageCapture,
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

  /**
   * Toggle the global `systemMessageCapture` setting (system prompt recording).
   * Global — independent of any model — and read live by the provider at request
   * time, so no cache invalidation is needed.
   */
  private async setSystemMessageCapture(enabled: boolean): Promise<void> {
    await vscode.workspace.getConfiguration('vllm-copilot')
      .update('systemMessageCapture', enabled, vscode.ConfigurationTarget.Global);
  }

  /**
   * Persist a model edit from the webview. Identity is extracted here — `id` and
   * `serverUrl` are lookup keys, never patchable properties — and delegated to
   * `configStore.patchModelConfig`, which owns the field-merge / composite-id
   * logic. Side effects (log, cache clear, toast) run in this handler AFTER the
   * store write succeeds, so the store stays pure. The webview refresh is NOT one
   * of them: `patchModelConfig` writes `vllm-copilot.models`, which fires the
   * `onDidChangeConfiguration` listener registered in `resolveWebviewView`, and
   * that listener owns the single refresh. Refreshing here too would post two
   * `data` messages per save — harmless for the plain save path, but the second
   * message would re-render and clobber a draft the webview deliberately preserved
   * across an auto-applied change (personality).
   */
  private async saveModelConfig(updates: Partial<ModelConfig>): Promise<void> {
    const { id, serverUrl, ...rest } = updates;
    const identity: ModelIdentity = {
      id: id || updates.vllmModelId || '',
      serverUrl: serverUrl || '',
    };

    const result = await patchModelConfig(identity, rest);
    this.outputChannel.appendLine(`[SETTINGS] Saved config for ${identity.id}`);
    this.clearCache?.();
    vscode.window.showInformationMessage(
      `Settings saved for "${result.model.displayName || identity.id}"`
    );
  }
}
