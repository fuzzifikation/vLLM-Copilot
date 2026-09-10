/**
 * Set Model Personality workflow: pick a model, pick/clear a personality preset,
 * and persist via the config store. Extracted from the root `commands.ts` facade
 * so the workflow — including the server-less guard — is
 * independently testable.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import type { VllmChatModelProvider } from '../provider/provider.js';
import { getConfig, findModelConfigIndex, pathsEquivalent, resolveConfigId, resolveServerConfig } from '../state/config.js';
import { patchModelConfig, readModels } from '../state/configStore.js';
import { discoverPersonalities, resolveModelReplacements } from '../persona/personalityStore.js';
import { describeError } from '../provider/messageConverter.js';

/**
 * A personality option in the Set Model Personality quick pick (step 2/2).
 * Discriminated: the Default entry is `clear: true`, preset entries carry a
 * `sourcePath`, separators carry only `kind` — "neither clear nor path" is
 * unrepresentable, so no runtime guard can exist for it either. The apply
 * path tests `clear === true`, never `'clear' in pick`: a property check
 * would treat a spread-in `clear: undefined` as a CLEAR signal, silently
 * wiping the model's personality instead of applying the picked preset.
 */
type PersonalityPick = { label: string; description?: string } & (
  | { clear: true; kind?: undefined }
  | { sourcePath: string; name?: string; bundled?: boolean; kind?: undefined; clear?: undefined }
  | { kind: vscode.QuickPickItemKind.Separator; clear?: undefined; sourcePath?: undefined }
);

