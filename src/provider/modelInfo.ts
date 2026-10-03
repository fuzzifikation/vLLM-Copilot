/**
 * Projection of a core `ModelDescriptor` into VS Code
 * `LanguageModelChatInformation`. All model FACTS (family, budgets, menu
 * ceiling, advertised output, surviving length values, modes) are computed
 * by `core/catalog/describe.ts`; this file adds only editor-facing surfaces:
 * the `ThemeIcon`, the formatted price line, the banner copy, the picker
 * configuration schema and the version-gated metadata fields. Pure function
 * with no provider state, so it can be unit-tested without the provider.
 */

import * as vscode from 'vscode';
import type { ModelDescriptor } from '../core/catalog/describe.js';
import { formatCostRate } from '../usage/usageStore.js';

/**
 * True when `current` (a VS Code version string such as `1.135.0` or
 * `1.136.0-insider`) is at least `minimum` (`major.minor`). Unparsable inputs
 * return false — an unknown runtime is treated as too old, never as capable.
 */
function isVersionAtLeast(minimum: string, current: string): boolean {
  const min = /^(\d+)\.(\d+)/.exec(minimum);
  const cur = /^(\d+)\.(\d+)/.exec(current);
  if (!min || !cur) {
    return false;
  }
  const [minMajor, minMinor] = [Number(min[1]), Number(min[2])];
  const [curMajor, curMinor] = [Number(cur[1]), Number(cur[2])];
  return curMajor > minMajor || (curMajor === minMajor && curMinor >= minMinor);
}

/**
 * `warningText` has been part of the `chatProvider` proposal since VS Code
 * 1.128 (verified against `release/1.128`). `infoText` landed later — it only
 * exists from 1.135 (verified: absent in `release/1.130`, present in
 * `release/1.135`). Older cores silently ignore unknown metadata fields, so
 * emitting `infoText` unconditionally would be harmless but dishonest; the
 * runtime gate keeps the metadata we advertise exactly what the host renders.
 */
const INFO_TEXT_MIN_VSCODE = '1.135';

/**
 * Derive model-picker banners (`warningText` / `infoText`, shown in the model
 * hover) from descriptor facts. Every message states a derived fact about
 * THIS model — never a guess — and a banner that merely restates information
 * VS Code already shows (context size, vision) is deliberately not emitted.
 *
 * File-private: `buildModelInfo` is the only caller and the only test seam
 * (U9 demotion: banners are asserted through the built info's metadata).
 *
 * @param bannerMaxOutput - the output budget the clamp comparison runs
 *   against: the advertised budget raised to the static menu ceiling, so a
 *   deliberate shorter pick is the feature working, not a clamp to warn about.
 * @param supportsInfoText - false suppresses `infoText` (host too old);
 *   `warningText` is never suppressed.
 */
function buildPickerBanners(
  descriptor: ModelDescriptor,
  bannerMaxOutput: number,
  supportsInfoText: boolean,
): { warningText?: Record<string, string>; infoText?: Record<string, string> } {
  const override = descriptor.override;
  const warningText: Record<string, string> = {};
  const infoText: Record<string, string> = {};

  // Explicitly disabled tool calling means agent mode silently cannot work —
  // worth a banner before the user blames the extension.
  if (override?.capabilities?.toolCalling === false) {
    warningText.tool_calling = 'Tool calling is disabled for this model, so Agent mode cannot use it. Enable tool calling in the vLLM-Copilot model settings if the model supports tools.';
  }

  // Output budget clamped well below what was configured (by the context
  // window or a provider-reported completion ceiling). "Well below" = more
  // than 5% under: the budget derivation always shaves a token or two to keep
  // input room, and a 1-token deviation is noise, not news. Every producer of
  // the reference is finite by construction (normalized pick, finite-or-
  // undefined budget scalar, floored settings value) — no validity check.
  const configuredOutput = descriptor.effectiveOutputTokens ?? descriptor.configuredMaxOutputTokens;
  const desiredOutput = Math.max(1, Math.floor(configuredOutput));
  if (bannerMaxOutput < desiredOutput * 0.95) {
    const providerCapped = descriptor.reportedMaxOutputTokens !== undefined
      && descriptor.reportedMaxOutputTokens < desiredOutput;
    warningText.output_limit = providerCapped
      ? `The provider caps responses to ${bannerMaxOutput} tokens - below the configured output budget of ${desiredOutput}.`
      : `The ${descriptor.contextWindow}-token context window caps responses to ${bannerMaxOutput} tokens - below the configured output budget of ${desiredOutput}.`;
    // When a length dropdown actually renders for this model, point at it —
    // it is the actionable control for working within the cap. Same inputs as
    // the schema builder, so the banner can never advertise an absent dropdown.
    if (descriptor.outputLengthValues) {
      warningText.output_limit += ' Pick a response length in the Output Length dropdown to work within this cap.';
    }
  }

  // Non-default OpenRouter routing changes which backend actually serves the
  // request — purely informational, exactly what infoText is for.
  if (descriptor.serverType === 'openrouter' && override) {
    const bits: string[] = [];
    if (override.provider) {
      bits.push(`pinned to provider \"${override.provider}\"`);
    }
    if (override.routingMode && override.routingMode !== 'standard') {
      bits.push(`\"${override.routingMode}\" routing`);
    }
    if (bits.length > 0) {
      infoText.openrouter_routing = `OpenRouter requests are ${bits.join(' with ')}.`;
    }
  }

  return {
    warningText: Object.keys(warningText).length > 0 ? warningText : undefined,
    infoText: supportsInfoText && Object.keys(infoText).length > 0 ? infoText : undefined,
  };
}

