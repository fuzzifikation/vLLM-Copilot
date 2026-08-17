/**
 * OpenRouter control plane: input parsing, exact-model metadata lookup, and
 * normalization into the fields the extension's config consumes.
 *
 * The ONLY vendor-specific path in the OpenRouter backend. Chat requests and
 * responses flow through the shared OpenAI-compatible data plane; this module
 * exists so onboarding/refresh can resolve a model's runtime limits, capabilities,
 * reasoning modes, defaults, and estimated rates from OpenRouter's exact-model API
 * instead of guessing or fabricating.
 *
 * Verified against the live API (2026-08-17) + official OpenAPI:
 * - `GET /api/v1/model/{author}/{slug}` returns `{ data: { ...model fields... } }`,
 *   unauthenticated. Path segments must be URL-encoded.
 * - `per_request_limits` is null for essentially every catalog model (incl. the
 *   auto router) — the plan's "resolve first" field is a defensive nicety, not the
 *   working path. The real chain is `context_length` → `top_provider.context_length`.
 * - Variant/alias suffixes (`:free`, `:thinking`, `~latest`) 404 on the metadata
 *   endpoint even though the docs claim support; the BASE slug always resolves.
 *   `:free` etc. ARE valid chat ids (free-router responses echo `model: "...:free"`).
 *   => Strip the suffix for the LOOKUP, preserve the full requested id for CHAT.
 * - `pricing.prompt`/`completion` are per-token USD strings; `-1` means unknown
 *   (dynamic routers). Estimated per-1M rates = value × 1e6.
 * - Reasoning is toggled via `reasoning: { enabled, effort }` (Chat Completions).
 */

import { buildEndpoint } from './config.js';
import { fetchWithRetry } from './fetchRetry.js';
import type { RuntimeModelLimits } from './types.js';

/** OpenRouter's API base — composes with `buildEndpoint` like any other server. */
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api';

/** Timeout for the exact-model metadata GET (same budget as other metadata probes). */
const METADATA_TIMEOUT_MS = 10000;

/** Top-level reserved paths on openrouter.ai that are NOT model pages. */
const RESERVED_PATHS = new Set([
  'models', 'docs', 'settings', 'api', 'chat', 'library', 'about',
  'pricing', 'login', 'signup', 'search', 'explore', 'apps', 'rankings',
]);

/** A positive finite number (guards against null / 0 / NaN / strings). */
function isPositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** Round a per-million rate to 6 decimals to kill float noise. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Parse a user-provided model reference into the pieces needed for the metadata
 * lookup, preserving the FULL requested id for chat.
 *
 * Accepted forms:
 * - `author/slug` (e.g. `deepseek/deepseek-chat`)
 * - `author/slug:variant` (e.g. `meta-llama/llama-3.3-70b-instruct:free`)
 * - `~author/family-latest` (family-latest alias form)
 * - `https://openrouter.ai/author/slug[...]` (verified model-page URL — query
 *   strings, fragments, and trailing slashes are ignored)
 *
 * Rejects (with a message, never guessed at): unrelated hosts, reserved paths,
 * malformed values, and anything that isn't exactly `author/slug`.
 *
 * The lookup slug is the variant-stripped BASE slug — variants 404 on the
 * metadata endpoint (verified live). `requestedId` keeps the full input so chat
 * can address the variant the user actually picked.
 */
export function parseOpenRouterModelRef(
  input: string,
): { requestedId: string; author: string; slug: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: 'Model reference is empty.' };

  let author = '';
  let slug = '';
  let requestedId = '';

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { error: `"${trimmed}" is not a valid URL.` };
    }
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'openrouter.ai') {
      return { error: `Only openrouter.ai model-page URLs are accepted, got "${url.hostname}".` };
    }
    const segments = url.pathname.split('/').filter(s => s.length > 0);
    if (segments.length !== 2) {
      return { error: `OpenRouter model pages are /author/slug, got "${url.pathname}".` };
    }
    [author, slug] = segments;
    if (RESERVED_PATHS.has(author.toLowerCase())) {
      return { error: `"${author}" is a reserved openrouter.ai path, not a model author.` };
    }
    // Query strings, fragments, trailing slashes are already excluded by URL parsing.
    requestedId = `${author}/${slug}`;
  } else {
    // Bare slug — strip a leading `~` (family-latest alias form) for the lookup,
    // but keep it in the requested id so chat can address what the user picked.
    // Rebuild the requested id from the parsed segments (NOT the raw input) so
    // stray leading/trailing/double slashes can't poison the chat id.
    const tilde = trimmed.startsWith('~');
    const raw = tilde ? trimmed.slice(1) : trimmed;
    // Trim each segment so a pasted "author / model" (spaces around the slash)
    // doesn't poison the lookup URL with percent-encoded whitespace.
    const segments = raw.split('/').map(s => s.trim()).filter(s => s.length > 0);
    if (segments.length !== 2) {
      return { error: `Expected "author/model" (e.g. "deepseek/deepseek-chat"), got "${trimmed}".` };
    }
    [author, slug] = segments;
    requestedId = `${tilde ? '~' : ''}${segments.join('/')}`;
  }

  // Variant/alias suffixes are NOT part of the metadata lookup — the base slug is.
  const baseSlug = slug.split(':')[0];

  return { requestedId, author, slug: baseSlug };
}

