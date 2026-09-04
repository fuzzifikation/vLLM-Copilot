/**
 * OpenRouter control plane: input parsing, model-catalog metadata resolution,
 * and normalization into the fields the extension's config consumes.
 *
 * The ONLY vendor-specific path in the OpenRouter backend. Chat requests and
 * responses flow through the shared OpenAI-compatible data plane; this module
 * exists so onboarding/refresh can resolve a model's runtime limits, capabilities,
 * reasoning modes, defaults, and estimated rates deterministically from
 * OpenRouter's MODEL CATALOG instead of guessing or fabricating.
 *
 * Verified against the live API (2026-08-17) + official OpenAPI:
 * - Metadata is resolved from `GET /api/v1/models` — the authoritative catalog.
 *   Every model VARIANT is its own entry keyed by its exact `id` (e.g.
 *   `author/slug:free` and `author/slug` are separate entries with separate
 *   metadata). Matching the requested id verbatim therefore guarantees a
 *   `:free` pick resolves to the free entry, never the paid model. NO slug
 *   derivation, NO fallback, NO guessing.
 * - The exact-model endpoint (`/api/v1/model/{author}/{slug}`) is deliberately
 *   NOT used: it resolves variants inconsistently (some `:free` variants 404),
 *   and deriving a lookup slug could resolve a DIFFERENT model than the one the
 *   user picked — silently charging them for a model they didn't choose.
 * - `per_request_limits` is null for essentially every catalog model (incl. the
 *   auto router) — the plan's "resolve first" field is a defensive nicety, not the
 *   working path. The real chain is `context_length` → `top_provider.context_length`.
 * - A model absent from the CURRENT catalog snapshot throws
 *   `OpenRouterModelNotFoundError`. The metrics engine treats this as "not yet
 *   resolved" and rechecks on the next poll (the catalog is already re-fetched),
 *   while a catalog entry that reports no context bound throws
 *   `PermanentContextError` (never retried).
 * - `pricing.prompt`/`completion` are per-token USD strings; `-1` means unknown
 *   (dynamic routers). Estimated per-1M rates = value × 1e6.
 * - Reasoning is toggled via `reasoning: { enabled, effort }` (Chat Completions).
 */

import { buildEndpoint } from '../state/config.js';
import type { ModelConfig } from '../state/config.js';
import { buildRequestHeaders, fetchWithRetry } from '../shared/fetchRetry.js';
import type { RuntimeModelLimits } from '../types.js';

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

/**
 * The requested model id is absent from the CURRENT catalog snapshot. Unlike
 * `PermanentContextError` (an entry exists but is unusable — never retried),
 * this means the id wasn't in this particular `/v1/models` response. The catalog
 * is re-fetched every poll, so a metrics engine treats this as "recheck next
 * tick" rather than caching a permanent miss — a transiently incomplete catalog
 * or propagation delay must not permanently disable context for a model.
 */
export class OpenRouterModelNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterModelNotFoundError';
  }
}

/** OpenRouter's API base — composes with `buildEndpoint` like any other server. */
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api';

/** Timeout for the catalog metadata GET (same budget as other metadata probes). */
const METADATA_TIMEOUT_MS = 10000;

/**
 * Fallback output ceiling when a catalog model reports NO completion cap
 * (`top_provider.max_completion_tokens` / `per_request_limits.completion_tokens`
 * absent or invalid — null for essentially every catalog model): 10% of the
 * context window, hard-capped.
 *
 * The old fallback was the FULL context window, which guaranteed
 * output + input > context on the first real request — OpenRouter 400s with
 * "...1048575 in the output" because output is reserved against the SAME window
 * as the prompt. 10% keeps enough headroom for the prompt.
 *
 * Mirrors `OUTPUT_TOKEN_FACTOR` / `OUTPUT_TOKEN_CAP` in `commands/hfDiscovery.ts`
 * (same convention). Kept local — NOT imported — because importing the commands
 * module here would create a cycle (`hfDiscovery` → `runtimeLimits` → `openRouter`).
 * If either factor changes, update both.
 */
const OUTPUT_TOKEN_FACTOR = 0.1;
const OUTPUT_TOKEN_CAP = 81920;

