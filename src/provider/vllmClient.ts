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
   * Copilot boundary: this facade owns the `vscode.CancellationToken`
   * subscription and converts it to a plain `AbortSignal` for the core
   * transport. The 'User cancelled' abort reason is preserved verbatim
   * (messageConverter error classification pattern-matches it), and an
   * already-cancelled token aborts immediately — VS Code's event fires
   * synchronously on subscribe for cancelled tokens; the explicit
   * `isCancellationRequested` check reproduces that.
   */
  async *chatCompletionStream(
    model: string,
    messages: OpenAIChatMessage[],
    options: VllmChatOptions,
    token: vscode.CancellationToken,
    serverConfig?: ServerConfig,
  ): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const cancel = () => controller.abort('User cancelled');
    const subscription = token.onCancellationRequested(cancel);
    if (token.isCancellationRequested) cancel();
    try {
      yield* this.chatTransport.stream(model, messages, options, controller.signal, serverConfig);
    } finally {
      subscription.dispose();
    }
  }
}