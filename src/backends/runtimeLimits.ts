import { buildEndpoint, KNOWN_SERVER_TYPES, type ServerType } from '../state/config.js';
import { buildRequestHeaders, fetchWithRetry } from '../shared/fetchRetry.js';
import { describeError } from '../provider/messageConverter.js';
import { resolveOpenRouterRuntimeLimits } from './openRouter.js';
import { isOpenRouterUrl } from '../state/serverCore.js';
import type { LmStudioModel, RuntimeModelLimits, VllmModel } from '../types.js';

const METADATA_TIMEOUT_MS = 10000;

/**
 * Short-TTL memos for {@link resolveRuntimeLimits} (audit P6-2/P16-1), two layers:
 *
 * 1. SERVER LIST layer, keyed (serverType, url, headers): the vLLM, LM Studio
 *    and Ollama resolvers each fetch the server's WHOLE model list and pluck
 *    one entry, so without this layer ten models on one box meant ten
 *    identical `GET /v1/models` per pass. With it, one fetch per server per
 *    pass, shared by concurrent probes (in-flight) and sequential loops
 *    (settled, test & refresh resolves matched models one after another).
 * 2. LOOKUP layer, keyed (serverType, url, headers, modelId): collapses
 *    repeated resolutions of the SAME model across surfaces (model info,
 *    provider discovery, Test & Refresh) without re-running the parse.
 *
 * llama.cpp (`props?model=X`) is per-model by endpoint design and OpenRouter
 * has its own catalog memo in openRouter.ts; neither uses layer 1.
 *
 * A rejected LOOKUP deletes its entry so a model that loads a moment later
 * re-resolves; a rejected list fetch is likewise never cached. The one
 * accepted staleness: a SUCCESSFUL list fetch whose model was missing is
 * reused until the TTL expires (a model loaded within the TTL window shows up
 * one TTL later at the worst). `clearRuntimeLimitsCache()` runs on config
 * invalidation (settings edit, Test & Refresh) and drops BOTH layers; Test &
 * Refresh also clears the OpenRouter catalog layer (`resetOpenRouterCaches`),
 * so a manual refresh re-probes from zero on every backend.
 *
 * Headers are part of both keys: two registry entries sharing one URL with
 * different credentials never share anything (audit P14-1's twin hazard).
 */
const LIMITS_MEMO_TTL_MS = 5_000;

interface LimitsMemoEntry {
  promise: Promise<RuntimeModelLimits>;
  /** Set when the lookup succeeded; undefined while in flight (always shared). */
  settledAt?: number;
}

const limitsMemo = new Map<string, LimitsMemoEntry>();

/** Server-list memo (layer 1): same shape, keyed WITHOUT the model id. */
interface ListMemoEntry {
  promise: Promise<unknown>;
  settledAt?: number;
}

const listMemo = new Map<string, ListMemoEntry>();

/**
 * Shared key core for both memo layers: backend, URL, and the request
 * headers, sorted so header order never forks a cache entry.
 */
function serverKey(
  serverType: ServerType,
  serverUrl: string,
  requestHeaders: Record<string, string>,
): string {
  const headers = Object.keys(requestHeaders)
    .sort()
    .map((k) => `${k}:${requestHeaders[k]}`)
    .join('|');
  return `${serverType}|${serverUrl}|${headers}`;
}

/**
 * One in-flight + TTL memoized fetch of a server's WHOLE model list.
 * Rejections delete the entry immediately (a dead server must not be
 * remembered dead for the TTL); successes expire after the TTL like the
 * lookup layer. Sweeps its own stale rows on each settle.
 */
