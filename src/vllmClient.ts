import * as vscode from 'vscode';
import { getConfig, buildEndpoint, DEFAULT_MODEL_SETTINGS, type VllmConfig } from './config.js';
import { fetchWithRetry, type RetryLogger } from './fetchRetry.js';
import { readSseStream } from './streamReader.js';
import { FileLogger } from './logger.js';
import { describeError } from './messageConverter.js';
import type { StreamEvent, VllmChatOptions, OpenAIChatMessage, VllmModel } from './types.js';
export type { StreamEvent, VllmChatOptions, OpenAIChatMessage, VllmModel } from './types.js';

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

  /**
   * Shared retry logger — surfaces fetch retry warnings/successes to both the
   * Output channel and the file log. Used by every fetchWithRetry call so retry
   * visibility is consistent across getModelContextWindow and chatCompletionStream.
   */
  private get retryLogger(): RetryLogger {
    return {
      onRetry: (error) => {
        const warnMsg = `[WARN] ${error}, retrying in 1500ms…`;
        this.output.appendLine(warnMsg);
      },
      onRetrySuccess: (status) => {
        const successMsg = `[INFO] Retry succeeded — received HTTP ${status}`;
        this.output.appendLine(successMsg);
      },
    };
  }

  /**
   * Fetch the context window (max_model_len) for a specific model from a vLLM server.
   * Returns undefined if the server is unavailable or the model is not found.
   *
   * @param serverUrl - The server URL to query
   * @param requestHeaders - Auth/routing headers for the server
   * @param vllmModelId - The model ID to look up
   */
  async getModelContextWindow(
    serverUrl: string,
    requestHeaders: Record<string, string> = {},
    vllmModelId: string
  ): Promise<number | undefined> {
    try {
      const url = buildEndpoint(serverUrl, 'v1/models');
      this.fileLogger?.logRequest('GET', url, requestHeaders);

      const response = await fetchWithRetry(url, {
        method: 'GET',
      }, requestHeaders, this.retryLogger);

      const data: any = await response.json();
      this.fileLogger?.logResponse(response.status, url, this.getResponseHeaders(response), data);

      const models = data.data || [];
      const model = models.find((m: VllmModel) => m.id === vllmModelId || m.root === vllmModelId);
      return model?.max_model_len;
    } catch (err) {
      // Log the specific failure so the user can see WHY discovery failed
      // (DNS, TLS, 401, timeout, etc.) — not just "failed to connect".
      this.output.appendLine(`[WARN] getModelContextWindow: ${describeError(err)}`);
      return undefined;
    }
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
    serverConfig?: { serverUrl?: string; requestHeaders?: Record<string, string>; streamInactivityTimeout?: number }
  ): AsyncGenerator<StreamEvent> {
    const url = buildEndpoint(serverConfig?.serverUrl ?? '', 'v1/chat/completions');

    // Build body, filtering out undefined values.
    // Guard: never let options overwrite critical request fields.
    // modelOptions from Copilot can carry arbitrary keys — if one collides with
    // 'messages' it will corrupt the request (vLLM TextEncodeInput error).
    const body = this.buildChatBody(model, messages, options);

    const controller = new AbortController();
    const onCancellation = token.onCancellationRequested(() => {
      controller.abort('User cancelled');
    });

    // Stream inactivity timeout: abort if server stops sending data.
    // 0 = disabled (wait indefinitely). Measured via read() timing, not wall-clock,
    // so it is not affected by generator pauses during tool execution.
    const inactivityMs = serverConfig?.streamInactivityTimeout ?? DEFAULT_MODEL_SETTINGS.streamInactivityTimeout;
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
      const response = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
        serverConfig?.requestHeaders ?? {},
        this.retryLogger
      );

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
      clearTimeout(inactivityTimer);
      onCancellation.dispose();
    }
  }

  /**
   * Build the chat completion request body, guarding protected keys from overwrite.
   *
   * This is the **moat seam** — every vLLM-specific sampling param (bad_words,
   * repetition_detection, structured_outputs, …) enters the request here.
   * New params from Phase 1+ features are added to this method only.
   */
  private buildChatBody(
    model: string,
    messages: OpenAIChatMessage[],
    options: VllmChatOptions
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
