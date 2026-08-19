import * as vscode from 'vscode';
import { getConfig, buildEndpoint, DEFAULT_MODEL_SETTINGS, type VllmConfig, type ServerType } from './config.js';
import { fetchWithRetry } from './fetchRetry.js';
import { readSseStream } from './streamReader.js';
import { FileLogger } from './logger.js';
import { describeError } from './messageConverter.js';
import { isOpenRouterUrl, resolveOpenRouterRuntimeLimits } from './openRouter.js';
import type { ServerConfig } from './provider/requestBuilder.js';
import type { StreamEvent, VllmChatOptions, OpenAIChatMessage, VllmModel, LmStudioModel, RuntimeModelLimits } from './types.js';
export type { StreamEvent, VllmChatOptions, OpenAIChatMessage, VllmModel } from './types.js';

/**
 * Timeout for metadata/detection GETs (context resolution, Add Server probes).
 * Guards against an unresponsive endpoint blocking provider discovery or the
 * Add Server flow indefinitely. An AbortError is NOT an "invalid signature" —
 * it propagates immediately (never retried, never treated as "keep probing").
 */
const METADATA_TIMEOUT_MS = 10000;

/**
 * Overall budget for the initial chat POST to receive response headers.
 * fetch and fetchWithRetry have no deadline of their own, so without this a server
 * that accepts the connection but never answers would hang the request forever.
 * Default is 600000ms, overridable per model via `initialResponseTimeoutMs`
 * (0 = disabled). Resolved at request time in {@link chatCompletionStream}.
 */

/**
 * True when `err` is an HTTP 404 (probe "endpoint not served here" signal).
 * fetchWithRetry throws `HTTP 404: <text> — <body>` for non-5xx statuses.
 */
function isHttp404(err: unknown): boolean {
  return err instanceof Error && /^HTTP\s+404\b/.test(err.message);
}

/**
 * True when a probe failed in a way that means "this signature is not served
 * here" — HTTP 404 (no such route) or a non-JSON body (200 HTML, etc.).
 * Both are invalid-signature signals: REJECT this signature and keep probing.
 * Transport / auth / timeout / 5xx errors are NOT — they throw immediately.
 */
function isInvalidSignature(err: unknown): boolean {
  return isHttp404(err) || err instanceof SyntaxError;
}

/**
 * Resolve a model's runtime limits for a KNOWN backend (strict switch — never
 * probes). Single source of truth; `VllmClient.getModelContextWindow`,
 * auto-configure and test & refresh all call this. Backends that report only a
 * context window leave `maxOutputTokens` undefined.
 *
 * @throws Backend-specific, actionable error naming the backend, the endpoint+field
 *   inspected, and the concrete fix. We NEVER fabricate a window.
 */
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
      // Exact wire-id matching only — the configured `vllmModelId` must be one of
      // the server's served model ids. No quantization stripping, no cross-org
      // keys, no root-alias forgiveness. The extension's own write paths always
      // store the exact served id, so a mismatch is a hand-edited config that
      // violates the contract — it must fail loudly, not be silently forgiven and
      // replayed as a request the server will reject.
      const model = (data.data || []).find((m) => m.id === modelId);
      const ctx = model?.max_model_len;
      if (typeof ctx === 'number' && ctx > 0) return { contextWindow: ctx };
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
      const lm = (data.models || []).find((m) => m.key === modelId || m.id === modelId);
      const ctx = lm?.loaded_instances?.[0]?.config?.context_length ?? lm?.max_context_length;
      if (typeof ctx === 'number' && ctx > 0) return { contextWindow: ctx };
      throw new Error(
        `LM Studio model "${modelId}" has no context window: GET ${url} reported no loaded instance ` +
        `with config.context_length (or max_context_length). Load the model in LM Studio — it will not be served.`
      );
    }
    case 'llamacpp': {
      const url = buildEndpoint(serverUrl, `props?model=${encodeURIComponent(modelId)}`);
      const data = await fetchJsonRaw<{ default_generation_settings?: { n_ctx?: number } }>(url, requestHeaders);
      const ctx = data.default_generation_settings?.n_ctx;
      if (typeof ctx === 'number' && ctx > 0) return { contextWindow: ctx };
      throw new Error(
        `llama.cpp model "${modelId}" has no context window: GET ${url} reported no ` +
        `default_generation_settings.n_ctx. Check the server API key and model id — it will not be served.`
      );
    }
    case 'ollama': {
      const url = buildEndpoint(serverUrl, 'api/ps');
      const data = await fetchJsonRaw<{ models?: Array<{ model?: string; name?: string; context_length?: number }> }>(url, requestHeaders);
      const entry = (data.models || []).find((m) => m.model === modelId || m.name === modelId);
      const ctx = entry?.context_length;
      if (typeof ctx === 'number' && ctx > 0) return { contextWindow: ctx };
      throw new Error(
        `Ollama model "${modelId}" is not loaded (or reports no context_length): GET ${url}. ` +
        `Load the model with a context size in Ollama — it will not be served.`
      );
    }
    case 'openrouter': {
      // OpenRouter is a fixed managed remote — the module owns the API base, so
      // `serverUrl` is deliberately ignored here. `modelId` is the full requested
      // wire id (variants like `:free` preserved); the module strips the variant
      // for the metadata lookup and keeps it for chat.
      return resolveOpenRouterRuntimeLimits(modelId, requestHeaders);
    }
  }
}

