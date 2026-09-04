import * as vscode from 'vscode';
import type { ModelConfig } from './config.js';
import { findModelConfigIndex, normalizeModelEntry, resolveConfigId } from './config.js';
import type { ServerEntry } from './serverRegistry.js';

/**
 * Read the raw `vllm-copilot.models` array exactly as stored.
 *
 * Nothing here normalizes entries — callers that need effective values go through
 * `getConfig` / `resolveServerConfig`. `config.ts` reads the section itself instead
 * of calling here, to avoid a config ↔ configStore import cycle.
 */
export function readModels(): ModelConfig[] {
  // Shape guard, not just `|| []`: a hand-edited object/number instead of an
  // array, or a `null` element, would otherwise reach consumers verbatim
  // (`entry.id` on null) and can crash activation before the provider is
  // registered. Garbage fails as discarded entries, never as a corpse.
  const raw = vscode.workspace.getConfiguration('vllm-copilot').get<unknown>('models');
  return Array.isArray(raw) ? raw.filter((e): e is ModelConfig => !!e && typeof e === 'object') : [];
}

/**
 * The ONLY writer of the `vllm-copilot.models` setting, and always whole-array: the
 * setting is one array item, so there is no per-entry update. Callers read with
 * {@link readModels}, map over it, and hand back the complete new array.
 *
 * Errors propagate on purpose — a caller that must not report success after a failed
 * write depends on the rejection reaching it.
 *
 * This is the single home for write semantics: the server-registry migration needs
 * servers-before-models ordering plus "set the completion marker only after every
 * write succeeded" (the rule `outputLengthMigration` already follows), and one place
 * to put both.
 */
