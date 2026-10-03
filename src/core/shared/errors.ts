/**
 * Neutral error facts: cause-chain traversal, compact error description,
 * the transport-failure text rule, the TLS-certificate pattern rule, and the
 * stream-inactivity timeout marker.
 *
 * These are transport/protocol facts, not editor copy — the user-facing
 * classification (`formatError`, `_classifyMessage`, `TLS_CERT_SUGGESTION`)
 * stays with the host diagnostics that name editor commands and settings.
 */

/**
 * Walk an error's `cause` chain, yielding each cause value in order.
 * Caps traversal depth to guard against cyclic/self-referential chains.
 * Shared by every error classifier in the request pipeline
 * (messageConverter, postStream, streamOrchestrator) — that cross-module
 * reuse pays the export.
 */
export function* iterateCauses(err: unknown, maxDepth = 5): Generator<unknown> {
  let cause = (err as { cause?: unknown } | null | undefined)?.cause;
  let depth = 0;
  while (cause && depth < maxDepth) {
    yield cause;
    cause = (cause as { cause?: unknown }).cause;
    depth++;
  }
}

/**
 * Compact one-line description of an error that unwraps its `cause` chain.
 *
 * Node's global `fetch` (undici) throws `TypeError: fetch failed` and buries the
 * real reason in `err.cause` — e.g. a TLS failure behind a corporate MITM proxy
 * (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `SELF_SIGNED_CERT_IN_CHAIN`), a refused
 * connection (`ECONNREFUSED`), DNS failure (`ENOTFOUND`), or a proxy `407`.
 * Logging only `err.message` hides all of that, so this appends each cause
 * (with its `.code` when present) to keep one-liner log entries diagnosable.
 */
export function describeError(err: unknown): string {
  if (typeof err === 'string') return err;
  if (!(err instanceof Error)) return String(err);

  const format = (e: Error): string => {
    const code = (e as { code?: unknown }).code;
    return `${e.name}: ${e.message}${code ? ` [${String(code)}]` : ''}`;
  };

  const parts = [format(err)];
  for (const cause of iterateCauses(err)) {
    parts.push(cause instanceof Error ? format(cause) : String(cause));
  }
  return parts.join(' ← caused by: ');
}

/**
 * The transport-failure text rule (audit P2-4): the server was never reached.
 * ONE membership check over a flattened error-chain text (name + message +
 * causes, see {@link iterateCauses}) - the orchestrator decides cache
 * invalidation with it and the host's `formatError` chooses the "Cannot
 * connect" copy with it. Two implementations would drift into each other:
 * error copy claiming connectivity while the stale model list survives, or
 * inverse.
 */
export function isTransportFailureText(combinedChainText: string): boolean {
  return combinedChainText.includes('ECONNREFUSED')
    || combinedChainText.includes('fetch failed')
    || combinedChainText.includes('ENOTFOUND');
}

/** Error fragments that indicate a TLS certificate verification failure. */
const TLS_ERROR_PATTERNS = [
  // OpenSSL / undici error codes (uppercase)
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERTIFICATE_VERIFY_FAILED',
  'ERR_CERT',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  // Common human-readable undici/Node messages (lowercase)
  'unable to verify the first certificate',
  'unable to get local issuer certificate',
  'self-signed certificate',
  'self signed certificate',
  'certificate has expired',
];

/** True when an error message indicates a TLS certificate verification failure. */
export function isTlsCertificateError(msg: string): boolean {
  return TLS_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * The single owner of the stream-inactivity marker. Producers (chatTransport's
 * pre-body abort, streamReader's body-race reject) interpolate it; matchers
 * (streamReader's rethrow branch, the host classifier) compare against it. One
 * vocabulary, one owner: an edited literal here used to silently un-wire the
 * classifier from its own timeouts.
 */
export const STREAM_TIMEOUT_PREFIX = 'Stream inactivity timeout';
