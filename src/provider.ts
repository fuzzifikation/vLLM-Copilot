import * as vscode from 'vscode';
import { VllmClient } from './vllmClient.js';
import { SystemMessagePipeline } from './provider/systemMessagePipeline.js';
import { discoverModels } from './provider/discovery.js';
import { runChatResponse } from './provider/streamOrchestrator.js';
import type { ProviderClient } from './provider/contracts.js';
import { resolveOverrideForModel, resolveModelSettings } from './config.js';
import type { FileLogger } from './logger.js';
import { messageToText } from './messageConverter.js';

export class VllmChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private client: ProviderClient;
  private cachedModels: vscode.LanguageModelChatInformation[] | null = null;
  private modelCacheGeneration = 0;
  private modelContextWindows = new Map<string, number>();

  /**
   * Last selected model mode per picker id ('' = none). Used to re-register
   * model metadata with the selected mode's `max_tokens` output budget so
   * Copilot's context-window bar reflects the active mode (Option A).
   */
  private lastSelectedMode = new Map<string, string>();

  /** Instance-owned system-message pipeline (replacements + capture). */
  private readonly systemMessages: SystemMessagePipeline;

  /** Event fired when model information changes (e.g., after refresh). */
  private _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

  constructor(
    private context: vscode.ExtensionContext,
    private output: vscode.OutputChannel,
    private fileLogger?: FileLogger,
    dependencies?: { client?: ProviderClient }
  ) {
    this.client = dependencies?.client ?? new VllmClient(context, output, fileLogger);
    this.systemMessages = new SystemMessagePipeline(output);
  }

  dispose(): void {
    this._onDidChangeLanguageModelChatInformation.dispose();
  }

  /**
   * Clear cached model list and fire change event so VS Code refreshes.
   * Also invalidates VllmClient's config cache (the single source of truth for
   * config) so settings changes (per-model serverUrl, headers, params) take effect
   * immediately rather than after extension restart.
   */
  clearCache(): void {
    this.modelCacheGeneration++;
    this.cachedModels = null;
    this.modelContextWindows.clear();
    this.lastSelectedMode.clear();
    this.client.invalidateConfigCache();
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  /**
   * Track a model's selected mode and, when it changes, re-publish model
   * metadata so Copilot re-resolves and its context-window bar reflects the
   * mode's `max_tokens` output budget. Deduped per model: switching between
   * modes re-registers once per change; the first no-mode request is the
   * baseline and triggers nothing.
   */
  private trackModeSelection(modelId: string, selectedMode: string | undefined): void {
    const key = selectedMode ?? '';
    const prior = this.lastSelectedMode.get(modelId);
    if (prior === key) return;
    this.lastSelectedMode.set(modelId, key);
    // Baseline (no mode ever selected): metadata already matches — nothing to re-register.
    if (prior === undefined && key === '') return;
    // Increment the generation so any in-flight discovery captured BEFORE this
    // change cannot restore stale metadata when it completes (same
    // generation-invalidating pattern as clearCache). Then invalidate + fire so
    // Copilot re-resolves with the mode's budget.
    this.modelCacheGeneration++;
    this.cachedModels = null;
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  /**
   * Discover available models from the vLLM server.
   */
  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // If extension is not installed on the remote, don't show ghost models that can't work.
    if (vscode.env.remoteName && this.context.extension.extensionKind === vscode.ExtensionKind.UI) {
      return [];
    }

    // If silent mode, return cached models without recomputing
    if (options.silent && this.cachedModels) {
      return this.cachedModels;
    }

    while (!token.isCancellationRequested) {
      const generation = this.modelCacheGeneration;
      const config = await this.client.getConfigCached();
      const modelOverrides = config.models || [];

      if (modelOverrides.length === 0) {
        if (generation === this.modelCacheGeneration) {
          this.cachedModels = [];
          this.modelContextWindows.clear();
        }
        return [];
      }

      // The remote guard + cache stay here (lifecycle/cache owner); the per-model
      // discovery core (context-window fetch, model info, warnings) is a pure
      // function taking explicit collaborators.
      const contextWindows = new Map<string, number>();
      const models = await discoverModels(
        modelOverrides,
        this.client,
        this.output,
        (modelId, contextWindow) => contextWindows.set(modelId, contextWindow),
        this.lastSelectedMode,
      );
      if (generation === this.modelCacheGeneration) {
        this.cachedModels = models;
        this.modelContextWindows = contextWindows;
        return models;
      }
      // Config changed while discovery was in flight. The client's cache was
      // invalidated by clearCache(); retry so this call cannot return or cache
      // the obsolete model list after the change event.
    }
    return [];
  }

  /**
   * Handle chat requests by forwarding to the vLLM server and streaming back.
   *
   * Remote-guards the request, then delegates the full orchestration (request
   * building, auto-continue retry loop, post-stream diagnostics, error
   * classification) to {@link runChatResponse} in streamOrchestrator.ts, passing
   * the provider's collaborators (client, output, logger, pipeline).
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    // Guard: if we're connected to a remote but the extension is running locally,
    // the user almost certainly forgot to install the extension on the remote.
    // Catch this before making a request — the error would be opaque otherwise.
    if (vscode.env.remoteName && this.context.extension.extensionKind === vscode.ExtensionKind.UI) {
      const remoteHost = vscode.env.remoteName;
      this.output.appendLine(
        `[ERROR] vLLM-Copilot is running locally while connected to ${remoteHost}. ` +
        `Install the extension on the remote to enable chat.`
      );
      progress.report(new vscode.LanguageModelTextPart(
        `⚠️ **vLLM-Copilot is not installed on the remote.**\n\n` +
        `You are connected to **${remoteHost}**, but this extension is running on your local machine. ` +
        `LLM requests will fail or behave unexpectedly.\n\n` +
        `**To fix this:**\n` +
        `1. Open the Extensions view: \\\`Ctrl+Shift+X\\\`\n` +
        `2. Click the "..." menu in the extensions toolbar → **Install in ${remoteHost}...** (or look for the 📥 icon)\n` +
        `3. Search for **vLLM-Copilot** and install it on the remote\n` +
        `4. Try your request again`
      ));
      return;
    }

    // Track the selected model mode so re-registered metadata (and Copilot's
    // context-window bar) reflects the mode's output budget (Option A: max_tokens
    // per mode). Read before delegating — the request builder uses the same
    // `modelConfiguration` field to select the mode's request params.
    const modelConfiguration = (options as any).modelConfiguration as Record<string, unknown> | undefined;
    const selectedMode = typeof modelConfiguration?.reasoningEffort === 'string'
      ? modelConfiguration.reasoningEffort
      : undefined;
    this.trackModeSelection(model.id, selectedMode);

    await runChatResponse(
      {
        client: this.client,
        output: this.output,
        fileLogger: this.fileLogger,
        systemMessages: this.systemMessages,
        contextWindow: this.modelContextWindows.get(model.id),
      },
      model,
      messages,
      options,
      progress,
      token
    );
  }

  /**
   * Count tokens using a fast local estimate.
   * VS Code calls this repeatedly during chat — avoid blocking network calls,
   * otherwise the request never leaves Copilot (it waits on token counts).
   */
  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const prompt = typeof text === 'string' ? text : messageToText(text);

    let charsPerToken = 3.5;
    try {
      const cfg = await this.client.getConfigCached();
      const override = resolveOverrideForModel(cfg.models || [], model.id);
      const estimate = resolveModelSettings(override).estimateCharsPerToken;
      if (estimate > 0) charsPerToken = estimate;
    } catch (err) {
      // Fallback to default on config read failure
      this.output.appendLine(`[WARN] Token count config read failed: ${err instanceof Error ? err.message : String(err)}. Using default estimate.`);
    }

    return Math.max(1, Math.ceil(prompt.length / charsPerToken));
  }
}
