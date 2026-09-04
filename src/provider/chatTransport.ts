import type * as vscode from 'vscode';
import { buildEndpoint, DEFAULT_MODEL_SETTINGS, type ServerType } from '../state/config.js';
import { serverErrorMessage } from '../shared/errorEnvelope.js';
import { fetchWithRetry } from '../shared/fetchRetry.js';
import type { FileLogger } from '../shared/logger.js';
import { readSseStream } from './streamReader.js';
import type { OpenAIChatMessage, StreamEvent, VllmChatOptions } from '../types.js';
import type { ServerConfig } from './requestBuilder.js';

const PROTECTED_BODY_KEYS = new Set(['model', 'messages', 'stream', 'stream_options']);

/**
 * Assemble the chat-completion request body. Protected keys (`model`,
 * `messages`, `stream`, `stream_options`) can never be overwritten by user
 * options; vLLM-only chat-template flags are stripped for other backends;
 * `tool_choice` is dropped for Ollama (with a once-only warning via callback).
 */
function buildChatBody(
  model: string,
  messages: OpenAIChatMessage[],
  options: VllmChatOptions,
  serverType: ServerType,
  onOllamaToolChoiceRemoved: () => void,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && !PROTECTED_BODY_KEYS.has(key)) body[key] = value;
  }
  if (serverType !== 'vllm') {
    delete body.continue_final_message;
    delete body.add_generation_prompt;
  }
  if (serverType === 'ollama' && 'tool_choice' in body) {
    delete body.tool_choice;
    onOllamaToolChoiceRemoved();
  }
  return body;
}

/**
 * Pre-flight wire validation: message array shape, role strings, system-messages-first.
 *
 * This is an intentional REGRESSION TRIPWIRE, not input handling (CR-94). It is
 * unreachable by production input: the sole caller feeds it `convertMessages()`
 * output, which is an array of literal roles with system messages first by
 * construction, plus an optional trailing assistant prefill. It stays anyway:
 * vLLM-compatible servers reject a misordered envelope with an opaque 400, and
 * a future messageConverter refactor that breaks system-first would otherwise
 * surface as "Copilot silently stopped working". Loud failure at our own
 * boundary, with the role sequence in the message, is the whole point. The
 * validation tests in chatTransport.test.ts drive it deliberately - they are
 * exercising a tripwire, not documenting live input handling.
 */
function validateMessages(messages: unknown): void {
  if (!Array.isArray(messages)) {
    throw new Error(`Invalid messages in request body: expected array, got ${typeof messages}`);
  }
  let seenNonSystem = false;
  for (const [index, message] of messages.entries()) {
    if (typeof message !== 'object' || message === null || typeof (message as any).role !== 'string') {
      throw new Error(`Invalid message at index ${index}: ${JSON.stringify(message).slice(0, 200)}`);
    }
    const role = (message as any).role as string;
    if (role === 'system') {
      if (seenNonSystem) {
        throw new Error(
          `Message ordering violation: system message at index ${index} appears after user/assistant/tool messages. ` +
          `All system messages must come first. Roles so far: ${(messages as any[]).slice(0, index + 1).map((entry: any) => entry.role).join(', ')}`
        );
      }
    } else {
      seenNonSystem = true;
    }
  }
}

/**
 * A streaming chat response must be SSE. If the server answered with JSON or
 * HTML instead, surface the real cause (error envelope, OpenRouter
 * `error.metadata.raw`, reverse-proxy HTML) instead of a failed SSE parse.
 */
async function checkResponseContentType(response: Response): Promise<void> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const cloned = response.clone();
    const data: any = await cloned.json().catch(() => null);
    if (data?.error) {
      // Walk the whole envelope so OpenRouter's real reason under
      // `error.metadata.raw` surfaces instead of the terse `message` stub.
      const message = serverErrorMessage(data.error)
        ?? (typeof data.error === 'object' ? JSON.stringify(data.error) : String(data.error));
      throw new Error(`Server error (error response): ${String(message).slice(0, 500)}`);
    }
    throw new Error(`Server returned unexpected JSON response (expected SSE stream)`);
  }
  if (contentType.includes('text/html')) {
    const html = await response.text().catch(() => '');
    throw new Error(`Server returned HTML instead of SSE stream (possible reverse proxy error). Body: ${html.substring(0, 500)}`);
  }
}

export class ChatTransport {
  private warnedOllamaToolChoice = false;

  constructor(
    private output: vscode.OutputChannel,
    private fileLogger?: FileLogger,
  ) {}

  async *stream(
    model: string,
    messages: OpenAIChatMessage[],
    options: VllmChatOptions,
    token: vscode.CancellationToken,
    serverConfig?: ServerConfig,
  ): AsyncGenerator<StreamEvent> {
    const url = buildEndpoint(serverConfig?.serverUrl ?? '', 'v1/chat/completions');
    const body = buildChatBody(
      model,
      messages,
      options,
      serverConfig?.serverType ?? 'vllm',
      () => this.warnUnsupportedOllamaToolChoice(),
    );

    const requestKeys = ['chat_template_kwargs', 'temperature', 'top_p', 'top_k', 'presence_penalty', 'bad_words', 'ignore_eos', 'repetition_detection', 'structured_outputs'];
    const requestParams = Object.fromEntries(requestKeys.filter((key) => key in body).map((key) => [key, body[key]]));
    if (Object.keys(requestParams).length > 0) {
      this.output.appendLine(`[DEBUG] Request params: ${JSON.stringify(requestParams)}`);
    }

    validateMessages(body.messages);
    const allHeaders = { ...serverConfig?.requestHeaders, 'Content-Type': 'application/json' };
    this.fileLogger?.logRequest('POST', url, allHeaders, body);

    const controller = new AbortController();
    const onCancellation = token.onCancellationRequested(() => {
      controller.abort('User cancelled');
    });
    const inactivityMs = serverConfig?.streamInactivityTimeout ?? DEFAULT_MODEL_SETTINGS.streamInactivityTimeout;
    const initialResponseMs = serverConfig?.initialResponseTimeoutMs ?? DEFAULT_MODEL_SETTINGS.initialResponseTimeoutMs;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const resetPreFetchInactivity = () => {
      if (inactivityMs <= 0) return;
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        controller.abort(`Stream inactivity timeout (${inactivityMs}ms without data)`);
      }, inactivityMs);
    };
    let initialResponseTimer: ReturnType<typeof setTimeout> | undefined;

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
        (error, delayMs) => this.output.appendLine(`[WARN] ${error}, retrying in ${delayMs}ms…`),
        (status) => this.output.appendLine(`[INFO] Retry succeeded - received HTTP ${status}`),
      );

      clearTimeout(initialResponseTimer);
      resetPreFetchInactivity();
      if (!response.body) {
        throw new Error('No response body from server');
      }
      await checkResponseContentType(response);
      clearTimeout(inactivityTimer);

      yield* readSseStream(response.body.getReader(), token, {
        inactivityMs,
        fileLogger: this.fileLogger,
        output: this.output,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.match(/HTTP\s+(\d+)/)?.[1];
      this.fileLogger?.logError('POST', url, status ? parseInt(status, 10) : 0, message);
      throw error;
    } finally {
      clearTimeout(initialResponseTimer);
      clearTimeout(inactivityTimer);
      onCancellation.dispose();
    }
  }

  private warnUnsupportedOllamaToolChoice(): void {
    if (this.warnedOllamaToolChoice) return;
    this.warnedOllamaToolChoice = true;
    this.output.appendLine(
      `[WARN] Ollama does not support tool_choice - removed from request (tools preserved).`
    );
  }
}