/**
 * Compact length labels for the Output Length dropdown:
 * 512 → "512", 16384 → "16K", 1536 → "1.5K". Picker copy — host-side, while
 * the surviving VALUES are core descriptor facts.
 */
function lengthLabels(values: number[]): string[] {
  return values.map(n => {
    if (n < 1024) return String(n);
    const k = n / 1024;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  });
}

/**
 * Build the `configurationSchema` for a model's picker settings: up to two
 * independent dropdowns, each persisted per-model by VS Code.
 *
 * THE GROUP RULE (learned the hard way, in the field, at release): VS Code's
 * picker renders exactly TWO sections — `navigation` and `tokens` — and each
 * reads only the FIRST property of its group (modelPickerConfiguration.ts,
 * `_getConfigProperty`). Two properties in one group silently lose the
 * second; that is exactly how the length picker vanished while modes
 * rendered fine. Modes own `navigation`; output length owns `tokens` (the
 * group Copilot itself uses for its context-size selector — we never emit
 * `contextSize`, so our `tokens` slot is uncontested).
 *
 * 1. `reasoningEffort` — the model MODE dropdown (behavior params: reasoning,
 *    sampling, template kwargs). Emitted when the model has modes.
 * 2. `maxOutputTokens` — the output-LENGTH dropdown. Emitted ONLY when the
 *    model declares a VECTOR-form `maxOutputTokens` AND at least two entries
 *    survive the ceiling (`descriptor.outputLengthValues` — the core applies
 *    the filter, the menu never offers what the model was not advertised to
 *    deliver) — never auto-derived, in keeping with the no-generic-fallback
 *    contract the mode dropdown follows. Orthogonal to modes by design: the
 *    length menu is identical for every mode.
 *
 * Returns undefined when neither dropdown has anything to show.
 */
function buildConfigurationSchema(
  descriptor: ModelDescriptor,
): { properties: Record<string, unknown> } | undefined {
  const properties: Record<string, unknown> = {};

  if (descriptor.modeNames) {
    properties.reasoningEffort = {
      type: 'string',
      title: 'Model Mode',
      enum: descriptor.modeNames,
      enumItemLabels: descriptor.modeNames,
      default: descriptor.defaultMode,
      group: 'navigation',
    };
  }

  if (descriptor.outputLengthValues) {
    properties.maxOutputTokens = {
      type: 'number',
      title: 'Output Length',
      enum: descriptor.outputLengthValues,
      enumItemLabels: lengthLabels(descriptor.outputLengthValues),
      default: descriptor.outputLengthValues[0],
      // NOT 'navigation' — that slot belongs to the mode dropdown, and the
      // renderer keeps only one property per group. See the header comment.
      group: 'tokens',
    };
  }

  return Object.keys(properties).length > 0 ? { properties } : undefined;
}