function serverListOnce<T>(key: string, fetchList: () => Promise<T>): Promise<T> {
  const hit = listMemo.get(key);
  if (hit && (hit.settledAt === undefined || Date.now() - hit.settledAt < LIMITS_MEMO_TTL_MS)) {
    return hit.promise as Promise<T>;
  }
  const entry: ListMemoEntry = { promise: undefined as unknown as Promise<T> };
  entry.promise = fetchList().then(
    (payload) => {
      entry.settledAt = Date.now();
      const now = Date.now();
      for (const [k, v] of listMemo) {
        if (v.settledAt !== undefined && now - v.settledAt >= LIMITS_MEMO_TTL_MS) listMemo.delete(k);
      }
      return payload;
    },
    (err: unknown) => {
      if (listMemo.get(key) === entry) listMemo.delete(key);
      throw err;
    },
  );
  listMemo.set(key, entry);
  return entry.promise as Promise<T>;
}

/** Drop BOTH memo layers (resolver lookups and server lists). Called on
 *  config-cache invalidation and by tests. */
export function clearRuntimeLimitsCache(): void {
  limitsMemo.clear();
  listMemo.clear();
}

export function resolveRuntimeLimits(
  serverType: ServerType,
  serverUrl: string,
  requestHeaders: Record<string, string> = {},
  modelId: string,
): Promise<RuntimeModelLimits> {
  // Lookup-layer key: the server key plus the model id. Two registry entries
  // sharing one URL with different credentials never share a resolution.
  const key = `${serverKey(serverType, serverUrl, requestHeaders)}|${modelId}`;
  const hit = limitsMemo.get(key);
  if (hit && (hit.settledAt === undefined || Date.now() - hit.settledAt < LIMITS_MEMO_TTL_MS)) {
    return hit.promise;
  }
  const entry: LimitsMemoEntry = { promise: undefined as unknown as Promise<RuntimeModelLimits> };
  entry.promise = resolveLimitsUncached(serverType, serverUrl, requestHeaders, modelId).then(
    (limits) => {
      entry.settledAt = Date.now();
      // Opportunistic sweep: the map is small (servers x models) but entries
      // are only re-read when the same model is probed again, so stale rows
      // from retired models would otherwise linger.
      const now = Date.now();
      for (const [k, v] of limitsMemo) {
        if (v.settledAt !== undefined && now - v.settledAt >= LIMITS_MEMO_TTL_MS) limitsMemo.delete(k);
      }
      return limits;
    },
    (err: unknown) => {
      if (limitsMemo.get(key) === entry) limitsMemo.delete(key);
      throw err;
    },
  );
  limitsMemo.set(key, entry);
  return entry.promise;
}

