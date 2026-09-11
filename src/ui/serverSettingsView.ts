/**
 * Model Settings Webview View.
 * Per-model settings editor in the vLLM sidebar.
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getConfig, findModelConfigIndex, toPublicModelConfig, normalizeServerUrl, sanitizeRequestHeaders, resolveConfigId, resolveVllmModelId, KNOWN_SERVER_TYPES, type ModelConfig, type ServerType } from '../state/config.js';
import { patchModelConfig, readModels, readServers, writeServers, type ModelIdentity } from '../state/configStore.js';
import { firstEntryById } from '../state/serverRegistry.js';
import { listServerModels } from '../backends/runtimeLimits.js';
import { getOpenRouterModelEndpointsCached, type OpenRouterModelEndpoint } from '../backends/openRouter.js';

import {
  discoverPersonalities,
  resolveModelReplacements,
  getGlobalPersonalitiesDir,
  getBundledPersonalitiesDir,
} from '../persona/personalityStore.js';
import { loadPersonalityMeta, loadPromptReplacements, COMMON_REPLACEMENTS_FILENAME } from '../persona/promptReplacer.js';

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
  /**
   * Webview identity for this group: the registry ENTRY id. The entry IS the
   * server — no URL/header folding, so nothing derived from credentials (no
   * fingerprint, no hash) ever reaches the webview DOM.
   */
  key: string;
  /** Registry entry id (same value as `key`; kept for message payloads). */
  serverId: string;
  url: string;
  /** Backend type from the registry entry (undefined = unset → vLLM by policy). */
  serverType?: ServerType;
  /** User-set server label (first non-empty among the group's entries), or undefined. */
  serverDisplayName?: string;
  models: ModelConfig[];
  serverModelIds: string[];
  /** Backend detected from the server's /v1/models data (undefined = unknown). */
  detectedServerType?: ServerType;
}

/**
 * Decide the backend type used to default `serverType` for a server group's
 * unconfigured models. `/v1/models` can only identify vLLM (positive
 * `max_model_len`) and llama.cpp (`owned_by: "llamacpp"`); LM Studio and Ollama
 * expose their own endpoints and have no `/v1/models` signature. When the endpoint
 * signal is inconclusive — no such entry, or the fetch failed — adopt the persisted
 * serverType of the group's registry entry instead of silently defaulting to
 * vllm. Never guesses: absent both, returns undefined and the caller falls back
 * to the vLLM policy default.
 */
function resolveDetectedServerType(
  entries: Array<{ owned_by?: string; max_model_len?: number }>,
  siblings: ReadonlyArray<{ serverType?: ServerType }>
): ServerType | undefined {
  if (entries.some((entry) => typeof entry.max_model_len === 'number' && entry.max_model_len > 0)) {
    return 'vllm';
  }
  if (entries.some((entry) => entry.owned_by === 'llamacpp')) {
    return 'llamacpp';
  }
  return siblings[0]?.serverType;
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
  /** Registry entry id the target model lives on. */
  server: string;
  /** Extension `id` of the target model config (or the server model id when unconfigured). */
  id?: string;
  /** Personality file to attach (global folder path, or the user's own file). Omit (or set `clear`) to remove it. */
  sourcePath?: string;
  /** meta.name of a SHIPPED preset (option carries data-name). Stored as the
   *  portable `personality` name reference INSTEAD of a path — a path means
   *  this machine only; the name resolves to every machine's own seeded copy. */
  name?: string;
  clear?: boolean;
}

interface NewPersonalityMessage {
  type: 'newPersonality';
}

/**
 * Seed content for "+ New": a live COPY of the bundled Raw (Model Natural)
 * preset — real, working rules, not toy examples — plus the `_howTo`
 * explainer (JSON has no comments, so underscore keys are how the file talks;
 * the loader ignores them) and a placeholder meta.
 *
 * Copied from the shipped preset at click time, so the rules can never drift
 * from it, and the whole file is meant to be handed to an AI assistant
 * ("turn this into a pirate personality") — the copy shows exactly what a
 * working replacements file looks like against Copilot's real boilerplate.
 * Two deliberate deviations from the preset:
 * - meta becomes a placeholder; a copy keeping "Raw (Model Natural)" would
 *   collide with the bundled preset in every picker.
 * - the include is rewritten to an ABSOLUTE path at the shared folder's
 *   seeded copy of the common file. Unlike a preset, this file has no fixed
 *   home — the user decides where to save it, so the preset's bare filename
 *   would only resolve by luck; the absolute path resolves from anywhere on
 *   this machine (machine-specific by nature, and the explainer says so by
 *   printing the folder it points into).
 *
 * `personalitiesDir` is printed in the explainer because the shared drop-in
 * folder is machine-specific — pointing at it honestly means printing its
 * live path (forward slashes: readable, and no JSON backslash escaping to
 * mangle).
 *
 * Exported solely so a test can JSON.parse it — a template that stops being
 * valid JSON would otherwise ship silently to every user who clicks the
 * button (a trailing-comma regression nearly shipped, 2026-09-07).
 */