/** Apply a bundled personality preset to a model's system message replacements. */
export function registerSetModelPersonalityCommand(
  context: vscode.ExtensionContext,
  provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'vllm-copilot.setModelPersonality',
    async () => {
      const cfg = await getConfig();
      const models = cfg.models;
      const servers = cfg.servers;

      if (models.length === 0) {
        vscode.window.showInformationMessage(
          'No models are configured yet. Add a model first.'
        );
        return;
      }

      // Step 1: pick the model
      const modelItems = models.map((m) => ({
        label: m.displayName || m.id || '(unnamed)',
        description: resolveServerConfig(m, servers)?.serverUrl || 'no server',
        model: m,
      }));

      const modelPick = await vscode.window.showQuickPick(modelItems, {
        ignoreFocusOut: true,
        title: 'Set Model Personality (step 1/2)',
        placeHolder: 'Select a model',
      });
      if (!modelPick) return;

      // A model with an unresolvable server ref cannot be matched by
      // replaceModelConfig (findModelConfigIndex needs both id and server) and
      // would otherwise append a duplicate entry into settings.json. Skip it
      // with a clear warning instead of corrupting the config.
      if (!modelPick.model.server?.trim() || !resolveServerConfig(modelPick.model, servers)) {
        const label = modelPick.model.displayName || modelPick.model.id || '(unnamed)';
        outputChannel.appendLine(
          `[WARN] Personality not applicable: Model "${label}" has no resolvable server configured. Add a server before setting a personality.`
        );
        outputChannel.show(true);
        return;
      }

      // Step 2: discover and pick the personality (the global folder).
      // A name collision (a copied preset keeps its meta.name) makes the
      // entries indistinguishable by label — this surface is user-initiated,
      // so the warning goes to the user, not just the log.
      const collisions: string[] = [];
      const presets = await discoverPersonalities(context, (m) => collisions.push(m));
      if (collisions.length > 0) {
        for (const m of collisions) outputChannel.appendLine(`[WARN] ${m}`);
        void vscode.window.showWarningMessage(collisions[0]);
      }
      const dupeNames = new Set(
        presets.map((p) => p.name).filter((n, i, arr) => arr.indexOf(n) !== i),
      );

      // Which option is current comes from THE shared resolver — the same
      // function the request pipeline and Model Settings run. Detecting it
      // separately here is what let this picker claim "Default" while chat was
      // busy applying a personality (a stored path outside the discovered
      // folder, a preset path carried over from another OS).
      const nameRef = (modelPick.model.personality || '').trim();
      const fileRef = (modelPick.model.systemMessageReplacementsFile || '').trim();
      const hasReplacements = !!nameRef || !!fileRef;
      const resolved = hasReplacements ? await resolveModelReplacements(context, modelPick.model) : null;
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
            "Clear replacements - use Copilot's original system prompt",
            isDefaultActive,
          ),
          clear: true,
        },
      ];

      if (presets.length > 0) {
        pickItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        for (const p of presets) {
          // When the resolver identified a SHIPPED preset, current is the
          // BUNDLED entry of that name (twins stay unmarked — the name means
          // the shipped file). Otherwise current is the resolved PATH, never
          // the display name: matching by name would checkmark every twin.
          const isCurrent = !!resolved && !isDefaultActive && (resolved.personality
            ? p.bundled === true && p.name === resolved.personality
            : pathsEquivalent(p.sourcePath, resolved.sourcePath));
          // Twins are told apart by the file they live in.
          const description = dupeNames.has(p.name)
            ? `${p.description ? `${p.description} · ` : ''}${path.basename(p.sourcePath)}`
            : p.description;
          pickItems.push({
            ...markCurrent(p.name, description, isCurrent),
            sourcePath: p.sourcePath,
            name: p.name,
            bundled: p.bundled,
          });
        }
      }

      // Honest current label: the preset name when the resolver identified one,
      // else the stored name reference, else the stored path — a custom file
      // that is not a listed personality still counts as "not default". `||`
      // throughout, on purpose: an empty name reference is an empty string, not
      // nullish, and `??` there used to print "Default" over a live file.
      const activePath = resolved?.sourcePath;
      const currentLabel = !hasReplacements
        ? 'Default (no personality)'
        : (activePath ? presets.find(p => pathsEquivalent(p.sourcePath, activePath))?.name : undefined)
          || resolved?.personality || nameRef || fileRef;

      const personalityPick = await vscode.window.showQuickPick(pickItems, {
        ignoreFocusOut: true,
        title: 'Set Model Personality (step 2/2)',
        placeHolder: `Current: ${currentLabel}`,
      });
      if (!personalityPick || personalityPick.kind === vscode.QuickPickItemKind.Separator) return;

      try {
        // The personality folder is seeded into global storage at activation
        // (syncBundledPersonalities), so every discovered path is already the
        // final, user-owned-where-user-owned location: applying is a bare
        // reference write, no copy, no materialization step.
        // Re-read at write time and patch ONLY this command's field (the CR-13
        // staleness doctrine, same fix as the Add flows): the entry was
        // snapshotted before two quickpicks and an awaited file copy, so the
        // previous whole-entry replace clobbered any concurrent edit (webview
        // save, auto-configure) with the stale object. Identity re-checked
        // against the LIVE store with the store's own matcher: a model deleted
        // or re-keyed since the pick aborts honestly, instead of being appended
        // back as a shell by patchModelConfig's documented append-on-no-match.
        const pickId = resolveConfigId(modelPick.model);
        const pickServer = modelPick.model.server ?? '';
        // Blank id: the old replaceModelConfig path refused this at the store
        // boundary (assertValidIdentity); refuse it here with an honest line.
        if (!pickId || !pickId.trim() || findModelConfigIndex(readModels(), pickId, pickServer) < 0) {
          outputChannel.appendLine(
            `[WARN] Personality not applied: model "${pickId}" no longer exists (deleted or re-keyed since it was picked). Nothing was saved.`
          );
          return;
        }
        // Empty string is the explicit clear signal (undefined would preserve the previous value).
        // Shipped presets store the portable NAME and clear the path; user
        // files store the path and clear any stale name (the name outranks).
        // The discriminated pick type leaves nothing else to check.
        const patch = personalityPick.clear === true
          ? { personality: '', systemMessageReplacementsFile: '' }
          : personalityPick.bundled && personalityPick.name
            ? { personality: personalityPick.name, systemMessageReplacementsFile: '' }
            : { personality: '', systemMessageReplacementsFile: personalityPick.sourcePath };
        await patchModelConfig({ id: pickId, server: pickServer }, patch);
        outputChannel.appendLine(
          `[INFO] Personality presets: ${personalityPick.clear === true
            ? 'cleared'
            : `applied ${personalityPick.name || personalityPick.sourcePath}`} for ${modelPick.label}`
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
        personalityPick.clear === true
          ? `Cleared personality for "${modelPick.label}". Using Copilot's original system prompt.`
          : `Applied "${plainLabel}" personality to "${modelPick.label}".`
      );

      // Invalidate the provider's config cache so replacements take effect immediately
      provider.clearCache();
    }
  );
}