/** Top-level reserved paths on openrouter.ai that are NOT model pages. */
const RESERVED_PATHS = new Set([
  'models', 'docs', 'settings', 'api', 'chat', 'library', 'about',
  'pricing', 'login', 'signup', 'search', 'explore', 'apps', 'rankings',
]);

/** A positive finite number (guards against null / 0 / NaN / strings). */
function isPositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
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
 * `requestedId` keeps the full input so chat can address the variant the user
 * actually picked. Metadata resolution does NOT derive a lookup slug from this
 * — it matches `requestedId` verbatim against the model catalog, so a `:free`
 * pick can never resolve to the paid model (they are separate catalog entries).
 */
function parseOpenRouterModelRef(
  input: string,
): { requestedId: string } | { error: string } {
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
    // Bare slug. A leading `~` (family-latest alias form) is PARSED but also
    // KEPT in the requested id — the catalog carries the tilde as part of the
    // id itself, and normalizeOpenRouterFromCatalog matches `requestedId`
    // VERBATIM (CR-56: there is deliberately no strip-for-lookup step; making
    // the code match the old comment would break tilde resolution).
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

  // `requestedId` is the exact catalog id used for CHAT and for the metadata
  // lookup (matched verbatim against the catalog — no slug derivation). The
  // `author`/`slug` segments above are internal parsing detail; only
  // `requestedId` is exposed (nothing downstream consumes the split).
  return { requestedId };
}

/**
 * Extract the model reference from an OpenRouter Add-flow URL input. The model
 * is always PICKED from the catalog; this only produces the picker's prefill. A
 * scheme-less OpenRouter base or model-page URL (`openrouter.ai/api`,
 * `openrouter.ai/author/slug`) would mis-parse as a bare slug — detect the
 * `openrouter.ai` host and parse it as a URL instead. Routing is host-only
 * (`isOpenRouterUrl`); this never routes.
 */
export function parseOpenRouterBranchInput(
  input: string,
): { requestedId: string } | { error: string } {
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
 * A single catalog entry's wire shape (each element of the `data` array from
 * `GET /api/v1/models`). Fields are permissive — the API adds fields within
 * `v1`, and unknown optional values are ignored — but only the consumed
 * subset is typed here.
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
 * The normalized result of a catalog resolution — only fields the extension's
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

/**
 * Single per-token → per-1M USD conversion. `-1` (unknown, dynamic routers) and
 * malformed values → undefined. Shared authority: the normalized model's
 * `cost` block and the onboarding picker's `$X/1M` display both convert through
 * this, so the two surfaces cannot drift on what a price string means.
 */
export function perMillion(rate?: string | null): number | undefined {
  if (typeof rate !== 'string') return undefined;
  // Empty string is malformed — `Number('')` is 0, which would read as "free".
  if (rate.trim() === '') return undefined;
  const n = Number(rate);
  if (!Number.isFinite(n) || n < 0) return undefined;
  // Scale to per-1M, rounded to 6 decimals to kill float noise.
  return Math.round(n * 1e12) / 1e6;
}

/**
 * Locale-independent per-1M USD rate display. Forces `en-US` so a price ALWAYS
 * uses `.` as the decimal separator (`$0.66`) regardless of the user's OS
 * locale — a `$` amount rendered with a comma decimal (`$0,66`, de-DE) reads as
 * a different number and is confusing next to a dollar sign. `undefined` → "-".
 *
 * Single shared formatter: the onboarding picker, the confirm dialog, and the
 * dashboard pricing rows all render through this, so money never drifts across
 * surfaces.
 */
export function formatUsdRate(value?: number): string {
  return value === undefined ? '-' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
}

/** True when the model advertises a capability in `supported_parameters`. */
function supports(data: OpenRouterModelData, param: string): boolean {
  return data.supported_parameters?.includes(param) ?? false;
}

/**
 * Normalize a single catalog entry into extension-config fields.
 * Pure — no I/O — so it is unit-testable in isolation.
 *
 * @throws Error with an actionable message when the model reports NO positive
 *   context bound (strict policy: never fabricate a window, never serve a model
 *   we can't size).
 */
