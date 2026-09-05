import * as vscode from 'vscode';
import type { ServerType } from '../state/config.js';
import { buildEndpoint, resolveVllmModelId, resolveConfigId, normalizeServerUrl, buildModelId, toPublicModelConfig, sanitizeRequestHeaders, mergeAuthHeaders, sameHeaders, isOpenRouterUrl, isUsableServerUrl } from '../state/config.js';
import { replaceModelConfig, readModels, readServers, writeServers, type IdentifiedModelConfig } from '../state/configStore.js';
import type { ServerEntry } from '../state/serverRegistry.js';
import { entryMatchesConnection, firstEntryById, generateServerId, resolveServer } from '../state/serverRegistry.js';
import type { VllmModel } from '../types.js';
import { describeError, isTlsCertificateError, TLS_CERT_SUGGESTION } from '../provider/messageConverter.js';
import { detectServerType } from '../backends/runtimeLimits.js';
import { ensureByokUtilityDefault } from './byok.js';
import { promptForServerAuth } from './serverAuth.js';
import { fetchWithTimeout, resolveModelConfigForAddSafely } from './hfDiscovery.js';
import { presetBlobUrl } from './presets.js';
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

/**
 * Minimal provider surface the Add/Configure flows require: the flows only
 * invalidate the model cache after a save. Structural typing avoids importing
 * `VllmChatModelProvider` (which would create a circular runtime import).
 */
export interface ClearCacheProvider {
  clearCache(): void;
}

/**
 * Find-or-create the registry entry for a server connection (normalized URL +
 * auth). Matching is by {@link entryMatchesConnection}: an existing entry with
 * the same URL + headers is reused (its id and label are preserved; a backend
 * type it does not have yet is filled in from `serverType`, never overwritten);
 * otherwise a new entry is appended with a URL-derived id from
 * {@link generateServerId} and the registry is written whole-array.
 *
 * Returns the id the caller puts on the model's `server` field, plus whether
 * THIS call created the entry — callers that can abandon the save must roll
 * back entries they created, never pre-existing ones. Models never carry
 * server facts — URL, auth, type and label live only on the registry.
 * @internal All production callers are inside this module; the export exists
 * for the flow tests only (the auto-configure flow does not import it).
 */
export async function ensureServerEntry(options: {
  serverUrl: string;
  requestHeaders?: Record<string, string>;
  serverType?: ServerType;
  preferredId?: string;
}): Promise<{ id: string; created: boolean }> {
  const normalizedUrl = normalizeServerUrl(options.serverUrl);
  const headers = sanitizeRequestHeaders(options.requestHeaders ?? {});
  const servers = readServers();
  // Scan only the VISIBLE entries (first wins per id, the shared rule next to
  // `resolveServer`): matching a shadowed duplicate would hand the model an id
  // that resolves at runtime to the FIRST entry's credentials, not the ones
  // just matched. `indexOf` (identity, not id) targets the type backfill at
  // exactly the entry found, never an id-twin.
  const visible = [...firstEntryById(servers).values()];
  // Skip entries with no usable URL (CR-51): a blank/host-less `serverUrl`
  // normalizes to the localhost:8000 SENTINEL, so a hand-mangled entry would
  // "match" a genuine http://localhost:8000 connection, the flow would claim
  // the entry exists, point the new model at it — and the runtime resolver
  // would then refuse that very entry. The matcher must apply the same
  // isUsableServerUrl rule the resolver applies.
  const existing = visible.find(s => isUsableServerUrl(s.serverUrl) && entryMatchesConnection(s, normalizedUrl, headers));
  if (existing) {
    // Fill in a MISSING backend type on reuse. "Add Server" registers without
    // probing, so an entry can legitimately arrive type-less; when a model is
    // later added, the detected type must land, or an Ollama/LM Studio server
    // is spoken to as vLLM forever. Writing an unset field is not a change to
    // anything the user declared — an existing `serverType` is never touched.
    if (options.serverType && existing.serverType === undefined) {
      const at = servers.indexOf(existing);
      await writeServers(
        servers.map((s, i) => (i === at ? { ...s, serverType: options.serverType } : s))
      );
    }
    return { id: existing.id, created: false };
  }

  const takenIds = new Set(servers.map(s => s.id));
  const id = options.preferredId && !takenIds.has(options.preferredId)
    ? options.preferredId
    : generateServerId(normalizedUrl, takenIds);
  const newEntry: ServerEntry = {
    id,
    serverUrl: normalizedUrl,
    ...(options.serverType ? { serverType: options.serverType } : {}),
    ...(Object.keys(headers).length > 0 ? { requestHeaders: headers } : {}),
  };
  await writeServers([...servers, newEntry]);
  return { id, created: true };
}