/**
 * Classify a server by probing its documented signatures, FIRST-MATCH-WINS in this order:
 *
 *   1. /v1/models   entry with positive max_model_len           → 'vllm'
 *   2. /v1/models   entry with owned_by === 'llamacpp'      → 'llamacpp'
 *   3. /api/v1/models  with models[].key shape                → 'lmstudio'
 *   4. /api/ps        with models[] shape                      → 'ollama'
 *
 * Probing rules: 404 = endpoint not served here → continue. 200 with a structurally
 * invalid shape = that signature is rejected → continue. 200 with a valid shape but the
 * model not listed = continue. Auth / network / timeout / 5xx = throw immediately.
 * No match anywhere = throw "unsupported server" naming every expected signature.
 *
 * Add Server ONLY. Never used at runtime — runtime uses {@link resolveRuntimeLimits}.
 */
export async function detectServerType(
  serverUrl: string,
  requestHeaders: Record<string, string> = {},
  modelId: string,
): Promise<ServerType> {
  // 0. OpenRouter is a fixed managed remote, identified by HOST before any probe.
  //    Its `/v1/models` catalog and metadata endpoints are public, but the
  //    local-signature probes below (`/api/v1/models`, `/api/ps`) 404 on it —
  //    without this arm the Add flow would throw "Unsupported server".
  if (isOpenRouterUrl(serverUrl)) return 'openrouter';

  // 1+2. OpenAI /v1/models (vLLM, llama.cpp, LM Studio all serve it).
  let v1: { data?: VllmModel[] };
  try {
    v1 = await fetchJsonRaw<{ data?: VllmModel[] }>(buildEndpoint(serverUrl, 'v1/models'), requestHeaders);
  } catch (err) {
    if (!isInvalidSignature(err)) throw err;
    v1 = {};
  }
  const model = (v1.data || []).find((m) => m.id === modelId || m.root === modelId);
  if (model?.max_model_len) return 'vllm';
  if (model?.owned_by === 'llamacpp') return 'llamacpp';

  // 3. LM Studio metadata endpoint.
  try {
    const lm = await fetchJsonRaw<{ models?: LmStudioModel[] }>(buildEndpoint(serverUrl, 'api/v1/models'), requestHeaders);
    if (Array.isArray(lm.models)) {
      const entry = lm.models.find((m) => m.key === modelId || m.id === modelId);
      if (entry) return 'lmstudio';
      // Valid LM Studio shape but model not listed → not it; keep probing.
    }
    // 200 with a non-models shape → not LM Studio; keep probing.
  } catch (err) {
    if (!isInvalidSignature(err)) throw err;
  }

  // 4. Ollama loaded-models endpoint.
  try {
    const ps = await fetchJsonRaw<{ models?: Array<{ model?: string; name?: string }> }>(buildEndpoint(serverUrl, 'api/ps'), requestHeaders);
    if (Array.isArray(ps.models)) {
      const entry = ps.models.find((m) => m.model === modelId || m.name === modelId);
      if (entry) return 'ollama';
      // Valid Ollama shape but model not listed → not it; keep probing.
    }
    // 200 with a non-models shape → not Ollama.
  } catch (err) {
    if (!isInvalidSignature(err)) throw err;
  }

  throw new Error(
    `Unsupported server at ${serverUrl}: expected vLLM (/v1/models with max_model_len), ` +
    `llama.cpp (owned_by "llamacpp"), LM Studio (/api/v1/models with models[].key), or ` +
    `Ollama (/api/ps with models[]), or OpenRouter (openrouter.ai host). No documented signature matched model "${modelId}".`
  );
}