function normalizeOpenRouterModel(
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

  // Output ceiling: the smallest positive reported completion cap, but ONLY when
  // it leaves real input headroom. A cap at/near the window degenerates to
  // "output = whole window", which 400s on the first real request — output is
  // reserved against the SAME window as the prompt, so any nonzero input pushes
  // prompt + output over the limit (the exact failure the 10% fallback exists to
  // prevent; live catalog: ~12% of models report max_completion_tokens >= the
  // window). Degenerate caps (>= 90% of the window) carry no safety information
  // → fall back to the same 10%-of-window safe budget as the no-cap case.
  // Genuine caps that leave >= 10% of the window for input (e.g. 384k on a 1M
  // window) are preserved verbatim — never over-restricted.
  const safeOutputBudget = Math.min(
    Math.floor(contextWindow * OUTPUT_TOKEN_FACTOR),
    OUTPUT_TOKEN_CAP,
  );
  const reportedOutputCaps = [
    data.top_provider?.max_completion_tokens,
    data.per_request_limits?.completion_tokens,
  ].filter(isPositive);
  const trustedOutputCaps = reportedOutputCaps.filter(
    (cap) => cap < contextWindow * (1 - OUTPUT_TOKEN_FACTOR),
  );
  const maxOutputTokens = trustedOutputCaps.length > 0
    ? Math.min(...trustedOutputCaps)
    : safeOutputBudget;

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
      // Effort ladder from supported_efforts (API ships no order — the
      // highest-effort defaultMode fallback below relies on catalog ordering,
      // which is a contract this module does not get); skipping 'none'. Elements
      // are validated, not trusted: an empty-string or null entry would turn
      // thinkModeLabel's `effort[0].toUpperCase()` into a TypeError, which the
      // metrics engine files under TRANSIENT — the model would then be retried
      // forever in silence instead of reported (CR-55). Fall back to a single
      // 'high' when the API omits the allowlist OR the usable list is empty.
      const ladder = (reasoningCfg?.supported_efforts ?? []).filter(
        (e): e is string => typeof e === 'string' && e !== '' && e !== 'none'
      );
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
 * The OpenRouter catalog boundary (audit P16-2): a catalog payload is valid
 * only when it carries a `data` ARRAY; entries without a string `id` are
 * dropped (they can never match an exact id, and keeping them would
 * misreport them as "model not found"). Returns `undefined` for any other
 * shape — a protocol/proxy failure, never an empty model list. Shared with
 * the metrics engine's parse so the two views of one response can never
 * drift (this rule used to be sync'd by comment).
 *
 * Generic so each consumer keeps its own entry type (`OpenRouterModelData`
 * for lookups, plain records for the metrics raw view) without casts.
 */
export function parseOpenRouterCatalogData<T = OpenRouterModelData>(payload: unknown): T[] | undefined {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    return undefined;
  }
  return data.filter((m): m is T =>
    !!m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string');
}

/**
 * In-flight + short-TTL memo for the catalog (audit P16-1). The catalog is
 * ~500 KB for ~400 models; before the memo, discovery resolved EVERY
 * configured OpenRouter model with a fresh full download. The metrics engine
 * never hits this path (its tick reuses one raw response), and the catalog
 * changes on OpenRouter's scale (hours), so a minute of staleness is free.
 * Failures are never cached — the next call re-fetches live.
 */
const CATALOG_MEMO_TTL_MS = 60_000;

let catalogMemo: { promise: Promise<OpenRouterModelData[]>; settledAt?: number } | undefined;

/**
 * Fetch OpenRouter's full model catalog (`GET /api/v1/models`) — the
 * authoritative, deterministic source for model metadata. Every model VARIANT is
 * its own entry keyed by its exact `id`, so exact-id matching never conflates a
 * `:free` pick with the paid model. This is what metadata resolution matches
 * against — never a derived slug.
 *
 * The payload is validated by {@link parseOpenRouterCatalogData}: a `200`
 * whose body is not `{ data: [...] }` THROWS, it is never treated as an empty
 * authoritative catalog.
 *
 * Public and unauthenticated. Throws on HTTP/network failure and on malformed
 * payloads; `fetchWithRetry` retries transient failures once. Served from the
 * memo above while fresh.
 */
export async function fetchOpenRouterCatalog(): Promise<OpenRouterModelData[]> {
  if (catalogMemo && (catalogMemo.settledAt === undefined || Date.now() - catalogMemo.settledAt < CATALOG_MEMO_TTL_MS)) {
    return catalogMemo.promise;
  }
  const entry: { promise: Promise<OpenRouterModelData[]>; settledAt?: number } =
    { promise: undefined as unknown as Promise<OpenRouterModelData[]> };
  entry.promise = fetchCatalogUncached().then(
    (catalog) => {
      entry.settledAt = Date.now();
      return catalog;
    },
    (err: unknown) => {
      if (catalogMemo === entry) catalogMemo = undefined;
      throw err;
    },
  );
  catalogMemo = entry;
  return entry.promise;
}

async function fetchCatalogUncached(): Promise<OpenRouterModelData[]> {
  const url = buildEndpoint(OPENROUTER_API_BASE, 'v1/models');
  const response = await fetchWithRetry(
    url,
    { method: 'GET', signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) },
    {},
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
  }
  const payload = await response.json() as unknown;
  const entries = parseOpenRouterCatalogData(payload);
  if (!entries) {
    throw new Error(
      `Malformed OpenRouter catalog from ${url}: expected { data: [...] }, got an invalid payload. ` +
      `This is a transient protocol failure, not an empty model list.`
    );
  }
  return entries;
}

/**
 * Find a catalog entry by EXACT id match and normalize it. The catalog is the
 * deterministic metadata source: every model VARIANT is its own entry keyed by
 * its exact `id`, so matching the requested id verbatim guarantees a `:free`
 * pick resolves to the free entry, never the paid model. No slug derivation, no
 * fallback.
 *
 * @throws OpenRouterModelNotFoundError when the id is absent from THIS catalog
 *   snapshot (the model isn't listed here — the metrics engine rechecks next
 *   poll since the catalog is re-fetched). A catalog entry that exists but
 *   reports no usable context throws `PermanentContextError` (never retried).
 */
export function normalizeOpenRouterFromCatalog(
  catalog: OpenRouterModelData[],
  requestedId: string,
): OpenRouterModelInfo {
  const parsed = parseOpenRouterModelRef(requestedId);
  if ('error' in parsed) throw new PermanentContextError(parsed.error);

  const entry = catalog.find((m) => m.id === parsed.requestedId);
  if (!entry) {
    throw new OpenRouterModelNotFoundError(
      `OpenRouter model "${parsed.requestedId}" not found in the current OpenRouter catalog. ` +
      `Model ids must match a listed entry exactly - variants like ":free" are separate catalog entries and must be included.`
    );
  }
  return normalizeOpenRouterModel(entry, parsed.requestedId);
}

/**
 * Resolve a requested id's metadata from the catalog and normalize it.
 *
 * @param requestedId - Full model id the user wants (variants preserved for chat).
 * @returns Normalized model info; throws on network/HTTP/parse failure and when
 *   the model is absent from the catalog or reports no positive context bound.
 *
 * The catalog endpoint is public and unauthenticated, so no per-model headers
 * are sent (threading them here would be dead).
 */
async function fetchOpenRouterModel(requestedId: string): Promise<OpenRouterModelInfo> {
  // DETERMINISTIC metadata resolution — no slug guessing, no fallback. Resolve
  // from the model CATALOG (`GET /api/v1/models`), matching the requested id
  // verbatim (see normalizeOpenRouterFromCatalog). The exact-model endpoint
  // (`/api/v1/model/{author}/{slug}`) is NOT used: it resolves variants
  // inconsistently, and deriving a lookup slug could resolve a DIFFERENT model
  // than the one the user picked (a `:free` choice could silently become the
  // paid model).
  let catalog: OpenRouterModelData[];
  try {
    catalog = await fetchOpenRouterCatalog();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenRouter model "${requestedId}" lookup failed: GET ${OPENROUTER_API_BASE}/v1/models - ${detail}`);
  }
  return normalizeOpenRouterFromCatalog(catalog, requestedId);
}

/**
 * A single provider endpoint for a model, as reported by OpenRouter's
 * `/api/v1/models/{id}/endpoints`. `tag` is the exact slug used verbatim in the
 * request-body `provider.only`/`order` routing fields — never derived, never
 * guessed, always taken from the API (this is the same value the model-page
 * copy button yields). `provider_name` is the human-readable label.
 */
export interface OpenRouterModelEndpoint {
  /** Exact provider slug for `provider.only` routing (e.g. "together", "gmicloud/fp8"). */
  tag: string;
  /** Human-readable provider name (e.g. "Together", "GMICloud"). */
  providerName: string;
  /** Reported quantization ("fp8", "fp4", "unknown", …) — informational. */
  quantization?: string;
  /** Per-provider per-token pricing (estimate; actual cost is usage.cost). */
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
  /**
   * Provider-reported completion cap for this model (null when unset).
   * Display-only — never persists into `maxOutputTokens`, never clamps.
   */
  maxCompletionTokens?: number | null;
  /**
   * Provider-reported context window for this model (null when unset).
   * Differs from the catalog-level `context_length` (live-verified: SambaNova
   * serves 32,768 on a model whose catalog window is 163,840). Display-only —
   * the token budget stays keyed to the catalog context; the user owns the
   * choice when a pinned provider's window is smaller.
   */
  contextLength?: number | null;
  /** Server health: 0 = operational, -2 = degraded/unavailable (informational). */
  status?: number;
  /** Reported uptime over the last day, as a percentage 0-100 (e.g. 99.97). */
  uptimeLast1d?: number;
}

/**
 * Fetch the provider endpoints for an OpenRouter model from
 * `GET /api/v1/models/{id}/endpoints` — the authoritative, per-model provider
 * list. The requested id is used VERBATIM (variants like `:free` are their own
 * entries and resolve to only their own providers), so there is no slug
 * derivation and no guessing. Public and unauthenticated.
 *
 * Returns the endpoints with `tag`/`provider_name` (plus optional quantization,
 * pricing, caps, status) preserved as reported. Throws on HTTP/network failure
 * and on malformed payloads.
 */
async function fetchOpenRouterModelEndpoints(
  requestedId: string,
  timeoutMs: number = METADATA_TIMEOUT_MS,
): Promise<OpenRouterModelEndpoint[]> {
  // The id is `author/slug` — the `/` is a PATH SEPARATOR and must stay literal:
  // OpenRouter routes on the real slash, and an encoded `%2F` (what a naive
  // `encodeURIComponent(requestedId)` produces) 404s on their gateway. Encode
  // each segment separately so the route keeps its structure while stray
  // characters (and the `:free` variant's colon) are still escaped. The id is
  // used as-is, segment-wise — no slug derivation, no guessing.
  const encodedId = requestedId.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  const url = `${OPENROUTER_API_BASE}/v1/models/${encodedId}/endpoints`;
  try {
    const response = await fetchWithRetry(
      url,
      { method: 'GET', signal: AbortSignal.timeout(timeoutMs) },
      {},
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
    }
    const payload = await response.json() as unknown;
    const data = (payload as { data?: unknown })?.data;
    if (!data || typeof data !== 'object' || !Array.isArray((data as { endpoints?: unknown }).endpoints)) {
      throw new Error(
        `Malformed OpenRouter endpoints from ${url}: expected { data: { endpoints: [...] } }, got an invalid payload.`
      );
    }
    const raw = (data as { endpoints?: Array<Record<string, unknown>> }).endpoints ?? [];
    // Preserve ONLY fields the extension consumes, and only when they are the
    // types the API reports. No transformation of the routing slug.
    const endpoints: OpenRouterModelEndpoint[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const tag = typeof entry.tag === 'string' && entry.tag ? entry.tag : undefined;
      const providerName = typeof entry.provider_name === 'string' ? entry.provider_name : tag;
      if (!tag) continue; // a provider without a routing slug can never be selected
      const pricingRaw = entry.pricing;
      const pricing = pricingRaw && typeof pricingRaw === 'object'
        ? {
            prompt: typeof (pricingRaw as Record<string, unknown>).prompt === 'string' ? (pricingRaw as Record<string, unknown>).prompt as string : undefined,
            completion: typeof (pricingRaw as Record<string, unknown>).completion === 'string' ? (pricingRaw as Record<string, unknown>).completion as string : undefined,
            input_cache_read: typeof (pricingRaw as Record<string, unknown>).input_cache_read === 'string' ? (pricingRaw as Record<string, unknown>).input_cache_read as string : undefined,
          }
        : undefined;
      endpoints.push({
        tag,
        providerName: providerName ?? tag,
        quantization: typeof entry.quantization === 'string' ? entry.quantization : undefined,
        pricing,
        maxCompletionTokens: typeof entry.max_completion_tokens === 'number' ? entry.max_completion_tokens : undefined,
        contextLength: typeof entry.context_length === 'number' ? entry.context_length : undefined,
        status: typeof entry.status === 'number' ? entry.status : undefined,
        uptimeLast1d: typeof entry.uptime_last_1d === 'number' ? entry.uptime_last_1d : undefined,
      });
    }
    return endpoints;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenRouter model "${requestedId}" endpoints lookup failed: GET ${url} - ${detail}`);
  }
}

