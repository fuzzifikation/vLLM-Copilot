import * as vscode from 'vscode';
import type { ModelConfig, ServerType } from '../config.js';
import { buildEndpoint, resolveVllmModelId, resolveConfigId, normalizeServerUrl, buildModelId, toPublicModelConfig } from '../config.js';
import { replaceModelConfig, type IdentifiedModelConfig } from '../configStore.js';
import type { VllmModel } from '../types.js';
import { describeError, isTlsCertificateError, TLS_CERT_SUGGESTION } from '../messageConverter.js';
import { detectServerType } from '../runtimeLimits.js';
import { ensureByokUtilityDefault } from './byok.js';
import { promptForServerAuth } from './serverAuth.js';
import { fetchWithTimeout, resolveModelConfigForAddSafely } from './hfDiscovery.js';
import {
  OPENROUTER_API_BASE,
  parseOpenRouterBranchInput,
  normalizeOpenRouterFromCatalog,
  fetchOpenRouterCatalog as fetchOpenRouterCatalogFull,
  perMillion,
  formatUsdRate,
  formatPerMillionUsd,
  isOpenRouterUrl,
  type OpenRouterModelData,
  type OpenRouterModelInfo,
} from '../openRouter.js';

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
    description: m.max_model_len ? `${m.max_model_len.toLocaleString('en-US')} ctx` : '',
    detail: m.root ? `root: ${m.root}` : '',
  }));
  const selected = await vscode.window.showQuickPick(items, {
    ignoreFocusOut: true,
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
  } else {
    output.appendLine('[INFO] Model add cancelled — confirm dismissed.');
    output.show(true);
  }
  return false;
}

// ── OpenRouter onboarding branch ────────────────────────────────────────────
// OpenRouter's server is a FIXED managed remote (https://openrouter.ai/api),
// reached by host-only routing (isOpenRouterUrl). The flow follows the same
// ordering as every backend: server → key & headers → model pick. The model is
// always PICKED from the ~415-model catalog; a pasted model-page URL only
// pre-fills the picker. Metadata resolves UNAUTHENTICATED after the pick, then
// the model is saved with the fixed API base.

