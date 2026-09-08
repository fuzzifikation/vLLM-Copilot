/**
 * OpenRouter onboarding branch of Add Server - split out of addServerFlow.ts
 * (2026-09-08, pure move). Imports the shared save tail from addServerCore.ts
 * and knows nothing about the generic vLLM-family wizard.
 */

import * as vscode from 'vscode';
import { buildModelId, normalizeServerUrl } from '../state/config.js';
import type { IdentifiedModelConfig } from '../state/configStore.js';
import { describeError } from '../provider/messageConverter.js';
import { promptForServerAuth } from './serverAuth.js';
import {
  OPENROUTER_API_BASE,
  parseOpenRouterBranchInput,
  normalizeOpenRouterFromCatalog,
  fetchOpenRouterCatalog,
  perMillion,
  formatUsdRate,
  openRouterCatalogConfigFields,
  openRouterInfoDetailLines,
  type OpenRouterModelData,
  type OpenRouterModelInfo,
} from '../backends/openRouter.js';
import {
  confirmAndSaveAddedModel,
  ensureServerEntry,
  handleDuplicateModelGate,
  reportEntryWriteFailure,
  rotateEntryAuth,
  type ClearCacheProvider,
} from './addServerCore.js';

// ── OpenRouter onboarding branch ────────────────────────────────────────────
// OpenRouter's server is a FIXED managed remote (https://openrouter.ai/api),
// reached by host-only routing (isOpenRouterUrl). The flow follows the same
// ordering as every backend: server → key & headers → model pick. A pasted
// model-page URL names the model directly (the typeahead is skipped); anything
// else is PICKED from the ~415-model catalog. Metadata resolves
// UNAUTHENTICATED after the pick, then the model is saved with the fixed API
// base.

/** A single OpenRouter catalog entry (the subset of `/v1/models` the picker shows). */
interface OpenRouterCatalogEntry {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
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
 */
async function pickOpenRouterModel(
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
      // perMillion (openRouter.ts) is the single shared per-token → per-1M
      // conversion; formatting is formatUsdRate. This only lays out compact
      // per-1M "in · out" (the former formatPerMillionUsd wrapper was one
      // call site — audit U8b absorbed it here).
      (() => {
        const fmt = (v?: string): string | null => {
          const per = perMillion(v);
          return per === undefined ? null : `${formatUsdRate(per)}/1M`;
        };
        const inStr = fmt(entry.pricing?.prompt);
        const outStr = fmt(entry.pricing?.completion);
        if (!inStr && !outStr) return '';
        return `in ${inStr ?? '-'} · out ${outStr ?? '-'}`;
      })(),
    ].filter(Boolean).join(' · '),
  }));
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
  qp.title = 'Add OpenRouter Model';
  qp.placeholder = 'Type a model name or id to filter (e.g. nemotron)';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.ignoreFocusOut = true;
  qp.items = items;
  let seededLabel: string | undefined;
  if (prefill) {
    qp.value = prefill;
    const preSelected = items.find((i) => i.label === prefill);
    if (preSelected) {
      qp.activeItems = [preSelected];
      qp.selectedItems = [preSelected];
      seededLabel = preSelected.label;
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
      // The programmatic seed in `selectedItems` goes STALE the moment the
      // user edits the filter: typing updates `activeItems` but never clears
      // the seeded `selectedItems` (CR-49). Once the input diverges from the
      // seeded label, Enter must confirm the HIGHLIGHTED item, not the model
      // the prefill picked thirty keystrokes ago.
      const filterDiverged = seededLabel !== undefined && qp.value !== seededLabel;
      const picked = filterDiverged
        ? qp.activeItems[0] ?? qp.selectedItems[0]
        : qp.selectedItems[0] ?? qp.activeItems[0];
      finish(picked?.label);
    });
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}

/**
 * The OpenRouter onboarding branch of Add Server. The server is fixed
 * (`https://openrouter.ai/api`), so the flow mirrors the vLLM ordering —
 * server URL → API key → model list:
 *
 *   1. Prompt for the API key (+ optional custom headers) — REQUIRED.
 *   2. Pick the model from the catalog typeahead. A pasted model-page URL names
 *      the model directly (the typeahead is skipped and the confirm dialog is
 *      the consent point); a bare API base or author/slug pre-fills the picker.
 *      Reaching the model list means the OpenRouter endpoint is reachable.
 *   3. Resolve exact metadata (limits, caps, pricing, modes).
 *   4. Detect duplicates on the fixed API base (Update Auth / Replace Config).
 *   5. Confirm + save with `serverType: "openrouter"` and the fixed server URL.
 *
 * @param urlInput - Raw step-1 input (pre-normalization, so a model-page URL
 *   survives for direct resolution or picker pre-fill).
 */
