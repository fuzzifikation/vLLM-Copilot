/**
 * One-time migration offer: upgrade pre-v1.35 model entries to the vector-form
 * `maxOutputTokens` so they get the Output Length dropdown.
 *
 * Model entries saved before v1.35 carry a scalar `maxOutputTokens` (or none),
 * which is a perfectly valid plain cap — but renders no Output Length menu.
 * On activation (offline, zero server calls) we check whether an upgradable
 * vector can be built for each such model WITHOUT inventing anything:
 *
 *   1. PRESET: the model matches a bundled preset that declares a vector →
 *      adopt it verbatim (user decision: preset wins, even over a higher
 *      user scalar — the preset menu is the curated, model-card-backed one).
 *   2. SYNTHESIZED: the user's own config already encodes a length ladder
 *      (per-mode / defaultParams `max_tokens`, plus their scalar budget) →
 *      promote those exact values into a descending vector and strip the now
 *      dead `max_tokens` layers (the picker replaces them entirely — leaving
 *      them in would be the dead-config trap the docs warn about).
 *   3. Neither → the model is left completely alone. No derived ladders,
 *      no invented menus (the vector-only contract, enforced in migration too).
 *
 * The offer fires at most once per install (globalState: 'done' | 'declined'),
 * only when at least one proposal exists. Applying writes through the same
 * `patchModelConfig` store as the settings webview — field-level merges only,
 * identity/headers/personalities untouched.
 */

import * as vscode from 'vscode';
import type { ModelConfig } from '../state/config.js';
import { findModelConfigIndex, resolveConfigId, resolveVllmModelId } from '../state/config.js';
import { resolveOutputLengthVector } from '../shared/tokenBudget.js';
import { loadModelPresets, findPresetForModel, type ModelPreset } from '../commands/presets.js';
import { patchModelConfig, readModels } from '../state/configStore.js';

/** globalState key; bump the suffix if the proposal logic ever changes materially. */
const MIGRATION_FLAG = 'vllmCopilot.outputLengthMigration.v1';

/** Patch payload for one model, computed at plan time so apply is a dumb loop. */
export interface OutputLengthProposal {
  /** Config entry identity (patch lookup key). */
  id: string;
  server: string;
  /** What to show the user in the notification/preview. */
  displayName: string;
  /** Current value (scalar, or undefined = default) — for the before/after preview. */
  from: number | number[] | undefined;
  /** Proposed menu (≥2 entries, descending, sanitized). */
  to: number[];
  source: 'preset' | 'synthesized';
  /** Preset filename when source === 'preset'. */
  sourceFile?: string;
  /** Field-level patch for `patchModelConfig` (maxOutputTokens + stripped layers). */
  updates: Omit<Partial<ModelConfig>, 'id' | 'server'>;
}

/**
 * Copy `modelModes` with every entry's `max_tokens` removed. Returns undefined
 * when nothing was removed (caller leaves `modelModes` untouched then). An
 * entry emptied by the strip is dropped; ALL entries emptied → `''` (the
 * store's documented CLEAR signal — an empty object is not a valid modes map).
 */
function stripModeMaxTokens(
  modes: Record<string, Record<string, unknown>> | undefined
): Record<string, Record<string, unknown>> | '' | undefined {
  if (!modes) return undefined;
  let removed = false;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, params] of Object.entries(modes)) {
    if (params && Object.prototype.hasOwnProperty.call(params, 'max_tokens')) {
      removed = true;
      const { max_tokens: _dropped, ...rest } = params;
      if (Object.keys(rest).length > 0) out[name] = rest as Record<string, unknown>;
    } else {
      out[name] = params;
    }
  }
  if (!removed) return undefined;
  return Object.keys(out).length > 0 ? out : '';
}

/**
 * Build the per-model upgrade proposals (pure, offline, no vscode APIs).
 * Entries that already hold a vector, or for which no honest menu can be
 * built, are skipped silently. Malformed entries (no id / no server) are
 * skipped — the store would refuse them anyway.
 */
