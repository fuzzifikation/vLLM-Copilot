/**
 * Server-connection primitives: URL normalization, header sanitization, and
 * header-map equality.
 *
 * Leaf module by design — imports nothing from the project. `serverRegistry.ts`
 * and `config.ts` both build on these; keeping them here is what lets
 * `config.ts` use `resolveServer` from `serverRegistry.ts` without creating an
 * import cycle (the old cycle forced a duplicated resolver in config.ts).
 * `config.ts` re-exports these for its existing consumers.
 *
 * Server IDENTITY is the registry entry id — nothing here derives or hashes an
 * identity. "Same connection" questions (add-flow find-or-create, migration
 * grouping, the redundancy warning) answer it by comparing the normalized URL
 * and `sameHeaders`, which is exactly what this module provides.
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

  // Canonicalize the authority: hostnames are case-insensitive (RFC 4343) and
  // a scheme's default port is the same origin as no port, so `EXAMPLE.com`,
  // `example.com` and `example.com:80` must be ONE identity for fingerprints,
  // registry entries and dashboard pollers — not three entries and three
  // pollers for one server. Userinfo (`user:pass@`, when present) keeps its
  // exact bytes: credentials are case-sensitive. The scheme is already
  // lowercased at this point, and host presence is validated above.
  normalized = normalized.replace(/^(https?:\/\/)([^/?#]*)/, (_m, scheme: string, authority: string) => {
    const at = authority.lastIndexOf('@');
    const userinfo = at >= 0 ? authority.slice(0, at + 1) : '';
    let host = authority.slice(at + 1).toLowerCase();
    host = scheme === 'http://' ? host.replace(/:80$/, '') : host.replace(/:443$/, '');
    return scheme + userinfo + host;
  });

  // Remove one or more trailing slashes, but keep scheme delimiter intact.
  while (normalized.endsWith('/') && !normalized.endsWith('://')) {
    normalized = normalized.slice(0, -1);
  }

  // Strip trailing /v1 path segments. Users commonly copy the OpenAI base URL
  // (e.g. https://api.openai.com/v1) but the extension appends /v1 itself.
  // Repeated and case-insensitive: every read re-normalizes (resolveServer,
  // entryMatchesConnection), so the old single-shot strip was NOT idempotent
  // ('.../v1/v1' stored as '.../v1', effective '...' — stored value and
  // effective URL disagreeing, which defeats connection matching on the next
  // add) and a capitalized '/V1' was never stripped at all.
  normalized = normalized.replace(/(?:\/v1)+$/i, '');

  return normalized;
}

/**
 * Is this stored registry-entry URL a usable connection target? The extension
 * mints registry URLs normalized, but settings.json is hand-editable: a blank
 * value or a host-less shape ("http://", "//host", "/v1", "?x") normalizes to
 * the localhost:8000 sentinel (see {@link normalizeServerUrl}), and resolving
 * it would silently route the entry's request headers — credentials included
 * — to whatever local process squats on that port. The migration planner
 * checks this shape itself; the runtime resolver and validateConfig answer
 * through this one rule instead, so garbage fails loudly (unresolvable entry +
 * validation warning) instead of silently misrouting.
 *
 * A real host is required: the authority segment (host[:port]) before any
 * path/query/fragment must be non-empty once the scheme is removed.
 */
export function isUsableServerUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const authority = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].trim();
  return authority !== '';
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
 * Connection equality of two header maps: same headers with same values.
 * Names are compared case-INSENSITIVELY (RFC 7230 — `Authorization` and
 * `authorization` are ONE header on the wire, whatever spelling each map
 * happens to store); values are compared byte-exactly. Intended for
 * sanitized maps (see {@link sanitizeRequestHeaders}); unsanitized maps with
 * two spellings of one name collapse exactly like they do on the wire.
 */
export function sameHeaders(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const fold = (m: Record<string, string>): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [k, v] of Object.entries(m)) out.set(k.toLowerCase(), v);
    return out;
  };
  const fa = fold(a);
  const fb = fold(b);
  if (fa.size !== fb.size) return false;
  for (const [k, v] of fa) {
    if (!fb.has(k) || fb.get(k) !== v) return false;
  }
  return true;
}

/**
 * True when a server URL points at OpenRouter's fixed managed remote. Used to
 * route the Add flow into the OpenRouter branch — the "server" is fixed, so the
 * user's URL input is really a *model* reference — and to classify the backend
 * during detection and the forced migration. Host-only: the API base
 * (`openrouter.ai/api`), model-page URLs, and any future openrouter.ai host all
 * match. Scheme-less input returns false (the Add flow normalizes before
 * calling this).
 *
 * Division of labor (audit P16-3): the declarative `serverType` field is the
 * SOLE runtime truth — every request-path consumer (resolver arm, request
 * builder, metrics) dispatches on it. This host predicate is a detection and
 * migration concern: classifying raw user URL input that has no entry (yet),
 * and filling the key-prompt defaults in Update Auth. Never branch runtime
 * behavior on it.
 */
export function isOpenRouterUrl(serverUrl: string): boolean {
  try {
    return new URL(serverUrl).hostname.replace(/^www\./, '').toLowerCase() === 'openrouter.ai';
  } catch {
    return false;
  }
}


