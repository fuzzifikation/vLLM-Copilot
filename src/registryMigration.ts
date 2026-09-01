/**
 * Registry migration planner — the pure core of the forced migration that moves
 * server facts (serverUrl/requestHeaders/serverType/serverDisplayName) off the
 * per-model configs and into the `servers[]` registry (docs/server-registry.md §6).
 *
 * Pure module: no vscode imports, no I/O, no side effects. The caller (activation)
 * owns snapshotting, ordering the settings writes (servers first, then models),
 * and setting the migration marker.
 */

import {
  normalizeServerUrl,
  sanitizeRequestHeaders,
  serverFingerprint,
} from './config.js';
import { OPENROUTER_API_BASE } from './openRouter.js';
import {
  type ServerEntry,
  generateServerId,
  serverEntryFingerprint,
} from './serverRegistry.js';

/**
 * The pre-migration model shape: server facts inline on the model. This is the
 * ONLY place the legacy fields are named — the migration reads them, and after
 * the sweep nothing else may. `Omit<ModelConfig, ...>` keeps the shared model
 * fields in lockstep with the live type.
 */
import type { ModelConfig, ServerType } from './config.js';

export type LegacyModelConfig = Omit<ModelConfig, 'server'> & {
  serverUrl?: string;
  requestHeaders?: Record<string, string>;
  serverType?: ServerType;
  serverDisplayName?: string;
};

/** A model config after migration — inline server fields replaced by a ref. */
export type MigratedModelConfig = Omit<LegacyModelConfig, 'serverUrl' | 'requestHeaders' | 'serverType' | 'serverDisplayName'> & {
  /** Reference to the `ServerEntry.id` this model connects through. */
  server: string;
};

/** Result of planning the registry migration. */
export interface MigrationPlan {
  /** New servers array to write. */
  servers: ServerEntry[];
  /**
   * Models array to write, in original order: migrated entries carry a `server`
   * ref; models with no usable `serverUrl` are kept **verbatim** (no `server`) so
   * the migration never silently deletes user settings. Consumers narrow on
   * `'server' in m`.
   */
  models: Array<MigratedModelConfig | LegacyModelConfig>;
  /** Models kept verbatim because they could not be migrated (no usable serverUrl). */
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Plan the registry migration. Pure function — no I/O, no vscode, no side effects.
 *
 * Groups models by `serverFingerprint(normalizeServerUrl(serverUrl), sanitizedHeaders)`.
 * One `ServerEntry` per group. Models rewritten to reference entries by id.
 *
 * Rules:
 * - Same URL + different auth → separate entries (credential isolation preserved).
 * - displayName = first non-empty serverDisplayName among group members.
 * - serverType = the group's serverType (first defined value wins).
 * - A model with no usable serverUrl gets no entry — it's listed in `skipped` and
 *   kept verbatim in `models` (the migration never deletes user settings).
 * - No speculative entries: an OpenRouter entry is created only if a model actually
 *   points at the OpenRouter endpoint. `existing` is only ever reused, never added to.
 * - A group whose fingerprint matches an `existing` registry entry references that
 *   entry instead of creating a duplicate — this is what makes a retried migration
 *   (servers written, models write failed) converge instead of double-appending.
 * - Generated ids use generateServerId (host + path tail), deduplicated against
 *   `existing` ids as well.
 */
export function planRegistryMigration(models: LegacyModelConfig[], existing: ServerEntry[] = []): MigrationPlan {
  const servers: ServerEntry[] = [];
  const migrated: Array<MigratedModelConfig | LegacyModelConfig> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  /** fingerprint → entry id, so every member of a group resolves to its entry in O(1). */
  const entryIdByFingerprint = new Map<string, string>();
  /** fingerprint → id for the untouched pre-existing registry; reuse-only. */
  const existingIdByFingerprint = new Map<string, string>();
  const takenIds = new Set<string>();
  for (const entry of existing) {
    takenIds.add(entry.id);
    const fp = serverEntryFingerprint(entry);
    if (!existingIdByFingerprint.has(fp)) existingIdByFingerprint.set(fp, entry.id);
  }

  for (const model of models) {
    const { serverUrl, requestHeaders, serverType, serverDisplayName, ...rest } = model;

    if (!serverUrl?.trim()) {
      skipped.push({ id: model.id ?? model.vllmModelId ?? '(unnamed)', reason: 'no serverUrl' });
      migrated.push(model);
      continue;
    }

    const normalizedUrl = normalizeServerUrl(serverUrl);
    const headers = sanitizeRequestHeaders(requestHeaders ?? {});
    const fingerprint = serverFingerprint(normalizedUrl, headers);

    let serverId = entryIdByFingerprint.get(fingerprint) ?? existingIdByFingerprint.get(fingerprint);
    if (serverId === undefined) {
      // An unparseable URL survives normalizeServerUrl only to die in
      // generateServerId's `new URL`. Never let one garbage entry abort the
      // whole one-shot migration (§6: unusable models are skipped + reported).
      try {
        serverId = generateServerId(normalizedUrl, takenIds);
      } catch {
        skipped.push({ id: model.id ?? model.vllmModelId ?? '(unnamed)', reason: `unparseable serverUrl "${serverUrl}"` });
        migrated.push(model);
        continue;
      }
      takenIds.add(serverId);
      entryIdByFingerprint.set(fingerprint, serverId);

      const isOpenRouter = normalizeServerUrl(OPENROUTER_API_BASE) === normalizedUrl;
      const entry: ServerEntry = { id: serverId, serverUrl: normalizedUrl };
      if (serverDisplayName?.trim()) entry.displayName = serverDisplayName.trim();
      const effectiveType = serverType ?? (isOpenRouter ? 'openrouter' : undefined);
      if (effectiveType !== undefined) entry.serverType = effectiveType;
      if (Object.keys(headers).length > 0) entry.requestHeaders = headers;
      servers.push(entry);
    } else if (entryIdByFingerprint.has(fingerprint)) {
      // Backfill the entry with the group's first non-empty display name and
      // first defined server type, whichever member carries them. Only in-run
      // entries are touched — an existing registry entry is reused as-is.
      const entry = servers.find(s => s.id === serverId)!;
      if (entry.displayName === undefined && serverDisplayName?.trim()) {
        entry.displayName = serverDisplayName.trim();
      }
      if (entry.serverType === undefined && serverType !== undefined) {
        entry.serverType = serverType;
      }
    }

    migrated.push({ ...rest, server: serverId });
  }

  return { servers, models: migrated, skipped };
}
