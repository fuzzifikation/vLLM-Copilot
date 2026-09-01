/**
 * Server-connection primitives: URL normalization, header sanitization, and the
 * identity fingerprint.
 *
 * Leaf module by design — imports nothing from the project. `serverRegistry.ts`
 * and `config.ts` both build on these; keeping them here is what lets
 * `config.ts` use `resolveServer` from `serverRegistry.ts` without creating an
 * import cycle (the old cycle forced a duplicated resolver in config.ts).
 * `config.ts` re-exports all three for its existing consumers.
 */

/**
 * Ensure the server URL has a valid scheme. If the user types `localhost:8000`
 * instead of `http://localhost:8000`, prepend a scheme so `fetch()` doesn't
 * throw `TypeError: fetch failed` on an invalid URL.
 * Heuristic: if the host includes an explicit port (e.g. `host:8000`) we
 * default to `http://` (likely a raw vLLM server); otherwise `https://`
 * (likely a reverse proxy).
 * Also strip trailing slashes and trailing `/v1` so endpoint joins don't
 * produce `//v1/...` or `/v1/v1/models`. The extension adds `/v1` itself
 * when constructing requests, so a user-provided `/v1` suffix is redundant.
 *
 * A URL with no host (e.g. `http://`) is invalid and returns the localhost
 * default `http://localhost:8000` as a sentinel — this function never throws
 * and never warns. Callers that must distinguish garbage from an actual
 * localhost server (the migration planner) check the host-less shape
 * themselves before normalizing.
 */
export function normalizeServerUrl(url: string): string {
  if (!url) return 'http://localhost:8000';
  let normalized = url.trim();
  if (!normalized) return 'http://localhost:8000';

  // Already has a scheme (URI schemes are case-insensitive). Canonicalize it
  // so all downstream string operations and map keys see one spelling.
  if (!/^https?:\/\//i.test(normalized)) {
    // Missing scheme — detect scheme by whether the host has an explicit port.
    // Has port (e.g. host:8000) → http:// (raw vLLM). No port → https:// (reverse proxy).
    const hostPart = normalized.split(/[\/?]/)[0];
    const scheme = /\:\d+$/.test(hostPart) ? 'http' : 'https';
    normalized = `${scheme}://${normalized}`;
  } else {
    normalized = normalized.replace(/^https?:\/\//i, match => match.toLowerCase());
  }

  // Validate that a host is present (http:// and https:// have no host)
  // by checking that there's at least one character after the scheme that
  // isn't a path separator.
  const schemeMatch = normalized.match(/^(?:https?:)\/\//);
  if (schemeMatch) {
    const afterScheme = normalized.slice(schemeMatch[0].length);
    if (!afterScheme || afterScheme.startsWith('/') || afterScheme.startsWith('?')) {
      // No host — return the invalid-URL sentinel (see doc comment).
      return 'http://localhost:8000';
    }
  }

  // Remove one or more trailing slashes, but keep scheme delimiter intact.
  while (normalized.endsWith('/') && !normalized.endsWith('://')) {
    normalized = normalized.slice(0, -1);
  }

  // Strip a trailing /v1 path segment. Users commonly copy the OpenAI base URL
  // (e.g. https://api.openai.com/v1) but the extension appends /v1 itself.
  if (normalized.endsWith('/v1')) {
    normalized = normalized.slice(0, -3);
  }

  return normalized;
}

/**
 * Sanitize custom HTTP headers by stripping blocked names, invalid characters, and CRLF values.
 *
 * Header names are case-insensitive on the wire (RFC 7230 §3.2), so two entries
 * that differ only in spelling (`authorization` / `Authorization`) are ONE header.
 * The last occurrence wins — the earlier spelling is dropped, so the request (and
 * the identity fingerprint) never carries two spellings of the same header.
 * The surviving spelling is preserved as written.
 */
export function sanitizeRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const blockedHeaders = new Set([
    'host', 'origin', 'cookie', 'connection', 'content-length',
    'transfer-encoding', 'upgrade', 'te', 'trailer',
  ]);
  const headerNameRe = /^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/;
  const sanitized: Record<string, string> = {};
  const spellingByLower = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (blockedHeaders.has(key.toLowerCase())) continue;
    if (!headerNameRe.test(key)) continue;
    if (/\r|\n/.test(value)) continue;
    const lower = key.toLowerCase();
    const previous = spellingByLower.get(lower);
    if (previous !== undefined && previous !== key) delete sanitized[previous];
    spellingByLower.set(lower, key);
    sanitized[key] = value;
  }
  return sanitized;
}

/**
 * Build a deterministic fingerprint for a server identity from its URL and auth
 * headers. Two model configs that point to the same server (same URL + same
 * headers) produce the same fingerprint and are treated as one logical server;
 * models sharing a URL but with different credentials/scopes are DIFFERENT
 * logical servers and must never share a probe, engine, or status.
 *
 * The fingerprint embeds header VALUES — never send it to an untrusted surface
 * (webview DOM, logs). Use `serverGroupKey` (config.ts) for a non-reversible key.
 */
export function serverFingerprint(url: string, headers: Record<string, string>): string {
  // Header names are case-folded before sorting: HTTP names are case-insensitive,
  // so `Authorization` and `authorization` are the same header and must produce
  // the same identity. Values keep their exact bytes (secrets are case-sensitive).
  // Sort lexicographically — NEVER localeCompare: this feeds a
  // server-IDENTITY fingerprint (dashboard grouping, engine registry, Deep-Dive
  // identity). Two machines with different locales must derive the SAME key for
  // the same server, or a model silently moves server groups between machines.
  const sorted = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([url, sorted]);
}