async function resolveLimitsUncached(
  serverType: ServerType,
  serverUrl: string,
  requestHeaders: Record<string, string>,
  modelId: string,
): Promise<RuntimeModelLimits> {
  switch (serverType) {
    case 'vllm': {
      const url = buildEndpoint(serverUrl, 'v1/models');
      const data = await serverListOnce(serverKey(serverType, serverUrl, requestHeaders), () =>
        fetchJsonRaw<{ data?: VllmModel[] }>(url, requestHeaders)
      );
      // Match on `root` too (CR-54): a LoRA-style deployment addressed by its
      // base model must resolve here exactly as detectServerType classifies it,
      // or the detector calls the server vLLM while the resolver declares the
      // model "will not be served". LM Studio and Ollama accept their alias in
      // both halves already.
      const model = (data.data || []).find((entry) => entry.id === modelId || entry.root === modelId);
      const contextWindow = model?.max_model_len;
      if (typeof contextWindow === 'number' && contextWindow > 0) return { contextWindow };
      throw new Error(
        `vLLM model "${modelId}" has no runtime context window: GET ${url} returned no matching ` +
        `entry with max_model_len. Fix the served model id or server config. If this entry should ` +
        `target a third-party backend, set "serverType" ('lmstudio' | 'llamacpp' | 'ollama' | 'openrouter') - ` +
        `the model will not be served.`
      );
    }
    case 'lmstudio': {
      const url = buildEndpoint(serverUrl, 'api/v1/models');
      const data = await serverListOnce(serverKey(serverType, serverUrl, requestHeaders), () =>
        fetchJsonRaw<{ models?: LmStudioModel[] }>(url, requestHeaders)
      );
      const model = (data.models || []).find((entry) => entry.key === modelId || entry.id === modelId);
      const contextWindow = model?.loaded_instances?.[0]?.config?.context_length ?? model?.max_context_length;
      if (typeof contextWindow === 'number' && contextWindow > 0) return { contextWindow };
      throw new Error(
        `LM Studio model "${modelId}" has no context window: GET ${url} reported no loaded instance ` +
        `with config.context_length (or max_context_length). Load the model in LM Studio - it will not be served.`
      );
    }
    case 'llamacpp': {
      const url = buildEndpoint(serverUrl, `props?model=${encodeURIComponent(modelId)}`);
      const data = await fetchJsonRaw<{ default_generation_settings?: { n_ctx?: number } }>(url, requestHeaders);
      const contextWindow = data.default_generation_settings?.n_ctx;
      if (typeof contextWindow === 'number' && contextWindow > 0) return { contextWindow };
      throw new Error(
        `llama.cpp model "${modelId}" has no context window: GET ${url} reported no ` +
        `default_generation_settings.n_ctx. Check the server API key and model id - it will not be served.`
      );
    }
    case 'ollama': {
      const url = buildEndpoint(serverUrl, 'api/ps');
      const data = await serverListOnce(serverKey(serverType, serverUrl, requestHeaders), () =>
        fetchJsonRaw<{ models?: Array<{ model?: string; name?: string; context_length?: number }> }>(url, requestHeaders)
      );
      const model = (data.models || []).find((entry) => entry.model === modelId || entry.name === modelId);
      const contextWindow = model?.context_length;
      if (typeof contextWindow === 'number' && contextWindow > 0) return { contextWindow };
      throw new Error(
        `Ollama model "${modelId}" is not loaded (or reports no context_length): GET ${url}. ` +
        `Load the model with a context size in Ollama - it will not be served.`
      );
    }
    case 'openrouter':
      return resolveOpenRouterRuntimeLimits(modelId);
    default: {
      // Backstop, not a fallback (CR-39): resolveServer normalizes unknown
      // types to 'vllm' before anything reaches this switch, so arriving here
      // means a new call path bypassed the choke point. The typed union says
      // this arm is impossible — the type is a lie about hand-edited JSON, and
      // falling out silently would resolve `undefined` and let the memo cache
      // it as a settled SUCCESS.
      throw new Error(
        `No runtime-limits resolver for serverType "${String(serverType)}" - expected one of ` +
        `${KNOWN_SERVER_TYPES.join(', ')}. Fix the registry entry's "serverType" - the model will not be served.`
      );
    }
  }
}

/** "wrong backend here" signal: 404 from an endpoint, or unparseable JSON. */
function isInvalidSignature(error: unknown): boolean {
  return (error instanceof Error && /^HTTP\s+404\b/.test(error.message)) || error instanceof SyntaxError;
}

export async function detectServerType(
  serverUrl: string,
  requestHeaders: Record<string, string> = {},
  modelId: string,
): Promise<ServerType> {
  if (isOpenRouterUrl(serverUrl)) return 'openrouter';

  let v1: { data?: VllmModel[] };
  try {
    v1 = await fetchJsonRaw<{ data?: VllmModel[] }>(buildEndpoint(serverUrl, 'v1/models'), requestHeaders);
  } catch (error) {
    if (!isInvalidSignature(error)) throw error;
    v1 = {};
  }
  const model = (v1.data || []).find((entry) => entry.id === modelId || entry.root === modelId);
  if (model?.max_model_len) return 'vllm';
  if (model?.owned_by === 'llamacpp') return 'llamacpp';

  try {
    const data = await fetchJsonRaw<{ models?: LmStudioModel[] }>(buildEndpoint(serverUrl, 'api/v1/models'), requestHeaders);
    if (Array.isArray(data.models) && data.models.some((entry) => entry.key === modelId || entry.id === modelId)) {
      return 'lmstudio';
    }
  } catch (error) {
    if (!isInvalidSignature(error)) throw error;
  }

  try {
    const data = await fetchJsonRaw<{ models?: Array<{ model?: string; name?: string }> }>(buildEndpoint(serverUrl, 'api/ps'), requestHeaders);
    if (Array.isArray(data.models) && data.models.some((entry) => entry.model === modelId || entry.name === modelId)) {
      return 'ollama';
    }
  } catch (error) {
    if (!isInvalidSignature(error)) throw error;
  }

  throw new Error(
    `Unsupported server at ${serverUrl}: expected vLLM (/v1/models with max_model_len), ` +
    `llama.cpp (owned_by "llamacpp"), LM Studio (/api/v1/models with models[].key), or ` +
    `Ollama (/api/ps with models[]), or OpenRouter (openrouter.ai host). No documented signature matched model "${modelId}".`
  );
}