/**
 * The exact-model wire shape (the `data` object returned by
 * `GET /api/v1/model/{author}/{slug}`). Fields are permissive — the API adds
 * fields within `v1`, and unknown optional values are ignored — but only the
 * consumed subset is typed here.
 */
export interface OpenRouterModelData {
  id?: string;
  canonical_slug?: string;
  name?: string;
  context_length?: number | null;
  expiration_date?: string | null;
  architecture?: {
    input_modalities?: string[];
  };
  pricing?: {
    prompt?: string | null;
    completion?: string | null;
    input_cache_read?: string | null;
  };
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
  };
  per_request_limits?: {
    context_tokens?: number | null;
    completion_tokens?: number | null;
  } | null;
  supported_parameters?: string[];
  default_parameters?: Record<string, unknown> | null;
  reasoning?: { mandatory?: boolean } | null;
}

/**
 * The normalized result of an exact-model lookup — only fields the extension's
 * config consumes. There is deliberately no `family`: OpenRouter's
 * `instruct_type` is a chat-template name, not a model family, so the caller's
 * existing family heuristic/preset handles it.
 */
export interface OpenRouterModelInfo {
  /** Full requested model id, preserved verbatim for chat (variants intact). */
  wireModelId: string;
  /** Canonical id from the API (may differ from the requested id). */
  canonicalSlug?: string;
  displayName?: string;
  capabilities: { toolCalling: boolean; imageInput: boolean };
  /** Suggested modelModes derived from reasoning support (user-editable). */
  modelModes?: Record<string, Record<string, unknown>>;
  defaultMode?: string;
  /** OpenRouter-reported generation defaults (filtered to supported params). */
  defaultParams?: Record<string, unknown>;
  /** Estimated per-1M USD rates derived from catalog pricing (estimate only). */
  cost?: {
    input?: number;
    output?: number;
    cachedInput?: number;
    currency?: string;
  };
  runtimeLimits: RuntimeModelLimits;
  expirationDate?: string;
}

/** Convert a per-token USD pricing string to a per-1M rate; `-1`/invalid → undefined. */
function perMillion(rate?: string | null): number | undefined {
  if (typeof rate !== 'string') return undefined;
  // Empty string is malformed — `Number('')` is 0, which would read as "free".
  if (rate.trim() === '') return undefined;
  const n = Number(rate);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return round6(n * 1e6);
}

/** True when the model advertises a capability in `supported_parameters`. */
function supports(data: OpenRouterModelData, param: string): boolean {
  return data.supported_parameters?.includes(param) ?? false;
}

/**
 * Normalize a fetched exact-model payload into extension-config fields.
 * Pure — no I/O — so it is unit-testable in isolation.
 *
 * @throws Error with an actionable message when the model reports NO positive
 *   context bound (strict policy: never fabricate a window, never serve a model
 *   we can't size).
 */
