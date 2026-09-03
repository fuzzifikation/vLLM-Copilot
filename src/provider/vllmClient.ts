import * as vscode from 'vscode';
import { getConfig, type ServerType, type VllmConfig } from '../state/config.js';
import type { FileLogger } from '../shared/logger.js';
import { ChatTransport } from './chatTransport.js';
import type { ServerConfig } from './requestBuilder.js';
import { clearRuntimeLimitsCache, resolveRuntimeLimits } from '../backends/runtimeLimits.js';
import type { OpenAIChatMessage, RuntimeModelLimits, StreamEvent, VllmChatOptions } from '../types.js';

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
    // A settings edit (or Test & Refresh) means observed reality may have
    // changed: drop the resolver's short-TTL memo so the next pass re-probes
    // live instead of serving a resolution from before the edit.
    clearRuntimeLimitsCache();
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