// ─── Shared per-session provider-list cache ─────────────────────────────
// The dashboard engine and Model Settings both render provider lists from
// `GET /v1/models/{id}/endpoints`. One shared cache (keyed by wire id) removes
// the old duplicated policy — two independent 2s `Promise.race` wrappers whose
// underlying 10s fetches kept running after the race gave up. The display bound
// is now an `AbortSignal.timeout` on the real fetch, so nothing runs orphaned;
// in-flight calls for the same id share one request; failures back off instead
// of hammering; and both views see the SAME data (no dashboard/settings drift).

/** Cached provider list + fetch timestamp (wire id → entry). */
interface ProviderListEntry {
  providers: OpenRouterModelEndpoint[];
  fetchedAt: number;
}

const providerListCache = new Map<string, ProviderListEntry>();
/** In-flight dedup: concurrent callers for one id share a single fetch. */
const providerListInflight = new Map<string, Promise<OpenRouterModelEndpoint[]>>();
/** Failed ids are not retried until this timestamp. */
const providerListRetryAt = new Map<string, number>();

/** Provider lists are display-only; 5 minutes is fresh enough without hammering. */
const PROVIDER_LIST_CACHE_TTL_MS = 5 * 60_000;
/** Display bound — abort the real fetch past this (never block a refresh behind it). */
const PROVIDER_LIST_FETCH_TIMEOUT_MS = 2000;
/** Failure backoff before an id may be fetched again. */
const PROVIDER_LIST_RETRY_MS = 60_000;