export async function writeModels(models: ModelConfig[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('vllm-copilot');
  await config.update('models', models, vscode.ConfigurationTarget.Global);
}

/**
 * Read the raw `vllm-copilot.servers` array exactly as stored ([] when unset).
 * Counterpart of {@link readModels} for the server registry.
 */
export function readServers(): ServerEntry[] {
  // Same shape guard as {@link readModels}: `|| []` catches absent/null but
  // NOT `{}` or `[null]`, and this value feeds the activation dedupe block
  // OUTSIDE any inner try — one hand-typed `{` must not kill every window.
  const raw = vscode.workspace.getConfiguration('vllm-copilot').get<unknown>('servers');
  return Array.isArray(raw) ? raw.filter((e): e is ServerEntry => !!e && typeof e === 'object') : [];
}

/**
 * The ONLY writer of the `vllm-copilot.servers` setting, whole-array like
 * {@link writeModels}. The registry migration relies on the same error
 * propagation so it can defer its completion marker until every write succeeded.
 */
export async function writeServers(servers: ServerEntry[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('vllm-copilot');
  await config.update('servers', servers, vscode.ConfigurationTarget.Global);
}

/**
 * Result of a store write. `model` is the entry exactly as persisted.
 */
export interface SaveModelResult {
  model: ModelConfig;
  /** True when the write appended a new entry rather than replacing an existing one. */
  created: boolean;
}

/**
 * A full model entry for the replace operation: it must carry a non-blank
 * `id` (required) and a `server` ref — the identity the matcher keys on.
 * Requiring identity at the type boundary prevents an accidental append when a
 * caller omits a matching field.
 */
export type IdentifiedModelConfig = ModelConfig & { id: string; server: string };

/**
 * Runtime backstop for the type-level identity requirement. Returns the
 * validated config id.
 */
function assertValidIdentity(configId: string | undefined, server: string | undefined): string {
  if (!configId?.trim() || !server?.trim()) {
    throw new TypeError(
      'Model identity requires a non-blank id and a server ref; refusing to write a malformed entry.'
    );
  }
  return configId;
}

/**
 * Replace-mode persistence — the single source of truth for the replace contract.
 *
 * Replaces the entire entry for the entry's identity. Model-specific fields
 * (modelModes, family, capabilities, defaultParams, token budgets, transport
 * settings) are overwritten by the replacement; that is the contract. The only
 * infrastructure field the replacement cannot know that survives is
 * `systemMessageReplacementsFile` (undefined preserves the previous value; `''`
 * clears it via `normalizeModelEntry`). Server facts (URL, auth, type, label)
 * live on the registry entry the model references — never on the model — so
 * there is nothing server-shaped to preserve here.
 *
 * On no match the entry is appended with `id` verbatim. Callers' objects are
 * never mutated. Top-level undefined-valued fields are stripped before the
 * write. Nested undefined values are left untouched — they are inert.
 *
 * This is a pure store operation: it performs no toasts, no cache invalidation,
 * and no BYOK setup. Side effects belong to the callers.
 */
export async function replaceModelConfig(entry: IdentifiedModelConfig): Promise<SaveModelResult> {
  const clean = stripUndefined(entry as unknown as Record<string, unknown>) as unknown as IdentifiedModelConfig;
  const configId = assertValidIdentity(resolveConfigId(clean), clean.server);

  const existing = readModels();
  const useIdx = findModelConfigIndex(existing, configId, clean.server);

  if (useIdx >= 0) {
    const prev = existing[useIdx];
    const replacementsFile =
      clean.systemMessageReplacementsFile !== undefined
        ? clean.systemMessageReplacementsFile
        : prev.systemMessageReplacementsFile;
    const merged: ModelConfig = {
      ...clean,
      systemMessageReplacementsFile: replacementsFile,
    };
    const next = existing.slice();
    next[useIdx] = normalizeModelEntry(merged);
    await writeModels(next);
    return { model: next[useIdx], created: false };
  }

  const next = existing.concat(normalizeModelEntry({ ...clean }));
  await writeModels(next);
  return { model: next[next.length - 1], created: true };
}

/**
 * Immutable identity used by the patch operation. `id` and `server` are the
 * lookup keys the webview keys everything by; they are NOT patchable properties.
 */
export interface ModelIdentity {
  id: string;
  server: string;
}

/**
 * Remove TOP-LEVEL keys whose value is `undefined`. Used by patch and replace
 * modes so an explicit `{ key: undefined }` cannot overwrite a stored value
 * (JSON has no undefined; a future caller could still pass one). Nested
 * undefined values are left untouched deliberately — they are inert (reads and
 * JSON serialization treat absent and undefined identically), and there is no
 * caller-facing rule for what a nested undefined should mean (e.g. a header
 * value). Identity keys are excluded by the type boundaries (`Omit` in patch,
 * required identity in replace).
 */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Patch-mode persistence — a shallow field-level merge, the webview's contract.
 *
 * `identity.id`/`identity.server` are the immutable lookup keys. Fields
 * present in `updates` overwrite the existing entry; fields absent are
 * preserved (family, defaults, transport settings all survive — the
 * reverse of replace-mode). `''` clears `systemMessageReplacementsFile` via
 * `normalizeModelEntry`. Top-level undefined-valued keys in `updates` are
 * stripped before the merge, so a `{ displayName: undefined }` patch cannot
 * wipe the stored value; nested undefined values are left untouched (inert —
 * see `stripUndefined`) (hardening — the webview never sends undefined today).
 *
 * On no match a new entry is created under `identity` verbatim — identity is
 * always complete (`id` + `server`), so appending means exactly "a new model
 * on a known server". `wireId = updates.vllmModelId || identity.id`. Callers'
 * objects are never mutated.
 *
 * Pure store operation: no toasts, no cache invalidation, no refresh — the
 * handler owns those side effects.
 */
export async function patchModelConfig(
  identity: ModelIdentity,
  updates: Omit<Partial<ModelConfig>, 'id' | 'server'>
): Promise<SaveModelResult> {
  const configId = assertValidIdentity(identity.id, identity.server);
  const clean = stripUndefined(updates as Record<string, unknown>);
  // Runtime backstop for the Omit type boundary: identity is immutable, so even
  // a caller that smuggles id/server into updates must not move them. The
  // matcher already keyed on identity; the merge must not then overwrite it.
  delete clean.id;
  delete clean.server;

  const existing = readModels();
  const useIdx = findModelConfigIndex(existing, configId, identity.server);

  if (useIdx >= 0) {
    const next = existing.slice();
    next[useIdx] = normalizeModelEntry({ ...existing[useIdx], ...clean } as ModelConfig);
    await writeModels(next);
    return { model: next[useIdx], created: false };
  }

  const wireId = updates.vllmModelId || configId;
  const entry = normalizeModelEntry({
    ...(clean as unknown as ModelConfig),
    vllmModelId: wireId,
    id: configId,
    server: identity.server,
  });
  const next = existing.concat(entry);
  await writeModels(next);
  return { model: entry, created: true };
}
