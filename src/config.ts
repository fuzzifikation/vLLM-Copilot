import * as path from 'path';
import * as vscode from 'vscode';
import type { WireStructuredOutputConfig } from './types.js';

export type StructuredOutputConfig = WireStructuredOutputConfig;

/**
 * The backend that serves this model. Every model targets its own server; the
 * backend determines which metadata endpoint yields its served context window
 * and which request fields are adapted.
 *
 * Missing `serverType` ALWAYS means vLLM (intentional product policy — every
 * released configuration is vLLM). Secondary backends are explicit opt-in via
 * the Add Server flow or manual config.
 */
export type ServerType = 'vllm' | 'lmstudio' | 'llamacpp' | 'ollama';

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
   * Backend serving this model: `vllm` (default), `lmstudio`, `llamacpp`, or
   * `ollama`. Missing/omitted ALWAYS means `vllm`. Set by the Add Server
   * flow after detection, or manually for a secondary backend. Used to select the
   * required context endpoint and request adaptation — never guessed at runtime.
   */
  serverType?: ServerType;
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
   * The personality picker stores an absolute path into global storage
   * (`personalities/`); relative paths (e.g. `.vllm/prompt-replacements.json`)
   * are resolved against the workspace root and remain valid for custom files.
   */
  systemMessageReplacementsFile?: string;
  /**
   * Optional per-model cost rates for the dashboard usage tracker.
   * All rates are per 1,000,000 tokens and interpreted IN `currency` units.
   * Cost is derived at render time from these rates + stored token counts —
   * never stored — so editing a rate re-prices all history without migration.
   */
  cost?: {
    /** Cost per 1,000,000 fresh (uncached) input tokens. */
    input?: number;
    /** Cost per 1,000,000 output tokens (includes reasoning tokens). */
    output?: number;
    /** Cost per 1,000,000 cache-read input tokens. */
    cachedInput?: number;
    /**
     * Display unit for the rates. Default `"USD"`. Use `"AI Credits"` to compare
     * with the Copilot model picker (1 credit = $0.01 — enter credit values
     * directly; no conversion is applied).
     */
    currency?: string;
  };
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
  temperature: 1.0,
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
 * This is the WIRE identity — it is only used for requests to vLLM (and for
 * informational display). Everything else keys on {@link resolveConfigId}.
 */
export function resolveVllmModelId(override: ModelConfig | undefined): string | undefined {
  return override?.vllmModelId || override?.id;
}

/**
 * Resolve the backend type for a model. A missing field ALWAYS means `vllm` —
 * every released configuration is vLLM; secondary backends must opt in.
 */
export function resolveServerType(model?: ModelConfig): ServerType {
  return model?.serverType ?? 'vllm';
}

/**
 * Resolve a (possibly relative) file path against the first workspace folder.
 *
 * Single shared implementation for `systemMessageReplacementsFile` resolution
 * (used by {@link provider} `loadReplacements` and
 * `personalityStore.resolveActivePersonality`). `path.resolve` handles every
 * case in one call:
 * - absolute path → returned normalized
 * - relative path + open workspace → joined against the first workspace root
 * - relative path + no workspace → resolved against the process cwd (Node default)
 *
 * Keeping this in one place means the two call sites can never drift.
 */
export function resolveWorkspaceRelativePath(value: string): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return path.resolve(root, value);
}

/**
 * Resolve the extension-side identity of a model config: its unique `id`, falling
 * back to the vLLM wire id for legacy hand-written entries that predate the id
 * scheme. This is the key used for personalities, the webview, and config
 * updates. It is deliberately NOT the vLLM request id — use
 * {@link resolveVllmModelId} for that.
 */