/**
 * Get a model's provider list through the shared per-session cache. Returns the
 * cached list on a fresh hit; the stale list while a failure is in its backoff
 * window; and otherwise fetches once (concurrent callers share the request).
 * The fetch is aborted after the 2s display bound. On a fetch failure with a
 * stale cached value, the stale list is returned (stale data beats nothing); it
 * throws only when there is no cached value to fall back on.
 */
export async function getOpenRouterModelEndpointsCached(
  wireId: string,
): Promise<OpenRouterModelEndpoint[]> {
  const cached = providerListCache.get(wireId);
  if (cached && Date.now() - cached.fetchedAt < PROVIDER_LIST_CACHE_TTL_MS) return cached.providers;
  const retryAt = providerListRetryAt.get(wireId) ?? 0;
  if (Date.now() < retryAt) return cached ? cached.providers : [];

  const inflight = providerListInflight.get(wireId);
  if (inflight) return inflight;

  const promise = fetchOpenRouterModelEndpoints(wireId, PROVIDER_LIST_FETCH_TIMEOUT_MS)
    .then((providers) => {
      if (providers.length > 0) {
        providerListCache.set(wireId, { providers, fetchedAt: Date.now() });
      } else {
        // A 200 with an empty data array defeats every cache policy (CR-29):
        // nothing gets cached, so every metrics tick and settings refresh dials
        // the API again forever, each burning the 2 s abort budget. Throttle
        // empty successes through the same backoff as failures.
        providerListRetryAt.set(wireId, Date.now() + PROVIDER_LIST_RETRY_MS);
      }
      return providers;
    })
    .catch((err) => {
      providerListRetryAt.set(wireId, Date.now() + PROVIDER_LIST_RETRY_MS);
      // Stale data beats nothing: if a cached list exists (now past its TTL),
      // keep serving it — the backoff above makes subsequent calls return it
      // directly instead of re-fetching. Only throw when there is no fallback.
      const stale = providerListCache.get(wireId);
      if (stale) return stale.providers;
      throw err;
    })
    .finally(() => providerListInflight.delete(wireId));
  providerListInflight.set(wireId, promise);
  return promise;
}