export async function personalityTemplate(rawPresetPath: string, personalitiesDir: string): Promise<string> {
  const dir = personalitiesDir.split(path.sep).join('/');
  const commonAbs = `${dir}/${COMMON_REPLACEMENTS_FILENAME}`;
  const raw = JSON.parse(await fs.readFile(rawPresetPath, 'utf-8')) as { rules?: unknown[] };
  // The preset's include names the common file by bare filename, which only
  // works next to it. This file has no fixed home, so pin the shared copy's
  // absolute path instead; every other rule is copied untouched.
  const rules = (raw.rules ?? []).map(rule =>
    rule !== null && typeof rule === 'object'
      && (rule as { include?: unknown }).include === COMMON_REPLACEMENTS_FILENAME
      ? { include: commonAbs }
      : rule,
  );
  return JSON.stringify({
    _howTo: [
      "This file is a copy of the extension's 'Raw (Model Natural)' preset: its rules really strip Copilot's boilerplate. Edit them, delete them, add your own - or hand the whole file to an AI assistant and describe the personality you want.",
      "Each rule: find = exact text from Copilot's system prompt, replace = what takes its place (empty string deletes). Rules run in order.",
      "The include entry at the end is a path to another replacements file whose rules get spliced in at that position. Yours points by absolute path at prompt-replacements-common.json - the shared boilerplate removals - inside the extension's personality folder named below, so it resolves no matter where you save this file. Delete the include line to run with only your own rules, or point it at any replacements file you like.",
      "To get the exact text to match: enable vllm-copilot.systemMessageCapture in settings, chat once, open .vllm/system-messages.json, copy from receivedContent.",
      "This editor is unsaved - save it wherever you like, then attach it to a model in Model Settings with 'Load'. Edits apply on the next request.",
      `The extension's own personality files - the shipped presets and prompt-replacements-common.json - live in this folder: ${dir}. Save this file into it, under a name of your own, and the personality is offered in EVERY model's dropdown when it next refreshes. Filenames the extension ships are re-copied from the extension at every start, so never save under one of those.`,
    ],
    meta: { name: 'My Personality', description: 'Say what this personality does.' },
    rules,
  }, null, 2) + '\n';
}

/**
 * How an attached user file is stored in `systemMessageReplacementsFile`:
 * workspace-relative (forward slashes, portable across machines and git
 * checkouts) when it lives under the first workspace folder, absolute as
 * picked otherwise. `resolveWorkspaceRelativePath` re-applies the same rule
 * in reverse at request time.
 */
function personalityStoragePath(picked: string): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    const rel = path.relative(root, picked);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/');
    }
  }
  return picked;
}

interface PickPersonalityFileMessage {
  type: 'pickPersonalityFile';
  /** Registry entry id the target model lives on. */
  server: string;
  /** Extension `id` of the target model config. */
  id?: string;
}

interface SetServerTypeMessage {
  type: 'setServerType';
  /** Registry entry id whose backend type changes. */
  server: string;
  serverType: ServerType;
}

interface SetSystemMessageCaptureMessage {
  type: 'setSystemMessageCapture';
  enabled: boolean;
}

interface WebviewAction {
  type: 'autoConfigure' | 'removeModel';
  /** Registry entry id of the selected server — anchors both actions. */
  server?: string;
  /** Extension `id` of the target model config (or the server model id when unconfigured). */
  id?: string;
}

type FromWebviewMessage = ReadyMessage | SaveMessage | ApplyPersonalityMessage | NewPersonalityMessage | PickPersonalityFileMessage | SetServerTypeMessage | SetSystemMessageCaptureMessage | WebviewAction;

