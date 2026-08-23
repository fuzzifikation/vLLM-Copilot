/**
 * Set Model Personality workflow: pick a model, pick/clear a personality preset,
 * and persist via the config store. Extracted from the root `commands.ts` facade
 * (refactor-plan §2.3) so the workflow — including the server-less guard — is
 * independently testable.
 */

import * as vscode from 'vscode';
import type { VllmChatModelProvider } from '../provider.js';
import { getConfig } from '../config.js';
import type { ModelConfig } from '../config.js';
import { replaceModelConfig, type IdentifiedModelConfig } from '../configStore.js';
import { discoverPersonalities, ensureGlobalPersonality, resolveActivePersonality } from '../personalityStore.js';
import { describeError } from '../messageConverter.js';

/**
 * A personality option in the Set Model Personality quick pick (step 2/2).
 * Hoisted to module scope so the picker builder and the apply path share one type.
 */
interface PersonalityPick {
  label: string;
  description?: string;
  clear?: boolean;
  sourcePath?: string;
  kind?: vscode.QuickPickItemKind;
}

/**
 * A personality can only be persisted on a model with a `serverUrl`: the config
 * matcher (`findModelConfigIndex`) requires both config id and serverUrl, so a
 * server-less model falls through to `replaceModelConfig`'s append branch and
 * writes a duplicate entry. This guard lets the caller skip such models with a
 * clear warning instead of corrupting settings.json.
 * @returns `{ ok: true }` or `{ ok: false, reason }` with a user-facing message.
 */
export function personalityApplicableTo(model: ModelConfig): { ok: true } | { ok: false; reason: string } {
  if (!model.serverUrl?.trim()) {
    const label = model.displayName || model.id || '(unnamed)';
    return {
      ok: false,
      reason: `Model "${label}" has no serverUrl configured. Add a server before setting a personality.`,
    };
  }
  return { ok: true };
}

/** Apply a bundled personality preset to a model's system message replacements. */
export function registerSetModelPersonalityCommand(
  context: vscode.ExtensionContext,
  provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'vllm-copilot.setModelPersonality',
    async () => {
      const cfg = await getConfig(context);
      const models = cfg.models || [];

      if (models.length === 0) {
        vscode.window.showInformationMessage(
          'No models are configured yet. Add a model first.'
        );
        return;
      }

      // Step 1: pick the model
      const modelItems = models.map((m) => ({
        label: m.displayName || m.id || '(unnamed)',
        description: m.serverUrl || 'no serverUrl',
        model: m,
      }));

      const modelPick = await vscode.window.showQuickPick(modelItems, {
        ignoreFocusOut: true,
        title: 'Set Model Personality (step 1/2)',
        placeHolder: 'Select a model',
      });
      if (!modelPick) return;

      // A server-less model cannot be matched by replaceModelConfig (findModelConfigIndex
      // needs both id and serverUrl) and would otherwise append a duplicate entry.
      const applicability = personalityApplicableTo(modelPick.model);
      if (!applicability.ok) {
        outputChannel.appendLine(`[WARN] Personality not applicable: ${applicability.reason}`);
        outputChannel.show(true);
        return;
      }

      // Step 2: discover and pick the personality (bundled + global)
      const presets = await discoverPersonalities(context);

      // Resolve which option is currently active from the model's replacements file.
      // A custom file that isn't a known personality still counts as "not default".
      const hasReplacements = !!(modelPick.model.systemMessageReplacementsFile || '').trim();
      const active = await resolveActivePersonality(context, modelPick.model.systemMessageReplacementsFile, presets);
      const isDefaultActive = !hasReplacements;

      const markCurrent = (label: string, description: string | undefined, active: boolean): Pick<PersonalityPick, 'label' | 'description'> => ({
        label: active ? `$(check) ${label}` : label,
        description: active
          ? (description ? `${description} · current` : 'current')
          : description,
      });

      const pickItems: PersonalityPick[] = [
        {
          ...markCurrent(
            'Default (no personality)',
            "Clear replacements — use Copilot's original system prompt",
            isDefaultActive,
          ),
          clear: true,
        },
      ];

      if (presets.length > 0) {
        pickItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        for (const p of presets) {
          const isCurrent = !isDefaultActive && active?.name === p.name;
          pickItems.push({
            ...markCurrent(p.name, p.description, isCurrent),
            sourcePath: p.sourcePath,
          });
        }
      }

      const currentLabel = !hasReplacements
        ? 'Default (no personality)'
        : (active?.name ?? modelPick.model.systemMessageReplacementsFile) || 'Default (no personality)';

      const personalityPick = await vscode.window.showQuickPick(pickItems, {
        ignoreFocusOut: true,
        title: 'Set Model Personality (step 2/2)',
        placeHolder: `Current: ${currentLabel}`,
      });
      if (!personalityPick || personalityPick.kind === vscode.QuickPickItemKind.Separator) return;

      const clear = personalityPick.clear;
      const sourcePath = personalityPick.sourcePath;
      if (!clear && !sourcePath) {
        // Unreachable in practice: every non-separator pick item is either
        // `clear: true` or carries a `sourcePath`. This guard exists only to
        // narrow `clear`/`sourcePath` for the code below — a missed preset
        // would fall through here, so the message stays honest about what it
        // means rather than blaming missing presets.
        outputChannel.appendLine('[WARN] No personality action was selected.');
        return;
      }

      try {
        // Applying materializes the personality in global storage. Bundled
        // presets are extension-owned and re-synced from the shipped file on
        // every apply (see ensureGlobalPersonality); user-created personalities
        // are stored once and never clobbered.
        const replacementsFile = clear
          ? ''
          : await ensureGlobalPersonality(context, sourcePath!);
        // serverUrl is verified non-blank by personalityApplicableTo above; id or
        // vllmModelId is present for any matched entry. The store re-validates
        // identity at runtime rather than writing a malformed entry.
        await replaceModelConfig({
          ...modelPick.model,
          // Empty string is the explicit clear signal (undefined would preserve the previous value).
          systemMessageReplacementsFile: replacementsFile,
        } as IdentifiedModelConfig);
        outputChannel.appendLine(
          `[INFO] Personality presets: ${clear ? 'cleared' : `applied ${sourcePath}`} for ${modelPick.label}`
        );
      } catch (err) {
        outputChannel.appendLine(`[ERROR] Failed to apply personality: ${describeError(err)}`);
        outputChannel.show(true);
        vscode.window.showErrorMessage(`Failed to apply personality: ${describeError(err)}`);
        return;
      }

      // The label may carry the "$(check)" icon prefix when the picked preset is
      // the currently-active one — strip it so the message reads cleanly.
      const plainLabel = personalityPick.label.replace(/^\$\(check\)\s*/, '');
      vscode.window.showInformationMessage(
        clear
          ? `Cleared personality for "${modelPick.label}". Using Copilot's original system prompt.`
          : `Applied "${plainLabel}" personality to "${modelPick.label}".`
      );

      // Invalidate the provider's config cache so replacements take effect immediately
      provider.clearCache();
    }
  );
}
