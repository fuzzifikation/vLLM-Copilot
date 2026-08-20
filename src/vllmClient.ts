import * as vscode from 'vscode';
import { getConfig, type ServerType, type VllmConfig } from './config.js';
import type { FileLogger } from './logger.js';
import { ChatTransport } from './provider/chatTransport.js';
import type { ServerConfig } from './provider/requestBuilder.js';
import { resolveRuntimeLimits } from './runtimeLimits.js';
import type { OpenAIChatMessage, RuntimeModelLimits, StreamEvent, VllmChatOptions } from './types.js';

export type { OpenAIChatMessage, StreamEvent, VllmChatOptions, VllmModel } from './types.js';
export { detectServerType, detectServerTypeFromV1Models, resolveRuntimeLimits } from './runtimeLimits.js';

/**
 * Provider-facing facade and single owner of the configuration cache.
 * Runtime metadata resolution and chat transport are implemented by focused
 * collaborators while this public surface remains stable for the provider.
 */
export class VllmClient {
  private cachedConfigPromise: Promise<VllmConfig> | null = null;
  private readonly chatTransport: ChatTransport;

  constructor(
    private context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    fileLogger?: FileLogger,
  ) {
    this.chatTransport = new ChatTransport(output, fileLogger);
  }

  async getConfigCached(): Promise<VllmConfig> {
    if (this.cachedConfigPromise === null) {
      this.cachedConfigPromise = getConfig(this.context).catch((error) => {
        this.cachedConfigPromise = null;
        throw error;
      });
    }
    return this.cachedConfigPromise;
  }

  invalidateConfigCache(): void {
    this.cachedConfigPromise = null;
  }

  async getModelContextWindow(
    serverType: ServerType,
    serverUrl: string,
    requestHeaders: Record<string, string> = {},
    vllmModelId: string,
  ): Promise<RuntimeModelLimits> {
    return resolveRuntimeLimits(serverType, serverUrl, requestHeaders, vllmModelId);
  }

  async *chatCompletionStream(
    model: string,
    messages: OpenAIChatMessage[],
    options: VllmChatOptions,
    token: vscode.CancellationToken,
    serverConfig?: ServerConfig,
  ): AsyncGenerator<StreamEvent> {
    yield* this.chatTransport.stream(model, messages, options, token, serverConfig);
  }
}