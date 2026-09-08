/**
 * The generic Add Server / Add Model wizard (vLLM, LM Studio, llama.cpp, Ollama).
 *
 * Registers the server entry, probes it, picks a model, detects the backend,
 * and hands the result to the shared save tail in addServerCore.ts. The
 * OpenRouter host routes to openRouterAddFlow.ts instead. Both palette
 * commands registered from extension.ts live here.
 */

import * as vscode from 'vscode';
import type { ServerType } from '../state/config.js';
import { buildEndpoint, normalizeServerUrl, buildModelId, isOpenRouterUrl } from '../state/config.js';
import { readModels, readServers, writeServers, type IdentifiedModelConfig } from '../state/configStore.js';
import { firstEntryById, resolveServer } from '../state/serverRegistry.js';
import type { VllmModel } from '../types.js';
import { describeError, isTlsCertificateError, TLS_CERT_SUGGESTION } from '../provider/messageConverter.js';
import { detectServerType } from '../backends/runtimeLimits.js';
import { promptForServerAuth } from './serverAuth.js';
import { fetchWithTimeout, resolveModelConfigForAddSafely } from './hfDiscovery.js';
import { runOpenRouterAddFlow } from './openRouterAddFlow.js';
import {
  confirmAndSaveAddedModel,
  discardUnreferencedServerEntry,
  ensureServerEntry,
  handleDuplicateModelGate,
  persistAddedModelOrRollback,
  reportEntryWriteFailure,
  rotateEntryAuth,
  type ClearCacheProvider,
} from './addServerCore.js';

/**
 * Prompt user what to do when a registered server cannot be contacted while a
 * model is added to it. The server entry was already persisted by the flow's
 * server step (the 'Add Server' doctrine registers without probing), so the
 * choice is about the MODEL: keep the server unconfigured (Skip), run a
 * diagnostic, or save a minimal stub model anyway. The server entry is never
 * removed here. Always stops the wizard — the caller should `return` after
 * calling this.
 */
async function handleServerFailure(
  serverId: string,
  serverUrl: string,
  requestHeaders: Record<string, string>,
  detail: string,
  output: vscode.OutputChannel,
  onSaved: () => void,
): Promise<boolean> {
  // A certificate-ish failure gets the short suggestion: network test +
  // maybe the setting. One bucket, no deeper classification.
  const tlsDetail = isTlsCertificateError(detail) ? `${detail}\n\n${TLS_CERT_SUGGESTION}` : detail;
  const action = await vscode.window.showWarningMessage(
    `Cannot connect to ${serverUrl}: ${tlsDetail}`,
    { modal: true },
    'Skip Model',
    'Run Diagnostic',
    'Add Stub Model',
  );

  // Skip or dismissed → stop; the registered server stays, model-less.
  if (action === 'Skip Model' || action === undefined) {
    output.appendLine(`[INFO] Model add skipped for ${serverUrl} - server entry kept, no model saved.`);
    return true;
  }

  // Run Diagnostic — uses in-memory values, no settings write needed
  if (action === 'Run Diagnostic') {
    const { runDiagnostics, formatReport } = await import('../ui/diagnostics.js');
    const report = await runDiagnostics(buildEndpoint(serverUrl, 'v1/models'), requestHeaders);
    output.show(true);
    output.appendLine(formatReport(report));
    output.appendLine('');
    output.appendLine('Copy this report (right-click → Copy) and share it when reporting issues.');
    return true;
  }

  // Add Stub Model — save a minimal stub so the user can fix it later
  const modelId = await vscode.window.showInputBox({
    title: 'Add Stub Model - Model ID',
    prompt: 'Enter a model identifier for this server. You can auto-configure or edit it later.',
    placeHolder: 'e.g. my-model or the model name from the server',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Model ID is required'),
  });
  if (!modelId) {
    output.appendLine(`[INFO] Stub model cancelled for ${serverUrl} - no model id entered; the server stays registered.`);
    return true; // cancelled → stop
  }

  // The entry was registered by the flow's server step and lives in the
  // registry — the stub just references it by id. No ensureServerEntry here:
  // re-matching the entry's own URL + auth could land on a twin, and there is
  // nothing to create. The stub saves unconditionally — no abandon-rollback,
  // and a blocked settings write keeps the entry too (step 1's kept artifact).
  const finalConfig: IdentifiedModelConfig = {
    id: buildModelId(serverId, modelId),
    vllmModelId: modelId,
    server: serverId,
  };

  if (!(await persistAddedModelOrRollback(finalConfig, modelId, undefined, onSaved, output))) {
    return true;
  }
  output.appendLine(`[INFO] Saved stub config for "${modelId}" on ${serverUrl} - server was unreachable.`);
  vscode.window.showInformationMessage(
    `Stub saved for "${modelId}" on ${serverUrl}. Run "Auto-Configure Model" (command palette or Model Settings) once the server is reachable.`
  );
  return true;
}

