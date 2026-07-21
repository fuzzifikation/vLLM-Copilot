import * as vscode from 'vscode';
import type { WireStructuredOutputConfig } from './types.js';

export type StructuredOutputConfig = WireStructuredOutputConfig;

export interface ModelConfig {
  /**
   * Unique identifier for this model preset in VS Code.
   * Must be unique across all entries — this is what VS Code uses
   * to distinguish different presets of the same underlying model.
   * If `vllmModelId` is not set, `id` is also used as the vLLM server model identifier.
   */
  id?: string;
  /**
   * The actual model ID on the vLLM server (e.g. "Qwen/Qwen3-8B").
   * Allows multiple presets (different ids) to point to the same server model.
   * If omitted, `id` is used as the vLLM model identifier.
   */
  vllmModelId?: string;
  displayName?: string;
  /** Model family (e.g. "qwen3_5", "deepseek_v4"). Auto-detected from HuggingFace config.model_type. */
  family?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  capabilities?: {
    toolCalling?: boolean;
    imageInput?: boolean;
  };
  /**
   * User-defined model modes for the model picker dropdown.
   * Each key is a mode label, and the value is an object of parameters
   * to spread into the vLLM request body when that mode is selected.
   * Example: { "Think": { "chat_template_kwargs": { "enable_thinking": true } } }
   */
  modelModes?: Record<string, Record<string, unknown>>;
  /**
   * Explicit default mode to select in the model picker dropdown.
   * If not set, the first mode in modelModes is used as default.
   */
  defaultMode?: string;
  /**
   * The vLLM server URL hosting this model (OpenAI-compatible API).
   * Every model targets its own server — there is no global server.
   */
  serverUrl?: string;
  /**
   * HTTP headers sent with every request to this model's server (auth, routing).
   * Isolated: used only for this model's server, never shared with other servers.
   */
  requestHeaders?: Record<string, string>;
  /**
   * Model-scope request parameters (raw vLLM request-body keys, snake_case).
   * Applied on top of the built-in `DEFAULT_REQUEST_PARAMS` and overridden by the
   * selected `modelModes` entry. Same shape as a `modelModes` value.
   * Example: { "temperature": 1, "top_p": 0.95, "presence_penalty": 0 }
   */
  defaultParams?: Record<string, unknown>;
  /** Character-per-token estimate for input budgeting (depends on the model's tokenizer). */
  estimateCharsPerToken?: number;
  /** Inactivity timeout for the SSE stream in ms. 0 = disabled (wait indefinitely). */
  streamInactivityTimeout?: number;
  /**
   * How many times to auto-retry when the model returns an empty response.
   * Uses assistant prefill. 0 = disabled.
   */
  autoContinueRetries?: number;
  /**
   * Path to a JSON file containing find/replace pairs for system message text.
   * Each pair: { "find": "exact substring", "replace": "replacement text" }
   * Applied to every system message before sending to vLLM.
   * Empty replace string removes the matched text.
   * Recommended: .vllm/prompt-replacements.json
   */
  systemMessageReplacementsFile?: string;
}

export interface VllmConfig {
  /** Per-model configuration. Each entry carries its own server, auth, params, and budgets. */
  models: ModelConfig[];
  /** Extension-wide diagnostic toggle — the only global user setting. */
  enableFileLogging: boolean;
}

/**
 * Built-in base request params. Layered under model `defaultParams` and mode params.
 *
 * NOTE: repetition_detection was removed from defaults because the n-gram detector
 * (min_pattern_size: 2, min_count: 3) triggers on structured output like XML tables,
 * JSON arrays, and code loops — not just actual repetition loops.
 * Users who want it can enable it per-model via defaultParams in their config.
 */
export const DEFAULT_REQUEST_PARAMS: Record<string, unknown> = {
  temperature: 0.7,
  top_p: 1.0,
};

/** Built-in defaults for per-model token/transport settings. */
export const DEFAULT_MODEL_SETTINGS = {
  /** Maximum tokens the model may generate in a single response (output only). */
  maxOutputTokens: 4096,
  estimateCharsPerToken: 3.5,
  /** Inactivity timeout for SSE stream in ms. 0 = disabled. */
  streamInactivityTimeout: 0,
  autoContinueRetries: 1,
} as const;

/** Typed per-model settings resolved against the built-in defaults. */
export interface ResolvedModelSettings {
  maxOutputTokens: number;
  estimateCharsPerToken: number;
  streamInactivityTimeout: number;
  autoContinueRetries: number;
}