async function fetchJsonRaw<T>(url: string, requestHeaders: Record<string, string>): Promise<T> {
  const response = await fetchWithRetry(
    url,
    { method: 'GET', signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) },
    requestHeaders
  );
  return await response.json() as T;
}

// ─── Shared model-list probe (audit P13-2 / P9-1) ───────────────────────

/**
 * One model a backend serves, in the backend's AUTHORITATIVE id space (the
 * same id the resolver matches `modelId` against). `ownedBy`/`maxModelLen`
 * are only ever filled from the OpenAI-compatible `/v1/models` shape — the
 * fields the backend detector reads — so a LM Studio/Ollama probe can never
 * fake a vLLM signature.
 */
export interface ServerModelEntry {
  id: string;
  ownedBy?: string;
  maxModelLen?: number;
}

/** Probe failure. `status` is set for HTTP failures so callers can classify
 *  auth (401/403) without parsing the message. */
export class ServerProbeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ServerProbeError';
  }
}

/**
 * List what a server currently serves, via the backend's documented endpoint:
 * `/api/v1/models` for LM Studio (ids are model KEYS), `/api/ps` for Ollama
 * (loaded models), OpenAI `/v1/models` for vLLM/llama.cpp/OpenRouter.
 *
 * This is the shared core for the DISPLAY/LOOKUP consumers (Model Settings
 * badge, Test & Refresh group probe). It deliberately does NOT go through
 * `fetchWithRetry`: these are live status probes where an immediate honest
 * failure beats a 1.5 s backoff in front of a progress UI, and the previous
 * probe sites never retried either. Throws {@link ServerProbeError} on HTTP
 * or network failure — callers decide what a failure means.
 *
 * Diagnostics' independent transport probes and the Add flow's classified
 * pick-list are NOT consumers — their independence/failure UX is the point.
 */
export async function listServerModels(
  serverType: ServerType,
  serverUrl: string,
  requestHeaders: Record<string, string> = {},
): Promise<ServerModelEntry[]> {
  const probeJson = async <T>(url: string): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: buildRequestHeaders(undefined, requestHeaders),
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ServerProbeError(`GET ${url} failed: ${describeError(err)}`);
    }
    if (!response.ok) {
      throw new ServerProbeError(
        `HTTP ${response.status}${response.statusText ? `: ${response.statusText}` : ''} from ${url}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  };

  switch (serverType) {
    case 'lmstudio': {
      const data = await probeJson<{ models?: LmStudioModel[] }>(buildEndpoint(serverUrl, 'api/v1/models'));
      return (data.models ?? [])
        .map((m) => ({ id: m.key ?? m.id ?? '' }))
        .filter((m) => m.id);
    }
    case 'ollama': {
      const data = await probeJson<{ models?: Array<{ model?: string; name?: string }> }>(
        buildEndpoint(serverUrl, 'api/ps'),
      );
      return (data.models ?? [])
        .map((m) => ({ id: m.model ?? m.name ?? '' }))
        .filter((m) => m.id);
    }
    default: {
      // vllm, llamacpp, openrouter: OpenAI-compatible /v1/models.
      const data = await probeJson<{ data?: VllmModel[] }>(buildEndpoint(serverUrl, 'v1/models'));
      return (data.data ?? [])
        .map((m) => ({ id: m.id, ownedBy: m.owned_by, maxModelLen: m.max_model_len }))
        .filter((m) => m.id);
    }
  }
}
