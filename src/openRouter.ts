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
import { buildRequestHeaders, fetchWithRetry } from './fetchRetry.js';
import type { RuntimeModelLimits } from './types.js';

/**
 * A context-window resolve failure that retrying can never fix — the model
 * doesn't exist (404), returns no usable metadata, or reports no context bound.
 * The metrics engine classifies this as permanent (never re-probed) without
 * string-matching error text. Thrown by the OpenRouter resolver arms only; the
 * other backends still use plain Errors with marker strings.
 */
export class PermanentContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentContextError';
  }
}

/** OpenRouter's API base — composes with `buildEndpoint` like any other server. */
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api';

/**
 * True when a server URL points at OpenRouter's fixed managed remote. Used to
 * route the Add flow into the OpenRouter branch — the "server" is fixed, so the
 * user's URL input is really a *model* reference — and to classify the backend
 * during detection. Host-only: the API base (`openrouter.ai/api`), model-page
 * URLs, and any future openrouter.ai host all match. Scheme-less input returns
 * false (the Add flow normalizes before calling this).
 */
export function isOpenRouterUrl(serverUrl: string): boolean {
  try {
    return new URL(serverUrl).hostname.replace(/^www\./, '').toLowerCase() === 'openrouter.ai';
  } catch {
    return false;
  }
}

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

/** Title-case a reasoning effort into a mode label, e.g. 'high' → 'Think (High)'. */
function thinkModeLabel(effort: string): string {
  return `Think (${effort[0].toUpperCase()}${effort.slice(1)})`;
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
 * Extract the model reference from an OpenRouter Add-flow URL input. The model
 * is always PICKED from the catalog; this only produces the picker's prefill
 * (and validates the free-text fallback box). A scheme-less OpenRouter base or
 * model-page URL (`openrouter.ai/api`, `openrouter.ai/author/slug`) would
 * mis-parse as a bare slug — detect the `openrouter.ai` host and parse it as a
 * URL instead. Routing is host-only (`isOpenRouterUrl`); this never routes.
 */
export function parseOpenRouterBranchInput(
  input: string,
): { requestedId: string; author: string; slug: string } | { error: string } {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return parseOpenRouterModelRef(trimmed);
  let host: string | null = null;
  try {
    host = new URL(`https://${trimmed}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    host = null;
  }
  if (host === 'openrouter.ai') return parseOpenRouterModelRef(`https://${trimmed}`);
  return parseOpenRouterModelRef(trimmed);
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
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    default_effort?: string | null;
    supported_efforts?: string[] | null;
    supports_max_tokens?: boolean;
  } | null;
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
    throw new PermanentContextError(
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
  // against docs + API). The model's `reasoning` object is richer than a single
  // "supports reasoning" flag: it tells us the exact effort ladder
  // (`supported_efforts`), whether reasoning is on by default, whether it's
  // mandatory, and whether the model takes `max_tokens` instead of `effort`
  // (Anthropic-style). Build real thinking modes from that instead of a
  // hardcoded "Think (High) / No Think" pair.
  const reasoningSupported =
    data.reasoning != null ||
    supports(data, 'reasoning') ||
    supports(data, 'reasoning_effort');
  const reasoningCfg = data.reasoning;
  const reasoningMandatory = reasoningCfg?.mandatory === true;
  const supportsMaxTokens = reasoningCfg?.supports_max_tokens === true;
  let modelModes: Record<string, Record<string, unknown>> | undefined;
  let defaultMode: string | undefined;

  if (reasoningSupported) {
    modelModes = {};

    if (supportsMaxTokens) {
      // Anthropic-style reasoning: the budget is set via `reasoning.max_tokens`,
      // not an effort level, and there's no per-effort mapping. A single "Think"
      // mode (reasoning on) + "No Think" (when disableable) is the honest shape.
      modelModes['Think'] = { reasoning: { enabled: true } };
    } else {
      // Effort ladder from supported_efforts (descending, skipping 'none');
      // fall back to a single 'high' when the API omits the allowlist OR the
      // list is empty / only 'none' (contradictory metadata — treat like missing).
      const ladder = (reasoningCfg?.supported_efforts ?? []).filter((e) => e !== 'none');
      const efforts = ladder.length > 0 ? ladder : ['high'];
      for (const effort of efforts) {
        const label = thinkModeLabel(effort);
        modelModes[label] = { reasoning: { enabled: true, effort } };
      }
    }

    if (!reasoningMandatory) {
      modelModes['No Think'] = { reasoning: { enabled: false } };
    }

    // Default mode: the model's default effort when it maps to a generated mode;
    // 'none'/disabled default → "No Think" (only if it exists — a mandatory-
    // reasoning model has no No Think mode, so fall through to the first mode);
    // otherwise the first (highest) mode.
    const defaultEffort = reasoningCfg?.default_effort;
    const defaultLabel = defaultEffort && defaultEffort !== 'none' ? thinkModeLabel(defaultEffort) : undefined;
    if (defaultLabel && modelModes[defaultLabel]) {
      defaultMode = defaultLabel;
    } else if ((defaultEffort === 'none' || reasoningCfg?.default_enabled === false) && modelModes['No Think']) {
      defaultMode = 'No Think';
    } else {
      defaultMode = Object.keys(modelModes)[0];
    }
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
    // other backends' "model X has no window: GET <url>" convention. A 404 means
    // the slug is wrong/retired — retrying can never fix it, so classify it
    // permanent (the metrics engine must not re-probe it every poll).
    const detail = err instanceof Error ? err.message : String(err);
    const msg = `OpenRouter model "${requestedId}" lookup failed: GET ${url} — ${detail}`;
    if (msg.includes('HTTP 404')) {
      throw new PermanentContextError(msg);
    }
    throw new Error(msg);
  }
  const payload = await response.json() as { data?: OpenRouterModelData };
  if (!payload.data || typeof payload.data !== 'object') {
    throw new PermanentContextError(`OpenRouter exact-model lookup for "${requestedId}" returned no data payload.`);
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

/**
 * OpenRouter account/key health from `GET /api/v1/key` — credits, limits,
 * free-tier status. Used by the dashboard's relay node (Option A account rows).
 * Requires a valid `Authorization` header (same per-model key we already store).
 */
export interface OpenRouterAccount {
  label?: string;
  limit?: number | null;
  limit_remaining?: number | null;
  usage?: number;
  usage_monthly?: number;
  byok_usage?: number;
  is_free_tier?: boolean;
}

/** Timeout for the authenticated account-health probe. */
const ACCOUNT_TIMEOUT_MS = 10_000;

/**
 * Fetch the account/key health for the relay. Returns `undefined` when the
 * request fails or returns no usable `data` (bad/missing key, transient error)
 * — the dashboard degrades by hiding the account rows, never fabricating.
 *
 * Best-effort probe: plain fetch + timeout, NO retry. It runs on every metrics
 * poll (~15s), and `fetchWithRetry`'s 1.5s network-error backoff would add that
 * latency to EVERY tick while /api/v1/key is unreachable — for a value that's
 * optional anyway. Failure → undefined, always.
 */
export async function fetchOpenRouterAccount(
  requestHeaders: Record<string, string> = {},
): Promise<OpenRouterAccount | undefined> {
  const url = buildEndpoint(OPENROUTER_API_BASE, 'v1/key');
  const headers = buildRequestHeaders(undefined, requestHeaders);
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS) });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  try {
    const payload = await response.json() as { data?: OpenRouterAccount };
    // `typeof [] === 'object'` — reject array-shaped data explicitly.
    if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) return undefined;
    return payload.data;
  } catch {
    return undefined;
  }
}
