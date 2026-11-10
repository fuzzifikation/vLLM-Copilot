import * as vscode from 'vscode';
import { isDeepStrictEqual } from 'node:util';
import {
  resolveRequestParams,
  resolveServerType,
  resolveVllmModelId,
  type ModelConfig,
} from '../../core/config/config.js';
import { findPresetForModel, loadModelPresets } from '../commands/presets.js';
import { effectiveWriteTarget, readModels, readServers, writeModels } from '../state/configStore.js';
import { LEGACY_MODEL_MODE_SLUGS, readCopilotHarnessMapping, type CopilotHarnessMapping } from '../state/config.js';

const MIGRATION_FLAG = 'vllmCopilot.modelModeMigration.v1';
const REASONING_CONTROL_KEYS = ['reasoning_effort', 'chat_template_kwargs', 'reasoning'] as const;

/** Offline identifier/mapping migration; only exact known old preset controls are repaired. */
export async function maybeRunModelModeMigration(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<void> {
  try {
    const completionStates = {
      [vscode.ConfigurationTarget.Global]: { state: context.globalState, key: `${MIGRATION_FLAG}.user` },
      [vscode.ConfigurationTarget.Workspace]: { state: context.workspaceState, key: `${MIGRATION_FLAG}.workspace` },
      [vscode.ConfigurationTarget.WorkspaceFolder]: { state: context.workspaceState, key: `${MIGRATION_FLAG}.folder` },
    };
    let completionState = completionStates[effectiveWriteTarget('models')];
    if (completionState.state.get<string>(completionState.key) === 'done') return;
    if (readModels().length === 0) return;
    const presets = await loadModelPresets(context.extensionUri, { requireComplete: true });
    // Read again after the asynchronous file load; do not write an older settings snapshot.
    completionState = completionStates[effectiveWriteTarget('models')];
    if (completionState.state.get<string>(completionState.key) === 'done') return;
    const models = readModels();
    if (models.length === 0) return;
    const servers = readServers();
    const next = models.slice();
    const review = new Set<number>();
    const repaired = new Set<number>();
    let changed = 0;

    for (const [index, model] of models.entries()) {
      const modes = model.modelModes;
      if (!modes) continue;
      if (typeof modes !== 'object' || Array.isArray(modes)) {
        output.appendLine(`[WARN] Mode migration: model "${model.id}" has malformed modes; kept unchanged.`);
        review.add(index);
        continue;
      }
      const names = Object.keys(modes);
      if (names.length === 0) continue;
      const { effortByMode, warning } = readCopilotHarnessMapping(model);
      if (warning) {
        output.appendLine(`[WARN] Mode migration: ${warning} Model kept unchanged.`);
        review.add(index);
        continue;
      }
      const targets = names.map(name => LEGACY_MODEL_MODE_SLUGS.get(name) ?? name);
      if (new Set(targets).size !== targets.length) {
        output.appendLine(`[WARN] Mode migration: model "${model.id}" has a slug collision; kept unchanged.`);
        review.add(index);
        continue;
      }
      const renames = new Map(names.flatMap((name, position) =>
        name === targets[position] ? [] : [[name, targets[position]] as const]));
      const updated: ModelConfig & { copilotHarnessMapping?: CopilotHarnessMapping } = { ...model };
      let modelChanged = renames.size > 0;
      if (modelChanged) {
        updated.modelModes = Object.fromEntries(Object.entries(modes).map(([name, params]) =>
          [renames.get(name) ?? name, params]));
        if (model.defaultMode && renames.has(model.defaultMode)) {
          updated.defaultMode = renames.get(model.defaultMode);
        }
      }

      const wireId = resolveVllmModelId(model);
      // OpenRouter discovery deliberately does not use bundled HF presets.
      const preset = resolveServerType(model, servers) !== 'openrouter' && wireId
        ? findPresetForModel(presets, wireId) : undefined;
      if (preset && updated.modelModes) {
        for (const [name, params] of Object.entries(preset.config.modelModes ?? {})) {
          let previous: Record<string, unknown> | undefined;
          if (preset.sourceFile === 'DeepSeek-V4-Pro.json' && name === 'No-Think') {
            const { chat_template_kwargs: _controls, reasoning_effort: _effort, ...legacy } = params;
            previous = legacy;
          } else if (preset.sourceFile === 'Agents-A1-config.json') {
            const kwargs = params.chat_template_kwargs;
            if (kwargs && typeof kwargs === 'object' && 'enable_thinking' in kwargs && kwargs.enable_thinking === true) {
              previous = { ...params, chat_template_kwargs: { ...kwargs, preserve_thinking: true } };
            }
          }
          if (previous && isDeepStrictEqual(updated.modelModes[name], previous)) {
            const effective = resolveRequestParams(updated, name);
            if (REASONING_CONTROL_KEYS.some(key => !isDeepStrictEqual(effective[key], previous[key]))) {
              output.appendLine(`[WARN] Mode migration: model "${model.id}" mode "${name}" inherits custom reasoning controls; preset repair was skipped.`);
              review.add(index);
              continue;
            }
            updated.modelModes = { ...updated.modelModes, [name]: params };
            repaired.add(index);
            modelChanged = true;
          }
        }
      }

      const hasMapping = 'copilotHarnessMapping' in model && model.copilotHarnessMapping !== undefined;
      if (hasMapping && renames.size > 0) {
        updated.copilotHarnessMapping = Object.fromEntries([...effortByMode].map(([name, effort]) =>
          [effort, renames.get(name) ?? name]));
      } else if (!hasMapping) {
        if (preset?.config.copilotHarnessMapping) {
          const mapping: Record<string, string> = {};
          const presetModel: ModelConfig = { ...preset.config, id: model.id, server: model.server };
          for (const [effort, name] of Object.entries(preset.config.copilotHarnessMapping)) {
            if (!Object.hasOwn(updated.modelModes ?? {}, name)) continue;
            const saved = resolveRequestParams(updated, name);
            const recommended = resolveRequestParams(presetModel, name);
            if (REASONING_CONTROL_KEYS.some(key =>
              !isDeepStrictEqual(saved[key], recommended[key]))) {
              output.appendLine(`[WARN] Mode migration: model "${model.id}" mode "${name}" has custom reasoning controls; no harness alias added for it.`);
              review.add(index);
              continue;
            }
            mapping[effort] = name;
          }
          const candidate = { ...updated, copilotHarnessMapping: mapping };
          const checked = readCopilotHarnessMapping(candidate);
          if (checked.warning || checked.effortByMode.size === 0) {
            output.appendLine(`[WARN] Mode migration: model "${model.id}" needs a manual harness mapping${checked.warning ? `: ${checked.warning}` : '.'}`);
            review.add(index);
          } else {
            updated.copilotHarnessMapping = mapping;
            modelChanged = true;
          }
        } else {
          output.appendLine(`[WARN] Mode migration: model "${model.id}" has no matching bundled harness mapping; no mapping was invented.`);
          review.add(index);
        }
      }
      if (modelChanged) {
        next[index] = updated;
        changed++;
      }
    }

    if (changed > 0) await writeModels(next);
    await completionState.state.update(completionState.key, 'done');
    if (changed > 0) {
      const parameters = repaired.size > 0
        ? `Customized parameters were kept; ${repaired.size} model(s) received known preset-control repairs.`
        : 'Your parameters were kept.';
      output.appendLine(`[INFO] Mode migration: updated ${changed} model(s). ${parameters} Identity and other settings were preserved.`);
      void vscode.window.showInformationMessage(
        `vLLM-Copilot 1.38.0 updated mode identifiers and compatible harness mappings for ${changed} model(s). ${parameters} Reselect the mode once in existing chats.${review.size ? ` ${review.size} model(s) need manual review; see vLLM-Copilot Output.` : ''}`,
      );
    } else if (review.size > 0) {
      void vscode.window.showWarningMessage(
        `vLLM-Copilot: ${review.size} model(s) need manual mode migration. Settings were kept unchanged; see vLLM-Copilot Output.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[WARN] Mode migration failed: ${message}`);
    void vscode.window.showErrorMessage(`vLLM-Copilot: could not migrate model modes; will retry next start. ${message}`);
  }
}