/**
 * Register a server in the registry WITHOUT adding a model. The entry IS the
 * artifact here — it is what the user asked for, so it is written once,
 * directly, with no confirm/rollback dance. The optional 'Add a Model'
 * follow-up hands off to {@link addModelToServer} — the same step-2 function
 * the 'Add or Reconfigure Server/Model' wizard runs — so the two commands are
 * one composed flow rather than two wizards re-asking for URL and auth.
 */
export function registerAddServerCommand(
  context: vscode.ExtensionContext,
  provider: ClearCacheProvider,
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.addServer', async () => {
    const urlInput = await vscode.window.showInputBox({
      title: 'Add Server (1/2)',
      prompt: 'Enter a server URL (vLLM, LM Studio, llama.cpp, Ollama) to register without a model',
      placeHolder: 'https://host:8000',
      ignoreFocusOut: true,
      validateInput: validateServerUrlInput,
    });
    if (!urlInput) {
      output.appendLine('[INFO] Add server cancelled - no URL entered.');
      return;
    }
    const serverUrl = normalizeServerUrl(urlInput);
    if (isOpenRouterUrl(serverUrl)) {
      // OpenRouter entries only make sense with a catalog-picked model; the
      // dedicated add flow owns that branch.
      void vscode.window.showInformationMessage(
        'OpenRouter is set up with "Add or Reconfigure Server/Model" - it always adds a model.'
      );
      return;
    }

    const entry = await promptAuthAndRegisterServer(output, serverUrl, 'Add Server (without model)');
    if (!entry) return;
    const { id, created } = entry;
    if (!created) {
      void vscode.window.showInformationMessage(
        `Server ${serverUrl} is already registered as "${id}".`
      );
      return;
    }
    output.appendLine(`[INFO] Registered server "${id}" (${serverUrl}) - no model yet.`);
    const pick = await vscode.window.showInformationMessage(
      `Server "${id}" registered. It stays out of the model picker until a model references it.`,
      'Add a Model'
    );
    if (pick === 'Add a Model') {
      // NO flowCreatedServerId here on purpose: in THIS command the entry is
      // the artifact the user asked for, so a later duplicate-gate cancel must
      // never roll it back. A lingering zero-model entry is a legal state
      // (this command creates one on purpose); Remove Server deletes it.
      await addModelToServer(context, provider, output, id);
    }
  });
}

/**
 * Reject anything `new URL()` can't parse or that has no hostname. Without this,
 * `generateServerId` throws on garbage like "foo bar", and a host-less "http://"
 * silently becomes the localhost:8000 default (normalizeServerUrl's fallback).
 */
function validateServerUrlInput(value: string): string | undefined {
  const raw = value.trim();
  if (!raw) return 'Server URL is required';
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    return `"${raw}" is not a valid URL - e.g. https://host:8000`;
  }
  if (!url.hostname) return 'Enter a full server URL, e.g. https://host:8000';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Use an http(s) server URL';
  return undefined;
}

/**
 * STEP ONE of both add-server commands: collect auth for a known URL and
 * persist the registry entry — the 'Add Server (without model)' core. The
 * write happens once, directly, with no confirm/rollback dance (the entry IS
 * the artifact); cancellation aborts BEFORE any write, and a blocked settings
 * write is reported honestly. Returns the entry id + whether this call created
 * it, or `undefined` when the caller must stop (auth abandoned / write failed).
 */
async function promptAuthAndRegisterServer(
  output: vscode.OutputChannel,
  serverUrl: string,
  flowTitle: string,
): Promise<{ id: string; created: boolean } | undefined> {
  const requestHeaders = await promptForServerAuth({
    apiKeyTitle: `${flowTitle} - API Key`,
    apiKeyPrompt: '(optional) vLLM API key, sent as "Authorization: Bearer <key>". Leave empty if the server has none.',
    apiKeyPlaceholder: 'abc123... or leave empty',
    headersTitle: `${flowTitle} - Custom Headers`,
    headersPrompt: '(optional) Additional request headers (e.g. for proxy). JSON format or "Name": "Value". Leave empty for none.',
    headersPlaceholder: '{"CF-Access-Client-Id": "...", "CF-Access-Client-Secret": "..."}  or  "X-API-Key": "abc123"',
  });
  if (requestHeaders === undefined) {
    output.appendLine(`[INFO] ${flowTitle} cancelled - auth prompt abandoned.`);
    return undefined;
  }
  try {
    return await ensureServerEntry({ serverUrl, requestHeaders });
  } catch (err) {
    reportEntryWriteFailure(err, serverUrl, output);
    return undefined;
  }
}

