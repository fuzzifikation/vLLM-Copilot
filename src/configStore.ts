import * as vscode from 'vscode';
import type { ModelConfig } from './config.js';
import { findModelConfigIndex, normalizeModelEntry, resolveConfigId } from './config.js';

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
 * `serverUrl` and at least one of `id`/`vllmModelId` — the identity the matcher
 * keys on. Requiring identity at the type boundary prevents an accidental
 * append when a caller omits a matching field.
 */
export type IdentifiedModelConfig = ModelConfig
  & { serverUrl: string }
  & ({ id: string } | { vllmModelId: string });

/**
 * Runtime backstop for the type-level identity requirement. Returns the
 * validated config id (a blank `id` falling back to `vllmModelId` is already
 * resolved by the caller via `resolveConfigId`).
 */
function assertValidIdentity(configId: string | undefined, serverUrl: string | undefined): string {
  if (!configId?.trim() || !serverUrl?.trim()) {
    throw new TypeError(
      'Model identity requires a non-blank id (or vllmModelId) and serverUrl; refusing to write a malformed entry.'
    );
  }
  return configId;
}

/**
 * Replace-mode persistence — the single source of truth for the replace contract.
 *
 * Replaces the entire entry for the entry's identity. Model-specific fields
 * (modelModes, family, capabilities, defaultParams, token budgets, transport
 * settings) are overwritten by the replacement; that is the contract. Only
 * infrastructure/personal fields the replacement cannot know survive:
 * `serverUrl` (required identity), `requestHeaders` (when the replacement
 * omits them), and `systemMessageReplacementsFile` (undefined preserves the
 * previous value; `''` clears it via `normalizeModelEntry`).
 *
 * On no match the entry is appended with `id` verbatim — deriving a composite
 * id is the caller's job. Callers' objects are never mutated.
 *
 * This is a pure store operation: it performs no toasts, no cache invalidation,
 * and no BYOK setup. Side effects belong to the callers.
 */
export async function replaceModelConfig(entry: IdentifiedModelConfig): Promise<SaveModelResult> {
  const configId = assertValidIdentity(resolveConfigId(entry), entry.serverUrl);

  const config = vscode.workspace.getConfiguration('vllm-copilot');
  const existing: ModelConfig[] = config.get<ModelConfig[]>('models') || [];
  const useIdx = findModelConfigIndex(existing, configId, entry.serverUrl);

  if (useIdx >= 0) {
    const prev = existing[useIdx];
    const replacementsFile =
      entry.systemMessageReplacementsFile !== undefined
        ? entry.systemMessageReplacementsFile
        : prev.systemMessageReplacementsFile;
    const merged: ModelConfig = {
      ...entry,
      requestHeaders: entry.requestHeaders ?? prev.requestHeaders,
      systemMessageReplacementsFile: replacementsFile,
    };
    const next = existing.slice();
    next[useIdx] = normalizeModelEntry(merged);
    await config.update('models', next, vscode.ConfigurationTarget.Global);
    return { model: next[useIdx], created: false };
  }

  const next = existing.concat(normalizeModelEntry({ ...entry }));
  await config.update('models', next, vscode.ConfigurationTarget.Global);
  return { model: next[next.length - 1], created: true };
}
