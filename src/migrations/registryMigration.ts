/**
 * Registry migration planner — the pure core of the forced migration that moves
 * server facts (serverUrl/requestHeaders/serverType/serverDisplayName) off the
 * per-model configs and into the `servers[]` registry.
 *
 * Pure module: no vscode imports, no I/O, no side effects. The caller (activation)
 * owns the settings writes (servers first, then models) and the migration marker.
 */

import {
  isOpenRouterUrl,
  normalizeServerUrl,
  sanitizeRequestHeaders,
  sameHeaders,
} from '../state/config.js';
import {
  type ServerEntry,
  entryMatchesConnection,
  generateServerId,
} from '../state/serverRegistry.js';

/**
 * The pre-migration model shape: server facts inline on the model. This is the
 * ONLY place the legacy fields are named — the migration reads them, and after
 * the sweep nothing else may. `Omit<ModelConfig, ...>` keeps the shared model
 * fields in lockstep with the live type.
 */
import type { ModelConfig, ServerType } from '../state/config.js';

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
  /**
   * Groups that were merged into one entry whose members imply more than one
   * backend protocol. The registry keeps exactly one `serverType` per entry, so
   * one member's protocol wins — the caller must report this, never swallow it.
   */
  conflicts: ServerTypeConflict[];
}

/** One connection whose legacy members disagree about the backend protocol. */
export interface ServerTypeConflict {
  /** Registry entry the group was merged into (created or reused). */
  serverId: string;
  serverUrl: string;
  /** Every model id that joined the group, in migration order. */
  modelIds: string[];
  /** The distinct protocols the members implied — at least one of them loses. */
  protocols: ServerType[];
}

/**
 * Plan the registry migration. Pure function — no I/O, no vscode, no side effects.
 *
 * Groups models by connection: same `normalizeServerUrl(serverUrl)` + equal
 * sanitized headers (a plain comparison, no hashing). One `ServerEntry` per
 * group. Models rewritten to reference entries by id.
 *
 * Rules:
 * - Same URL + different auth → separate entries (credential isolation preserved).
 * - displayName = first non-empty serverDisplayName among group members.
 * - serverType = the group's serverType (first defined value wins). If the group
 *   implies more than one protocol (mixed declared types, or a declared type vs
 *   the default), the entry keeps one and the group is reported in `conflicts`
 *   — a protocol change is never silent.
 * - A model with no usable serverUrl gets no entry — it's listed in `skipped` and
 *   kept verbatim in `models` (the migration never deletes user settings). Junk
 *   that normalizes to the localhost sentinel without a real hostname ("//host",
 *   "/v1", "?x") counts as unusable and is skipped the same way.
 * - No speculative entries: an OpenRouter entry is created only if a model actually
 *   points at the OpenRouter endpoint. `existing` is only ever reused, never added to.
 * - A group whose URL + headers match an `existing` registry entry references that
 *   entry instead of creating a duplicate — this is what makes a retried migration
 *   (servers written, models write failed) converge instead of double-appending.
 * - Generated ids use generateServerId (host + path tail), deduplicated against
 *   `existing` ids as well.
 */