/**
 * Clear the module-level OpenRouter caches — provider-list values, in-flight
 * dedup, failure backoff, and the catalog memo. Production callers: the
 * activation config listener (flushes when `vllm-copilot.servers`/`.models`
 * change, so auth rotation, server URL fixes, and model add/remove surface
 * fresh provider lists instead of serving stale entries for the rest of the
 * TTL) and Test & Refresh (its finally block — see the runtimeLimits.ts
 * module doc). Tests reuse it for isolation.
 */
export function resetOpenRouterCaches(): void {
  providerListCache.clear();
  providerListInflight.clear();
  providerListRetryAt.clear();
  catalogMemo = undefined;
}

/**
 * Resolve only the runtime limits for an OpenRouter model — the arm the shared
 * `resolveRuntimeLimits` switch will call. Thin wrapper over the full lookup.
 */
export async function resolveOpenRouterRuntimeLimits(requestedId: string): Promise<RuntimeModelLimits> {
  const info = await fetchOpenRouterModel(requestedId);
  return info.runtimeLimits;
}

/**
 * The shared catalog projection (audit P8-2): the optional-field conditional
 * spreads that BOTH the Add flow and Auto-Configure write into settings.json.
 * Head fields (id/vllmModelId/displayName/server) stay with each flow because
 * they genuinely differ. This spread chain is the wire contract for what
 * OpenRouter catalog data looks like in config — one place to fix, not twins.
 */