/**
 * Rotate freshly entered credentials into an EXISTING registry entry instead of
 * connection-matching the entered auth into (possibly) a different one.
 *
 * Used by 'Replace Config': the replaced model must keep its `server` ref,
 * because `replaceModelConfig` matches on (`resolveConfigId`, `server`) — a ref
 * derived from the re-entered key would point at a new entry and the store would
 * APPEND a second model with the same id. Credentials belong to the entry (which
 * other models may share), so the new key/headers merge into it exactly like
 * Update Auth does. Returns the entry id to reference, or `undefined` when the
 * entry is gone (caller falls back to {@link ensureServerEntry}).
 */
async function rotateEntryAuth(
  entryId: string | undefined,
  enteredHeaders: Record<string, string>,
  output: vscode.OutputChannel,
): Promise<string | undefined> {
  if (!entryId) return undefined;
  // Resolve through firstEntryById — the registry's first-wins rule, the same
  // resolver every request path uses. servers.find() could grab a shadowed
  // duplicate-id twin and rotate credentials onto an entry that receives no
  // traffic. (The write below deliberately maps ALL same-id twins: until
  // activation repairs a hand-edited duplicate, both twins carry the fresh auth.)
  const entry = firstEntryById(readServers()).get(entryId);
  if (!entry) return undefined;
  const existingHeaders = sanitizeRequestHeaders(entry.requestHeaders ?? {});
  const merged = mergeAuthHeaders(existingHeaders, sanitizeRequestHeaders(enteredHeaders));
  if (merged && !sameHeaders(merged, existingHeaders)) {
    // Re-read at write time so an entry another flow added while this flow's
    // dialogs were open is not stomped by a whole-array write of a stale list.
    await writeServers(readServers().map(s => (s.id === entryId ? { ...s, requestHeaders: merged } : s)));
    // The write happens BEFORE the model confirm (the config to review needs a
    // resolved server), so a later "Copy JSON"/dismiss leaves the rotated
    // credentials in place. That must not be a secret: credentials on a shared
    // entry are a fact about the server, not about the abandoned model.
    output.appendLine(`[INFO] Rotated credentials into server entry "${entryId}" (Replace Config).`);
  }
  return entryId;
}

/**
 * Roll back a registry entry that was created for a model whose confirm was
 * dismissed. An entry no model references is just live credentials parked in
 * global settings with no purpose, so it is removed — but only when genuinely
 * unreferenced, so an entry the flow REUSED (or that another model picked up
 * meanwhile) is left alone. "Copy JSON" does NOT roll back: the copied config
 * references the entry.
 */
async function discardUnreferencedServerEntry(entryId: string | undefined): Promise<void> {
  if (!entryId) return;
  const servers = readServers();
  if (!servers.some(s => s.id === entryId)) return;
  if (readModels().some(m => m.server === entryId)) return;
  await writeServers(servers.filter(s => s.id !== entryId));
}

/**
 * Surface a registry-entry write failure as a real error instead of VS Code's
 * generic "command failed" toast. The write rejects when settings.json cannot
 * be written (e.g. invalid JSON); at that point nothing was created, so there
 * is nothing to roll back — the flow just stops with an honest message.
 */