export function resolveConfigId(override: ModelConfig | undefined): string | undefined {
  return override?.id || resolveVllmModelId(override);
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
 * Find the user override that produced a given VS Code model id.
 *
 * `buildModelInfo` sets a model's id to `override.id`, or — for id-less configs —
 * to a composite derived from `(serverUrl, vllmModelId)` via `buildModelId`
 * (`"<model> on <host>"`). The composite is what makes the same vLLM model on two
 * servers show as two distinct picker entries; this matcher round-trips it back
 * to the id-less config that produced it. An override that only sets `vllmModelId`
 * (no `id`) also yields a model id equal to the server id, so we resolve via the
 * vLLM model id too — matching on `o.id` alone would silently drop the model's
 * `modelModes`.
 *
 * Matching is EXACT ONLY — no fuzzy tiers, no quantization stripping, no
 * cross-org keys. `vllmModelId` is a wire identity: it must exactly equal one
 * of the server's served model ids. The picker id is unique and deduped by
 * construction, and every extension write path stores the exact served id, so
 * exact matching always finds the config. A mismatch means the user hand-edited a
 * config to violate the contract (pointing `vllmModelId` at a name the server
 * does not serve) — that must fail loudly at discovery/T&R, not be silently
 * forgiven and replayed as a request the server will reject.
 *
 * Matching is in tiers:
 * 1. Exact: config key equals the model id.
 * 2. Composite round-trip: an id-less config whose derived `buildModelId` equals
 *    the model id. Only id-less configs participate, so an id'd config that shares
 *    the same wire id + server is never matched by another config's composite.
 */
export function resolveOverrideForModel(
  overrides: ModelConfig[],
  modelId: string
): ModelConfig | undefined {
  return overrides.find(o => {
    const oId = o.id || resolveVllmModelId(o);
    if (!oId) return false;
    // Exact match first
    if (oId === modelId) return true;
    // Composite round-trip: match a derived "<model> on <host>" id back to the
    // id-less config that discovery assigned it to.
    return !o.id && o.serverUrl && buildModelId(o.serverUrl, oId) === modelId;
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
 * instead of `http://localhost:8000`, prepend a scheme so `fetch()` doesn't
 * throw `TypeError: fetch failed` on an invalid URL.
 * Heuristic: if the host includes an explicit port (e.g. `host:8000`) we
 * default to `http://` (likely a raw vLLM server); otherwise `https://`
 * (likely a reverse proxy).
 * Also strip trailing slashes and trailing `/v1` so endpoint joins don't
 * produce `//v1/...` or `/v1/v1/models`. The extension adds `/v1` itself
 * when constructing requests, so a user-provided `/v1` suffix is redundant.
 * Returns a warning string if the URL is invalid (e.g. `http://` with no host).
 */
export function normalizeServerUrl(url: string): string {
  if (!url) return 'http://localhost:8000';
  let normalized = url.trim();
  if (!normalized) return 'http://localhost:8000';

  // Already has a scheme
  if (!(normalized.startsWith('http://') || normalized.startsWith('https://'))) {
    // Missing scheme — detect scheme by whether the host has an explicit port.
    // Has port (e.g. host:8000) → http:// (raw vLLM). No port → https:// (reverse proxy).
    const hostPart = normalized.split(/[\/?]/)[0];
    const scheme = /\:\d+$/.test(hostPart) ? 'http' : 'https';
    normalized = `${scheme}://${normalized}`;
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

  // Strip a trailing /v1 path segment. Users commonly copy the OpenAI base URL
  // (e.g. https://api.openai.com/v1) but the extension appends /v1 itself.
  if (normalized.endsWith('/v1')) {
    normalized = normalized.slice(0, -3);
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
 *
 * ⚠️ **Scope: write/migration paths only.** This function is used only by the
 * Add Server and Update Auth commands (`commands/addServerFlow.ts`, `commands.ts`) to
 * construct headers from user-provided key input. Runtime chat requests do
 * NOT call this — auth comes from the per-model `requestHeaders` in settings.
 * Wiring this into runtime code would silently add or omit the wrong headers.
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

  // The extension's unique model key is `id` — it is what personalities, the
  // webview, and config updates all use. It must be present and unique. Two
  // presets may legitimately share a `vllmModelId` (same model on different
  // servers or as separate presets), so uniqueness is enforced on `id`, not the
  // wire id.
  const seenIds = new Set<string>();
  for (const model of config.models) {
    const display = model.id || model.vllmModelId || '(unnamed model)';
    const id = model.id?.trim();
    if (!id) {
      warnings.push(
        `Model "${display}": missing id — each model entry must have a unique id (the extension key for personalities and settings).`
      );
    } else {
      if (seenIds.has(id)) {
        warnings.push(`Model "${display}": duplicate id — each model entry must have a unique id.`);
      }
      seenIds.add(id);
    }

    if (!model.serverUrl) {
      warnings.push(`Model "${display}" has no serverUrl and cannot be reached. Add a serverUrl or run "Add vLLM Server & Model".`);
    } else {
      // Warn if normalizeServerUrl silently fell back to localhost (empty host after scheme).
      const trimmed = model.serverUrl.trim();
      const afterScheme = trimmed.replace(/^https?:\/\//, '');
      if ((trimmed.startsWith('http://') || trimmed.startsWith('https://')) &&
          (!afterScheme || afterScheme.startsWith('/') || afterScheme.startsWith('?'))) {
        warnings.push(`Model "${display}": serverUrl "${model.serverUrl}" is invalid (no host) — falling back to http://localhost:8000.`);
      }
    }

    // serverType must be a known backend when present. Missing always means vLLM.
    if (model.serverType !== undefined && !['vllm', 'lmstudio', 'llamacpp', 'ollama'].includes(model.serverType)) {
      warnings.push(
        `Model "${display}": serverType "${model.serverType}" is not a supported backend ` +
        `(expected "vllm", "lmstudio", "llamacpp", or "ollama").`
      );
    }

    const settings = resolveModelSettings(model);
    if (settings.maxOutputTokens <= 0) {
      warnings.push(`Model "${display}": maxOutputTokens is ${settings.maxOutputTokens}; should be > 0.`);
    }
    if (settings.estimateCharsPerToken <= 0) {
      warnings.push(`Model "${display}": estimateCharsPerToken is ${settings.estimateCharsPerToken}; should be > 0.`);
    }
    if (settings.streamInactivityTimeout < 0) {
      warnings.push(`Model "${display}": streamInactivityTimeout is ${settings.streamInactivityTimeout}ms; should be >= 0 (0 = disabled).`);
    }
    if (settings.autoContinueRetries < 0) {
      warnings.push(`Model "${display}": autoContinueRetries is ${settings.autoContinueRetries}; should be >= 0.`);
    }

    // Validate request params at model scope and each mode scope.
    warnings.push(...validateRequestParams(model.defaultParams, `Model "${display}" defaultParams`));

    // Warn if defaultMode doesn't match any key in modelModes.
    if (model.defaultMode && model.modelModes) {
      const modeKeys = Object.keys(model.modelModes);
      if (!modeKeys.includes(model.defaultMode)) {
        warnings.push(
          `Model "${display}": defaultMode "${model.defaultMode}" is not a valid mode — ` +
          `available modes are: ${modeKeys.map(k => `"${k}"`).join(', ')}.`
        );
      }
    }

    for (const [modeName, modeParams] of Object.entries(model.modelModes ?? {})) {
      warnings.push(...validateRequestParams(modeParams, `Model "${display}" mode "${modeName}"`));
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

/**
 * Find the index of a model in the array by its extension `id` and server URL.
 * Matching is on the unique config key ({@link resolveConfigId}) — NOT the vLLM
 * wire id, since several presets may share a `vllmModelId`. Uses normalized URL
 * comparison. Returns -1 if no match is found.
 *
 * Shared by {@link replaceModelConfig} (configStore.ts) and the webview's patch
 * path (serverSettingsView.ts) so matching logic stays in one place.
 */
export function findModelConfigIndex(
  models: ModelConfig[],
  configId: string,
  serverUrl: string,
): number {
  const normalizedUrl = normalizeServerUrl(serverUrl);
  return models.findIndex(m => {
    if (!m.serverUrl) return false;
    return resolveConfigId(m) === configId && normalizeServerUrl(m.serverUrl) === normalizedUrl;
  });
}

/**
 * Locate a model config by `(serverUrl, wire modelId)` — the id the usage
 * tracker keys on (`vllmModelId`, or legacy `id` when `vllmModelId` is unset).
 * Returns undefined when no configured entry matches. Shared by the dashboard
 * (cost lookup + display-name labeling) so wire-id matching stays in one place.
 *
 * Distinct from {@link findModelConfigIndex}, which matches on the extension
 * identity (`resolveConfigId`: `id` or `vllmModelId`) for config writes.
 */
export function findModelConfig(
  models: ModelConfig[],
  serverUrl: string,
  modelId: string,
): ModelConfig | undefined {
  const normalized = normalizeServerUrl(serverUrl);
  return models.find(m =>
    resolveVllmModelId(m) === modelId
    && normalizeServerUrl(m.serverUrl ?? '') === normalized
  );
}

/**
 * Fields whose empty-string value is an explicit "clear" signal (mapped to
 * deletion by {@link normalizeModelEntry}). The webview's form cannot express
 * "remove this key" except via the empty-string signal, so every clearable
 * scalar field participates. Checked with `=== ''` — NOT truthiness — so a
 * legitimate `0` (e.g. `streamInactivityTimeout: 0` = wait indefinitely)
 * survives. `systemMessageReplacementsFile` is a string, so `''` is its only
 * empty form and it is covered by the same rule.
 */
const CLEARABLE_ON_EMPTY: readonly (keyof ModelConfig)[] = [
  'displayName',
  'serverType',
  'maxOutputTokens',
  'maxInputTokens',
  'estimateCharsPerToken',
  'streamInactivityTimeout',
  'autoContinueRetries',
  'defaultMode',
  'defaultParams',
  'systemMessageReplacementsFile',
] as const;

/**
 * Normalize a model config entry for storage: an empty-string value on any
 * {@link CLEARABLE_ON_EMPTY} field (e.g. `''` on `displayName`, or `''` on
 * `defaultParams` after every param is removed) is removed rather than
 * persisted as `""`. An absent key is left alone — on merge that preserves the
 * previous value, which is what makes "undefined preserves, '' clears" work in
 * both save paths.
 *
 * Shared by {@link replaceModelConfig} (configStore.ts) and the webview's patch
 * path (serverSettingsView.ts) so the clear semantics live in one place. Mutates
 * and returns the entry (callers always pass a freshly-built object).
 */
export function normalizeModelEntry(entry: ModelConfig): ModelConfig {
  const rec = entry as unknown as Record<string, unknown>;
  for (const k of CLEARABLE_ON_EMPTY) {
    if (rec[k] === '') delete rec[k];
  }
  return entry;
}
