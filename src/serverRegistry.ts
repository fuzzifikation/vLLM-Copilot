/**
 * Server registry — the single place a server lives.
 * Models reference entries by id; all server facts (URL, auth, type, label) live here.
 * Pure module: no vscode imports, no side effects.
 */

import { type ServerType, normalizeServerUrl, sanitizeRequestHeaders, serverFingerprint } from './config.js';

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
  serverType: ServerType;                 // entry value, 'vllm' when omitted
  displayName?: string;
}

/**
 * Resolve a server id to the effective connection facts for a model.
 * Returns `undefined` when the id is not registered.
 */
export function resolveServer(serverId: string, servers: ServerEntry[]): EffectiveServer | undefined {
  const entry = servers.find(s => s.id === serverId);
  if (!entry) return undefined;
  return {
    serverUrl: normalizeServerUrl(entry.serverUrl),
    requestHeaders: sanitizeRequestHeaders(entry.requestHeaders ?? {}),
    serverType: entry.serverType ?? 'vllm',
    ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
  };
}

/**
 * Build an id → entry map for O(1) lookup by callers that resolve many models.
 */
export function indexServers(servers: ServerEntry[]): Map<string, ServerEntry> {
  return new Map(servers.map(s => [s.id, s]));
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
 * Strip credentials for webview state — mirrors `toPublicModelConfig(config, { strip: true })`.
 */
export function toPublicServerEntry(entry: ServerEntry): Omit<ServerEntry, 'requestHeaders'> {
  const { requestHeaders: _requestHeaders, ...rest } = entry;
  return rest;
}

/**
 * Identity key for a registry entry: normalized URL + sanitized headers.
 * Two entries with the same fingerprint are the same server connection.
 */
export function serverEntryFingerprint(entry: ServerEntry): string {
  return serverFingerprint(
    normalizeServerUrl(entry.serverUrl),
    sanitizeRequestHeaders(entry.requestHeaders ?? {}),
  );
}