/**
 * Classify a server from an ALREADY-FETCHED `/v1/models` `data` array — no probing.
 * FIRST-MATCH-WINS over the documented /v1/models signals only:
 *   any entry with positive max_model_len → 'vllm'
 *   any entry with owned_by === 'llamacpp' → 'llamacpp'
 * Returns undefined when neither signal is present. LM Studio and Ollama expose
 * their own endpoints; from /v1/models alone there is no honest signal for them,
 * so we return nothing rather than guess.
 *
 * Used by the Server Settings add path to default `serverType` for unconfigured
 * server models. Runtime never calls this — runtime uses {@link resolveRuntimeLimits}.
 */
export function detectServerTypeFromV1Models(
  entries: Array<{ owned_by?: string; max_model_len?: number }>
): ServerType | undefined {
  if (entries.some((m) => typeof m.max_model_len === 'number' && m.max_model_len > 0)) {
    return 'vllm';
  }
  if (entries.some((m) => m.owned_by === 'llamacpp')) {
    return 'llamacpp';
  }
  return undefined;
}

/** Bare JSON GET for the standalone resolver/detector (no logger, no retry callbacks). */
async function fetchJsonRaw<T>(url: string, requestHeaders: Record<string, string>): Promise<T> {
  const response = await fetchWithRetry(
    url,
    { method: 'GET', signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) },
    requestHeaders
  );
  return await response.json() as T;
}

/** Keys in the chat completion body that must not be overwritten by options spread. */
const PROTECTED_BODY_KEYS = new Set(['model', 'messages', 'stream', 'stream_options']);

export class VllmClient {
  /**
   * Cached config as a Promise, not the value itself. If two callers invoke
   * getConfigCached() simultaneously on cold start, both see the same promise
   * instead of racing to fetch. On rejection the promise is invalidated so
   * the next call retries. On settings change invalidateConfigCache() clears it.
   */
  private cachedConfigPromise: Promise<VllmConfig> | null = null;

  /** Warn about the Ollama tool_choice drop only once per session, not per request. */
  private warnedOllamaToolChoice = false;

  constructor(
    private context: vscode.ExtensionContext,
    private output: vscode.OutputChannel,
    private fileLogger?: FileLogger
  ) {}

  /**
   * Get cached config. This client is the single owner of the cached config;
   * the provider reads config through here rather than maintaining its own copy.
   * Config rarely changes mid-session; caching avoids repeated async disk I/O
   * on every request.
   * Cache is invalidated via invalidateConfigCache() on settings change.
   *
   * Uses a Promise-based cache so concurrent callers on cold start share the
   * same in-flight fetch instead of thundering-herding 100+ disk reads.
   */
  async getConfigCached(): Promise<VllmConfig> {
    if (this.cachedConfigPromise === null) {
      this.cachedConfigPromise = getConfig(this.context).catch(err => {
        // Invalidate on failure so the next caller retries.
        this.cachedConfigPromise = null;
        throw err;
      });
    }
    return this.cachedConfigPromise;
  }