export function openRouterCatalogConfigFields(info: OpenRouterModelInfo): Partial<ModelConfig> {
  return {
    capabilities: info.capabilities,
    ...(info.modelModes ? { modelModes: info.modelModes } : {}),
    ...(info.defaultMode ? { defaultMode: info.defaultMode } : {}),
    ...(info.defaultParams ? { defaultParams: info.defaultParams } : {}),
    ...(info.cost ? { cost: info.cost } : {}),
    ...(info.runtimeLimits.maxOutputTokens !== undefined ? { maxOutputTokens: info.runtimeLimits.maxOutputTokens } : {}),
  };
}

/**
 * The shared detail lines of both OpenRouter confirm dialogs (output limit,
 * caps, modes, rates, expiry). Head lines ("OpenRouter model:", the
 * context-window line) and flow trailers stay at the call sites; only the
 * byte-identical middle lives here.
 */
export function openRouterInfoDetailLines(info: OpenRouterModelInfo): string[] {
  const lines: string[] = [];
  if (info.runtimeLimits.maxOutputTokens !== undefined) {
    lines.push(`Max output: ${info.runtimeLimits.maxOutputTokens.toLocaleString('en-US')} tokens`);
  }
  lines.push(`Tool calling: ${info.capabilities.toolCalling ? 'yes' : 'no'}`);
  lines.push(`Image input: ${info.capabilities.imageInput ? 'yes' : 'no'}`);
  if (info.modelModes && Object.keys(info.modelModes).length > 0) {
    lines.push(`Modes: ${Object.keys(info.modelModes).join(', ')}`);
    if (info.defaultMode) lines.push(`Default mode: ${info.defaultMode}`);
  }
  if (info.cost) {
    lines.push(`Estimated rates: in ${formatUsdRate(info.cost.input)} · out ${formatUsdRate(info.cost.output)} per 1M tokens`);
  }
  if (info.expirationDate) lines.push(`Expires: ${info.expirationDate}`);
  return lines;
}

