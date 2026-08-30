import * as vscode from 'vscode';
import { VllmClient } from './vllmClient.js';
import { SystemMessagePipeline } from './provider/systemMessagePipeline.js';
import { discoverModels } from './provider/discovery.js';
import { createBudgetLedger, type BudgetLedger } from './provider/budgetLedger.js';
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
   * True when the cached list came from a pass where EVERY configured server
   * answered. VS Code never re-queries the picker on open — silent resolves
   * are the only self-heal path — so an incomplete cache (any offline row) is
   * never trusted: those silent calls re-check the servers instead of serving
   * a snapshot of a broken moment forever. A list of permanent skips (no
   * serverUrl) IS complete: re-probing cannot fix a config error.
   */
  private discoveryWasComplete = false;

  /** Generation the current `cachedModels` was computed for (-1 = none). */
  private cachedGeneration = -1;

  /**
   * Dead-server throttle: while this timestamp is in the future, silent calls
   * serve the cached (offline) list IMMEDIATELY and re-check in the
   * background. A blackholed server's probe costs the full metadata timeout,
   * and VS Code resolves the model list repeatedly during an outage — without
   * the throttle every lookup would stall ~10s. Timestamp, not timer: nothing
   * waits, nothing is scheduled. Deliberate refreshes (Test & Refresh, mode or
   * length picks, settings edits) null the cache through clearCache/the
   * generation bump, and the gate only applies when a cache exists to serve —
   * so user actions always probe live.
   */
  private discoveryRetryAfter = 0;

  /** How long a still-down server is left alone before the next background re-check. */
  private static readonly OFFLINE_RETRY_COOLDOWN_MS = 30_000;

  /**
   * A single shared discovery pass. Concurrent calls JOIN the running pass
   * instead of starting duplicate probe storms. The pass is tagged with the
   * generation it started for: callers never join an obsolete pass (a
   * mid-flight invalidation must not make a fresh resolve wait out the old
   * pass's probes). Resolves with the pass's starting generation so waiters
   * can tell whether its result still applies.
   */
  private discoveryRun: { generation: number; promise: Promise<number> } | null = null;

  /** Last-known-good budgets for honest offline rows during outages. Lazy: reads globalState once. */
  private budgetLedgerInstance: BudgetLedger | undefined;

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

  /** Lazy so construction never touches globalState; degrades to in-memory without one. */
  private getBudgetLedger(): BudgetLedger {
    if (!this.budgetLedgerInstance) {
      this.budgetLedgerInstance = createBudgetLedger(this.context.globalState);
    }
    return this.budgetLedgerInstance;
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
    this.discoveryWasComplete = false;
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

    // Silent calls serve the cache when it is AUTHORITATIVE (every server
    // answered). When it is not — an outage snapshot — re-check, but never
    // make the caller wait behind a dead server's probe: inside the cooldown,
    // serve the cached list NOW and heal in the background, firing the change
    // event once the servers fully recover so VS Code re-resolves and the
    // picker updates itself. Without this, a cache built during an outage
    // would pin models offline until a settings change or a reload.
    if (options.silent && this.cachedModels) {
      if (this.discoveryWasComplete) {
        return this.cachedModels;
      }
      if (Date.now() < this.discoveryRetryAfter) {
        void this.runDiscoveryOnce()
          .then(() => {
            // Event ONLY on full recovery: partial heals would churn the
            // picker, and still-failing passes just re-arm the cooldown quietly.
            if (this.discoveryWasComplete) {
              this._onDidChangeLanguageModelChatInformation.fire();
            }
          })
          .catch(() => { /* discovery failures are already logged */ });
        return this.cachedModels;
      }
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
   * Join the in-flight discovery pass or start one. Exactly one pass runs at
   * a time; its result is cached only if the generation it started with is
   * still current when it finishes. Resolves with that starting generation.
   *
   * @param rejoin - true when the caller already waited behind one pass and
   *   is looping because the generation moved. Only re-entries may converge
   *   on an already-published authoritative cache (avoiding a redundant probe
   *   wave). A FIRST pass always probes — or joins the pass already probing —
   *   so a non-silent resolve (VS Code's management flows: "the truth now")
   *   is never answered from a cache built before it asked. Silent calls with
   *   an authoritative cache never reach here at all; the gate above serves
   *   them. An INCOMPLETE cache never satisfies the fast path either way —
   *   healing it is the whole point of calling.
   */
  private runDiscoveryOnce(rejoin = false): Promise<number> {
    if (rejoin && this.cachedModels && this.discoveryWasComplete
      && this.cachedGeneration === this.modelCacheGeneration) {
      return Promise.resolve(this.modelCacheGeneration);
    }
    // Only join a pass started for the CURRENT generation — an invalidated
    // in-flight pass must never make a fresh resolve wait for a config that
    // no longer exists.
    if (this.discoveryRun && this.discoveryRun.generation === this.modelCacheGeneration) {
      return this.discoveryRun.promise;
    }
    const generation = this.modelCacheGeneration;
    const run = (async (): Promise<number> => {
      const config = await this.client.getConfigCached();
      const modelOverrides = config.models || [];

      if (modelOverrides.length === 0) {
        if (generation === this.modelCacheGeneration) {
          this.cachedModels = [];
          this.cachedGeneration = generation;
          this.discoveryWasComplete = true; // nothing to discover — [] is the truth
          this.discoveryRetryAfter = 0;
          this.modelContextWindows.clear();
        }
        return generation;
      }

      // The remote guard + cache stay here (lifecycle/cache owner); the per-model
      // discovery core (context-window fetch, model info, warnings) is a pure
      // function taking explicit collaborators.
      const contextWindows = new Map<string, number>();
      const { models, failures } = await discoverModels(
        modelOverrides,
        this.client,
        this.output,
        (modelId, contextWindow) => contextWindows.set(modelId, contextWindow),
        this.lastSelectedMode,
        this.lastSelectedLength,
        this.getBudgetLedger(),
      );
      if (generation === this.modelCacheGeneration) {
        this.cachedModels = models;
        this.cachedGeneration = generation;
        this.modelContextWindows = contextWindows;
        // An offline row means the list is a snapshot of a broken moment, not
        // the truth: keep re-checking (throttled) until the servers cooperate.
        this.discoveryWasComplete = failures === 0;
        this.discoveryRetryAfter = failures === 0
          ? 0
          : Date.now() + VllmChatModelProvider.OFFLINE_RETRY_COOLDOWN_MS;
      }
      return generation;
    })().finally(() => {
      // Only clear the slot if it still holds OUR pass — an abandoned obsolete
      // pass settling must not evict a newer one.
      if (this.discoveryRun?.promise === run) this.discoveryRun = null;
    });
    this.discoveryRun = { generation, promise: run };
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
    // before delegating — the request builder uses the same `modelConfiguration`
    // field to select the mode's request params and the request's max_tokens.
    const modelConfiguration = (options as any).modelConfiguration as Record<string, unknown> | undefined;
    const selectedMode = typeof modelConfiguration?.reasoningEffort === 'string'
      ? modelConfiguration.reasoningEffort
      : undefined;
    const pickerTokensRaw = modelConfiguration?.maxOutputTokens;
    const selectedLength = typeof pickerTokensRaw === 'number' && Number.isFinite(pickerTokensRaw)
      ? Math.max(1, Math.floor(pickerTokensRaw))
      : undefined;
    this.trackConfigSelection(model.id, selectedMode, selectedLength);

    // Pre-flight for OUR offline rows: a row published in the current cache
    // with NO registered context window (only live servers register windows).
    // Its advertised budget is stale or placeholder, and request construction
    // hard-clamps the wire max_tokens to it — so a server that woke up after
    // the last discovery would be strangled by metadata from when it was dead
    // (worst case: Copilot rejecting the prompt against a 1-token placeholder
    // while the server is fine). A chat request is a deliberate user action —
    // same class as Test & Refresh — so re-check live BEFORE building the
    // request: single-flight pass, no cooldown gate on this path (a doomed
    // request's own connection timeout dwarfs the probe anyway). Then build
    // from the freshest row for this id, not the snapshot VS Code was holding.
    // An id ABSENT from the cache (stale row for a deleted model, or a request
    // arriving mid-refresh) is NOT an offline row — probing would repeat a
    // full server wave for every doomed request, turning an instant failure
    // into a slow one. Healthy rows (registered window): zero cost, zero probing.
    let requestModel = model;
    const cachedRow = this.cachedModels?.find(m => m.id === model.id);
    if (cachedRow && !this.modelContextWindows.has(model.id)) {
      if (!token.isCancellationRequested) {
        try {
          await this.runDiscoveryOnce();
          requestModel = this.cachedModels?.find(m => m.id === model.id) ?? model;
          // Full recovery detected here means VS Code still holds the offline
          // row until its next silent resolve — tell it now so the picker's
          // ⚠ marker clears the moment a request proves the server is back.
          // (discoveryWasComplete is the whole gate: an offline row never
          // becomes complete without the failed server actually answering.)
          if (this.discoveryWasComplete) {
            this._onDidChangeLanguageModelChatInformation.fire();
          }
        } catch {
          // Strictly best-effort: if the re-check itself fails (corrupt config,
          // servers screaming), proceed with the row as handed over. Error
          // classification belongs to runChatResponse/handleResponseError —
          // the established routing (ERROR log + chat part, quiet on cancel) —
          // and this pre-flight must never steal it with a raw throw.
        }
      }
    }

    await runChatResponse(
      {
        client: this.client,
        output: this.output,
        fileLogger: this.fileLogger,
        systemMessages: this.systemMessages,
        contextWindow: this.modelContextWindows.get(requestModel.id),
      },
      requestModel,
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