export class ServerSettingsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private isWebviewReady = false;
  private refreshGeneration = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly clearCache?: () => void,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.refreshGeneration++;
    this.view = webviewView;
    this.isWebviewReady = false;
    this.outputChannel.appendLine('[SETTINGS] resolveWebviewView called');

    // Resolve paths to external JS/CSS files
    const resourcesUri = vscode.Uri.joinPath(this.context.extensionUri, 'resources');
    const scriptPath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'serverSettings.js');
    const stylePath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'serverSettings.css');
    const scriptUri = webviewView.webview.asWebviewUri(scriptPath);
    const styleUri = webviewView.webview.asWebviewUri(stylePath);
    // Vendored Choices.js (searchable model picker) - loaded before our own
    // assets so the library defines window.Choices at first render and our
    // CSS overrides its theme variables.
    const choicesJsUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'choices.min.js')
    );
    // Shared fuzzy matcher (same function the Model Selector runs) - loaded
    // before serverSettings.js, which swaps it into Choices at init.
    const searchJsUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'webview-search.js')
    );
    const choicesCssUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'choices.min.css')
    );

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
          } else if (msg.type === 'newPersonality') {
            await this.newPersonalityFile();
          } else if (msg.type === 'pickPersonalityFile') {
            await this.pickPersonalityFile(msg);
          } else if (msg.type === 'setServerType') {
            await this.setServerType(msg);
          } else if (msg.type === 'setSystemMessageCapture') {
            await this.setSystemMessageCapture(msg.enabled);
          } else if (msg.type === 'autoConfigure') {
            await vscode.commands.executeCommand('vllm-copilot.autoConfigureModel', {
              server: msg.server,
              id: msg.id,
            });
          } else if (msg.type === 'removeModel') {
            await vscode.commands.executeCommand('vllm-copilot.removeModel', {
              server: msg.server,
              id: msg.id,
            });
          }
        } catch (err) {
          // Error boundary — a failing handler must never become an unhandled
          // rejection (VS Code would only log it invisibly).
          this.outputChannel.appendLine(
            `[ERROR] Model Settings message "${msg.type}" failed: ${err instanceof Error ? err.message : String(err)}`
          );
          this.outputChannel.show(true);
          vscode.window.showErrorMessage(
            `Model Settings: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      },
    );

    const configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('vllm-copilot.models') || e.affectsConfiguration('vllm-copilot.servers')) {
        this.refreshWebview();
      }
    });

    webviewView.onDidDispose(() => {
      msgDisposable.dispose();
      configDisposable.dispose();
      // Drop the stale view reference so an in-flight refreshWebview (which
      // passed the entry guard before awaiting getConfig) can't postMessage to
      // a dead webview. resolveWebviewView re-creates both on re-show.
      if (this.view === webviewView) {
        this.refreshGeneration++;
        this.view = undefined;
        this.isWebviewReady = false;
      }
    });

    // Set HTML synchronously - references external files
    webviewView.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webviewView.webview.cspSource}; script-src ${webviewView.webview.cspSource};">
  <link href="${choicesCssUri}" rel="stylesheet">
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>
  <div id="root"><p class="empty-state">Loading...</p></div>
  <div class="modal-overlay" id="modal"><div class="modal-box" id="modalBody"></div></div>
  <script src="${choicesJsUri}"></script>
  <script src="${searchJsUri}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;

    this.outputChannel.appendLine('[SETTINGS] HTML set with external resources');
  }

  private async refreshWebview(): Promise<void> {
    const view = this.view;
    if (!view || !this.isWebviewReady) return;
    const generation = ++this.refreshGeneration;
    const config = await getConfig();
    // One group per ENTRY, in `servers[]` array order. The entry IS the server:
    // no URL/header folding — each entry is probed and labelled with its own
    // credentials, and models attach through their `server` reference.
    const modelsByServer = new Map<string, ModelConfig[]>();
    for (const model of config.models) {
      const list = modelsByServer.get(model.server);
      if (list) list.push(model);
      else modelsByServer.set(model.server, [model]);
    }
    // First entry wins per id, exactly like the runtime resolver
    // (`resolveServer` uses `servers.find`). Attaching models to a shadowed
    // duplicate id would show them on a server no request ever reaches —
    // `validateConfig` already warns about the duplicate itself.
    const uniqueEntries = [...firstEntryById(config.servers).values()];
    // Models whose `server` ref dangles never reach a group and so are absent
    // from this view; `validateConfig` (activation) and discovery (every
    // refresh) already name them, so no third log line belongs here.
    const servers: ServerGroup[] = await Promise.all(
      uniqueEntries.map(async (entry) => {
        const url = normalizeServerUrl(entry.serverUrl);
        const entryType = entry.serverType;
        const requestHeaders = sanitizeRequestHeaders(entry.requestHeaders ?? {});
        // Server-reported model ids via the shared backend-aware lister
        // (audit P9-1/P13-2): LM Studio is listed by its model-key endpoint and
        // Ollama by its loaded-models endpoint, so the badge is no longer
        // silently blind for backends without a meaningful /v1/models. The
        // vLLM/llama.cpp/OpenRouter branch of the lister answers the same
        // /v1/models the old raw probe did, and carries the fields the backend
        // detector below reads.
        const serverModelIds: string[] = [];
        let entries: Array<{ owned_by?: string; max_model_len?: number }> = [];
        try {
          const listed = await listServerModels(entryType ?? 'vllm', url, requestHeaders);
          for (const m of listed) {
            serverModelIds.push(m.id);
            entries.push({ owned_by: m.ownedBy, max_model_len: m.maxModelLen });
          }
        } catch (err) {
          this.outputChannel.appendLine(`[WARN] Model Settings: model list probe failed for ${url}: ${err instanceof Error ? err.message : String(err)} - server-reported models hidden.`);
        }
        // /v1/models can only identify vLLM and llama.cpp. LM Studio / Ollama have no
        // /v1/models signature — when the endpoint signal is inconclusive (or unreachable),
        // fall back to the entry's persisted serverType.
        const detectedServerType = resolveDetectedServerType(entries, [entry]);
        // Mirror the dashboard's single normalization point for the display
        // name: trimmed, so whitespace-only hand-edits never render as blank
        // labels. One rule for every backend, relays included — rename
        // addresses the entry, so the entry's own label is what shows.
        const serverDisplayName = entry.displayName?.trim() || undefined;
        // Public projection: models carry no credentials post-registry — auth
        // lives on the entry, whose headers never reach the webview DOM.
        return {
          key: entry.id,
          serverId: entry.id,
          url,
          serverType: entryType,
          serverDisplayName,
          models: (modelsByServer.get(entry.id) ?? []).map(m => toPublicModelConfig(m)),
          serverModelIds,
          detectedServerType,
        };
      }),
    );
    const firstServer = servers[0];
    const firstModel = resolveConfigId(firstServer?.models[0]) ?? '';

    // Personality list: the global personality folder (bundled presets seeded
    // at activation + anything the user drops in there). Applying is a bare
    // path write, so the entry's own path is what gets stored — no target/copy
    // distinction survives the seeding model. Name collisions are logged, not
    // toasted: this method re-runs on every settings change, a toast would be
    // a mosquito farm; the quick-pick command warns interactively.
    const personalities = (await discoverPersonalities(this.context, (m) => this.outputChannel.appendLine(`[WARN] ${m}`))).map(p => ({
      name: p.name,
      description: p.description,
      sourcePath: p.sourcePath,
      // Shipped presets are applied as NAME references (see ApplyPersonalityMessage.name).
      bundled: p.bundled,
    }));
    // Global Diagnostics toggle surfaced in the webview so recording can be
    // triggered without hand-editing settings.json.
    const systemMessageCapture = vscode.workspace
      .getConfiguration('vllm-copilot')
      .get<boolean>('systemMessageCapture', false);
    // Active personality per configured model (keyed by the extension `id` —
    // never the vLLM wire id, since several presets may share one). A custom
    // replacements file that isn't a listed personality gets its own `meta.name`
    // as the label (honest dropdown), falling back to the raw stored path.
    const activePersonalities: Record<string, string | null> = {};
    for (const sv of servers) {
      for (const m of sv.models) {
        const key = resolveConfigId(m) ?? '';
        if (!key) continue;
        const nameRef = (m.personality || '').trim();
        const file = (m.systemMessageReplacementsFile || '').trim();
        let label: string | null = null;
        if (nameRef || file) {
          // THE shared resolver (same function the request pipeline runs) — the
          // dropdown can no longer disagree with what chat actually loads: name
          // references resolve to THIS machine's seeded copy, and a preset path
          // stored on another OS resolves instead of degrading to the raw-path
          // "(user file)" label. This is a READ only: machine-bound path
          // references become portable names once at activation
          // (personalityStore.migratePersonalityPathRefs). Writing here turned
          // every render into a settings change plus a re-entrant config refresh.
          const resolved = await resolveModelReplacements(this.context, m, (msg) => this.outputChannel.appendLine(`[INFO] ${msg}`));
          label = (resolved ? (await loadPersonalityMeta(resolved.sourcePath))?.name ?? resolved.sourcePath : null)
            ?? (nameRef || file || null);
        }
        activePersonalities[key] = label;
      }
    }

    // OpenRouter providers: read lazily from the SHARED per-session cache
    // (`getOpenRouterModelEndpointsCached`) — the same cache the dashboard
    // engine uses, so the dropdown and the dashboard can never drift. The cache
    // owns the display bound (2s abort on the real fetch — nothing runs
    // orphaned), in-flight dedup, TTL, and failure backoff, so Model Settings
    // no longer duplicates that policy on every refresh. The authoritative
    // per-model provider list (`GET /api/v1/models/{id}/endpoints`) is keyed by
    // the wire id for the webview dropdown. The tags come VERBATIM from the
    // API — never derived. A failed fetch yields no entry (dropdown falls back
    // to "Auto" only), never a fabricated list.
    const openRouterWireIds: string[] = [];
    for (const sv of servers) {
      if (sv.serverType !== 'openrouter') continue;
      for (const m of sv.models) {
        const wireId = resolveVllmModelId(m) ?? '';
        if (wireId && !openRouterWireIds.includes(wireId)) openRouterWireIds.push(wireId);
      }
    }
    const providersByModel: Record<string, OpenRouterModelEndpoint[]> = {};
    if (openRouterWireIds.length > 0) {
      const settled = await Promise.allSettled(openRouterWireIds.map((wireId) => getOpenRouterModelEndpointsCached(wireId)));
      for (let i = 0; i < openRouterWireIds.length; i++) {
        const s = settled[i];
        if (s.status !== 'fulfilled') {
          this.outputChannel.appendLine(
            `[WARN] Model Settings: OpenRouter provider list for "${openRouterWireIds[i]}" unavailable: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`
          );
          continue;
        }
        if (s.value.length > 0) providersByModel[openRouterWireIds[i]] = s.value;
      }
    }

    // The view may have been disposed during the awaits above (entry guard
    // passed, then the config/server/personality fetches ran). Posting to a
    // dead webview throws, so re-check before the single postMessage.
    if (this.view !== view || !this.isWebviewReady || generation !== this.refreshGeneration) return;
    view.webview.postMessage({
      type: 'data',
      servers,
      selectedServerKey: firstServer?.key || '',
      selectedModelId: firstModel,
      knownParams: KNOWN_PARAMS,
      providersByModel,
      personalities,
      activePersonalities,
      systemMessageCapture,
    });
    this.outputChannel.appendLine(`[SETTINGS] Data sent via postMessage, ${servers.length} servers`);
  }

  /**
   * Apply (or clear) a personality for the selected model, immediately.
   * Applying is a bare path write: preset paths point into the global
   * personality folder (seeded at activation), "user file" options carry the
   * user's own path. The file already exists where it says — no materialization.
   */
  private async applyPersonality(msg: ApplyPersonalityMessage): Promise<void> {
    const targetId = msg.id || '';
    if (!targetId || !msg.server) return;

    const models = readModels();
    const idx = findModelConfigIndex(models, targetId, msg.server);
    if (idx < 0) return;
    const model = models[idx];

    // Shipped presets store the portable NAME and clear the path (a path is
    // meaningful only on the machine that wrote it); user files store the path
    // and clear any stale name (which would otherwise outrank the file).
    const name = !msg.clear ? (msg.name || '').trim() : '';
    const replacementsFile = !msg.clear && !name && msg.sourcePath ? msg.sourcePath : '';

    await this.saveModelConfig({
      ...model,
      vllmModelId: model.vllmModelId || targetId,
      id: model.id || targetId,
      systemMessageReplacementsFile: replacementsFile,
      personality: name,
    });
  }

  /**
   * Open the personality template in an UNTITLED editor — nothing touches
   * disk. The seed is a live copy of the Raw preset (see
   * {@link personalityTemplate}); the user saves it wherever they want
   * ("boss of the folders": attach-per-model from anywhere, or into the
   * shared personalities folder printed in the template) and attaches it
   * with {@link pickPersonalityFile}.
   */
  private async newPersonalityFile(): Promise<void> {
    const template = await personalityTemplate(
      path.join(getBundledPersonalitiesDir(this.context), 'prompt-replacements-raw.json'),
      getGlobalPersonalitiesDir(this.context),
    );
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content: template });
    await vscode.window.showTextDocument(doc, { preview: false });
    void vscode.window.showInformationMessage(
      'Personality template opened in a new editor - nothing is saved yet. Save it wherever you like, then attach it with "Load".',
    );
  }

  /**
   * Attach the user's own replacements file. Validated through the REAL loader
   * so a malformed file or a broken include is rejected at pick time with the
   * actual reason, never silently ignored at request time. Only
   * `include-failed` warnings are fatal: an include the loader DEDUPLICATES
   * (cycle or diamond) is by-design resolution, not degradation - the file
   * produces exactly these rules at request time too, so rejecting it would
   * call a legal file broken. Stored workspace-relative when it lives under
   * the first workspace folder (portable, git-versionable), absolute otherwise.
   */
  private async pickPersonalityFile(msg: PickPersonalityFileMessage): Promise<void> {
    const targetId = msg.id || '';
    if (!targetId || !msg.server) return;

    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'Personality JSON': ['json'] },
      title: 'Attach a personality replacements file',
    });
    if (!picked || picked.length === 0) return;
    const file = picked[0].fsPath;

    const degradations: string[] = [];
    try {
      await loadPromptReplacements(file, (w, kind) => {
        if (kind === 'include-failed') degradations.push(w);
      });
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Not a usable personality file: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    if (degradations.length > 0) {
      // A file the loader had to degrade over is not attached — at pick time
      // the user can still fix it; at request time it would only half-apply.
      void vscode.window.showErrorMessage(`Not a usable personality file: ${degradations[0]}`);
      return;
    }

    const models = readModels();
    const idx = findModelConfigIndex(models, targetId, msg.server);
    if (idx < 0) return;
    const model = models[idx];
    await this.saveModelConfig({
      ...model,
      vllmModelId: model.vllmModelId || targetId,
      id: model.id || targetId,
      systemMessageReplacementsFile: personalityStoragePath(file),
      // An attached file is the path-form reference — a stale name would
      // outrank it in resolution and silently keep the old preset active.
      personality: '',
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
   * Change a server's backend type. serverType describes the SERVER, so this
   * writes exactly ONE registry ENTRY — the one the webview sent. The entry id
   * IS the identity; there is no fingerprint sweep across "siblings", because
   * two entries with the same URL and headers are two servers by design.
   */
  private async setServerType(msg: SetServerTypeMessage): Promise<void> {
    if (!msg.server || !KNOWN_SERVER_TYPES.includes(msg.serverType)) return;
    const servers = readServers();
    const selected = servers.find(s => s.id === msg.server);
    if (!selected || (selected.serverType ?? 'vllm') === msg.serverType) return;
    const next = servers.map(s => (s.id === msg.server ? { ...s, serverType: msg.serverType } : s));
    await writeServers(next);
    this.clearCache?.();
    // The 'vllm-copilot.servers' config listener owns the webview refresh.
    this.outputChannel.appendLine(`[SETTINGS] Server type → ${msg.serverType} (entry "${msg.server}")`);
  }

  /**
   * Persist a model edit from the webview. Identity is extracted here — `id` and
   * `server` are lookup keys, never patchable properties — and delegated to
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
    const { id, server, ...rest } = updates;
    const identity: ModelIdentity = {
      id: id || updates.vllmModelId || '',
      server: server || '',
    };

    try {
      const result = await patchModelConfig(identity, rest);
      this.outputChannel.appendLine(`[SETTINGS] Saved config for ${identity.id}`);
      this.clearCache?.();
      vscode.window.showInformationMessage(
        `Settings saved for "${result.model.displayName || identity.id}"`
      );
    } catch (err) {
      // Reply so the webview knows the save FAILED. The webview sets a one-shot
      // `pendingSave` flag that is consumed ONLY by a 'data' message; a failed
      // save suppresses the refresh (no 'data' arrives), leaving the flag set.
      // The NEXT unrelated refresh would then be misread as the save's answer and
      // wipe the draft the user just failed to save. Notifying it lets the
      // webview clear the flag and re-arm the dirty indicator without touching
      // field values. This message is scoped to save only — other actions never
      // set pendingSave, so a stray 'save-failed' is a harmless no-op.
      this.view?.webview.postMessage({ type: 'save-failed' });
      throw err;
    }
  }
}
