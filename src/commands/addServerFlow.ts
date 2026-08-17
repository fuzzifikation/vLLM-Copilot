import * as vscode from 'vscode';
import type { ModelConfig, ServerType } from '../config.js';
import { buildEndpoint, resolveVllmModelId, resolveConfigId, normalizeServerUrl, buildModelId, toPublicModelConfig } from '../config.js';
import { replaceModelConfig, type IdentifiedModelConfig } from '../configStore.js';
import type { VllmModel } from '../types.js';
import { describeError } from '../messageConverter.js';
import { detectServerType } from '../vllmClient.js';
import { ensureByokUtilityDefault } from './byok.js';
import { promptForServerAuth } from './serverAuth.js';
import { fetchWithTimeout, resolveModelConfigForAddSafely } from './hfDiscovery.js';

/**
 * Minimal provider surface the Add/Configure flows require: the flows only
 * invalidate the model cache after a save. Structural typing avoids importing
 * `VllmChatModelProvider` (which would create a circular runtime import).
 */
export interface ClearCacheProvider {
  clearCache(): void;
}

/**
 * Minimal shape required from a `GET /v1/models` entry to feed the picker.
 * Both `addServerModel` and `testAndRefreshModels` consume `GET /v1/models`
 * and present the same quick-pick UI; this shared helper is the single
 * source for that UX so the two flows cannot drift.
 */
export interface ServerModelChoice {
  id: string;
  root?: string;
  max_model_len?: number;
}

/**
 * Show a QuickPick of models returned by a vLLM server and return the user's
 * chosen `id`, or `undefined` if they cancel. Shared by the "Add Server &
 * Model" command (initial selection) and the "Test & Refresh Models" command
 * (corrective selection when a configured `vllmModelId` is not on the server).
 *
 * Item layout mirrors the prior inline picker: model id as label, max_model_len
 * as description, and root (when present) as detail so an alias served under
 * `--served-model-name` shows the checkpoint it points at.
 */
export async function pickModelFromServer(
  models: ServerModelChoice[],
  host: string,
  title?: string
): Promise<string | undefined> {
  const items: vscode.QuickPickItem[] = models.map(m => ({
    label: m.id,
    description: m.max_model_len ? `${m.max_model_len.toLocaleString()} ctx` : '',
    detail: m.root ? `root: ${m.root}` : '',
  }));
  const selected = await vscode.window.showQuickPick(items, {
    ...(title ? { title } : {}),
    placeHolder: `Select a model on ${host}`,
  });
  return selected?.label;
}

/**
 * Persist a newly added model and ensure the BYOK utility-model default so agent
 * mode works once the model becomes selectable. Only the Add paths call this
 * (discovered/preset and Keep-Anyway stub) — auto-configure and personality
 * updates must NOT re-run the BYOK write.
 *
 * The BYOK write is awaited AFTER the model write resolves: a failed save never
 * starts the BYOK bootstrap, and the write cannot race the model persistence
 * (the previous fire-and-forget call did both).
 */
export async function persistAddedModel(
  finalConfig: IdentifiedModelConfig,
  onSaved?: () => void
): Promise<void> {
  await replaceModelConfig(finalConfig);
  await ensureByokUtilityDefault();
  onSaved?.();
}

/**
 * Show the final confirm dialog for a newly added model, then save it (or copy
 * its JSON) and offer a window reload. Shared by the preset and HuggingFace
 * branches of the Add flow, and by the auto-configure command's "unconfigured
 * model" branch — both end the same way.
 * @internal Exported for the auto-configure flow.
 */
export async function confirmAndSaveAddedModel(
  finalConfig: IdentifiedModelConfig,
  modelId: string,
  serverUrl: string,
  detail: string,
  output: vscode.OutputChannel,
  onSaved?: () => void
): Promise<boolean> {
  output.appendLine(`[INFO] Add server ${serverUrl} → ${modelId}:`);
  output.appendLine(detail);
  output.appendLine(`Config: ${JSON.stringify(toPublicModelConfig(finalConfig), null, 2)}`);

  const action = await vscode.window.showInformationMessage(
    `Add "${modelId}" from ${serverUrl}?\n\n${detail}`,
    { modal: true },
    'Save to Settings',
    'Copy JSON'
  );

  if (action === 'Save to Settings') {
    await persistAddedModel(finalConfig, onSaved);
    vscode.window.showInformationMessage(`Model "${modelId}" added.`);
    return true;
  } else if (action === 'Copy JSON') {
    await vscode.env.clipboard.writeText(JSON.stringify(finalConfig, null, 2));
    vscode.window.showInformationMessage('Model config copied to clipboard.');
  }
  return false;
}

/**
 * Prompt user what to do when a server cannot be contacted during Add Server.
 * Presents three options: Discard, Run Diagnostic, or Keep Anyway.
 * Always stops the wizard — the caller should `return` after calling this.
 */
