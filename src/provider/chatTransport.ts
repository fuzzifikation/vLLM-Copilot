import type * as vscode from 'vscode';
import { buildEndpoint, DEFAULT_MODEL_SETTINGS } from '../config.js';
import { fetchWithRetry } from '../fetchRetry.js';
import type { FileLogger } from '../logger.js';
import { readSseStream } from '../streamReader.js';
import type { OpenAIChatMessage, StreamEvent, VllmChatOptions } from '../types.js';
import { buildChatBody, checkResponseContentType, validateMessages } from './chatProtocol.js';
import type { ServerConfig } from './requestBuilder.js';

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
        (status) => this.output.appendLine(`[INFO] Retry succeeded — received HTTP ${status}`),
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
      `[WARN] Ollama does not support tool_choice — removed from request (tools preserved).`
    );
  }
}