/**
 * Guided command, composed of the product's two building blocks:
 *
 *   1. ADD SERVER (no model) — URL + auth are collected and the registry entry
 *      is persisted IMMEDIATELY, by the same `ensureServerEntry` core the
 *      'Add Server (no model)' command uses. From this point the entry is a
 *      kept artifact: every later abandonment (Esc at the model picker,
 *      dismissed confirm, unreachable server, failed discovery) leaves the
 *      server registered, to be configured later via Auto-Configure.
 *   2. ADD MODEL ON THAT SERVER — {@link addModelToServer} probes the entry,
 *      picks a model and runs the shared auto-configure/confirm tail (the same
 *      pieces the auto-configure command reuses).
 *
 * The OpenRouter branch is exempt: its server is a fixed managed remote that
 * only exists together with a catalog-picked model.
 */
export function registerAddServerModelCommand(
  context: vscode.ExtensionContext,
  provider: ClearCacheProvider,
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.addServerModel', async () => {
    // 1. Server URL. This field is a SERVER, always — the model is picked next.
    //    OpenRouter is detected by its host; pasting a full model-page URL
    //    names that model directly (its flow skips the picker).
    const urlInput = await vscode.window.showInputBox({
      title: 'Add or Reconfigure Server/Model (1/2)',
      prompt: 'Enter a server URL (vLLM, LM Studio, llama.cpp, Ollama), or an openrouter.ai URL - a model-page URL goes straight to that model',
      placeHolder: 'https://host:8000  ·  https://openrouter.ai  ·  https://openrouter.ai/author/model',
      ignoreFocusOut: true,
      validateInput: validateServerUrlInput,
    });
    if (!urlInput) {
      output.appendLine('[INFO] Add Server cancelled - no URL entered.');
      return;
    }
    const serverUrl = normalizeServerUrl(urlInput);

    const existingModels = readModels();

    // OpenRouter branch — onboarding for the fixed managed remote. The check is
    // exactly the host: `openrouter.ai` → OpenRouter. Everything else is a normal
    // server (the Add Server field is a SERVER — never a model name). The model
    // is then PICKED from the ~415-model catalog; a pasted model-page URL names
    // that model directly (its flow skips the picker). Runs BEFORE the generic
    // "server already configured" gate, which groups by the raw server URL — a
    // model-page URL would never
    // match the fixed API base; the branch performs its own duplicate handling
    // against it.
    if (isOpenRouterUrl(serverUrl)) {
      await runOpenRouterAddFlow(output, provider, urlInput);
      return;
    }

    // Check if this server already exists. Models reference the registry by
    // `server` id — resolve each model's entry to compare by URL.
    const registeredServers = readServers();
    const existingServerModels = existingModels.filter(
      m => resolveServer(m.server, registeredServers)?.serverUrl === serverUrl
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
        await vscode.commands.executeCommand('vllm-copilot.updateServerAuth', serverUrl);
        return;
      }
      if (pick === 'Add Different Model') {
        // Step 2 directly on the entry the existing models live on — its URL
        // and credentials are already stored, so there is nothing to re-enter.
        // (Re-prompting auth here used to derive a credential-twin entry
        // whenever the user left the key blank.)
        await addModelToServer(context, provider, output, existingServerModels[0].server);
        return;
      }
      output.appendLine(`[INFO] Add Server cancelled - server ${serverUrl} already configured.`);
      return; // cancelled
    }

    // 2. STEP ONE — collect auth and register the server BEFORE any model is
    //    chosen. Same shared core as the 'Add Server (without model)' command
    //    (ensureServerEntry, no-rollback doctrine): the entry is the artifact
    //    the user asked for, written once, directly. Escaping step 2 keeps it.
    const registered = await promptAuthAndRegisterServer(output, serverUrl, 'Add or Reconfigure Server/Model');
    if (!registered) return;
    const { id: serverId, created } = registered;
    if (created) {
      output.appendLine(`[INFO] Registered server "${serverId}" (${serverUrl}) - no model yet.`);
      void vscode.window.showInformationMessage(
        `Server "${serverId}" registered. Pick a model next - cancelling keeps the server.`
      );
    }

    // 3. STEP TWO — add and auto-configure a model on that server.
    await addModelToServer(context, provider, output, serverId, created ? serverId : undefined);
  });
}