export async function runOpenRouterAddFlow(
  output: vscode.OutputChannel,
  provider: ClearCacheProvider,
  urlInput: string,
): Promise<void> {
  const onSaved = () => provider.clearCache();

  // 1. API key (required). Custom headers are NOT prompted — OpenRouter needs no
  //    extra headers for chat; expert headers (e.g. HTTP-Referer for dashboard
  //    attribution) are added by editing the model config in settings.
  const requestHeaders = await promptForServerAuth({
    apiKeyTitle: 'Add OpenRouter Model - API Key',
    apiKeyPrompt: 'OpenRouter API key. Sent as "Authorization: Bearer <key>". Get one at https://openrouter.ai/keys. Chat requires it.',
    apiKeyPlaceholder: 'sk-or-v1-...',
    requireApiKey: true,
    headersTitle: 'Add OpenRouter Model - Custom Headers (optional)',
    headersPrompt: '(optional) Additional request headers (e.g. HTTP-Referer for the OpenRouter dashboard). JSON format or "Name": "Value". Leave empty for none.',
    headersPlaceholder: '{"HTTP-Referer": "https://github.com"}',
    promptForHeaders: false,
  });
  if (requestHeaders === undefined) {
    output.appendLine('[WARN] OpenRouter add cancelled - no API key entered.');
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
    fullCatalog = await fetchOpenRouterCatalog();
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
    // Project the full catalog down to the subset the typeahead renders; the
    // full snapshot stays with the flow for exact-id metadata resolution, so
    // the catalog is fetched exactly once per onboarding.
    const catalog: OpenRouterCatalogEntry[] = fullCatalog.map((entry) => ({
      id: entry.id ?? '',
      name: entry.name,
      context_length: entry.context_length ?? undefined,
      pricing: entry.pricing
        ? { prompt: entry.pricing.prompt ?? undefined, completion: entry.pricing.completion ?? undefined }
        : undefined,
    }));
    requestedId = await pickOpenRouterModel(catalog, prefill);
  }
  if (!requestedId) {
    output.appendLine('[WARN] OpenRouter add cancelled - no model selected.');
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

  // 4. Duplicate detection against the FIXED API base (shared gate with the
  //    vLLM path). Models reference the registry, so "on the OpenRouter server"
  //    resolves through each model's server entry — not a URL field on the model.
  const apiBase = normalizeServerUrl(OPENROUTER_API_BASE); // 'https://openrouter.ai/api'
  const gate = await handleDuplicateModelGate(
    requestedId, apiBase, requestHeaders, 'OpenRouter add', output
  );
  if (!gate) return; // cancelled, or Update Auth took over
  const { replaceExistingId, replaceTargetServer } = gate;

  // 5. Assemble, confirm, save. `id` is composite on the registry entry id so
  //    two OpenRouter models stay distinct; `vllmModelId` is the raw wire id.
  //    The API key + URL live on the `openrouter` registry entry; the model
  //    carries only the `server` reference. On 'Replace Config' the replaced
  //    model KEEPS its entry and the new key rotates into it (Update Auth
  //    doctrine) — a ref derived from the entered key would append a duplicate
  //    instead of replacing. An entry created here is rolled back if the
  //    confirm is abandoned.
  let openRouterServerId: string;
  let createdServerId: string | undefined;
  const replaceServerId = replaceExistingId
    ? await rotateEntryAuth(replaceTargetServer, requestHeaders, output)
    : undefined;
  if (replaceExistingId && !replaceServerId) {
    // The replaced model's entry vanished while the dialogs were open
    // (Remove Server ran elsewhere). Falling through would mint a NEW entry,
    // and replaceModelConfig — matching on (id, server) — would find no match
    // and APPEND a zombie model reusing the replaced model's config id.
    output.appendLine(`[ERROR] OpenRouter replace aborted: server entry "${replaceTargetServer}" no longer exists. Nothing was saved.`);
    void vscode.window.showErrorMessage('vLLM-Copilot: could not replace the existing model: its server entry no longer exists. Nothing was changed; re-run the command to add the model fresh.');
    return;
  }
  if (replaceServerId) {
    openRouterServerId = replaceServerId;
  } else {
    let entry: { id: string; created: boolean };
    try {
      entry = await ensureServerEntry({
        serverUrl: OPENROUTER_API_BASE,
        requestHeaders,
        serverType: 'openrouter',
        preferredId: 'openrouter',
      });
    } catch (err) {
      reportEntryWriteFailure(err, OPENROUTER_API_BASE, output);
      return;
    }
    openRouterServerId = entry.id;
    if (entry.created) createdServerId = entry.id;
  }
  const finalConfig: IdentifiedModelConfig = {
    id: replaceExistingId ?? buildModelId(openRouterServerId, requestedId),
    vllmModelId: requestedId,
    displayName: info.displayName ?? requestedId,
    server: openRouterServerId,
    ...openRouterCatalogConfigFields(info),
  };

  // Confirm-dialog summary: flow-specific head lines, shared detail middle
  // from the backend's projection (audit P8-2 - same lines Auto-Configure shows).
  const summary = [
    `OpenRouter model: ${info.wireModelId}`,
    ...(info.canonicalSlug && info.canonicalSlug !== info.wireModelId ? [`Canonical: ${info.canonicalSlug}`] : []),
    `Context window: ${info.runtimeLimits.contextWindow.toLocaleString('en-US')} tokens`,
    ...openRouterInfoDetailLines(info),
  ].join('\n');
  await confirmAndSaveAddedModel(finalConfig, requestedId, OPENROUTER_API_BASE, summary, output, onSaved, undefined, createdServerId);
}

