import * as vscode from 'vscode';
import { VllmClient } from './vllmClient.js';
import { SystemMessagePipeline } from './systemMessagePipeline.js';
import { discoverModels } from './discovery.js';
import { runChatResponse } from './streamOrchestrator.js';
import type { ProviderClient } from './contracts.js';
import { resolveOverrideForModel, resolveModelSettings, readPickerSelection } from '../state/config.js';
import type { FileLogger } from '../shared/logger.js';
import { messageToText } from './messageConverter.js';

export class VllmChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private client: ProviderClient;
  private cachedModels: vscode.LanguageModelChatInformation[] | null = null;
  private modelCacheGeneration = 0;
  private modelContextWindows = new Map<string, number>();

  /**
   * Last selected model mode per picker id ('' = none). A mode switch
   * re-registers model metadata so Copilot's context-window bar reflects the
   * active mode's budget — the mode's `max_tokens` while no output-length pick
   * exists, and otherwise the mode's behavior params with the picked length
   * still owning the output budget (the pick outranks per-mode `max_tokens`).
   */
  private lastSelectedMode = new Map<string, string>();

  /**
   * Last selected output LENGTH per picker id (absent = no dropdown/never
   * picked). The pick IS the advertised output budget — a shorter selection
   * grows the advertised input budget (window − output), handing the freed
   * tokens to the prompt — so a change re-registers metadata exactly like a
   * mode switch does, and Copilot's context math reacts on the next resolve.
   */
  private lastSelectedLength = new Map<string, number>();

  /**
   * Generation the current `cachedModels` was computed for (-1 = none) and
   * when it was published (0 = none). The timestamp backs the single
   * freshness rule: a silent resolve inside the TTL serves the cache, past it
   * the servers are re-probed. There is no "was the last pass healthy" state:
   * the cache is simply what the servers reported at that moment, and the TTL
   * bounds how long that snapshot may stand in for the truth. Deliberate
   * refreshes (settings changes, Test & Refresh, mode or output-length picks)
   * and a chat request dying on a transport failure null the cache through
   * clearCache, so user intent and observed reality always re-probe live.
   */
  private cachedGeneration = -1;
  private cachedAt = 0;

  /** How long a silent resolve may reuse the cached list before re-probing. */
  private static readonly CACHE_TTL_MS = 60_000;

  /**
   * The discovery pass currently running, if any. Concurrent calls JOIN it
   * instead of starting duplicate probe storms. Joining is unconditional: if
   * the running pass was invalidated mid-flight, its result is discarded by
   * the generation guard and the caller loops into a fresh pass. Resolves
   * with the generation the pass started for, so waiters can tell whether
   * its result still applies.
   */
  private discoveryRun: Promise<number> | undefined;

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
   * config) so settings changes (model edits, server registry entries, params)
   * take effect immediately rather than after extension restart.
   */
  clearCache(): void {
    this.modelCacheGeneration++;
    this.cachedModels = null;
    this.modelContextWindows.clear();
    this.lastSelectedMode.clear();
    this.lastSelectedLength.clear();
    this.client.invalidateConfigCache();
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  /**
   * Track the per-model picker selections (mode + output length) and, when
   * either changes, re-publish model metadata so Copilot re-resolves and its
   * context-window math reflects the new budget. A mode switch re-anchors the
   * budget via the mode's `max_tokens` (legacy); an output-length pick IS the
   * advertised output budget (shorter pick = more prompt headroom). Deduped per
   * model; a length-only change whose pick already equals the advertised output
   * (the default pick == ceiling case) skips the otherwise-identical
   * re-registration roundtrip.
   */
  private trackConfigSelection(
    modelId: string,
    selectedMode: string | undefined,
    selectedLength: number | undefined,
  ): void {
    const priorMode = this.lastSelectedMode.get(modelId);
    const priorLength = this.lastSelectedLength.get(modelId);
    const modeChanged = (priorMode ?? '') !== (selectedMode ?? '');
    const lengthChanged = priorLength !== selectedLength;
    if (!modeChanged && !lengthChanged) return;
    // Baseline (nothing ever selected, nothing selected now): metadata already
    // matches the static budget — nothing to re-register.
    if (priorMode === undefined && priorLength === undefined && !selectedMode && selectedLength === undefined) return;

    this.lastSelectedMode.set(modelId, selectedMode ?? '');
    if (selectedLength === undefined) this.lastSelectedLength.delete(modelId);
    else this.lastSelectedLength.set(modelId, selectedLength);

    // Length-only change, pick already advertised: re-registering would
    // re-fetch context windows to produce identical metadata.
    if (!modeChanged && selectedLength !== undefined) {
      const advertised = this.cachedModels?.find(m => m.id === modelId)?.maxOutputTokens;
      if (advertised === selectedLength) return;
    }

    // Increment the generation so any in-flight discovery captured BEFORE this
    // change cannot restore stale metadata when it completes (same
    // generation-invalidating pattern as clearCache). Then invalidate + fire so
    // Copilot re-resolves with the new budget.
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

    // Silent calls serve the cache while it is fresh (inside the TTL); past
    // it they re-probe so the picker tracks reality in both directions on its
    // own: a server that went down drops out, one that came back reappears.
    if (options.silent && this.cachedModels && Date.now() - this.cachedAt < VllmChatModelProvider.CACHE_TTL_MS) {
      return this.cachedModels;
    }

    // Track whether this call has already waited behind one pass. Re-entries
    // (generation moved while the pass ran) may converge on a freshly
    // published cache; FIRST passes never take that shortcut — see
    // runDiscoveryOnce.
    let rejoin = false;
    while (!token.isCancellationRequested) {
      // One shared pass serves all concurrent callers; the generation it was
      // computed for tells us whether its (cached) result still applies.
      const runGeneration = await this.runDiscoveryOnce(rejoin);
      if (runGeneration === this.modelCacheGeneration) {
        return this.cachedModels ?? [];
      }
      // Config changed / mode or length pick switched while the pass was in
      // flight: its result was NOT cached (generation guard inside). Loop and
      // join or start a fresh pass so this call cannot return the obsolete list.
      rejoin = true;
    }
    return this.cachedModels ?? [];
  }

  /**
   * Join the in-flight discovery pass or start one. At most one pass runs at
   * a time; its result is cached only if the generation it started with is
   * still current when it finishes. Resolves with that starting generation.
   *
   * Joining is unconditional: if the running pass was invalidated mid-flight,
   * its result is discarded by the generation guard below and the caller
   * loops into a fresh pass. A stale join costs waiting out one obsolete
   * probe; tracking per-generation passes to refuse it is not worth it.
   *
   * @param rejoin - true when the caller already waited behind one pass and
   *   is looping because the generation moved. Only re-entries may converge
   *   on an already-published cache (avoiding a redundant probe wave). A FIRST
   *   pass always probes, or joins the pass already probing, so a non-silent
   *   resolve (VS Code's management flows: "the truth now") and a silent
   *   resolve past the TTL are never answered from a cache built before they
   *   asked. There is no "was the last pass healthy" state: the TTL alone
   *   decides freshness.
   */
  private runDiscoveryOnce(rejoin = false): Promise<number> {
    if (rejoin && this.cachedModels && this.cachedGeneration === this.modelCacheGeneration) {
      return Promise.resolve(this.modelCacheGeneration);
    }
    if (this.discoveryRun) {
      return this.discoveryRun;
    }
    const generation = this.modelCacheGeneration;
    const run = (async (): Promise<number> => {
      const config = await this.client.getConfigCached();
      const modelOverrides = config.models || [];
      const servers = config.servers || [];

      if (modelOverrides.length === 0) {
        if (generation === this.modelCacheGeneration) {
          this.cachedModels = [];
          this.cachedGeneration = generation;
          this.cachedAt = Date.now();
          this.modelContextWindows.clear();
        }
        return generation;
      }

      // The remote guard + cache stay here (lifecycle/cache owner); the per-model
      // discovery core (context-window fetch, model info, warnings) is a pure
      // function taking explicit collaborators.
      const contextWindows = new Map<string, number>();
      const models = await discoverModels(
        modelOverrides,
        servers,
        this.client,
        this.output,
        (modelId, contextWindow) => contextWindows.set(modelId, contextWindow),
        this.lastSelectedMode,
        this.lastSelectedLength,
      );
      if (generation === this.modelCacheGeneration) {
        this.cachedModels = models;
        this.cachedGeneration = generation;
        this.cachedAt = Date.now();
        this.modelContextWindows = contextWindows;
      }
      return generation;
    })().finally(() => {
      // A new pass can only start once this slot is empty, so the slot always
      // holds the pass that is actually running.
      this.discoveryRun = undefined;
    });
    this.discoveryRun = run;
    return run;
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

    // Track the selected model mode and output length so re-registered metadata
    // (and Copilot's context-window bar) reflects the picked output budget. Read
    // before delegating — the request builder reads the same picker state through
    // the same shared reader (single parse, single normalization).
    const { selectedMode, pickerTokens: selectedLength } = readPickerSelection(options);
    this.trackConfigSelection(model.id, selectedMode, selectedLength);

    await runChatResponse(
      {
        client: this.client,
        output: this.output,
        fileLogger: this.fileLogger,
        systemMessages: this.systemMessages,
        contextWindow: this.modelContextWindows.get(model.id),
        onTransportFailure: () => this.clearCache(),
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