/**
 * Auto-configure an OpenRouter model from its catalog metadata — the ONLY
 * discovery source for this backend. HF chat-template sniffing cannot express
 * OpenRouter's `reasoning` object (effort ladder, mandatory, default_enabled)
 * or `supported_parameters`, so routing OpenRouter through the HuggingFace
 * discovery would fabricate a "detected from HuggingFace" summary and never set
 * thinking modes. Presets are keyed to HF repos and skipped here by design
 * (matches the plan's "no OpenRouter presets" decision).
 *
 * Settings fields and detail lines come from the shared catalog projections
 * ({@link openRouterCatalogConfigFields}, {@link openRouterInfoDetailLines})
 * that the Add flow uses too: one mapping, one authoritative
 * `maxOutputTokens`, no twin left to drift.
 *
 * @throws when the catalog fetch fails (network), the id is absent from the
 *   catalog, or the model reports no positive context bound — the strict
 *   no-context-no-model policy.
 */
export async function autoConfigureOpenRouterModel(
  modelId: string,
): Promise<{ modelConfig: ModelConfig; summary: string[] }> {
  const info = await fetchOpenRouterModel(modelId);
  const modelConfig: ModelConfig = {
    id: modelId,
    vllmModelId: info.wireModelId,
    displayName: info.displayName ?? info.wireModelId,
    // OpenRouter models reference the conventional `openrouter` registry entry;
    // the calling flow upserts that entry (create-if-absent) before writing.
    server: 'openrouter',
    ...openRouterCatalogConfigFields(info),
  };

  const summary: string[] = [
    `Context window (OpenRouter): ${info.runtimeLimits.contextWindow.toLocaleString('en-US')} tokens`,
    ...openRouterInfoDetailLines(info),
    '',
    'Note: Configured from OpenRouter catalog metadata (authoritative for this backend).',
  ];
  return { modelConfig, summary };
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
  usage_daily?: number;
  usage_weekly?: number;
  usage_monthly?: number;
  byok_usage?: number;
  byok_usage_monthly?: number;
  /** ISO timestamp when this key expires, or null for never. */
  expires_at?: string | null;
  /** ISO timestamp when the credit limit resets, or null when not on a reset cycle. */
  limit_reset?: string | null;
  is_free_tier?: boolean;
  is_management_key?: boolean;
  is_provisioning_key?: boolean;
  /** Whether BYOK spend counts against the credit limit. */
  include_byok_in_limit?: boolean;
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
export function fetchOpenRouterAccount(
  requestHeaders: Record<string, string> = {},
): Promise<OpenRouterAccount | undefined> {
  return fetchOpenRouterAccountData<OpenRouterAccount>('v1/key', requestHeaders);
}

/**
 * Shared best-effort body for the two account probes (audit P16-4): plain
 * fetch + timeout, NO retry (the 1.5 s network backoff would stall every
 * metrics poll while the endpoint is down, for optional values), failure →
 * `undefined`, always.
 */
async function fetchOpenRouterAccountData<T extends object>(
  path: string,
  requestHeaders: Record<string, string>,
): Promise<T | undefined> {
  const url = buildEndpoint(OPENROUTER_API_BASE, path);
  const headers = buildRequestHeaders(undefined, requestHeaders);
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS) });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  try {
    const payload = await response.json() as { data?: T };
    // `typeof [] === 'object'` — reject array-shaped data explicitly.
    if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) return undefined;
    return payload.data;
  } catch {
    return undefined;
  }
}

/**
 * OpenRouter account budget from `GET /api/v1/credits` — total credits purchased
 * and total usage (the account-level "money in vs money out", independent of the
 * per-key `limit`/`limit_remaining` which are null for unlimited keys). Verified
 * live: `{ total_credits: 8, total_usage: 0.0009 }` for a key whose `limit` is
 * null. Requires a valid `Authorization` header (same per-model key).
 */
export interface OpenRouterCredits {
  total_credits?: number;
  total_usage?: number;
}

/**
 * Fetch the account budget from `GET /api/v1/credits`. Same best-effort
 * discipline as {@link fetchOpenRouterAccount}: plain fetch + timeout, NO retry,
 * failure → undefined (the dashboard hides the rows rather than fabricating).
 */
export function fetchOpenRouterCredits(
  requestHeaders: Record<string, string> = {},
): Promise<OpenRouterCredits | undefined> {
  return fetchOpenRouterAccountData<OpenRouterCredits>('v1/credits', requestHeaders);
}