export function normalizeOpenRouterModel(
  data: OpenRouterModelData,
  requestedId: string,
): OpenRouterModelInfo {
  // ── Runtime limits ──
  // Conservative: take the smallest positive reported bound so we never over-claim
  // the window. In practice per_request_limits is null and the chain collapses to
  // min(context_length, top_provider.context_length).
  const contextCandidates = [
    data.per_request_limits?.context_tokens,
    data.context_length,
    data.top_provider?.context_length,
  ].filter(isPositive);
  if (contextCandidates.length === 0) {
    throw new Error(
      `OpenRouter model "${requestedId}" reports no positive context bound ` +
      `(per_request_limits.context_tokens, context_length, top_provider.context_length all absent/invalid). ` +
      `The model may be retired or the slug may be wrong.`
    );
  }
  const contextWindow = Math.min(...contextCandidates);

  // Output ceiling: smallest positive of the reported completion caps, clamped to
  // the context window so output can never exceed what the model can hold.
  const outputCandidates = [
    data.top_provider?.max_completion_tokens,
    data.per_request_limits?.completion_tokens,
    contextWindow,
  ].filter(isPositive);
  const maxOutputTokens = Math.min(...outputCandidates);

  // ── Capabilities ──
  const toolCalling = supports(data, 'tools');
  const imageInput = data.architecture?.input_modalities?.includes('image') ?? false;

  // ── Reasoning modes ──
  // OpenRouter toggles reasoning via `reasoning: { enabled, effort }` (verified
  // against docs + API). When reasoning is mandatory, a "No Think" mode is invalid.
  const reasoningSupported = supports(data, 'reasoning') || supports(data, 'reasoning_effort');
  const reasoningMandatory = data.reasoning?.mandatory === true;
  let modelModes: Record<string, Record<string, unknown>> | undefined;
  let defaultMode: string | undefined;
  if (reasoningSupported) {
    modelModes = {
      'Think (High)': { reasoning: { enabled: true, effort: 'high' } },
    };
    if (!reasoningMandatory) {
      modelModes['No Think'] = { reasoning: { enabled: false } };
    }
    defaultMode = 'Think (High)';
  }

  // ── Default params: only non-null values, only params the model supports ──
  // `default_parameters` comes from the API itself, so `supported_parameters` is
  // authoritative — no whitelist. OpenRouter ignores unknown request params, so
  // the filter is a courtesy, not a compatibility gate.
  let defaultParams: Record<string, unknown> | undefined;
  if (data.default_parameters && typeof data.default_parameters === 'object') {
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data.default_parameters)) {
      if (v === null || v === undefined) continue;
      if (supports(data, k)) {
        filtered[k] = v;
      }
    }
    if (Object.keys(filtered).length > 0) defaultParams = filtered;
  }

  // ── Estimated rates (catalog pricing is an ESTIMATE; usage.cost is authoritative) ──
  const input = perMillion(data.pricing?.prompt);
  const output = perMillion(data.pricing?.completion);
  const cachedInput = perMillion(data.pricing?.input_cache_read);
  const cost = input !== undefined || output !== undefined || cachedInput !== undefined
    ? { input, output, cachedInput, currency: 'USD' as const }
    : undefined;

  return {
    wireModelId: requestedId,
    canonicalSlug: data.canonical_slug ?? data.id,
    displayName: data.name,
    capabilities: { toolCalling, imageInput },
    modelModes,
    defaultMode,
    defaultParams,
    cost,
    runtimeLimits: { contextWindow, maxOutputTokens },
    expirationDate: data.expiration_date || undefined,
  };
}

/**
 * Fetch the exact-model metadata for a requested id and normalize it.
 *
 * @param requestedId - Full model id the user wants (variants preserved for chat).
 * @param requestHeaders - The model's isolated request headers (auth). The exact
 *   endpoint is unauthenticated, but the request may carry optional headers.
 * @returns Normalized model info; throws on network/HTTP/parse failure and when
 *   the model reports no positive context bound.
 */
export async function fetchOpenRouterModel(
  requestedId: string,
  requestHeaders: Record<string, string> = {},
): Promise<OpenRouterModelInfo> {
  const parsed = parseOpenRouterModelRef(requestedId);
  if ('error' in parsed) throw new Error(parsed.error);

  const url = buildEndpoint(
    OPENROUTER_API_BASE,
    `v1/model/${encodeURIComponent(parsed.author)}/${encodeURIComponent(parsed.slug)}`
  );
  let response: Response;
  try {
    response = await fetchWithRetry(
      url,
      { method: 'GET', signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) },
      requestHeaders,
    );
  } catch (err) {
    // Wrap with model context so a failed lookup is actionable, matching the
    // other backends' "model X has no window: GET <url>" convention.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenRouter model "${requestedId}" lookup failed: GET ${url} — ${detail}`);
  }
  const payload = await response.json() as { data?: OpenRouterModelData };
  if (!payload.data || typeof payload.data !== 'object') {
    throw new Error(`OpenRouter exact-model lookup for "${requestedId}" returned no data payload.`);
  }
  return normalizeOpenRouterModel(payload.data, parsed.requestedId);
}

/**
 * Resolve only the runtime limits for an OpenRouter model — the arm the shared
 * `resolveRuntimeLimits` switch will call. Thin wrapper over the full lookup.
 */
export async function resolveOpenRouterRuntimeLimits(
  requestedId: string,
  requestHeaders: Record<string, string> = {},
): Promise<RuntimeModelLimits> {
  const info = await fetchOpenRouterModel(requestedId, requestHeaders);
  return info.runtimeLimits;
}