  /**
   * Invalidate the config cache (e.g. after settings change).
   */
  invalidateConfigCache(): void {
    this.cachedConfigPromise = null;
  }

  /** Shared retry callbacks used by getModelContextWindow and chatCompletionStream. */
  private get retryCallbacks(): { onRetry: (error: string) => void; onRetrySuccess: (status: number) => void } {
    return {
      onRetry: (error) => this.output.appendLine(`[WARN] ${error}, retrying in 1500ms…`),
      onRetrySuccess: (status) => this.output.appendLine(`[INFO] Retry succeeded — received HTTP ${status}`),
    };
  }

  /**
   * Resolve a model's runtime limits (context window + optional output ceiling)
   * from its server, switching strictly on the configured `serverType` — never
   * probing at runtime:
   *
   *   vllm      → /v1/models            max_model_len
   *   lmstudio  → /api/v1/models        loaded_instances[].config.context_length else max_context_length
   *   llamacpp  → /props                default_generation_settings.n_ctx (router: ?model=<encoded>)
   *   ollama    → /api/ps              models[].context_length (LOADED only)
   *
   * **Policy (user directive): we never fabricate metadata.** If the server is alive
   * but the standard documented path for that backend does not yield a context window,
   * this THROWS a clear, backend-specific error and discovery skips the model.
   * There is no fallback window, no synthetic budget, no cross-backend cascade.
   * Connection / auth / 5xx failures also propagate — a dead or misconfigured
   * server must never surface as a crippled model.
   *
   * Wraps the standalone {@link resolveRuntimeLimits} (single source of truth) so
   * non-provider consumers (auto-configure, test & refresh) reuse the exact same
   * implementation without a client instance.
   *
   * @throws Backend-specific, actionable error when the server is unreachable or the
   *   standard path reports no window.
   */
  async getModelContextWindow(
    serverType: ServerType,
    serverUrl: string,
    requestHeaders: Record<string, string> = {},
    vllmModelId: string
  ): Promise<RuntimeModelLimits> {
    return resolveRuntimeLimits(serverType, serverUrl, requestHeaders, vllmModelId);
  }

