import * as vscode from 'vscode';
import {
  resolveVllmModelId,
  resolveOverrideForModel,
  resolveServerConfig,
  resolveModelSettings,
  resolveServerType,
  resolveConfiguredMaxTokens,
  buildModelId,
  type ModelConfig,
} from '../config.js';
import { buildModelInfo } from '../modelInfo.js';
import { describeError } from '../messageConverter.js';
import type { ProviderClient } from './contracts.js';

/**
 * Discover available models from configured overrides: fetch each model's
 * context window from its server, build the model info, and collect warnings.
 *
 * All models are queried in parallel so discovery time = max(server latencies),
 * not sum. Pure w.r.t. the collaborator surfaces — the remote-install guard and
 * the cached-model set are the provider's (lifecycle/cache owner); this function
 * takes the overrides + client and returns the discovered models.
 *
 * Policy: a model is served ONLY when its server reports a context window on the
 * standard documented path for its backend. A missing window or unreachable server
 * THROWS from the resolver and the model is skipped with a clear warning — never
 * a fabricated budget. The resolver's own message is preserved verbatim so the
 * user sees the backend-specific cause, not a vague rewrite.
 *
 * Output-budget contract (per-mode max_tokens, Option A): the advertised
 * `maxOutputTokens` is the user-configured `max_tokens` (mode > defaultParams),
 * clamped by `deriveTokenBudget` to the context window + server-reported output
 * ceiling. The REQUEST path (`resolveMaxTokensForRequest`) clamps the wire to
 * this SAME advertised value, so the two can never disagree and the wire can
 * never exceed what Copilot was told. To make that work, the override is CLONED
 * with the effective budget as `maxOutputTokens` because `deriveTokenBudget`
 * prioritizes `override.maxOutputTokens` over its config argument — without the
 * clone, a preset/model-level `maxOutputTokens` silently discards the mode's
 * `max_tokens` and Copilot would never receive updated limits.
 */
export async function discoverModels(
  modelOverrides: ModelConfig[],
  client: Pick<ProviderClient, 'getModelContextWindow'>,
  output: vscode.OutputChannel,
  onModelDiscovered?: (modelId: string, contextWindow: number) => void,
  /**
   * Currently selected model mode per picker id (provider-tracked). When a mode
   * sets `max_tokens`, that becomes the model's advertised output budget so
   * re-registered metadata (and Copilot's context-window bar) reflects it.
   */
  selectedModeByModel?: ReadonlyMap<string, string>,
): Promise<vscode.LanguageModelChatInformation[]> {
  // Process each model: fetch context window from server, build info, or record error.
  // All models are queried in parallel so discovery time = max(server latencies), not sum.
  const tasks = modelOverrides.map(async (override) => {
    if (!override.serverUrl) {
      const id = override.id || resolveVllmModelId(override) || '(unnamed model)';
      return {
        model: null,
        contextWindow: null,
        error: `[WARN] Model "${id}" has no serverUrl and will be skipped. Add one or run "Add vLLM Server & Model".`,
      };
    }

    const settings = resolveModelSettings(override);
    const vllmModelId = resolveVllmModelId(override) || override.id || '';
    const serverConfig = resolveServerConfig(override);
    const serverType = resolveServerType(override);

    // Picker id — matches buildModelInfo's derivation so provider-tracked mode
    // selections keyed by model.id resolve to the right override.
    const presetId = override.id || buildModelId(serverConfig.serverUrl, vllmModelId);

    // Advertise the user-configured output budget (mode > defaultParams) as the
    // model's maxOutputTokens so re-registered metadata — and Copilot's context
    // bar — agrees with the wire (both read resolveConfiguredMaxTokens).
    const selectedMode = selectedModeByModel?.get(presetId);
    const effectiveMaxOutput = resolveConfiguredMaxTokens(override, selectedMode) ?? settings.maxOutputTokens;
    // deriveTokenBudget prioritizes `override.maxOutputTokens` over its config
    // argument, so hand it a clone carrying the effective budget. Without this a
    // preset/model-level maxOutputTokens silently discards the mode's max_tokens
    // and Copilot would never receive updated limits (finding: presets all set
    // maxOutputTokens, so the feature was dead for them).
    const overrideForBudget = { ...override, maxOutputTokens: effectiveMaxOutput };

    try {
      // Resolve runtime limits (context window + optional server-reported output
      // ceiling), switching strictly on the model's serverType. Connection/auth/5xx
      // failures and a missing window all THROW from the resolver with a
      // backend-specific message — no fabricated budget (user directive). The error
      // message below preserves that detail.
      const limits = await client.getModelContextWindow(
        serverType,
        serverConfig.serverUrl,
        serverConfig.requestHeaders,
        vllmModelId
      );

      const serverModel = { id: vllmModelId, max_model_len: limits.contextWindow };
      return {
        model: buildModelInfo(serverModel, overrideForBudget, settings, serverConfig.serverUrl, limits.maxOutputTokens, (family, modelId) => {
          // Fires only when no preset-declared family was available AND
          // HuggingFace auto-discovery did not provide one — the heuristic
          // fell through to the org-name guess. The family is just a sort key
          // in the model picker so this is non-fatal, but the user should
          // know the discovery path didn't reach HuggingFace.
          output.appendLine(
            `[WARN] Model "${modelId}" — family estimated as "${family}" from org-name fallback (no preset/HuggingFace family available). Family is informational only; use a preset or run auto-discovery for authoritative values.`
          );
        }),
        contextWindow: limits.contextWindow,
        error: null,
      };
    } catch (err) {
      const id = override.id || vllmModelId || '(unnamed model)';
      return {
        model: null,
        contextWindow: null,
        error: `[WARN] Model "${id}" skipped: ${describeError(err)}`,
      };
    }
  });

  const results = await Promise.all(tasks);
  const models: vscode.LanguageModelChatInformation[] = [];

  // Every task self-catches and resolves with `{ model, error }` — no task can
  // reject (a rejection here would be a programming error inside the map
  // callback, not a model-skipping condition). `Promise.all` is honest: there is
  // no rejected branch to handle.
  for (const { model, contextWindow, error } of results) {
    if (model) {
      models.push(model);
      if (contextWindow !== null) onModelDiscovered?.(model.id, contextWindow);
    }
    if (error) {
      output.appendLine(error);
    }
  }

  // Picker ids are unique per (server, model) by construction (composite ids
  // for id-less configs). The only remaining collision source is an explicit
  // duplicate `id` in settings — surface it so a silent collapse in the picker
  // is never a mystery (all working models must stay visible).
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const m of models) {
    if (seenIds.has(m.id)) duplicateIds.add(m.id);
    seenIds.add(m.id);
  }
  for (const dup of duplicateIds) {
    output.appendLine(
      `[WARN] Duplicate model id "${dup}" — multiple configs share this id and collapse to one picker entry. Give each model a unique "id".`
    );
  }

  if (models.length > 0) {
    const summary = models.map(m => {
      const ctx = ((m.maxInputTokens || 0) + (m.maxOutputTokens || 0)).toLocaleString('en-US');
      return `${m.id} (${ctx} ctx)`;
    }).join(', ');
    output.appendLine(`[INFO] Loaded ${models.length} model(s): ${summary}`);
  }

  return models;
}