async function handleServerFailure(
  serverUrl: string,
  requestHeaders: Record<string, string>,
  detail: string,
  output: vscode.OutputChannel,
  onSaved: () => void,
): Promise<boolean> {
  const action = await vscode.window.showWarningMessage(
    `Cannot connect to ${serverUrl}: ${detail}`,
    { modal: true },
    'Discard',
    'Run Diagnostic',
    'Keep Anyway',
  );

  // Discard or dismissed → stop
  if (action === 'Discard' || action === undefined) return true;

  // Run Diagnostic — uses in-memory values, no settings write needed
  if (action === 'Run Diagnostic') {
    const { runDiagnostics, formatReport } = await import('../diagnostics.js');
    const report = await runDiagnostics(buildEndpoint(serverUrl, 'v1/models'), requestHeaders);
    output.show(true);
    output.appendLine(formatReport(report));
    output.appendLine('');
    output.appendLine('Copy this report (right-click → Copy) and share it when reporting issues.');
    return true;
  }

  // Keep Anyway — save a minimal stub so the user can fix it later
  const modelId = await vscode.window.showInputBox({
    title: 'Keep Anyway — Model ID',
    prompt: 'Enter a model identifier for this server. You can auto-configure or edit it later.',
    placeHolder: 'e.g. my-model or the model name from the server',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Model ID is required'),
  });
  if (!modelId) return true; // cancelled → stop

  const finalConfig: IdentifiedModelConfig = {
    id: buildModelId(serverUrl, modelId),
    vllmModelId: modelId,
    serverUrl,
    ...(Object.keys(requestHeaders).length > 0 ? { requestHeaders } : {}),
  };

  await persistAddedModel(finalConfig, onSaved);
  output.appendLine(`[INFO] Saved stub config for "${modelId}" on ${serverUrl} — server was unreachable.`);
  vscode.window.showInformationMessage(
    `Stub saved for "${modelId}" on ${serverUrl}. Right-click → Auto-Configure when the server is reachable.`
  );
  return true;
}

/**
 * Guided command: add a vLLM server (URL + optional headers), discover its models,
 * auto-configure the chosen one, and save it as a per-model entry. This is the
 * end-to-end flow for onboarding a second server without hand-editing settings.json.
 */