/**
 * The picker's price line: `$0.30 in · $1.20 out · $0.03 cached`, or '' when
 * the model has no configured rates.
 *
 * PRICE IS THE ONLY THING ADDED HERE, by owner ruling after an earlier pass
 * tried the rest and it read as noise. VS Code already renders the context
 * window in the card below the picker, and the Server Dashboard already
 * carries server, backend, wire model ID and capabilities. A server entry is
 * named by whoever set up the box — often a bare IT hostname — and it never
 * changes which model you want. Price is the one fact the picker showed
 * nowhere, and choosing between a cheap local model and a paid one is
 * exactly the decision being made at this moment.
 *
 * VS Code flattens newlines in this tooltip, so it is deliberately ONE line
 * with explicit separators. Rates go through the shared money helper so the
 * picker and the dashboard can never print the same rate two different ways.
 *
 * READ from `vllm-copilot.models[].cost`; nothing is invented, and no
 * catalog is fetched.
 */
function buildPickerPrice(descriptor: ModelDescriptor): string {
  const cost = descriptor.cost;
  if (!cost || (cost.input === undefined && cost.output === undefined && cost.cachedInput === undefined)) {
    return '';
  }

  const parts: string[] = [];
  if (cost.input !== undefined) parts.push(`${formatCostRate(cost.input, cost.currency)} in`);
  if (cost.output !== undefined) parts.push(`${formatCostRate(cost.output, cost.currency)} out`);
  if (cost.cachedInput !== undefined) parts.push(`${formatCostRate(cost.cachedInput, cost.currency)} cached`);
  return parts.join(' · ');
}

/**
 * Project a core {@link ModelDescriptor} into a picker entry. The descriptor
 * carries every fact; this function adds only editor-facing surfaces —
 * `ThemeIcon`, `isBYOK`, the price line, the configuration schema and the
 * version-gated banners.
 */
export function buildModelInfo(
  descriptor: ModelDescriptor,
): vscode.LanguageModelChatInformation {
  // `detail` and `tooltip` are readonly on the stable type, so they are placed
  // in the literal rather than assigned afterwards.
  const price = buildPickerPrice(descriptor);
  // `configurationSchema` is a `chatProvider`-proposal field VS Code reads for the
  // model-modes picker; it is not on the stable LanguageModelChatInformation type,
  // so it is declared via intersection rather than erased with `any`. `isBYOK` is
  // likewise proposal-gated and signals that this model is served with user-supplied
  // credentials rather than the built-in Copilot (CAPI) service — which is what lets
  // VS Code route MCP/agent-mode utility flows to it.
  const info: vscode.LanguageModelChatInformation & {
    configurationSchema?: { properties: Record<string, unknown> };
    isBYOK?: boolean;
    statusIcon?: vscode.ThemeIcon;
    warningText?: Record<string, string>;
    infoText?: Record<string, string>;
  } = {
    id: descriptor.configId,
    name: descriptor.name,
    family: descriptor.family,
    version: '1.0.0',
    maxInputTokens: descriptor.maxInputTokens,
    maxOutputTokens: descriptor.maxOutputTokens,
    capabilities: descriptor.capabilities,
    // OpenRouter models advertise the OpenRouter brand glyph (U+E002 in our
    // icon font, sourced unmodified from openrouter.ai/brand); everything
    // else keeps the project V.
    statusIcon: new vscode.ThemeIcon(
      descriptor.serverType === 'openrouter' ? 'vllm-copilot-openrouter' : 'vllm-copilot-model',
    ),
    isBYOK: true,
    // Omitted entirely when no rates are configured, so the picker is not
    // left with an empty label. Both fields carry the same line: VS Code
    // shows the tooltip on hover and the detail beside the model name.
    ...(price ? { detail: price, tooltip: price } : {}),
  };

  const schema = buildConfigurationSchema(descriptor);
  if (schema) {
    info.configurationSchema = schema;
  }

  // Clamp banners compare against the STATIC ceiling, not the picked budget:
  // a deliberate shorter pick is the feature working, not a clamp to warn about.
  const bannerMaxOutput = Math.max(descriptor.maxOutputTokens, descriptor.outputMenuCeiling);
  const banners = buildPickerBanners(
    descriptor,
    bannerMaxOutput,
    isVersionAtLeast(INFO_TEXT_MIN_VSCODE, vscode.version),
  );
  if (banners.warningText) {
    info.warningText = banners.warningText;
  }
  if (banners.infoText) {
    info.infoText = banners.infoText;
  }

  return info;
}
