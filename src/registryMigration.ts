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
  type ModelConfig,
  normalizeServerUrl,
  sanitizeRequestHeaders,
  serverFingerprint,
} from './config.js';
import { OPENROUTER_API_BASE } from './openRouter.js';
import {
  type ServerEntry,
  generateServerId,
} from './serverRegistry.js';

/** A model config after migration — inline server fields replaced by a ref. */
export type MigratedModelConfig = Omit<ModelConfig, 'serverUrl' | 'requestHeaders' | 'serverType' | 'serverDisplayName'> & {
  /** Reference to the `ServerEntry.id` this model connects through. */
  server: string;
};

/** Result of planning the registry migration. */
export interface MigrationPlan {
  /** New servers array to write. */
  servers: ServerEntry[];
  /** Rewritten models array with `server` refs replacing inline server fields. */
  models: MigratedModelConfig[];
  /** Models that could not be migrated (no usable serverUrl). */
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
 * - A model with no usable serverUrl gets no entry — it's listed in `skipped`.
 * - No speculative entries: an OpenRouter entry is created only if a model actually
 *   points at the OpenRouter endpoint.
 * - Generated ids use generateServerId (host + path tail), deduplicated.
 */
export function planRegistryMigration(models: ModelConfig[]): MigrationPlan {
  const servers: ServerEntry[] = [];
  const migrated: MigratedModelConfig[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  /** fingerprint → entry id, so every member of a group resolves to its entry in O(1). */
  const entryIdByFingerprint = new Map<string, string>();
  const takenIds = new Set<string>();

  for (const model of models) {
    const { serverUrl, requestHeaders, serverType, serverDisplayName, ...rest } = model;

    if (!serverUrl?.trim()) {
      skipped.push({ id: model.id ?? model.vllmModelId ?? '(unnamed)', reason: 'no serverUrl' });
      continue;
    }

    const normalizedUrl = normalizeServerUrl(serverUrl);
    const headers = sanitizeRequestHeaders(requestHeaders ?? {});
    const fingerprint = serverFingerprint(normalizedUrl, headers);

    let serverId = entryIdByFingerprint.get(fingerprint);
    if (serverId === undefined) {
      serverId = generateServerId(normalizedUrl, takenIds);
      takenIds.add(serverId);
      entryIdByFingerprint.set(fingerprint, serverId);

      const isOpenRouter = normalizeServerUrl(OPENROUTER_API_BASE) === normalizedUrl;
      const entry: ServerEntry = { id: serverId, serverUrl: normalizedUrl };
      if (serverDisplayName?.trim()) entry.displayName = serverDisplayName.trim();
      const effectiveType = serverType ?? (isOpenRouter ? 'openrouter' : undefined);
      if (effectiveType !== undefined) entry.serverType = effectiveType;
      if (Object.keys(headers).length > 0) entry.requestHeaders = headers;
      servers.push(entry);
    } else {
      // Backfill the entry with the group's first non-empty display name and
      // first defined server type, whichever member carries them.
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