/**
 * Resolve the effective request-body params for a model via the layering chain
 * (highest wins): `DEFAULT_REQUEST_PARAMS` ← `runtimeOptions` ← model `defaultParams`
 * ← selected mode.
 *
 * `runtimeOptions` carries the caller's non-user layer — Copilot's `modelOptions`
 * plus the resolved `max_tokens` budget — so the model's own `defaultParams`/mode
 * always win over Copilot's runtime defaults. The caller re-asserts `max_tokens`,
 * `tools`, and `tool_choice` after this call so those safety-critical fields
 * always win over user-configured params.
 */
export function resolveRequestParams(
  override: ModelConfig | undefined,
  selectedMode: string | undefined,
  runtimeOptions?: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...DEFAULT_REQUEST_PARAMS };
  if (runtimeOptions) Object.assign(merged, runtimeOptions);
  if (override?.defaultParams) Object.assign(merged, override.defaultParams);
  if (selectedMode && override?.modelModes?.[selectedMode]) {
    Object.assign(merged, override.modelModes[selectedMode]);
  }
  return merged;
}

/** Resolve typed per-model token/transport settings against the built-in defaults. */
export function resolveModelSettings(override: ModelConfig | undefined): ResolvedModelSettings {
  return {
    maxOutputTokens: override?.maxOutputTokens ?? DEFAULT_MODEL_SETTINGS.maxOutputTokens,
    estimateCharsPerToken: override?.estimateCharsPerToken ?? DEFAULT_MODEL_SETTINGS.estimateCharsPerToken,
    streamInactivityTimeout: override?.streamInactivityTimeout ?? DEFAULT_MODEL_SETTINGS.streamInactivityTimeout,
    autoContinueRetries: override?.autoContinueRetries ?? DEFAULT_MODEL_SETTINGS.autoContinueRetries,
  };
}

/**
 * Resolve the vLLM server model ID from a ModelConfig override.
 * Returns `vllmModelId` if set, otherwise falls back to `id`.
 */
export function resolveVllmModelId(override: ModelConfig | undefined): string | undefined {
  return override?.vllmModelId || override?.id;
}

/**
 * Build a readable, unique VS Code model `id` from a server URL and the vLLM
 * model id, formatted as `"<model> on <host>"` (e.g. `zai-glm-52 on host:8000`).
 *
 * The host (including port) makes the id unique per (server, model) pair, so the
 * same model served from two servers yields two distinct entries — enabling manual
 * load balancing. The `vllmModelId` stays the raw wire identity; this is only the
 * extension-facing key (and the picker label when no `displayName` is set).
 */
export function buildModelId(serverUrl: string, vllmModelId: string): string {
  let host = serverUrl;
  try {
    host = new URL(normalizeServerUrl(serverUrl)).host; // host:port, path/scheme stripped
  } catch (err) {
    // Should not happen after normalizeServerUrl, but fall back to the raw string
    // if it does. The caller (provider.ts) will log the resulting model id as a
    // warning if discovery fails, so the user will see the issue.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[config] buildModelId URL parse failed for "${serverUrl}": ${reason}`);
  }
  return `${vllmModelId} on ${host}`;
}

/**
 * Strip quantization/format suffixes from a model ID for fuzzy matching.
 * e.g. "Qwen/Qwen3.6-27B-FP8" → "Qwen/Qwen3.6-27B"
 *      "Qwen/Qwen3.6-27B-GGUF" → "Qwen/Qwen3.6-27B"
 *
 * Quantization format doesn't affect inference parameters (temperature, top_p, etc.),
 * so configs for the base model should match all quantized variants.
 */
export function normalizeModelId(modelId: string): string {
  // Common quantization/format suffixes (order matters: check longer suffixes first).
  // Matching is case-insensitive — vLLM may serve "qwen3.6-27b-fp8" (lowercase)
  // while presets use "Qwen/Qwen3.6-27B-FP8".
  const suffixes = [
    '-GGUF', '-GPTQ', '-AWQ', '-AQLM', '-EAGLE',
    '-FP8', '-INT8', '-INT4', '-NF4',
    '-4bit', '-8bit',
  ];
  let normalized = modelId;
  for (const suffix of suffixes) {
    if (normalized.toLowerCase().endsWith(suffix.toLowerCase())) {
      normalized = normalized.slice(0, -suffix.length);
      break;
    }
  }
  return normalized;
}

/**
 * Find the user override that produced a given VS Code model id.
 *
 * `buildModelInfo` sets a model's id to `override.id || serverModel.id`, so an
 * override that only sets `vllmModelId` (no `id`) yields a model id equal to the
 * server id. Matching on `o.id` alone would miss those and silently drop the
 * model's `modelModes`, so we resolve via the vLLM model id too.
 *
 * Matching is fuzzy: quantization suffixes (-FP8, -AWQ, -GGUF, etc.) are stripped
 * before comparison, so a config for "Qwen/Qwen3.6-27B" also matches a server
 * running "Qwen/Qwen3.6-27B-FP8".
 */