/** A single OpenRouter catalog entry (the subset of `/v1/models` the picker shows). */
export interface OpenRouterCatalogEntry {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

/**
 * Project a full catalog entry down to the subset the typeahead picker renders.
 * The full snapshot is kept by the flow for exact-id metadata resolution, so the
 * catalog is fetched exactly once per onboarding.
 */
export function projectCatalog(full: OpenRouterModelData[]): OpenRouterCatalogEntry[] {
  return full.map((entry) => ({
    id: entry.id ?? '',
    name: entry.name,
    context_length: entry.context_length ?? undefined,
    pricing: entry.pricing
      ? { prompt: entry.pricing.prompt ?? undefined, completion: entry.pricing.completion ?? undefined }
      : undefined,
  }));
}

/** Render a catalog entry's pricing as compact per-1M "in · out", or ''. */
function catalogPricing(entry: OpenRouterCatalogEntry): string {
  // perMillion + formatPerMillionUsd (openRouter.ts) are the single shared
  // per-token → per-1M conversion and en-US formatting; this only lays them out.
  const fmt = (v?: string): string | null => formatPerMillionUsd(perMillion(v));
  const inStr = fmt(entry.pricing?.prompt);
  const outStr = fmt(entry.pricing?.completion);
  if (!inStr && !outStr) return '';
  return `in ${inStr ?? '—'} · out ${outStr ?? '—'}`;
}

/**
 * Model picker for the OpenRouter branch: filter-as-you-type over a catalog
 * snapshot. VS Code's quick pick matches the model id (label) and, via
 * `matchOnDescription` / `matchOnDetail`, the model name and ctx/price detail.
 * Returns the chosen model id, or `undefined` on cancel.
 *
 * The catalog is REQUIRED and authoritative — metadata resolution reuses the
 * SAME snapshot. There is deliberately NO free-text fallback: a model that isn't
 * in the catalog cannot be sized or saved, so the flow fetches the catalog
 * before showing the picker rather than collecting an id it can't confirm.
 * @internal Exported for testing.
 */
export async function pickOpenRouterModel(
  catalog: OpenRouterCatalogEntry[],
  prefill?: string,
): Promise<string | undefined> {
  // Catalog present → filter-as-you-type. A pasted model-page URL pre-fills and
  // PRE-SELECTS the matching item so Enter confirms it directly — VS Code does
  // NOT populate `selectedItems` from a programmatic `.value` (it fills
  // `activeItems`), so relying on selectedItems alone silently cancelled the flow
  // when the user pressed Enter on a prefill. The accept handler falls back to
  // the active item — but NEVER to parsing the typed filter value (no free-text
  // fallback: the catalog stays the authoritative source).
  const items: vscode.QuickPickItem[] = catalog.map((entry) => ({
    label: entry.id,
    description: entry.name ?? '',
    detail: [
      entry.context_length ? `${entry.context_length.toLocaleString('en-US')} ctx` : '',
      catalogPricing(entry),
    ].filter(Boolean).join(' · '),
  }));
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
  qp.title = 'Add OpenRouter Model';
  qp.placeholder = 'Type a model name or id to filter (e.g. nemotron)';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.ignoreFocusOut = true;
  qp.items = items;
  if (prefill) {
    qp.value = prefill;
    const preSelected = items.find((i) => i.label === prefill);
    if (preSelected) {
      qp.activeItems = [preSelected];
      qp.selectedItems = [preSelected];
    }
  }
  // A picked item's label is always a valid wire model id — no re-parsing.
  return await new Promise<string | undefined>((resolve) => {
    // CRITICAL: resolve BEFORE dispose. In real VS Code, disposing a QuickPick
    // fires onDidHide synchronously. If we disposed first, onDidHide's
    // resolve(undefined) would win over the accepted label — the flow would see
    // "cancelled" the moment the user clicked a model. The settled guard makes
    // whichever fires first the single outcome.
    let settled = false;
    const finish = (label: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(label);
      qp.dispose();
    };
    qp.onDidAccept(() => {
      // Only a real catalog item can be accepted. Every pickable label is a
      // projected catalog entry id, so this is inherently catalog-scoped — there
      // is deliberately NO free-text fallback. A typed id that isn't in the
      // snapshot has no active item, so finish(undefined) and the flow exits as
      // "no model selected" (a model outside the catalog cannot be sized/saved).
      const picked = qp.selectedItems[0] ?? qp.activeItems[0];
      finish(picked?.label);
    });
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}

/** Human-readable summary lines for the OpenRouter confirm dialog. */
export function buildOpenRouterSummary(info: OpenRouterModelInfo): string {
  const lines: string[] = [];
  lines.push(`OpenRouter model: ${info.wireModelId}`);
  if (info.canonicalSlug && info.canonicalSlug !== info.wireModelId) lines.push(`Canonical: ${info.canonicalSlug}`);
  lines.push(`Context window: ${info.runtimeLimits.contextWindow.toLocaleString('en-US')} tokens`);
  if (info.runtimeLimits.maxOutputTokens !== undefined) {
    lines.push(`Max output: ${info.runtimeLimits.maxOutputTokens.toLocaleString('en-US')} tokens`);
  }
  lines.push(`Tool calling: ${info.capabilities.toolCalling ? 'yes' : 'no'}`);
  lines.push(`Image input: ${info.capabilities.imageInput ? 'yes' : 'no'}`);
  if (info.modelModes && Object.keys(info.modelModes).length > 0) {
    lines.push(`Modes: ${Object.keys(info.modelModes).join(', ')}`);
    if (info.defaultMode) lines.push(`Default mode: ${info.defaultMode}`);
  }
  if (info.cost) {
    lines.push(`Estimated rates: in ${formatUsdRate(info.cost.input)} · out ${formatUsdRate(info.cost.output)} per 1M tokens`);
  }
  if (info.expirationDate) lines.push(`Expires: ${info.expirationDate}`);
  return lines.join('\n');
}

/**
 * The OpenRouter onboarding branch of Add Server. The server is fixed
 * (`https://openrouter.ai/api`), so the flow mirrors the vLLM ordering —
 * server URL → API key → model list:
 *
 *   1. Prompt for the API key (+ optional custom headers) — REQUIRED.
 *   2. Pick the model from the catalog typeahead — a pasted model-page URL only
 *      pre-fills the picker (the model is never taken from the URL directly).
 *      Reaching the model list means the OpenRouter endpoint is reachable.
 *   3. Resolve exact metadata (limits, caps, pricing, modes).
 *   4. Detect duplicates on the fixed API base (Update Auth / Replace Config).
 *   5. Confirm + save with `serverType: "openrouter"` and the fixed server URL.
 *
 * @param urlInput - Raw step-1 input (pre-normalization, so a model-page URL
 *   survives for pre-filling the picker).
 * @param existingModels - Current `vllm-copilot.models` (for duplicate handling).
 */
export async function runOpenRouterAddFlow(
  output: vscode.OutputChannel,
  provider: ClearCacheProvider,
  urlInput: string,
  existingModels: ModelConfig[],
): Promise<void> {
  const onSaved = () => provider.clearCache();

  // 1. API key (required). Custom headers are NOT prompted — OpenRouter needs no
  //    extra headers for chat; expert headers (e.g. HTTP-Referer for dashboard
  //    attribution) are added by editing the model config in settings.
  const requestHeaders = await promptForServerAuth({
    apiKeyTitle: 'Add OpenRouter Model — API Key',
    apiKeyPrompt: 'OpenRouter API key. Sent as "Authorization: Bearer <key>". Get one at https://openrouter.ai/keys. Chat requires it.',
    apiKeyPlaceholder: 'sk-or-v1-...',
    requireApiKey: true,
    headersTitle: 'Add OpenRouter Model — Custom Headers (optional)',
    headersPrompt: '(optional) Additional request headers (e.g. HTTP-Referer for the OpenRouter dashboard). JSON format or "Name": "Value". Leave empty for none.',
    headersPlaceholder: '{"HTTP-Referer": "https://github.com"}',
    promptForHeaders: false,
  });
  if (requestHeaders === undefined) {
    output.appendLine('[WARN] OpenRouter add cancelled — no API key entered.');
    output.show(true);
    return;
  }

  // 2. Fetch the catalog ONCE and keep the full snapshot. The picker projects it
  //    for typeahead and metadata normalization matches the picked id against the
  //    SAME snapshot — so the ~500KB catalog is downloaded a single time and there
  //    is no selection→confirmation race. The catalog is REQUIRED (metadata is
  //    authoritative): if it can't be loaded, fail here rather than collect an id
  //    that cannot be sized/saved.
  const parsed = parseOpenRouterBranchInput(urlInput);
  const prefill = 'error' in parsed ? undefined : parsed.requestedId;
  // An explicit model-page reference (scheme'd OR scheme-less openrouter.ai URL)
  // names the model directly; a bare /api base or a bare author/slug does not.
  const isExplicitModelUrl = /^(?:https?:\/\/)?(?:www\.)?openrouter\.ai\/[^/]+\/[^/]+/i.test(urlInput.trim());
  let fullCatalog: OpenRouterModelData[];
  try {
    fullCatalog = await fetchOpenRouterCatalogFull();
  } catch (err) {
    const detail = describeError(err);
    output.appendLine(`[ERROR] OpenRouter model catalog unavailable: ${detail}`);
    output.show(true);
    vscode.window.showErrorMessage(`Couldn't load the OpenRouter model catalog. ${detail}`);
    return;
  }
  // A pasted full model-page URL names the model EXPLICITLY — skip the catalog
  // typeahead and go straight to the confirm/save dialog, so the user actively
  // confirms the model instead of it pre-selecting and auto-accepting on Enter.
  // A bare /api base or a bare slug still routes through the picker (typeahead).
  let requestedId: string | undefined;
  if (isExplicitModelUrl && prefill) {
    requestedId = prefill;
    output.appendLine(`[INFO] OpenRouter model-page URL → resolving "${requestedId}" directly (picker skipped).`);
  } else {
    requestedId = await pickOpenRouterModel(projectCatalog(fullCatalog), prefill);
  }
  if (!requestedId) {
    output.appendLine('[WARN] OpenRouter add cancelled — no model selected.');
    output.show(true);
    return;
  }
  output.appendLine(`[INFO] OpenRouter model: ${requestedId}`);

  // 3. Resolve exact metadata from the SAME catalog snapshot (no re-download).
  let info: OpenRouterModelInfo;
  try {
    info = normalizeOpenRouterFromCatalog(fullCatalog, requestedId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.appendLine(`[ERROR] OpenRouter metadata lookup failed: ${detail}`);
    output.show(true);
    vscode.window.showErrorMessage(`OpenRouter model "${requestedId}" lookup failed: ${detail}`);
    return;
  }
  output.appendLine(
    `[INFO] OpenRouter metadata: ${info.runtimeLimits.contextWindow.toLocaleString('en-US')} ctx, ` +
    `max output ${info.runtimeLimits.maxOutputTokens?.toLocaleString('en-US') ?? '?'}, ` +
    `tools ${info.capabilities.toolCalling ? 'yes' : 'no'}`
  );

  // 4. Duplicate detection against the FIXED API base (mirrors the vLLM path).
  const apiBase = normalizeServerUrl(OPENROUTER_API_BASE); // 'https://openrouter.ai/api'
  const existingOpenRouterModels = existingModels.filter(
    (m) => m.serverUrl && normalizeServerUrl(m.serverUrl) === apiBase
  );
  let replaceExistingId: string | undefined;
  const sameModelEntries = existingOpenRouterModels.filter((m) => resolveVllmModelId(m) === requestedId);
  if (sameModelEntries.length > 0) {
    // Multiple configs may share one wire id — disambiguate before replacing.
    let target = sameModelEntries[0];
    if (sameModelEntries.length > 1) {
      const items: vscode.QuickPickItem[] = sameModelEntries.map((m) => ({
        label: m.displayName ?? resolveConfigId(m) ?? '',
        description: resolveConfigId(m),
        detail: `vllmModelId: ${m.vllmModelId ?? m.id}`,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        ignoreFocusOut: true,
        placeHolder: `Multiple configs share "${requestedId}" — choose which to replace`,
      });
      if (!picked) {
        output.appendLine('[INFO] OpenRouter add cancelled — duplicate disambiguation abandoned.');
        return; // cancelled
      }
      target = sameModelEntries.find((m) => resolveConfigId(m) === picked.description) ?? target;
    }
    const pick = await vscode.window.showInformationMessage(
      `"${requestedId}" is already configured. Update auth only, or replace entire config?`,
      { modal: true },
      'Update Auth',
      'Replace Config',
    );
    if (pick === 'Update Auth') {
      // Reuse the headers the user already entered at step 1 — never re-prompt
      // through updateServerAuth (that would discard this key and ask again).
      await vscode.commands.executeCommand('vllm-copilot.updateServerAuth', apiBase, requestHeaders);
      return;
    }
    if (pick !== 'Replace Config') {
      output.appendLine('[INFO] OpenRouter add cancelled — no action chosen for existing config.');
      return; // cancelled
    }
    replaceExistingId = resolveConfigId(target);
  }

  // 5. Assemble, confirm, save. `id` is composite on the fixed host so two
  //    OpenRouter models stay distinct; `vllmModelId` is the raw wire id.
  const finalConfig: IdentifiedModelConfig = {
    id: replaceExistingId ?? buildModelId(OPENROUTER_API_BASE, requestedId),
    vllmModelId: requestedId,
    displayName: info.displayName ?? requestedId,
    serverUrl: OPENROUTER_API_BASE,
    serverType: 'openrouter',
    capabilities: info.capabilities,
    ...(info.modelModes ? { modelModes: info.modelModes } : {}),
    ...(info.defaultMode ? { defaultMode: info.defaultMode } : {}),
    ...(info.defaultParams ? { defaultParams: info.defaultParams } : {}),
    ...(info.cost ? { cost: info.cost } : {}),
    ...(info.runtimeLimits.maxOutputTokens !== undefined ? { maxOutputTokens: info.runtimeLimits.maxOutputTokens } : {}),
    ...(Object.keys(requestHeaders).length > 0 ? { requestHeaders } : {}),
  };

  await confirmAndSaveAddedModel(finalConfig, requestedId, OPENROUTER_API_BASE, buildOpenRouterSummary(info), output, onSaved);
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
  // A certificate-ish failure gets the short suggestion: network test +
  // maybe the setting. One bucket, no deeper classification.
  const tlsDetail = isTlsCertificateError(detail) ? `${detail}\n\n${TLS_CERT_SUGGESTION}` : detail;
  const action = await vscode.window.showWarningMessage(
    `Cannot connect to ${serverUrl}: ${tlsDetail}`,
    { modal: true },
    'Discard',
    'Run Diagnostic',
    'Keep Anyway',
  );

  // Discard or dismissed → stop
  if (action === 'Discard' || action === undefined) {
    output.appendLine(`[INFO] Server ${serverUrl} not added — user discarded the failed connection.`);
    return true;
  }

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
  if (!modelId) {
    output.appendLine(`[INFO] Keep-Anyway cancelled for ${serverUrl} — no model id entered.`);
    return true; // cancelled → stop
  }

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
    // 1. Server URL. This field is a SERVER, always — the model is picked next.
    //    OpenRouter is detected by its host; pasting a full model-page URL only
    //    pre-fills the model picker.
    const urlInput = await vscode.window.showInputBox({
      title: 'Add vLLM Server & Model (1/4)',
      prompt: 'Enter a server URL (vLLM, LM Studio, llama.cpp, Ollama), or an openrouter.ai URL — a model-page URL pre-fills the model picker',
      placeHolder: 'https://host:8000  ·  https://openrouter.ai  ·  https://openrouter.ai/author/model',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Server URL is required'),
    });
    if (!urlInput) {
      output.appendLine('[INFO] Add Server cancelled — no URL entered.');
      return;
    }
    const serverUrl = normalizeServerUrl(urlInput);

    const existingModels: ModelConfig[] = vscode.workspace.getConfiguration('vllm-copilot').get('models') || [];

    // OpenRouter branch — onboarding for the fixed managed remote. The check is
    // exactly the host: `openrouter.ai` → OpenRouter. Everything else is a normal
    // server (the Add Server field is a SERVER — never a model name). The model
    // is then PICKED from the ~415-model catalog; a pasted model-page URL only
    // pre-fills that picker. Runs BEFORE the generic "server already configured"
    // gate, which groups by the raw server URL — a model-page URL would never
    // match the fixed API base; the branch performs its own duplicate handling
    // against it.
    if (isOpenRouterUrl(serverUrl)) {
      await runOpenRouterAddFlow(output, provider, urlInput, existingModels);
      return;
    }

    // Check if this server already exists
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
      if (pick !== 'Add Different Model') {
        output.appendLine(`[INFO] Add Server cancelled — server ${serverUrl} already configured.`);
        return; // cancelled
      }
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
    if (requestHeaders === undefined) {
      output.appendLine('[INFO] Add Server cancelled — no API key/headers entered.');
      return;
    }
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
      output.appendLine(`[WARN] No models found on ${serverUrl}.`);
      vscode.window.showInformationMessage(`No models found on ${serverUrl}.`);
      return;
    }

    const modelId = await pickModelFromServer(models, serverUrl, 'Add vLLM Server & Model (4/4)');
    if (!modelId) {
      output.appendLine(`[INFO] Add Server cancelled — no model selected on ${serverUrl}.`);
      return;
    }

    // Detect the backend type by probing its documented signatures. Add Server
    // ONLY — never at runtime (runtime uses the persisted serverType switch).
    let detectedServerType: ServerType;
    try {
      detectedServerType = await detectServerType(serverUrl, hasHeaders ? requestHeaders : {}, modelId);
      output.appendLine(`[INFO] Server type detected: ${detectedServerType}`);
    } catch (err) {
      output.appendLine(`[ERROR] Unsupported server: ${describeError(err)}`);
      output.show(true);
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
          ignoreFocusOut: true,
          placeHolder: `Multiple configs share "${modelId}" — choose which to replace`,
        });
        if (!picked) {
          output.appendLine(`[INFO] Add Server cancelled — duplicate disambiguation abandoned.`);
          return; // cancelled
        }
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
      if (pick !== 'Replace Config') {
        output.appendLine(`[INFO] Add Server cancelled — no action chosen for existing config on ${serverUrl}.`);
        return; // cancelled
      }
      replaceExistingId = resolveConfigId(target);
    }

    const discoveryResult = await resolveModelConfigForAddSafely(
      output, context, modelId, serverUrl, hasHeaders ? requestHeaders : undefined,
      models.find((m: any) => m.id === modelId)?.root,
      undefined,
      detectedServerType,
    );
    if (!discoveryResult) {
      output.appendLine(`[INFO] Add Server stopped — auto-configure returned no result for "${modelId}".`);
      return;
    }

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