export function registerAddServerModelCommand(
  context: vscode.ExtensionContext,
  provider: ClearCacheProvider,
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.addServerModel', async () => {
    // 1. Server URL
    const urlInput = await vscode.window.showInputBox({
      title: 'Add vLLM Server & Model (1/4)',
      prompt: 'Enter the vLLM server URL',
      placeHolder: 'https://your-server.example.com',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Server URL is required'),
    });
    if (!urlInput) return;
    const serverUrl = normalizeServerUrl(urlInput);

    // Check if this server already exists
    const existingModels: ModelConfig[] = vscode.workspace.getConfiguration('vllm-copilot').get('models') || [];
    const existingServerModels = existingModels.filter(
      m => m.serverUrl && normalizeServerUrl(m.serverUrl) === serverUrl
    );

    if (existingServerModels.length > 0) {
      const modelNames = existingServerModels.map(m => m.displayName || m.vllmModelId || m.id).join(', ');
      const pick = await vscode.window.showInformationMessage(
        `Server already configured with: ${modelNames}`,
        { modal: true },
        'Add Different Model',
        'Update Auth',
      );
      if (pick === 'Update Auth') {
        // Delegate to update auth command
        return vscode.commands.executeCommand('vllm-copilot.updateServerAuth', serverUrl);
      }
      if (pick !== 'Add Different Model') return; // cancelled
    }

    // 2. API key + custom headers (optional). Cancellation aborts the flow.
    const requestHeaders = await promptForServerAuth({
      apiKeyTitle: 'Add vLLM Server & Model (2/4)',
      apiKeyPrompt: '(optional) vLLM API key. Sent as "Authorization: Bearer <key>". Leave empty if not present.',
      apiKeyPlaceholder: 'abc123... or leave empty',
      headersTitle: 'Add vLLM Server & Model (3/4)',
      headersPrompt: '(optional) Additional request headers (e.g. for proxy). JSON format or "Name": "Value". Leave empty for none.',
      headersPlaceholder: '{"CF-Access-Client-Id": "...", "CF-Access-Client-Secret": "..."}  or  "X-API-Key": "abc123"',
    });
    if (requestHeaders === undefined) return;
    const hasHeaders = Object.keys(requestHeaders).length > 0;

    // 4. Discover models on that server, using its headers
    let models: VllmModel[] = [];
    try {
      const url = buildEndpoint(serverUrl, 'v1/models');
      const resp = await fetchWithTimeout(url, { timeoutMs: 10000, requestHeaders });
      if (!resp.ok) {
        const detail = resp.status === 401 || resp.status === 403
          ? `Authentication failed (status ${resp.status})`
          : `Server returned status ${resp.status}`;
        await handleServerFailure(serverUrl, requestHeaders, detail, output, () => provider.clearCache());
        return;
      }
      const data = await resp.json() as { data?: VllmModel[] };
      models = data.data || [];
    } catch (err) {
      output.appendLine(`[ERROR] Add server: cannot connect to ${serverUrl}: ${describeError(err)}`);
      await handleServerFailure(serverUrl, requestHeaders, describeError(err), output, () => provider.clearCache());
      return;
    }

    if (models.length === 0) {
      vscode.window.showInformationMessage(`No models found on ${serverUrl}.`);
      return;
    }

    const modelId = await pickModelFromServer(models, serverUrl, 'Add vLLM Server & Model (4/4)');
    if (!modelId) return;

    // Detect the backend type by probing its documented signatures. Add Server
    // ONLY — never at runtime (runtime uses the persisted serverType switch).
    let detectedServerType: ServerType;
    try {
      detectedServerType = await detectServerType(serverUrl, hasHeaders ? requestHeaders : {}, modelId);
      output.appendLine(`[INFO] Server type detected: ${detectedServerType}`);
    } catch (err) {
      output.appendLine(`[ERROR] Unsupported server: ${describeError(err)}`);
      vscode.window.showErrorMessage(
        `Unsupported server at ${serverUrl}: ${describeError(err)}`
      );
      return;
    }

    // Check if this model already exists on this server
    const newVllmId = modelId;
    const sameModelEntries = existingServerModels.filter(m => resolveVllmModelId(m) === newVllmId);

    // The extension-side identity of the entry we are replacing, if any. When
    // 'Replace Config' is chosen the existing id (which may be a custom
    // preset-derived id) must be retained: `replaceModelConfig` matches on
    // `resolveConfigId` + server URL, so building a fresh composite id here
    // would make it append a duplicate instead of replacing.
    let replaceExistingId: string | undefined;
    if (sameModelEntries.length > 0) {
      // Multiple configs may legitimately share one wire id on a server (e.g. a
      // preset-derived entry beside a discovered composite entry). Replacing the
      // first `.find()` match would silently destroy the wrong config, so when
      // ambiguous let the user choose which entry to replace.
      let target = sameModelEntries[0];
      if (sameModelEntries.length > 1) {
        const items: vscode.QuickPickItem[] = sameModelEntries.map(m => ({
          label: m.displayName ?? resolveConfigId(m) ?? '',
          description: resolveConfigId(m),
          detail: `vllmModelId: ${m.vllmModelId ?? m.id}`,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: `Multiple configs share "${modelId}" — choose which to replace`,
        });
        if (!picked) return; // cancelled
        target = sameModelEntries.find(m => resolveConfigId(m) === picked.description) ?? target;
      }
      const pick = await vscode.window.showInformationMessage(
        `"${modelId}" already exists on this server. Update auth only, or replace entire config?`,
        { modal: true },
        'Update Auth',
        'Replace Config',
      );
      if (pick === 'Update Auth') {
        // Update auth for all models on this server (reuses updateServerAuth)
        return vscode.commands.executeCommand('vllm-copilot.updateServerAuth', serverUrl);
      }
      if (pick !== 'Replace Config') return; // cancelled
      replaceExistingId = resolveConfigId(target);
    }

    const discoveryResult = await resolveModelConfigForAddSafely(
      output, context, modelId, serverUrl, hasHeaders ? requestHeaders : undefined,
      models.find((m: any) => m.id === modelId)?.root,
      undefined,
      detectedServerType,
    );
    if (!discoveryResult) return;

    // Attach the server + headers. `id` is composite ("<model> on <host>") so the
    // same model on two servers stays distinct; `vllmModelId` remains the raw wire identity.
    // When replacing an existing entry the existing id is kept so the store replaces
    // rather than appends (the composite would only match if it was already the stored id).
    const finalConfig: IdentifiedModelConfig = {
      ...discoveryResult.modelConfig,
      id: replaceExistingId ?? buildModelId(serverUrl, modelId),
      vllmModelId: modelId,
      serverUrl,
      serverType: detectedServerType,
      ...(hasHeaders ? { requestHeaders } : {}),
    };
    if (discoveryResult.suggestedMaxOutputTokens !== undefined && finalConfig.maxOutputTokens === undefined) {
      finalConfig.maxOutputTokens = discoveryResult.suggestedMaxOutputTokens;
    }

    await confirmAndSaveAddedModel(finalConfig, modelId, serverUrl, discoveryResult.summary.join('\n'), output, () => provider.clearCache());
  });
}