export function resolveOverrideForModel(
  overrides: ModelConfig[],
  modelId: string
): ModelConfig | undefined {
  const normalized = normalizeModelId(modelId);
  return overrides.find(o => {
    const oId = o.id || resolveVllmModelId(o);
    if (!oId) return false;
    // Exact match first
    if (oId === modelId) return true;
    // Fuzzy match (quantization-agnostic)
    return normalizeModelId(oId) === normalized;
  });
}

/**
 * Resolve the effective server URL and request headers for a model.
 *
 * Every model is an independent server: its `requestHeaders` are used only for
 * its own server and never shared, so one server's credentials (e.g. a Cloudflare
 * Access secret) cannot leak to another. A model with no `serverUrl` yields an
 * empty URL — the caller is expected to skip such models (they are unreachable).
 */
export function resolveServerConfig(
  override: ModelConfig | undefined
): { serverUrl: string; requestHeaders: Record<string, string> } {
  return {
    serverUrl: override?.serverUrl ? normalizeServerUrl(override.serverUrl) : '',
    requestHeaders: override?.requestHeaders ? sanitizeRequestHeaders(override.requestHeaders) : {},
  };
}

/**
 * Ensure the server URL has a valid scheme. If the user types `localhost:8000`
 * instead of `http://localhost:8000`, prepend `http://` so `fetch()` doesn't
 * throw `TypeError: fetch failed` on an invalid URL.
 * Also strip trailing slashes so endpoint joins don't produce `//v1/...`.
 * Returns a warning string if the URL is invalid (e.g. `http://` with no host).
 */
