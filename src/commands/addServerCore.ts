/**
 * Add-flow core - the shared save tail of every model-adding path.
 *
 * Registry entry bookkeeping (find-or-create, auth rotation, rollback of
 * unreferenced entries), the duplicate gate, and the confirm/save pipeline.
 * Shared by the generic Add wizard (addServerFlow.ts), the OpenRouter
 * onboarding branch (openRouterAddFlow.ts), and the auto-configure command
 * (autoConfigureFlow.ts). One-way dependency: the flows import this core,
 * never the other way. Extracted from addServerFlow.ts (2026-09-08, pure move).
 */

import * as vscode from 'vscode';
import type { ServerType } from '../state/config.js';
import { normalizeServerUrl, sanitizeRequestHeaders, mergeAuthHeaders, sameHeaders, isUsableServerUrl, resolveVllmModelId, resolveConfigId, toPublicModelConfig } from '../state/config.js';
import { replaceModelConfig, readModels, readServers, writeServers, type IdentifiedModelConfig } from '../state/configStore.js';
import type { ServerEntry } from '../state/serverRegistry.js';
import { entryMatchesConnection, firstEntryById, generateServerId, resolveServer } from '../state/serverRegistry.js';
import { describeError } from '../provider/messageConverter.js';
import { ensureByokUtilityDefault } from './byok.js';
import { presetBlobUrl } from './presets.js';

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
 * Exported for the add flows (generic wizard, OpenRouter branch) and the flow
 * tests.
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
export async function rotateEntryAuth(
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
export async function discardUnreferencedServerEntry(entryId: string | undefined): Promise<void> {
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
export function reportEntryWriteFailure(err: unknown, targetUrl: string, output: vscode.OutputChannel): void {
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
export async function handleDuplicateModelGate(
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
export async function persistAddedModelOrRollback(
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
 * Exported for the add flows (generic wizard, OpenRouter branch) and the
 * auto-configure command.
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