function reportEntryWriteFailure(err: unknown, targetUrl: string, output: vscode.OutputChannel): void {
  const msg = describeError(err);
  output.appendLine(`[ERROR] Could not register the server entry for ${targetUrl}: ${msg}`);
  void vscode.window.showErrorMessage(
    `vLLM-Copilot: could not register the server entry for ${targetUrl}. ${msg}`
  );
}

/**
 * Duplicate gate shared by both Add flows (vLLM-family and OpenRouter): when
 * the picked wire id already has configs on the target server, disambiguate
 * WHICH one to replace — multiple configs may legitimately share one wire id
 * (e.g. a preset-derived entry beside a discovered composite entry), and
 * replacing the first `.find()` match would silently destroy the wrong config.
 * Then offer Update Auth vs Replace Config. Update Auth delegates to the auth
 * command with the credentials collected earlier in this flow, so the user is
 * never re-prompted for a key they just typed.
 *
 * Returns the replace target (empty object when there is no duplicate), or
 * `undefined` when the caller must stop — cancelled at either dialog, or the
 * Update Auth command took over. On 'Replace Config' the returned identity
 * must be retained downstream: `replaceModelConfig` matches on
 * (`resolveConfigId`, `server`), so a fresh composite id OR a ref re-derived
 * from the entered credentials would append a duplicate instead of replacing.
 */
