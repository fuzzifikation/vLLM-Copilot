import * as vscode from 'vscode';
import type { ModelConfig } from '../state/config.js';
import { resolveConfigId, resolveVllmModelId, buildModelId, findModelConfigIndex } from '../state/config.js';
import { replaceModelConfig, readModels, readServers, type IdentifiedModelConfig } from '../state/configStore.js';
import { resolveServer } from '../state/serverRegistry.js';
import { resolveModelConfigForAddSafely } from './hfDiscovery.js';
import { confirmAndSaveAddedModel, type ClearCacheProvider } from './addServerFlow.js';

/**
 * Standalone command: re-run auto-configuration (HuggingFace + vLLM server discovery)
 * for an already-configured model. Lets the user update modelModes, capabilities,
 * family, token budgets, etc. without deleting and re-adding the model.
 */
export function registerAutoConfigureModelCommand(
  context: vscode.ExtensionContext,
  provider: ClearCacheProvider,
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.autoConfigureModel', async (arg?: { server?: string; id?: string }) => {
    const existing = readModels();
    if (existing.length === 0) {
      output.appendLine('[INFO] Auto-configure cancelled - no models configured.');
      vscode.window.showInformationMessage('No models configured. Use "Add or Reconfigure Server/Model" first.');
      return;
    }
    // Server facts live on the registry; models reference entries by `server` id.
    const servers = readServers();

    let modelConfig: ModelConfig | undefined;
    let vllmId: string;
    const argModelId = arg?.id;
    // The webview posts the selected server group's registry entry id plus the
    // target model's id. The entry id pins URL AND credentials outright — no
    // URL matching, identity-sibling guessing or fingerprint comparing, which
    // is exactly where those heuristics failed for model-less groups and for
    // one URL hosting several credentials.
    const argEntry = arg?.server ? resolveServer(arg.server, servers) : undefined;
    if (arg?.server && !argEntry) {
      output.appendLine(`[ERROR] Auto-configure: server entry "${arg.server}" is not registered.`);
      void vscode.window.showErrorMessage('vLLM-Copilot: the selected server no longer exists in the registry.');
      return;
    }

    if (argEntry && argModelId) {
      // Called with explicit entry + model identity (Server Settings webview).
      // The webview keys everything by the extension `id`; for an unconfigured
      // server-reported model that id is just the server model id.
      const entryId = arg.server!;
      modelConfig = existing.find(m => m.server === entryId && resolveConfigId(m) === argModelId);
      vllmId = resolveVllmModelId(modelConfig) || argModelId;

      if (!modelConfig) {
        // Unconfigured model: the server reports it but settings has no entry
        // (Server Settings lists server-reported models even when unconfigured).
        // Auto-configure it as a NEW model referencing the selected entry —
        // same entry means same URL and credentials, nothing is duplicated.
        const discoveryResult = await resolveModelConfigForAddSafely(
          output, context, vllmId, argEntry.serverUrl, argEntry.requestHeaders,
          undefined, undefined, argEntry.serverType
        );
        if (!discoveryResult) {
          output.appendLine(`[INFO] Auto-configure stopped for new model "${vllmId}" - discovery returned no result.`);
          return;
        }

        const newConfig: IdentifiedModelConfig = {
          ...discoveryResult.modelConfig,
          id: buildModelId(entryId, vllmId),
          vllmModelId: vllmId,
          server: entryId,
        };
        if (discoveryResult.suggestedMaxOutputTokens !== undefined && newConfig.maxOutputTokens === undefined) {
          newConfig.maxOutputTokens = discoveryResult.suggestedMaxOutputTokens;
        }
        await confirmAndSaveAddedModel(
          newConfig, vllmId, argEntry.serverUrl, discoveryResult.summary.join('\n'), output,
          () => provider.clearCache(), discoveryResult.presetFile
        );
        return;
      }
    } else {
      // No args — show QuickPick to select a model
      const items = existing.map((m, idx) => {
        const label = m.displayName || resolveVllmModelId(m);
        return {
          label,
          description: `#${idx + 1}`,
          detail: resolveServer(m.server, servers)?.serverUrl || '(no server)',
        } as vscode.QuickPickItem;
      });

      const selected = await vscode.window.showQuickPick(items, {
        ignoreFocusOut: true,
        placeHolder: 'Select a model to re-configure',
      });
      if (!selected) {
        output.appendLine('[INFO] Auto-configure cancelled - no model selected.');
        return;
      }

      // `selected` is one of the object references `items` was just built from
      // (one item per `existing` entry, no filtering), so the index lookup
      // cannot miss — the old not-found guard was unreachable (CR-91).
      const idx = items.indexOf(selected);
      modelConfig = existing[idx];

      vllmId = resolveVllmModelId(modelConfig) || '';
      if (!vllmId) {
        output.appendLine('[ERROR] Selected model has no identifiable vLLM model id.');
        output.show(true);
        return;
      }
    }

    const modelServer = resolveServer(modelConfig.server, servers);
    if (!modelServer) {
      output.appendLine(`[ERROR] Model "${vllmId}" references server "${modelConfig.server}", which is not registered.`);
      output.show(true);
      return;
    }

    // 2. Shared resolution (preset check → dialog → preset or HuggingFace)
    const discoveryResult = await resolveModelConfigForAddSafely(
      output, context, vllmId, modelServer.serverUrl, modelServer.requestHeaders,
      undefined, // no server root for existing models
      modelConfig, // preserve identity
      modelServer.serverType // persist the model's own backend type
    );
    if (!discoveryResult) {
      output.appendLine(`[INFO] Auto-configure stopped for "${vllmId}" - discovery returned no result.`);
      return;
    }

    // 3. Merge: discovery result is the base (full model-specific replace).
    //    Only infrastructure/personal fields survive from the user's old config.
    //    Server facts (URL, auth, type) live on the registry entry the model
    //    references — the `server` ref is preserved verbatim.
    //    `preserveFrom` is parameterized on purpose (CR-43, the personality.ts
    //    doctrine): the Save branch re-reads the store and passes the LIVE entry,
    //    because discovery + the modal can take minutes, during which the entry
    //    may be edited (personal fields must survive from the NEW value, not a
    //    pre-dialog snapshot) or deleted outright (writing the snapshot through
    //    replaceModelConfig would APPEND it back to life).
    const buildMerged = (preserveFrom: ModelConfig): ModelConfig => {
      const merged: ModelConfig = {
        ...discoveryResult.modelConfig,
        id: preserveFrom.id,
        vllmModelId: preserveFrom.vllmModelId,
        server: preserveFrom.server,
        systemMessageReplacementsFile: preserveFrom.systemMessageReplacementsFile,
        autoContinueRetries: preserveFrom.autoContinueRetries,
        streamInactivityTimeout: preserveFrom.streamInactivityTimeout,
        initialResponseTimeoutMs: preserveFrom.initialResponseTimeoutMs,
        // Token-budget overrides are user-configured (webview "reserve headroom" /
        // chars-per-token fields) and must survive re-configure like the other
        // transport settings. replaceModelConfig strips undefined, so unset values
        // are inert here.
        maxInputTokens: preserveFrom.maxInputTokens,
        estimateCharsPerToken: preserveFrom.estimateCharsPerToken,
        // User decisions, not model facts (the presets.ts doctrine): the
        // configured cost, the OpenRouter pin/routing choice, and a user-chosen
        // label survive a re-configure. replaceModelConfig strips top-level
        // undefined, so the ?? fallbacks below mean: user value wins, discovery
        // fills the gap. Without this, one Auto-Configure silently deletes the
        // cost that anchors the whole dashboard history.
        cost: preserveFrom.cost ?? discoveryResult.modelConfig.cost,
        provider: preserveFrom.provider ?? discoveryResult.modelConfig.provider,
        routingMode: preserveFrom.routingMode ?? discoveryResult.modelConfig.routingMode,
        displayName: preserveFrom.displayName ?? discoveryResult.modelConfig.displayName,
      };
      if (discoveryResult.suggestedMaxOutputTokens !== undefined && merged.maxOutputTokens === undefined) {
        merged.maxOutputTokens = discoveryResult.suggestedMaxOutputTokens;
      }
      return merged;
    };

    // 4. Confirm dialog, then save or copy. The auto-configure path guards
    //    identity (vllmId via resolveVllmModelId, non-blank serverUrl) before
    //    merging; the store's runtime check is the backstop against a malformed
    //    write. No BYOK write here — the model already exists.
    output.appendLine(`[INFO] Auto-configure ${vllmId}:`);
    output.appendLine(discoveryResult.summary.join('\n'));
    const action = await vscode.window.showInformationMessage(
      `Update configuration for "${vllmId}"?`,
      { modal: true },
      'Save',
      'Copy JSON'
    );
    if (action === 'Save') {
      // Existence re-check at write time against a fresh read (CR-13 doctrine,
      // the pattern personality.ts comments): the modal may have sat open while
      // the Model Settings webview or another window removed the entry.
      const liveModels = readModels();
      const liveIdx = findModelConfigIndex(liveModels, resolveConfigId(modelConfig) ?? '', modelConfig.server ?? '');
      if (liveIdx < 0) {
        output.appendLine(
          `[WARN] Auto-configure aborted: model "${vllmId}" was removed while the confirm dialog was open - not writing (a write here would resurrect the deleted entry).`
        );
        void vscode.window.showWarningMessage(
          `vLLM-Copilot: model "${vllmId}" was deleted while this dialog was open - changes not saved.`
        );
        return;
      }
      try {
        await replaceModelConfig(buildMerged(liveModels[liveIdx]) as IdentifiedModelConfig);
      } catch (err) {
        output.appendLine(
          `[ERROR] Auto-configure: write failed for "${vllmId}": ${err instanceof Error ? err.message : String(err)}`
        );
        void vscode.window.showErrorMessage(
          `vLLM-Copilot: could not save model "${vllmId}" - settings unchanged.`
        );
        return;
      }
      provider.clearCache();
      vscode.window.showInformationMessage(`Model "${vllmId}" updated.`);
    } else if (action === 'Copy JSON') {
      await vscode.env.clipboard.writeText(JSON.stringify(buildMerged(modelConfig), null, 2));
      vscode.window.showInformationMessage('Model config copied to clipboard.');
    }
  });
}
