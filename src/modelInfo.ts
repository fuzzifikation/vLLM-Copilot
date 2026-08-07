/**
 * Construction of VS Code `LanguageModelChatInformation` from vLLM server models
 * and user overrides. Pure functions with no provider state, so they can be
 * unit-tested without instantiating the provider.
 */

import * as vscode from 'vscode';
import { extractFamilyWithSource } from './modelUtils.js';
import { deriveTokenBudget } from './tokenBudget.js';
import { buildModelId, type ModelConfig } from './config.js';

/**
 * Build the `configurationSchema` for a model's picker settings.
 *
 * Returns undefined when the model has no model modes configured.
 *
 * @param override - Per-model override from `vllm-copilot.models` settings
 */
export function buildConfigurationSchema(
  override: Pick<ModelConfig, 'modelModes' | 'defaultMode'> | undefined
): { properties: Record<string, unknown> } | undefined {
  if (override?.modelModes && Object.keys(override.modelModes).length > 0) {
    const modes = Object.keys(override.modelModes);
    const defaultMode = override.defaultMode && modes.includes(override.defaultMode)
      ? override.defaultMode
      : modes[0];
    return {
      properties: {
        reasoningEffort: {
          type: 'string',
          title: 'Model Mode',
          enum: modes,
          enumItemLabels: modes,
          default: defaultMode,
          group: 'navigation',
        },
      },
    };
  }

  return undefined;
}

/**
 * Build LanguageModelChatInformation from a server model and an optional user override.
 * When `override` is undefined, defaults are used for all fields.
 *
 * @param serverModel - The vLLM wire model (`id` is the vLLM model id, not the picker id).
 * @param override - Per-model override from `vllm-copilot.models`.
 * @param config - Resolved token/transport settings.
 * @param serverUrl - The model's server URL. Used to derive a unique picker id when
 *   `override.id` is absent (so the same vLLM model on two servers yields two distinct
 *   picker entries instead of colliding on the wire id).
 * @param onFamilyFallback - Called once with `(family, modelId)` when the family had to
 *   be estimated from the model id via the org-name fallback (no preset/HF family).
 */
export function buildModelInfo(
  serverModel: { id: string; max_model_len?: number },
  override: Partial<ModelConfig> | undefined,
  config: { maxOutputTokens: number },
  serverUrl: string,
  /**
   * Invoked once with `(family, modelId)` when no preset/HuggingFace family was
   * available and the family had to be estimated from the model id via the
   * org-name fallback. Callers with an OutputChannel can route this to a
   * `[WARN]` line. Optional — omit to suppress.
   */
  onFamilyFallback?: (family: string, modelId: string) => void,
): vscode.LanguageModelChatInformation {
  const budget = deriveTokenBudget(serverModel.max_model_len, config.maxOutputTokens, override, serverModel.id);

  // Resolve family: preset-declared family is authoritative; otherwise fall back
  // to the heuristic. When the heuristic itself falls through to the org-name
  // guess (i.e. no preset AND HuggingFace `config.model_type` was unavailable),
  // surface that to the caller so it can warn the user.
  let family: string;
  if (override?.family) {
    family = override.family;
  } else {
    const extracted = extractFamilyWithSource(serverModel.id);
    family = extracted.family;
    if (extracted.fromFallback) {
      onFamilyFallback?.(family, serverModel.id);
    }
  }

  // Picker id: an explicit `id` is the unique extension key; otherwise derive a
  // unique id from (serverUrl, vllmModelId) so the same model on two servers
  // shows as two picker entries instead of colliding on the wire id.
  // `resolveOverrideForModel` round-trips this derived id back to its config.
  const presetId = override?.id || buildModelId(serverUrl, serverModel.id);
  const info: any = {
    id: presetId,
    name: override?.displayName || presetId,
    family,
    version: '1.0.0',
    maxInputTokens: budget.maxInputTokens,
    maxOutputTokens: budget.maxOutputTokens,
    capabilities: {
      toolCalling: override?.capabilities?.toolCalling ?? true,
      imageInput: override?.capabilities?.imageInput ?? false,
    },
  };

  const schema = override ? buildConfigurationSchema(override) : undefined;
  if (schema) {
    info.configurationSchema = schema;
  }

  return info;
}