export function planOutputLengthMigration(
  models: readonly ModelConfig[],
  presets: readonly ModelPreset[]
): OutputLengthProposal[] {
  const proposals: OutputLengthProposal[] = [];
  for (const m of models) {
    if (Array.isArray(m.maxOutputTokens)) continue; // already a menu
    const id = resolveConfigId(m);
    if (!id?.trim() || !m.server?.trim()) continue;

    const updates: Omit<Partial<ModelConfig>, 'id' | 'server'> = {};

    // Shared dead-parameter cleanup (CR-59): the dropdown pick outranks
    // defaultParams.max_tokens forever, so that layer is exactly the "completely
    // dead config" this migration exists to delete — the synthesized branch used
    // to strip it while the preset branch left it behind.
    if (typeof m.defaultParams?.max_tokens === 'number') {
      const { max_tokens: _dropped, ...restParams } = m.defaultParams as Record<string, unknown>;
      updates.defaultParams = (Object.keys(restParams).length > 0 ? restParams : '') as Partial<ModelConfig>['defaultParams'];
    }

    // 1. Preset vector wins outright (user decision — even over a higher user
    //    scalar). The preset's DECLARED order is kept (head = its default);
    //    sanitization only filters/dedupes/caps. Fewer than 2 survivors is not
    //    a menu — fall through to synthesis.
    const wireId = resolveVllmModelId(m);
    const preset = wireId ? findPresetForModel(presets as ModelPreset[], wireId) : undefined;
    const presetMenu = Array.isArray(preset?.config.maxOutputTokens)
      ? resolveOutputLengthVector(preset!.config.maxOutputTokens as number[])
      : undefined;
    if (preset && presetMenu && presetMenu.length >= 2) {
      const strippedModes = stripModeMaxTokens(m.modelModes as any);
      updates.maxOutputTokens = presetMenu;
      if (strippedModes !== undefined) updates.modelModes = strippedModes as Partial<ModelConfig>['modelModes'];
      proposals.push({
        id, server: m.server, displayName: m.displayName || id,
        from: m.maxOutputTokens, to: presetMenu,
        source: 'preset', sourceFile: preset.sourceFile, updates,
      });
      continue;
    }

    // 2. Synthesize from the user's OWN ladder — scalar budget + every
    //    mode/defaultParams max_tokens. <2 distinct values → no menu, skip.
    const userValues: number[] = [];
    if (typeof m.maxOutputTokens === 'number') userValues.push(m.maxOutputTokens);
    if (typeof m.defaultParams?.max_tokens === 'number') userValues.push(m.defaultParams.max_tokens as number);
    for (const params of Object.values(m.modelModes ?? {})) {
      if (params && typeof (params as Record<string, unknown>).max_tokens === 'number') {
        userValues.push((params as Record<string, unknown>).max_tokens as number);
      }
    }
    // Menu sanitization (this ladder is the only candidate source): positive
    // ints, deduped, descending, ≤8. Fewer than 2 survivors is not a menu.
    const vector = resolveOutputLengthVector(userValues.map(n => Math.floor(n)));
    const synthesized = vector
      ? [...new Set(vector)].sort((a, b) => b - a)
      : undefined;
    if (!synthesized || synthesized.length < 2) continue;
    const strippedModes = stripModeMaxTokens(m.modelModes as any);
    updates.maxOutputTokens = synthesized;
    if (strippedModes !== undefined) updates.modelModes = strippedModes as Partial<ModelConfig>['modelModes'];
    proposals.push({
      id, server: m.server, displayName: m.displayName || id,
      from: m.maxOutputTokens, to: synthesized, source: 'synthesized', updates,
    });
  }
  return proposals;
}

/** Preview document text: one before/after block per proposal, JSONC-ish. */
function formatMigrationPreview(proposals: readonly OutputLengthProposal[]): string {
  const lines: string[] = [
    '// vLLM-Copilot - proposed Output Length menu updates',
    '// Close this editor and choose "Update output length menus" in the vLLM-Copilot notification to apply.',
    '',
  ];
  for (const p of proposals) {
    lines.push(`// ${p.displayName}`);
    lines.push(`//   source: ${p.source === 'preset' ? `preset ${p.sourceFile}` : 'your own configured max_tokens values'}`);
    lines.push(`//   before: maxOutputTokens: ${p.from === undefined ? '(not set - extension default)' : JSON.stringify(p.from)}`);
    lines.push(`//   after:  maxOutputTokens: ${JSON.stringify(p.to)}`);
    if (p.updates.modelModes !== undefined) lines.push(`//   after:  modelModes max_tokens layers removed (the dropdown owns response length now)`);
    if (p.updates.defaultParams !== undefined) lines.push(`//   after:  defaultParams max_tokens removed`);
    lines.push('');
  }
  return lines.join('\n');
}