export function normalizeServerUrl(url: string): string {
  if (!url) return 'http://localhost:8000';
  let normalized = url.trim();
  if (!normalized) return 'http://localhost:8000';

  // Already has a scheme
  if (!(normalized.startsWith('http://') || normalized.startsWith('https://'))) {
    // Missing scheme — default to http
    normalized = `http://${normalized}`;
  }

  // Validate that a host is present (http:// and https:// have no host)
  // by checking that there's at least one character after the scheme that
  // isn't a path separator.
  const schemeMatch = normalized.match(/^(?:https?:)\/\//);
  if (schemeMatch) {
    const afterScheme = normalized.slice(schemeMatch[0].length);
    if (!afterScheme || afterScheme.startsWith('/') || afterScheme.startsWith('?')) {
      // No host — mark URL as invalid so validateConfig can surface the warning.
      return 'http://localhost:8000';
    }
  }

  // Remove one or more trailing slashes, but keep scheme delimiter intact.
  while (normalized.endsWith('/') && !normalized.endsWith('://')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Build a full endpoint URL from a normalized base server URL and a path.
 * Ensures correct joining regardless of leading/trailing slashes.
 *
 * @param baseUrl - Normalized server URL (no trailing slash, e.g. `http://localhost:8000`)
 * @param path - Endpoint path (e.g. `/v1/models` or `v1/models`)
 * @returns Full URL string
 */
export function buildEndpoint(baseUrl: string, path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${cleanPath}`;
}

/**
 * Build the auth header for a vLLM request from an API key. The vLLM `--api-key`
 * check validates `Authorization: Bearer <key>`, so that is the single header we
 * emit. Other schemes (e.g. a gateway's `x-api-key` or Cloudflare Access headers)
 * are a separate concern — users add those as custom request headers. Returns an
 * empty object when no key is set.
 */
export function buildAuthHeaders(apiKey?: string): Record<string, string> {
  if (!apiKey) return {};
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

/**
 * Sanitize custom HTTP headers by stripping blocked names, invalid characters, and CRLF values.
 */
function sanitizeRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const blockedHeaders = new Set([
    'host', 'origin', 'cookie', 'connection', 'content-length',
    'transfer-encoding', 'upgrade', 'te', 'trailer',
  ]);
  const headerNameRe = /^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/;
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (blockedHeaders.has(key.toLowerCase())) continue;
    if (!headerNameRe.test(key)) continue;
    if (/\r|\n/.test(value)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

/**
 * Read configuration from VS Code settings.
 *
 * Only two genuine globals exist: the per-model `models` array and the
 * `enableFileLogging` diagnostic toggle. All server, auth, generation, token, and
 * transport settings are per-model and resolved at request time via
 * `resolveServerConfig` / `resolveRequestParams` / `resolveModelSettings`.
 */
export async function getConfig(_context: vscode.ExtensionContext): Promise<VllmConfig> {
  const section = vscode.workspace.getConfiguration('vllm-copilot');

  return {
    models: section.get<ModelConfig[]>('models') || [],
    enableFileLogging: section.get<boolean>('enableFileLogging') ?? false,
  };
}

/**
 * Validate config values and return warnings for clearly invalid settings.
 * This is non-blocking — invalid values still pass through but the user is informed.
 * Everything is per-model now, so we iterate the model list and validate each
 * model's typed settings plus its `defaultParams` and `modelModes` request params.
 */
export function validateConfig(config: VllmConfig): string[] {
  const warnings: string[] = [];

  // Check for duplicate ids across the model array. Duplicate ids cause VS Code
  // to behave unpredictably (one entry silently shadows the other).
  const seenIds = new Set<string>();
  for (const model of config.models) {
    const id = model.id || model.vllmModelId || '(unnamed model)';
    if (seenIds.has(id)) {
      warnings.push(`Model "${id}": duplicate id — each model entry must have a unique id.`);
    }
    seenIds.add(id);

    if (!model.serverUrl) {
      warnings.push(`Model "${id}" has no serverUrl and cannot be reached. Add a serverUrl or run "Add vLLM Server & Model".`);
    } else {
      // Warn if normalizeServerUrl silently fell back to localhost (empty host after scheme).
      const trimmed = model.serverUrl.trim();
      const afterScheme = trimmed.replace(/^https?:\/\//, '');
      if ((trimmed.startsWith('http://') || trimmed.startsWith('https://')) &&
          (!afterScheme || afterScheme.startsWith('/') || afterScheme.startsWith('?'))) {
        warnings.push(`Model "${id}": serverUrl "${model.serverUrl}" is invalid (no host) — falling back to http://localhost:8000.`);
      }
    }

    const settings = resolveModelSettings(model);
    if (settings.maxOutputTokens <= 0) {
      warnings.push(`Model "${id}": maxOutputTokens is ${settings.maxOutputTokens}; should be > 0.`);
    }
    if (settings.estimateCharsPerToken <= 0) {
      warnings.push(`Model "${id}": estimateCharsPerToken is ${settings.estimateCharsPerToken}; should be > 0.`);
    }
    if (settings.streamInactivityTimeout < 0) {
      warnings.push(`Model "${id}": streamInactivityTimeout is ${settings.streamInactivityTimeout}ms; should be >= 0 (0 = disabled).`);
    }
    if (settings.autoContinueRetries < 0) {
      warnings.push(`Model "${id}": autoContinueRetries is ${settings.autoContinueRetries}; should be >= 0.`);
    }

    // Validate request params at model scope and each mode scope.
    warnings.push(...validateRequestParams(model.defaultParams, `Model "${id}" defaultParams`));

    // Warn if defaultMode doesn't match any key in modelModes.
    if (model.defaultMode && model.modelModes) {
      const modeKeys = Object.keys(model.modelModes);
      if (!modeKeys.includes(model.defaultMode)) {
        warnings.push(
          `Model "${id}": defaultMode "${model.defaultMode}" is not a valid mode — ` +
          `available modes are: ${modeKeys.map(k => `"${k}"`).join(', ')}.`
        );
      }
    }

    for (const [modeName, modeParams] of Object.entries(model.modelModes ?? {})) {
      warnings.push(...validateRequestParams(modeParams, `Model "${id}" mode "${modeName}"`));
    }
  }

  return warnings;
}

/** Validate common sampling params inside a raw request-params object (defaultParams or a mode). */
function validateRequestParams(params: Record<string, unknown> | undefined, label: string): string[] {
  if (!params) return [];
  const warnings: string[] = [];
  const num = (k: string): number | undefined => (typeof params[k] === 'number' ? params[k] as number : undefined);

  const temperature = num('temperature');
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
    warnings.push(`${label}: temperature is ${temperature}; typical range is 0.0–2.0.`);
  }
  const topP = num('top_p');
  if (topP !== undefined && (topP < 0 || topP > 1)) {
    warnings.push(`${label}: top_p is ${topP}; should be 0.0–1.0.`);
  }
  const topK = num('top_k');
  if (topK !== undefined && topK !== -1 && topK < 1) {
    warnings.push(`${label}: top_k is ${topK}; should be -1 (unset) or >= 1.`);
  }
  const minP = num('min_p');
  if (minP !== undefined && (minP < 0 || minP > 1)) {
    warnings.push(`${label}: min_p is ${minP}; should be 0.0–1.0.`);
  }
  const repetitionPenalty = num('repetition_penalty');
  if (repetitionPenalty !== undefined && (repetitionPenalty < 0.01 || repetitionPenalty > 2)) {
    warnings.push(`${label}: repetition_penalty is ${repetitionPenalty}; typical range is 0.01–2.0.`);
  }

  return warnings;
}