  /**
   * Stream chat completion from the vLLM server.
   *
   * Returns structured `StreamEvent` objects with accumulated tool calls.
   *
   * @param model - Model ID
   * @param messages - OpenAI-format messages
   * @param options - Sampling parameters (standard + vLLM extras)
   * @param token - Cancellation token
   * @param serverConfig - Per-model server config: url, isolated request headers,
   *   and the per-model stream inactivity timeout.
   */
  async *chatCompletionStream(
    model: string,
    messages: OpenAIChatMessage[],
    options: VllmChatOptions,
    token: vscode.CancellationToken,
    serverConfig?: ServerConfig
  ): AsyncGenerator<StreamEvent> {
    const url = buildEndpoint(serverConfig?.serverUrl ?? '', 'v1/chat/completions');

    // Build body, filtering out undefined values.
    // Guard: never let options overwrite critical request fields.
    // modelOptions from Copilot can carry arbitrary keys — if one collides with
    // 'messages' it will corrupt the request (vLLM TextEncodeInput error).
    const body = this.buildChatBody(model, messages, options, serverConfig?.serverType ?? 'vllm');

    const controller = new AbortController();
    const onCancellation = token.onCancellationRequested(() => {
      controller.abort('User cancelled');
    });

    // Stream inactivity timeout: abort if server stops sending data.
    // 0 = disabled (wait indefinitely). Measured via read() timing, not wall-clock,
    // so it is not affected by generator pauses during tool execution.
    const inactivityMs = serverConfig?.streamInactivityTimeout ?? DEFAULT_MODEL_SETTINGS.streamInactivityTimeout;
    // Budget for the initial POST to receive response headers. 0 = disabled.
    const initialResponseMs = serverConfig?.initialResponseTimeoutMs ?? DEFAULT_MODEL_SETTINGS.initialResponseTimeoutMs;
    // For the initial fetch (pre-stream), we still need a timer because there is
    // no read() call yet. Once streaming starts, readSseStream takes over.
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const resetPreFetchInactivity = () => {
      if (inactivityMs <= 0) return;
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        controller.abort(`Stream inactivity timeout (${inactivityMs}ms without data)`);
      }, inactivityMs);
    };
    // Do NOT start the pre-fetch timer yet — fetchWithRetry has a 1.5s retry sleep,
    // and starting the timer before fetchWithRetry would fire during that sleep,
    // aborting the retry. Start the timer only after fetchWithRetry returns successfully.

    // Overall bound on the initial POST itself. Unlike the pre-fetch inactivity timer
    // (which is disabled for inactivityMs=0 and must not fire during the 1.5s retry
    // sleep), this is a fixed generous budget that starts before fetchWithRetry and is
    // cleared the moment headers arrive; readSseStream then takes over for
    // time-to-first-data. Cleared in finally on every path.
    let initialResponseTimer: ReturnType<typeof setTimeout> | undefined;

    // Log request-relevant params for debugging
    const requestKeys = ['chat_template_kwargs', 'temperature', 'top_p', 'top_k', 'presence_penalty', 'bad_words', 'ignore_eos', 'repetition_detection', 'structured_outputs'];
    const requestParams = Object.fromEntries(requestKeys.filter(k => k in body).map(k => [k, body[k]]));
    if (Object.keys(requestParams).length > 0) {
      this.output.appendLine(`[DEBUG] Request params: ${JSON.stringify(requestParams)}`);
    }

    // Validate messages before sending — catches corrupted requests early
    // rather than getting an opaque TextEncodeInput error from vLLM.
    this.validateMessages(body.messages);

    // Log request with headers
    const allHeaders = { ...serverConfig?.requestHeaders, 'Content-Type': 'application/json' };
    this.fileLogger?.logRequest('POST', url, allHeaders, body);

    try {
      if (initialResponseMs > 0) {
        initialResponseTimer = setTimeout(() => {
          controller.abort(`Initial request timed out after ${initialResponseMs}ms without a response`);
        }, initialResponseMs);
      }

      const response = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
        serverConfig?.requestHeaders ?? {},
        this.retryCallbacks.onRetry,
        this.retryCallbacks.onRetrySuccess
      );

      // Headers arrived — the initial-response budget is spent; the inactivity
      // timer now governs time-to-first-data.
      clearTimeout(initialResponseTimer);
      // Now start the pre-fetch timer — fetch succeeded, so if the server doesn't
      // begin streaming data within inactivityMs, abort.
      resetPreFetchInactivity();

      if (!response.body) {
        throw new Error('No response body from server');
      }

      await this.checkResponseContentType(response);

      // Clear pre-fetch timer — streaming takes over inactivity detection
      clearTimeout(inactivityTimer);

      // Delegate SSE parsing to a separate generator.
      // Errors from fetch/SSE parsing propagate directly to provider.ts
      // which has full context for logging and user-facing error display.
      yield* readSseStream(response.body.getReader(), token, {
        inactivityMs,
        fileLogger: this.fileLogger,
      });
    } catch (err) {
      // Log failed requests to the file logger so they're diagnosable
      // (network errors, 401/403, timeouts — anything that prevents streaming).
      const errMsg = err instanceof Error ? err.message : String(err);
      const status = errMsg.match(/HTTP\s+(\d+)/)?.[1];
      this.fileLogger?.logError('POST', url, status ? parseInt(status, 10) : 0, errMsg);
      throw err;
    } finally {
      clearTimeout(initialResponseTimer);
      clearTimeout(inactivityTimer);
      onCancellation.dispose();
    }
  }

  /**
   * Build the chat completion request body, guarding protected keys from overwrite.
   *
   * This is the **moat seam** — every vLLM-specific sampling param (bad_words,
   * repetition_detection, structured_outputs, …) enters the request here, and
   * backend adaptation happens here so callers (streamOrchestrator) don't need
   * per-backend branches:
   *
   *   - Secondary backends (lmstudio/llamacpp/ollama): drop vLLM-only
   *     continuation controls (continue_final_message/add_generation_prompt) but KEEP
   *     the assistant prefill message — the prefill is a normal message, the dropped
   *     fields are just vLLM-only body flags.
   *   - Ollama additionally: drop tool_choice (tools stay), warning ONCE per session.
   *   - vLLM: unchanged (byte-identical request bodies — the F5 gate).
   *
   * New params from Phase 1+ features are added to this method only.
   */
  private buildChatBody(
    model: string,
    messages: OpenAIChatMessage[],
    options: VllmChatOptions,
    serverType: ServerType
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    for (const [k, v] of Object.entries(options)) {
      if (v !== undefined && !PROTECTED_BODY_KEYS.has(k)) body[k] = v;
    }
    if (serverType !== 'vllm') {
      // Continuation controls are vLLM-only. The assistant prefill message itself
      // (in `messages`) is retained — only the body-level flags are stripped.
      delete body.continue_final_message;
      delete body.add_generation_prompt;
    }
    if (serverType === 'ollama' && 'tool_choice' in body) {
      delete body.tool_choice;
      if (!this.warnedOllamaToolChoice) {
        this.warnedOllamaToolChoice = true;
        this.output.appendLine(
          `[WARN] Ollama does not support tool_choice — removed from request (tools preserved).`
        );
      }
    }
    return body;
  }

  /**
   * Validate that messages in the request body are well-formed.
   *
   * Enforces that all system messages appear at the beginning of the message array,
   * before any user/assistant/tool messages. This prevents interleaved system messages
   * (e.g., system → user → system), which models like Qwen reject with errors such
   * as "system message must be the first message". Multiple system messages at the
   * start are allowed; only system messages appearing after non-system messages are rejected.
   */
  private validateMessages(messages: unknown): void {
    if (!Array.isArray(messages)) {
      throw new Error(`Invalid messages in request body: expected array, got ${typeof messages}`);
    }
    let seenNonSystem = false;
    for (const [i, msg] of messages.entries()) {
      if (typeof msg !== 'object' || msg === null || typeof (msg as any).role !== 'string') {
        throw new Error(`Invalid message at index ${i}: ${JSON.stringify(msg).slice(0, 200)}`);
      }
      const role = (msg as any).role as string;
      if (role === 'system') {
        if (seenNonSystem) {
          throw new Error(
            `Message ordering violation: system message at index ${i} appears after user/assistant/tool messages. ` +
            `All system messages must come first. Roles so far: ${(messages as any[]).slice(0, i + 1).map((m: any) => m.role).join(', ')}`
          );
        }
      } else {
        seenNonSystem = true;
      }
    }
  }

  /**
   * Extract response headers as a plain Record for logging.
   */
  private getResponseHeaders(response: Response): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) {
      headers[key] = value;
    }
    return headers;
  }

  /**
   * Check response Content-Type and throw a clear error for non-SSE responses.
   */
  private async checkResponseContentType(response: Response): Promise<void> {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const cloned = response.clone();
      const data: any = await cloned.json().catch(() => null);
      if (data?.error) {
        const message = typeof data.error === 'object' && data.error !== null
          ? data.error.message || JSON.stringify(data.error).slice(0, 500)
          : String(data.error);
        throw new Error(`Server returned JSON error: ${message}`);
      }
      throw new Error(`Server returned unexpected JSON response (expected SSE stream)`);
    }
    if (contentType.includes('text/html')) {
      const html = await response.text().catch(() => '');
      throw new Error(`Server returned HTML instead of SSE stream (possible reverse proxy error). Body: ${html.substring(0, 500)}`);
    }
  }
}