const BTN_UPDATE = 'Update output length menus';
const BTN_REVIEW = 'Review first';
const BTN_NOT_NOW = 'Not now';

/**
 * Activation entry point: offer the migration once. Never throws (activation
 * fire-and-forgets it; failures land in the Output channel).
 */
export async function maybeOfferOutputLengthMigration(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  try {
    const decided = context.globalState.get<string>(MIGRATION_FLAG);
    if (decided === 'done' || decided === 'declined') return;

    const models = readModels();
    if (models.length === 0) return; // nothing configured yet — offer on a later activation

    const presets = await loadModelPresets(context.extensionUri);
    const proposals = planOutputLengthMigration(models, presets);
    if (proposals.length === 0) return; // no honest menus to offer — never nag

    const pick = await vscode.window.showInformationMessage(
      `vLLM-Copilot 1.35 adds an "Output Length" dropdown to the model picker for models with a maxOutputTokens menu. ${proposals.length} configured model${proposals.length === 1 ? '' : 's'} can get it. Update now?`,
      { title: BTN_UPDATE, isCloseAffordance: false },
      { title: BTN_REVIEW },
      { title: BTN_NOT_NOW, isCloseAffordance: true },
    );
    const choice = (pick as string | { title?: string } | undefined);
    const title = typeof choice === 'object' && choice !== null ? choice.title : choice;

    if (title === BTN_NOT_NOW) {
      await context.globalState.update(MIGRATION_FLAG, 'declined');
      return;
    }
    // Defensive, currently unreachable: BTN_NOT_NOW is the close affordance,
    // so ✕/Escape resolves to IT (recorded 'declined' above) and title is
    // always one of the three. Kept as a belt in case the button set changes;
    // recording NOTHING decided here means a future true dismiss path re-offers
    // next activation instead of silently never again (the module header's
    // "at most once" holds only because today no path reaches this line).
    if (title !== BTN_UPDATE && title !== BTN_REVIEW) return;

    if (title === BTN_REVIEW) {
      const doc = await vscode.workspace.openTextDocument({
        language: 'jsonc',
        content: formatMigrationPreview(proposals),
      });
      await vscode.window.showTextDocument(doc);
      const confirm = await vscode.window.showInformationMessage(
        `Apply the ${proposals.length} Output Length menu update${proposals.length === 1 ? '' : 's'} shown in the preview?`,
        { title: BTN_UPDATE },
        { title: 'Cancel', isCloseAffordance: true },
      );
      const confirmTitle = (confirm as string | { title?: string } | undefined);
      if ((typeof confirmTitle === 'object' && confirmTitle !== null ? confirmTitle.title : confirmTitle) !== BTN_UPDATE) return;
    }

    try {
      // Sequential writes on purpose: patchModelConfig is read-modify-write on
      // the whole models array — parallel calls would clobber each other.
      // Existence re-checked at apply time with the store's own matcher: the
      // proposals were planned BEFORE the offer dialog (and possibly a Review
      // detour), so a model the user deleted while the dialog was open must
      // stay deleted — patchModelConfig appends on no match and would
      // resurrect it as a shell entry carrying only identity fields.
      for (const p of proposals) {
        if (findModelConfigIndex(readModels(), p.id, p.server) < 0) {
          output.appendLine(`[INFO] Output length migration: model "${p.id}" no longer exists, skipped.`);
          continue;
        }
        await patchModelConfig({ id: p.id, server: p.server }, p.updates);
      }
    } catch (err) {
      // Settings write blocked (e.g. invalid settings.json) — do NOT set the
      // flag; the offer returns on the next activation once the file is valid.
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`vLLM-Copilot: could not update the models setting: ${msg}`);
      output.appendLine(`[WARN] Output length migration failed: ${msg}`);
      return;
    }
    await context.globalState.update(MIGRATION_FLAG, 'done');
    void vscode.window.showInformationMessage(
      `vLLM-Copilot: added an Output Length menu to ${proposals.length} model${proposals.length === 1 ? '' : 's'}. Pick it in the model picker. A shorter choice frees tokens for your prompt. If the dropdown is not visible yet, open the model list once and click the "Output Length" chip on the model.`
    );
  } catch (err) {
    output.appendLine(`[WARN] Output length migration check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
