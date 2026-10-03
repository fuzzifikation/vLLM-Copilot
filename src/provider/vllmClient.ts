import * as vscode from 'vscode';
import { getConfig } from '../state/config.js';
import type { VllmConfig } from '../core/config/config.js';
import type { ServerType } from '../core/config/serverCore.js';
import type { FileLogger } from '../shared/logger.js';
import { ChatTransport } from '../core/request/chatTransport.js';
import type { ServerConfig } from '../core/request/assemble.js';
import { clearRuntimeLimitsCache, resolveRuntimeLimits } from '../core/backends/runtimeLimits.js';
import type { OpenAIChatMessage, RuntimeModelLimits, StreamEvent, VllmChatOptions } from '../core/types.js';

/**
 * Provider-facing facade and single owner of the configuration cache.
 * Runtime metadata resolution and chat transport are implemented by focused
 * collaborators while this public surface remains stable for the provider.
 */
export class VllmClient {
  private cachedConfigPromise: Promise<VllmConfig> | null = null;
  private readonly chatTransport: ChatTransport;

  constructor(
    output: vscode.OutputChannel,
    fileLogger?: FileLogger,
  ) {
    this.chatTransport = new ChatTransport(output, fileLogger);
  }

  async getConfigCached(): Promise<VllmConfig> {
    if (this.cachedConfigPromise === null) {
      this.cachedConfigPromise = getConfig().catch((error) => {
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
    configuredContextWindow?: number,
  ): Promise<RuntimeModelLimits> {
    return resolveRuntimeLimits(serverType, serverUrl, requestHeaders, vllmModelId, configuredContextWindow);
  }

  /**
   * Byte-for-byte passthrough into the core transport. The cancellation
   * signal is CALLER-OWNED: the Copilot boundary (streamOrchestrator) converts
   * its token once per operation, so the facade neither subscribes nor converts.
   */
  async *chatCompletionStream(
    model: string,
    messages: OpenAIChatMessage[],
    options: VllmChatOptions,
    signal: AbortSignal,
    serverConfig?: ServerConfig,
  ): AsyncGenerator<StreamEvent> {
    yield* this.chatTransport.stream(model, messages, options, signal, serverConfig);
  }
}