async function handleDuplicateModelGate(
  wireModelId: string,
  delegateUrl: string,
  requestHeaders: Record<string, string>,
  flowLabel: string,
  output: vscode.OutputChannel,
): Promise<{ replaceExistingId?: string; replaceTargetServer?: string } | undefined> {
  // Read the store HERE, not from the caller's snapshot taken before every
  // dialog and network fetch of the flow (Update Auth / Rename / Remove all
  // re-read for the same reason): a model created by another window mid-flow
  // must reach this gate, not slip past a stale array into an append that
  // duplicates the wire id. `delegateUrl` doubles as the server filter — the
  // duplicate rule is per-server, and both flows pass the normalized URL
  // they duplicate-check against.
  const servers = readServers();
  const sameModelEntries = readModels().filter(
    m =>
      resolveVllmModelId(m) === wireModelId &&
      resolveServer(m.server, servers)?.serverUrl === delegateUrl,
  );
  if (sameModelEntries.length === 0) return {};
  let target = sameModelEntries[0];
  if (sameModelEntries.length > 1) {
    const items: vscode.QuickPickItem[] = sameModelEntries.map(m => ({
      label: m.displayName ?? resolveConfigId(m) ?? '',
      description: resolveConfigId(m),
      detail: `vllmModelId: ${m.vllmModelId ?? m.id}`,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      ignoreFocusOut: true,
      placeHolder: `Multiple configs share "${wireModelId}" - choose which to replace`,
    });
    if (!picked) {
      output.appendLine(`[INFO] ${flowLabel} cancelled - duplicate disambiguation abandoned.`);
      return undefined;
    }
    // Index into the same array the QuickPick was built from - description-string
    // re-lookup would pick the wrong twin when two entries share an id.
    target = sameModelEntries[items.indexOf(picked)] ?? target;
  }
  const pick = await vscode.window.showInformationMessage(
    `"${wireModelId}" is already configured. Update auth only, or replace entire config?`,
    { modal: true },
    'Update Auth',
    'Replace Config',
  );
  if (pick === 'Update Auth') {
    // Reuses updateServerAuth — and hands it the credentials collected earlier
    // in this flow, so the user is never re-prompted for the key they just typed.
    await vscode.commands.executeCommand('vllm-copilot.updateServerAuth', delegateUrl, requestHeaders);
    return undefined;
  }
  if (pick !== 'Replace Config') {
    output.appendLine(`[INFO] ${flowLabel} cancelled - no action chosen for existing config.`);
    return undefined;
  }
  return { replaceExistingId: resolveConfigId(target), replaceTargetServer: target.server };
}

/**
 * Persist a newly added model and ensure the BYOK utility-model default so agent
 * mode works once the model becomes selectable. Only the Add paths reach this
 * (discovered/preset and Keep-Anyway stub) — auto-configure and personality
 * updates must NOT re-run the BYOK write. The BYOK write is awaited AFTER the
 * model write resolves: a failed save never starts the BYOK bootstrap, and the
 * write cannot race the model persistence.
 */
async function persistAddedModelOrRollback(
  finalConfig: IdentifiedModelConfig,
  modelId: string,
  createdServerId: string | undefined,
  onSaved: (() => void) | undefined,
  output: vscode.OutputChannel
): Promise<boolean> {
  try {
    await replaceModelConfig(finalConfig);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.appendLine(`[ERROR] Could not save model "${modelId}" to settings: ${msg}`);
    await discardUnreferencedServerEntry(createdServerId);
    void vscode.window.showErrorMessage(
      `vLLM-Copilot: could not save "${modelId}" to settings.${createdServerId ? ' The newly created server entry was rolled back.' : ''} ${msg}`
    );
    return false;
  }
  // The BYOK bootstrap gets its OWN warn-only catch (CR-31): the model IS saved
  // at this point. Inside one shared try, a bootstrap rejection toasted "save
  // failed", rolled back a server entry the saved model still referenced, and
  // skipped onSaved (the provider cache never cleared).
  try {
    await ensureByokUtilityDefault();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.appendLine(`[WARN] Model "${modelId}" saved, but the BYOK utility-model default was not set: ${msg}`);
  }
  onSaved?.();
  return true;
}

/**
 * Show the final confirm dialog for a newly added model, then save it (or copy
 * its JSON) and offer a window reload. Shared by the preset and HuggingFace
 * branches of the Add flow, and by the auto-configure command's "unconfigured
 * model" branch — both end the same way.
 *
 * Preset fast-path: when `presetFile` is set (the config came from the
 * "Use Preset" dialog), the model is saved IMMEDIATELY and reported via a
 * non-blocking toast. That dialog already captured informed consent — modes,
 * notes, verified date and provenance, modally — so a second "really add?"
 * modal would be a rubber stamp. The toast carries a direct GitHub link to the
 * preset file (click in the notification, or copy it) — that replaces the
 * Copy JSON escape hatch: the user can read the real file instead of our
 * paste of it. HuggingFace/OpenRouter discovery keeps the review-before-save
 * modal: a sniffed config is guesswork and deserves eyes.
 *
 * `createdServerId`: id of a registry entry this flow created for the model. If
 * the confirm is DISMISSED — or the settings write fails after it — the entry is
 * rolled back ({@link discardUnreferencedServerEntry}) so a cancelled or broken
 * add never leaves orphaned credentials in settings. "Copy JSON" keeps it: the
 * copied `server` ref points at that entry.
 * @internal Exported for the auto-configure flow.
 */
export async function confirmAndSaveAddedModel(
  finalConfig: IdentifiedModelConfig,
  modelId: string,
  serverUrl: string,
  detail: string,
  output: vscode.OutputChannel,
  onSaved?: () => void,
  presetFile?: string,
  createdServerId?: string
): Promise<boolean> {
  output.appendLine(`[INFO] Add server ${serverUrl} → ${modelId}:`);
  output.appendLine(detail);
  output.appendLine(`Config: ${JSON.stringify(toPublicModelConfig(finalConfig), null, 2)}`);

  if (presetFile !== undefined) {
    // Informed consent was already given in the modal preset dialog — save now.
    if (!(await persistAddedModelOrRollback(finalConfig, modelId, createdServerId, onSaved, output))) {
      return false;
    }
    const fileLabel = presetFile.startsWith('remote:')
      ? `${presetFile.slice('remote:'.length)} (from vLLM-Copilot/main)`
      : presetFile;
    // GitHub link instead of a Copy JSON button — the source of truth is one
    // click away, and notifications linkify the URL.
    vscode.window.showInformationMessage(
      `Model "${modelId}" added from preset ${fileLabel}. ${presetBlobUrl(presetFile)}`,
    );
    return true;
  }

  const action = await vscode.window.showInformationMessage(
    `Add "${modelId}" from ${serverUrl}?\n\n${detail}`,
    { modal: true },
    'Save to Settings',
    'Copy JSON'
  );

  if (action === 'Save to Settings') {
    if (!(await persistAddedModelOrRollback(finalConfig, modelId, createdServerId, onSaved, output))) {
      return false;
    }
    vscode.window.showInformationMessage(`Model "${modelId}" added.`);
    return true;
  } else if (action === 'Copy JSON') {
    await vscode.env.clipboard.writeText(JSON.stringify(finalConfig, null, 2));
    // An entry this flow created is deliberately KEPT here: the copied config's
    // `server` ref points at it, so rolling it back would hand the user a
    // dangling ref. A zero-model entry is a legal state ("Add Server" creates
    // one on purpose) and Remove Server deletes it again.
    if (createdServerId) {
      output.appendLine(
        `[INFO] Copied config for "${modelId}" - registry entry "${createdServerId}" kept, the copied "server" ref points at it.`
      );
    }
    vscode.window.showInformationMessage('Model config copied to clipboard.');
    return false;
  } else {
    output.appendLine('[INFO] Model add cancelled - confirm dismissed.');
    output.show(true);
    // Dismissed with nothing saved: an entry this flow created would sit in
    // settings unreferenced, holding live credentials nobody asked to keep.
    await discardUnreferencedServerEntry(createdServerId);
    return false;
  }
}

// ── OpenRouter onboarding branch ────────────────────────────────────────────
// OpenRouter's server is a FIXED managed remote (https://openrouter.ai/api),
// reached by host-only routing (isOpenRouterUrl). The flow follows the same
// ordering as every backend: server → key & headers → model pick. The model is
// always PICKED from the ~415-model catalog; a pasted model-page URL only
// pre-fills the picker. Metadata resolves UNAUTHENTICATED after the pick, then
// the model is saved with the fixed API base.

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

/** Human-readable summary lines for the OpenRouter confirm dialog. The flow-
 * specific head lines stay here; the shared detail middle comes from the
 * backend's projection (audit P8-2 — same lines Auto-Configure shows). */
export function buildOpenRouterSummary(info: OpenRouterModelInfo): string {
  const lines: string[] = [];
  lines.push(`OpenRouter model: ${info.wireModelId}`);
  if (info.canonicalSlug && info.canonicalSlug !== info.wireModelId) lines.push(`Canonical: ${info.canonicalSlug}`);
  lines.push(`Context window: ${info.runtimeLimits.contextWindow.toLocaleString('en-US')} tokens`);
  lines.push(...openRouterInfoDetailLines(info));
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

  await confirmAndSaveAddedModel(finalConfig, requestedId, OPENROUTER_API_BASE, buildOpenRouterSummary(info), output, onSaved, undefined, createdServerId);
}

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
      await addModelToServer(context, provider, output, id, id);
    }
  });
}

/**
 * Reject anything `new URL()` can't parse or that has no hostname. Without this,
 * `generateServerId` throws on garbage like "foo bar", and a host-less "http://"
 * silently becomes the localhost:8000 default (normalizeServerUrl's fallback).
 */
export function validateServerUrlInput(value: string): string | undefined {
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
    //    OpenRouter is detected by its host; pasting a full model-page URL only
    //    pre-fills the model picker.
    const urlInput = await vscode.window.showInputBox({
      title: 'Add or Reconfigure Server/Model (1/2)',
      prompt: 'Enter a server URL (vLLM, LM Studio, llama.cpp, Ollama), or an openrouter.ai URL - a model-page URL pre-fills the model picker',
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
    // is then PICKED from the ~415-model catalog; a pasted model-page URL only
    // pre-fills that picker. Runs BEFORE the generic "server already configured"
    // gate, which groups by the raw server URL — a model-page URL would never
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