export function planRegistryMigration(models: LegacyModelConfig[], existing: ServerEntry[] = []): MigrationPlan {
  const servers: ServerEntry[] = [];
  const migrated: Array<MigratedModelConfig | LegacyModelConfig> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  /** One record per connection group (same normalized URL + headers), in
   *  first-seen order. Doubles as the protocol-conflict bookkeeping. */
  interface Group {
    normalizedUrl: string;
    /** Sanitized headers of the group's first member — comparison basis. */
    headers: Record<string, string>;
    serverId: string;
    /** True when merged into a pre-existing registry entry (never mutated). */
    reusedExisting: boolean;
    isOpenRouter: boolean;
    modelIds: string[];
    declaredTypes: Set<ServerType>;
    hasTypeless: boolean;
    /** Effective protocol of a REUSED existing entry (undefined for created
     *  groups). The entry is never mutated, so this is what every member of a
     *  reused group will actually speak — it must join the conflict union. */
    reusedType?: ServerType;
  }
  const groups: Group[] = [];
  const takenIds = new Set<string>();
  for (const entry of existing) takenIds.add(entry.id);

  for (const model of models) {
    const { serverUrl, requestHeaders, serverType, serverDisplayName, ...rest } = model;

    if (!serverUrl?.trim()) {
      skipped.push({ id: model.id ?? model.vllmModelId ?? '(unnamed)', reason: 'no serverUrl' });
      migrated.push(model);
      continue;
    }

    if (/^https?:\/\/(?:$|[/?#])/i.test(serverUrl.trim())) {
      // A scheme with no host ("http://") is a half-typed URL. normalizeServerUrl
      // reports it via its localhost:8000 fallback sentinel, which would make the
      // migration silently point the model at a server the user never typed —
      // skip and report instead.
      skipped.push({ id: model.id ?? model.vllmModelId ?? '(unnamed)', reason: `host-less serverUrl "${serverUrl}"` });
      migrated.push(model);
      continue;
    }

    const normalizedUrl = normalizeServerUrl(serverUrl);
    // Garbage that survives the host-less guard above ("//host:8000", "/v1",
    // "?x") gains a bogus scheme from normalizeServerUrl and collapses to its
    // localhost:8000 sentinel — which parses perfectly well, so a URL-parse
    // check alone cannot tell it from a real localhost server. Require BOTH a
    // real hostname in the normalized result AND a non-empty host segment in
    // what the user actually stored; otherwise junk mints a live
    // localhost-8000 registry entry that healthy models silently share.
    let hostname = '';
    try {
      hostname = new URL(normalizedUrl).hostname;
    } catch {
      hostname = '';
    }
    // The authority segment (host[:port]) this raw URL carries before any
    // path/query/fragment — empty exactly when there is no host at all
    // ("//host", "/v1", "?x"). normalizeServerUrl turns every one of those
    // into its localhost:8000 sentinel, so this is what distinguishes junk
    // from a real localhost server the user actually typed.
    const authority = serverUrl.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].trim();
    if (!hostname || !authority) {
      skipped.push({ id: model.id ?? model.vllmModelId ?? '(unnamed)', reason: `unparseable serverUrl "${serverUrl}"` });
      migrated.push(model);
      continue;
    }
    const headers = sanitizeRequestHeaders(requestHeaders ?? {});

    let group = groups.find(
      g => g.normalizedUrl === normalizedUrl && sameHeaders(g.headers, headers),
    );
    if (group && !group.reusedExisting) {
      // Backfill the entry with the group's first non-empty display name and
      // first defined server type, whichever member carries them. Only in-run
      // entries are touched — an existing registry entry is reused as-is.
      const backfillId = group.serverId;
      const entry = servers.find(s => s.id === backfillId)!;
      if (entry.displayName === undefined && serverDisplayName?.trim()) {
        entry.displayName = serverDisplayName.trim();
      }
      if (entry.serverType === undefined && serverType !== undefined) {
        entry.serverType = serverType;
      }
    }
    if (!group) {
      // A group whose connection matches a pre-existing entry reuses that entry
      // instead of creating a duplicate — reuse-only, the entry is never mutated.
      const reused = existing.find(e => entryMatchesConnection(e, normalizedUrl, headers));
      let serverId: string;
      let reusedType: ServerType | undefined;
      if (reused) {
        serverId = reused.id;
        // A reused entry is never mutated, so ITS effective protocol is what
        // every model in this group will speak. Without it in the union, a
        // typeless group (implicitly vllm) bound to an existing 'ollama' entry
        // reported no conflict while silently changing every member's backend.
        reusedType = reused.serverType ?? (isOpenRouterUrl(normalizedUrl) ? 'openrouter' : 'vllm');
      } else {
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
        // Same classifier the runtime uses: any openrouter.ai host is OpenRouter,
        // not just the exact canonical API base the old string equality matched.
        const isOpenRouter = isOpenRouterUrl(normalizedUrl);
        const entry: ServerEntry = { id: serverId, serverUrl: normalizedUrl };
        if (serverDisplayName?.trim()) entry.displayName = serverDisplayName.trim();
        const effectiveType = serverType ?? (isOpenRouter ? 'openrouter' : undefined);
        if (effectiveType !== undefined) entry.serverType = effectiveType;
        if (Object.keys(headers).length > 0) entry.requestHeaders = headers;
        servers.push(entry);
      }
      group = {
        normalizedUrl,
        headers,
        serverId,
        reusedExisting: reused !== undefined,
        isOpenRouter: isOpenRouterUrl(normalizedUrl),
        modelIds: [],
        declaredTypes: new Set<ServerType>(),
        hasTypeless: false,
        reusedType,
      };
      groups.push(group);
    }
    group.modelIds.push(model.id ?? model.vllmModelId ?? '(unnamed)');
    if (serverType === undefined) group.hasTypeless = true;
    else group.declaredTypes.add(serverType);

    migrated.push({ ...rest, server: group.serverId });
  }

  // One entry speaks exactly one protocol. Pre-migration each model declared its
  // own (missing = vllm, OpenRouter URLs classified as openrouter — the same
  // rule the entry creation above uses), so a group whose members imply more
  // than one protocol means at least one model changes backend. Report, never
  // stay silent: the planner has no I/O, so the caller owns the log line.
  const conflicts: ServerTypeConflict[] = [];
  for (const group of groups) {
    const protocols = new Set<ServerType>(group.declaredTypes);
    if (group.hasTypeless) protocols.add(group.isOpenRouter ? 'openrouter' : 'vllm');
    if (group.reusedType !== undefined) protocols.add(group.reusedType);
    if (protocols.size > 1) {
      conflicts.push({
        serverId: group.serverId,
        serverUrl: group.normalizedUrl,
        modelIds: group.modelIds,
        protocols: [...protocols],
      });
    }
  }

  return { servers, models: migrated, skipped, conflicts };
}
