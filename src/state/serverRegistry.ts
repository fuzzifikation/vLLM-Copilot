/**
 * Server registry — the single place a server lives.
 * Models reference entries by id; all server facts (URL, auth, type, label) live here.
 * Pure module: no vscode imports, no side effects.
 */

import { isUsableServerUrl, normalizeServerUrl, sanitizeRequestHeaders, sameHeaders, KNOWN_SERVER_TYPES, type ServerType } from './serverCore.js';

/** A registered server. The only place server facts live. */
export interface ServerEntry {
  /** Unique, user-facing identifier. The reference target for models. */
  id: string;
  /** User label. Rename Server writes here. */
  displayName?: string;
  /** Backend type. Missing = 'vllm'. */
  serverType?: ServerType;
  /** The server URL. Normalized on write. */
  serverUrl: string;
  /** Credentials / custom headers. Sanitized on write. */
  requestHeaders?: Record<string, string>;
}

/** Resolved server — what a model actually connects to. */
export interface EffectiveServer {
  serverUrl: string;                      // normalized
  requestHeaders: Record<string, string>; // sanitized
  /** Entry value when it names a KNOWN_SERVER_TYPE; 'vllm' for omitted,
   *  blank, and anything a hand-edit smuggled past the type system. */
  serverType: ServerType;
  displayName?: string;
}

/**
 * Normalization choke point for the backend type (CR-39). The declared value
 * comes from hand-editable JSON, so the `ServerType` annotation is a lie until
 * proven against the runtime list. Anything unknown resolves as vLLM — which is
 * what validateConfig's warning PROMISES ("requests fall back to vLLM
 * behavior") and what the chat body builder's `serverType !== 'vllm'` strip
 * implements. Without this, a typo'd type flowed verbatim into the limits
 * resolver and the model died with a bare TypeError at discovery.
 */
function normalizeServerType(declared: ServerType | undefined): ServerType {
  return declared && KNOWN_SERVER_TYPES.includes(declared) ? declared : 'vllm';
}

/**
 * Resolve a server id to the effective connection facts for a model.
 * Returns `undefined` when the id is not registered OR the entry carries no
 * usable URL — a blank/hand-mangled `serverUrl` normalizes to the
 * localhost:8000 sentinel, and resolving it would silently send the entry's
 * headers (credentials included) to a machine the user never named. Such an
 * entry is unreachable on purpose; `validateConfig` reports it. See
 * `isUsableServerUrl` in serverCore.ts.
 */
export function resolveServer(serverId: string, servers: ServerEntry[]): EffectiveServer | undefined {
  const entry = servers.find(s => s.id === serverId);
  if (!entry || !isUsableServerUrl(entry.serverUrl)) return undefined;
  return {
    serverUrl: normalizeServerUrl(entry.serverUrl),
    requestHeaders: sanitizeRequestHeaders(entry.requestHeaders ?? {}),
    serverType: normalizeServerType(entry.serverType),
    ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
  };
}

/**
 * Collapse a registry list to one entry per id, FIRST occurrence winning —
 * the exact rule {@link resolveServer}'s `servers.find` applies per lookup.
 * Consumers that iterate the whole registry (dashboard nodes, Model Settings
 * groups, add-flow connection scans) must go through here so a hand-edited
 * duplicate id can never show or address a shadowed entry that no request
 * ever reaches. Insertion order (settings array order) is preserved.
 * `validateConfig` reports the duplicate itself.
 */
export function firstEntryById(servers: readonly ServerEntry[]): Map<string, ServerEntry> {
  const out = new Map<string, ServerEntry>();
  for (const entry of servers) {
    if (!out.has(entry.id)) out.set(entry.id, entry);
  }
  return out;
}

/** One duplicate-id repair performed by {@link dedupeServerIds}. */
export interface ServerIdRename {
  /** The id as found — shared by several entries. */
  from: string;
  /** The unique id assigned to the shadowed entry. */
  to: string;
}

/**
 * Repair duplicate server ids. The extension MINTS these ids
 * ({@link generateServerId}), so a collision only exists after a hand-edit —
 * and a shadowed entry is dead config: invisible in every view, unaddressable
 * by every command, while models referencing the id silently reach the FIRST
 * entry. Rather than tolerate that, the registry is normalized: the first
 * occurrence keeps its id (exactly what `resolveServer` already resolves to,
 * so no model's routing changes), every later entry with a taken id gets the
 * same counter rule {@link generateServerId} uses (`id-2`, `id-3`, ... checked
 * against the full taken set, so a rename can never collide either) and
 * becomes visible and addressable. Entries with a missing (empty) id are left
 * untouched — that is `validateConfig`'s "missing its id" report, not an
 * identity collision, and models cannot reference an absent id.
 *
 * Pure: returns a repaired copy plus the renames for user reporting. No
 * duplicate ids → same content, empty renames.
 */
export function dedupeServerIds(servers: readonly ServerEntry[]): {
  servers: ServerEntry[];
  renames: ServerIdRename[];
} {
  const taken = new Set(servers.map(s => s.id));
  const seen = new Set<string>();
  const renames: ServerIdRename[] = [];
  const out = servers.map(entry => {
    if (!entry.id) return entry;
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      return entry;
    }
    const to = dedupe(entry.id, taken);
    taken.add(to);
    renames.push({ from: entry.id, to });
    return { ...entry, id: to };
  });
  return { servers: out, renames };
}

/**
 * Generate a human-readable, URL-derived server id.
 * Slug = host + path tail (last path segment only), lowercased, non-alphanumeric
 * collapsed to single `-`, leading/trailing `-` stripped. OpenRouter hosts always
 * slug to `openrouter`. Collisions with `existingIds` get a numeric suffix
 * (`-2`, `-3`, ...).
 */
export function generateServerId(serverUrl: string, existingIds: Set<string>): string {
  const normalized = normalizeServerUrl(serverUrl);
  const parsed = new URL(normalized);
  const host = parsed.hostname.toLowerCase();
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) {
    return dedupe('openrouter', existingIds);
  }
  // Include the port in the slug when present (host with port, e.g. localhost:8000).
  const hostWithPort = parsed.port ? `${host}-${parsed.port}` : host;
  // Path tail: last non-empty segment keeps the slug short on deep gateway paths.
  const segments = parsed.pathname.split('/').filter(Boolean);
  const tail = segments.length > 0 ? `-${segments[segments.length - 1]}` : '';
  const slug = `${hostWithPort}${tail}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return dedupe(slug || 'server', existingIds);
}

/** Append `-2`, `-3`, ... until the id is free. */
function dedupe(slug: string, existingIds: Set<string>): string {
  if (!existingIds.has(slug)) return slug;
  let n = 2;
  while (existingIds.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

/**
 * Does this entry describe the given connection (normalized URL + sanitized
 * headers)? Plain field comparison, no hashing, no derived identity: entry IDS
 * are the identity, and this answers only the write-time question "is this
 * URL+auth already registered" (add-flow find-or-create, migration grouping,
 * the redundancy warning).
 *
 * @param normalizedUrl - result of normalizeServerUrl (already canonical)
 * @param sanitizedHeaders - result of sanitizeRequestHeaders (one spelling per name)
 */
export function entryMatchesConnection(
  entry: ServerEntry,
  normalizedUrl: string,
  sanitizedHeaders: Record<string, string>,
): boolean {
  return (
    normalizeServerUrl(entry.serverUrl) === normalizedUrl &&
    sameHeaders(sanitizeRequestHeaders(entry.requestHeaders ?? {}), sanitizedHeaders)
  );
}
