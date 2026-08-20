import { buildEndpoint, type ServerType } from './config.js';
import { fetchWithRetry } from './fetchRetry.js';
import { isOpenRouterUrl, resolveOpenRouterRuntimeLimits } from './openRouter.js';
import type { LmStudioModel, RuntimeModelLimits, VllmModel } from './types.js';

const METADATA_TIMEOUT_MS = 10000;

function isHttp404(error: unknown): boolean {
  return error instanceof Error && /^HTTP\s+404\b/.test(error.message);
}

function isInvalidSignature(error: unknown): boolean {
  return isHttp404(error) || error instanceof SyntaxError;
}

export async function resolveRuntimeLimits(
  serverType: ServerType,
  serverUrl: string,
  requestHeaders: Record<string, string> = {},
  modelId: string,
): Promise<RuntimeModelLimits> {
  switch (serverType) {
    case 'vllm': {
      const url = buildEndpoint(serverUrl, 'v1/models');
      const data = await fetchJsonRaw<{ data?: VllmModel[] }>(url, requestHeaders);
      const model = (data.data || []).find((entry) => entry.id === modelId);
      const contextWindow = model?.max_model_len;
      if (typeof contextWindow === 'number' && contextWindow > 0) return { contextWindow };
      throw new Error(
        `vLLM model "${modelId}" has no runtime context window: GET ${url} returned no matching ` +
        `entry with max_model_len. Fix the served model id or server config. If this entry should ` +
        `target a third-party backend, set "serverType" ('lmstudio' | 'llamacpp' | 'ollama' | 'openrouter') — ` +
        `the model will not be served.`
      );
    }
    case 'lmstudio': {
      const url = buildEndpoint(serverUrl, 'api/v1/models');
      const data = await fetchJsonRaw<{ models?: LmStudioModel[] }>(url, requestHeaders);
      const model = (data.models || []).find((entry) => entry.key === modelId || entry.id === modelId);
      const contextWindow = model?.loaded_instances?.[0]?.config?.context_length ?? model?.max_context_length;
      if (typeof contextWindow === 'number' && contextWindow > 0) return { contextWindow };
      throw new Error(
        `LM Studio model "${modelId}" has no context window: GET ${url} reported no loaded instance ` +
        `with config.context_length (or max_context_length). Load the model in LM Studio — it will not be served.`
      );
    }
    case 'llamacpp': {
      const url = buildEndpoint(serverUrl, `props?model=${encodeURIComponent(modelId)}`);
      const data = await fetchJsonRaw<{ default_generation_settings?: { n_ctx?: number } }>(url, requestHeaders);
      const contextWindow = data.default_generation_settings?.n_ctx;
      if (typeof contextWindow === 'number' && contextWindow > 0) return { contextWindow };
      throw new Error(
        `llama.cpp model "${modelId}" has no context window: GET ${url} reported no ` +
        `default_generation_settings.n_ctx. Check the server API key and model id — it will not be served.`
      );
    }
    case 'ollama': {
      const url = buildEndpoint(serverUrl, 'api/ps');
      const data = await fetchJsonRaw<{ models?: Array<{ model?: string; name?: string; context_length?: number }> }>(url, requestHeaders);
      const model = (data.models || []).find((entry) => entry.model === modelId || entry.name === modelId);
      const contextWindow = model?.context_length;
      if (typeof contextWindow === 'number' && contextWindow > 0) return { contextWindow };
      throw new Error(
        `Ollama model "${modelId}" is not loaded (or reports no context_length): GET ${url}. ` +
        `Load the model with a context size in Ollama — it will not be served.`
      );
    }
    case 'openrouter':
      return resolveOpenRouterRuntimeLimits(modelId);
  }
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

export function detectServerTypeFromV1Models(
  entries: Array<{ owned_by?: string; max_model_len?: number }>
): ServerType | undefined {
  if (entries.some((entry) => typeof entry.max_model_len === 'number' && entry.max_model_len > 0)) {
    return 'vllm';
  }
  if (entries.some((entry) => entry.owned_by === 'llamacpp')) {
    return 'llamacpp';
  }
  return undefined;
}

async function fetchJsonRaw<T>(url: string, requestHeaders: Record<string, string>): Promise<T> {
  const response = await fetchWithRetry(
    url,
    { method: 'GET', signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) },
    requestHeaders
  );
  return await response.json() as T;
}