/**
 * The 'add a model to a registered server' half of the flows: probe the
 * entry's `/v1/models`, pick a model, detect the backend type, run the
 * duplicate gate, auto-configure the pick and confirm-save it — the same
 * shared tail (`resolveModelConfigForAddSafely` + `confirmAndSaveAddedModel`)
 * the auto-configure command runs for a server-reported unconfigured model.
 * Called by the Add/Reconfigure wizard (after it persisted the entry), by its
 * 'Add Different Model' shortcut, and by the 'Add Server (no model)' command's
 * 'Add a Model' follow-up.
 *
 * The entry is step 1's kept artifact: EVERY abandonment path (unreachable
 * server, empty model list, Esc at the picker, unsupported backend, dismissed
 * confirm) leaves the server registered, to be configured later via
 * Auto-Configure. `flowCreatedServerId` — an entry THIS run created — is
 * discarded only when the duplicate gate proves it was a mistake: the model
 * ends up on a pre-existing entry with different credentials for the same
 * URL, or the gate hands off to Update Auth / is abandoned at that point.
 */
async function addModelToServer(
  context: vscode.ExtensionContext,
  provider: ClearCacheProvider,
  output: vscode.OutputChannel,
  serverId: string,
  flowCreatedServerId?: string
): Promise<void> {
  // Re-read the registry: the entry may have been edited or removed since the
  // caller registered/selected it (the store's re-read-at-use doctrine).
  const entry = resolveServer(serverId, readServers());
  if (!entry) {
    output.appendLine(`[ERROR] Add model: server entry "${serverId}" is not registered.`);
    void vscode.window.showErrorMessage(`vLLM-Copilot: server "${serverId}" is no longer registered.`);
    return;
  }
  const onSaved = () => provider.clearCache();
  const requestHeaders = entry.requestHeaders ?? {};

  // Discover the models this server reports, with the entry's stored auth.
  let models: VllmModel[] = [];
  try {
    const resp = await fetchWithTimeout(buildEndpoint(entry.serverUrl, 'v1/models'), { timeoutMs: 10000, requestHeaders });
    if (!resp.ok) {
      const detail = resp.status === 401 || resp.status === 403
        ? `Authentication failed (status ${resp.status})`
        : `Server returned status ${resp.status}`;
      await handleServerFailure(serverId, entry.serverUrl, requestHeaders, detail, output, onSaved);
      return;
    }
    const data = await resp.json() as { data?: VllmModel[] };
    models = data.data || [];
  } catch (err) {
    output.appendLine(`[ERROR] Cannot connect to ${entry.serverUrl}: ${describeError(err)}`);
    await handleServerFailure(serverId, entry.serverUrl, requestHeaders, describeError(err), output, onSaved);
    return;
  }

  if (models.length === 0) {
    output.appendLine(`[WARN] No models found on ${entry.serverUrl}.`);
    vscode.window.showInformationMessage(`No models found on ${entry.serverUrl}. The server stays registered.`);
    return;
  }

  // Quick-pick the models the server reported: id as label, ctx as
  // description, root (when present) as detail so an alias served under
  // `--served-model-name` shows the checkpoint it points at.
  const modelItems: vscode.QuickPickItem[] = models.map(m => ({
    label: m.id,
    description: m.max_model_len ? `${m.max_model_len.toLocaleString('en-US')} ctx` : '',
    detail: m.root ? `root: ${m.root}` : '',
  }));
  const modelPick = await vscode.window.showQuickPick(modelItems, {
    ignoreFocusOut: true,
    title: `Add Model on ${entry.serverUrl}`,
    placeHolder: `Select a model on ${serverId}`,
  });
  const modelId = modelPick?.label;
  if (!modelId) {
    // THE point of the two-step flow: the server was persisted in step 1, so
    // escaping the picker keeps it. A zero-model entry is a legal state (the
    // 'Add Server (no model)' command creates one on purpose); a model can be
    // added later from the dashboard or via Auto-Configure.
    output.appendLine(`[INFO] No model selected - server "${serverId}" stays registered. Add a model later via "Auto-Configure Model".`);
    return;
  }

  // Detect the backend type by probing its documented signatures. Add Server
  // ONLY — never at runtime (runtime uses the persisted serverType switch).
  let detectedServerType: ServerType;
  try {
    detectedServerType = await detectServerType(entry.serverUrl, requestHeaders, modelId);
    output.appendLine(`[INFO] Server type detected: ${detectedServerType}`);
  } catch (err) {
    output.appendLine(`[ERROR] Unsupported server: ${describeError(err)} - server "${serverId}" stays registered without a model.`);
    output.show(true);
    vscode.window.showErrorMessage(
      `Unsupported server at ${entry.serverUrl}: ${describeError(err)}`
    );
    return;
  }

  // Land the detected type on THIS entry. Step 1 registered without probing
  // (the 'Add Server' doctrine — an entry may legitimately arrive type-less).
  // Checked on the RAW entry, not `entry`: resolveServer's EffectiveServer
  // normalizes an unset type to 'vllm', so the effective value is never
  // undefined and would skip the fill forever. Written by id, not through
  // ensureServerEntry: a connection match would fill the FIRST twin for this
  // URL + auth, which need not be this entry.
  const rawEntry = firstEntryById(readServers()).get(serverId);
  if (rawEntry?.serverType === undefined) {
    try {
      await writeServers(readServers().map(s => (s.id === serverId ? { ...s, serverType: detectedServerType } : s)));
    } catch (err) {
      reportEntryWriteFailure(err, entry.serverUrl, output);
      return;
    }
  }

  // Duplicate gate shared with the OpenRouter flow (see
  // handleDuplicateModelGate): disambiguation when several configs share one
  // wire id, then Update Auth / Replace Config. On 'Replace Config' the
  // returned identity is retained downstream — a fresh composite id would
  // append a duplicate instead of replacing.
  const gate = await handleDuplicateModelGate(
    modelId, entry.serverUrl, requestHeaders, `Add Model (${entry.serverUrl})`, output
  );
  if (!gate) {
    // Cancelled at the duplicate dialog, or Update Auth took over: this run's
    // credential variant of an already-configured URL served no purpose.
    await discardUnreferencedServerEntry(flowCreatedServerId);
    return;
  }
  const { replaceExistingId, replaceTargetServer } = gate;

  // On 'Replace Config' the model KEEPS the replaced entry and the entry's
  // credentials stay in charge (Update Auth doctrine owns key rotation from
  // here on) — a ref pointing elsewhere would append a duplicate instead of
  // replacing.
  let targetServerId = serverId;
  if (replaceExistingId) {
    const rotated = await rotateEntryAuth(replaceTargetServer, requestHeaders, output);
    if (!rotated) {
      // Entry vanished mid-flow — same zombie-append trap as the OpenRouter
      // flow: a fresh entry changes the (id, server) match, replaceModelConfig
      // appends, and two models share one config id. Abort honestly.
      output.appendLine(`[ERROR] Replace aborted: server entry "${replaceTargetServer}" no longer exists. Nothing was saved.`);
      void vscode.window.showErrorMessage('vLLM-Copilot: could not replace the existing model: its server entry no longer exists. Nothing was changed; re-run the command to add the model fresh.');
      return;
    }
    targetServerId = rotated;
    if (targetServerId !== serverId) {
      // The model lands on the pre-existing entry — this run's credential
      // twin would sit there unreferenced, holding credentials nobody kept.
      await discardUnreferencedServerEntry(flowCreatedServerId);
    }
  }

  const discoveryResult = await resolveModelConfigForAddSafely(
    output, context, modelId, entry.serverUrl,
    Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined,
    models.find((m: any) => m.id === modelId)?.root,
    undefined,
    detectedServerType,
  );
  if (!discoveryResult) {
    output.appendLine(`[INFO] Add model stopped - auto-configure returned no result for "${modelId}". The server stays registered.`);
    return;
  }

  // `id` is composite ("<model> on <entry-id>") so the same model on two
  // servers stays distinct; `vllmModelId` remains the raw wire identity.
  // NO createdServerId here on purpose: the entry is step 1's kept artifact,
  // so a dismissed confirm never rolls it back.
  const finalConfig: IdentifiedModelConfig = {
    ...discoveryResult.modelConfig,
    id: replaceExistingId ?? buildModelId(targetServerId, modelId),
    vllmModelId: modelId,
    server: targetServerId,
  };
  if (discoveryResult.suggestedMaxOutputTokens !== undefined && finalConfig.maxOutputTokens === undefined) {
    finalConfig.maxOutputTokens = discoveryResult.suggestedMaxOutputTokens;
  }

  await confirmAndSaveAddedModel(finalConfig, modelId, entry.serverUrl, discoveryResult.summary.join('\n'), output, onSaved, discoveryResult.presetFile);
}
