/**
 * Construction of VS Code `LanguageModelChatInformation` from vLLM server models
 * and user overrides. Pure functions with no provider state, so they can be
 * unit-tested without instantiating the provider.
 */

import * as vscode from 'vscode';
import { deriveTokenBudget, resolveOutputBudgetScalar, resolveOutputLengthVector, type TokenBudget } from './tokenBudget.js';
import { type ModelConfig } from './config.js';

/**
 * Result of {@link extractFamilyWithSource}.
 *
 * - `fromFallback === false`: matched one of the known family names.
 * - `fromFallback === true`: no known family matched; family was derived from
 *   the org prefix (text before `/`) or the full model id. This is a GUESS —
 *   the authoritative family comes from a preset or HuggingFace
 *   `config.model_type`. Callers that care about accuracy should warn when
 *   this is `true`.
 */
export interface ExtractedFamily {
  family: string;
  fromFallback: boolean;
}

/**
 * Known-family list used by the heuristic in {@link extractFamilyWithSource}.
 *
 * NOT a complete list of model families — it only covers the families the old
 * hard-coded heuristic recognized. Anything not here (GLM, Cohere, Aya, Yi,
 * granite, …) intentionally falls through to the org-prefix fallback. The
 * authoritative family comes from a preset or HuggingFace `config.model_type`;
 * this list is only the last-resort classifier when neither is available.
 */
const KNOWN_FAMILIES = ['codellama', 'llama', 'qwen', 'mistral', 'phi', 'gemma', 'deepseek', 'falcon'];

/**
 * Extract a short family name from a full model ID, with a flag indicating
 * whether the result came from the known-family list or from the org-prefix
 * fallback (a guess).
 *
 * e.g. "meta-llama/Llama-3-70B-Instruct" → { family: "llama", fromFallback: false }
 *      "some-org/SomeNewModel-7B"        → { family: "some-org", fromFallback: true }
 */
export function extractFamilyWithSource(modelId: string): ExtractedFamily {
  // Check for known family names. Match only when the family name is a distinct
  // token — i.e. preceded by start-of-string or one of the separators '/', '-',
  // '_', '.'. This prevents matching a family name embedded mid-word (e.g.
  // "ballama" should not match "llama"). Note that '-' IS a separator, so
  // hyphenated compounds like "anti-llama-detector" WILL match "llama" — that
  // is the intended behavior for token-based family names like
  // "meta-llama/Llama-3".
  const lower = modelId.toLowerCase();
  for (const family of KNOWN_FAMILIES) {
    const idx = lower.indexOf(family);
    if (idx === -1) continue;
    // Check character before match (if any) — should be a separator or start of string
    const before = idx === 0 ? '' : lower[idx - 1];
    if (before === '/' || before === '-' || before === '_' || before === '.' || before === '') {
      return { family, fromFallback: false };
    }
  }
  // Fallback: org name (everything before '/'), or full model ID if no '/'
  const slashIndex = modelId.indexOf('/');
  const fallback = slashIndex > 0 ? modelId.slice(0, slashIndex).toLowerCase() : modelId.toLowerCase();
  return { family: fallback, fromFallback: true };
}

/**
 * True when `current` (a VS Code version string such as `1.135.0` or
 * `1.136.0-insider`) is at least `minimum` (`major.minor`). Unparsable inputs
 * return false — an unknown runtime is treated as too old, never as capable.
 */
export function isVersionAtLeast(minimum: string, current: string): boolean {
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
 * hover) from inputs that are already known at discovery time. Every message
 * states a derived fact about THIS model — never a guess — and a banner that
 * merely restates information VS Code already shows (context size, vision)
 * is deliberately not emitted.
 *
 * Exported separately so each rule is unit-testable without the version gate;
 * `buildModelInfo` passes the real `vscode.version` result.
 *
 * @param supportsInfoText - false suppresses `infoText` (host too old);
 *   `warningText` is never suppressed.
 * @param effectiveOutputTokens - the budget actually advertised/wired (tracked
 *   output-length pick included). When present it IS the banner's "configured"
 *   reference — a deliberate shorter pick is the feature working, not a clamp.
 *   Absent → the raw configured budget (vector head or scalar).
 */
export function buildPickerBanners(
  override: Partial<ModelConfig> | undefined,
  config: { maxOutputTokens: number },
  budget: TokenBudget,
  reportedMaxOutputTokens: number | undefined,
  supportsInfoText: boolean,
  effectiveOutputTokens?: number,
  /** Resolved backend type of the model's server (defaults to 'vllm'). */
  serverType: import('./config.js').ServerType = 'vllm',
): { warningText?: Record<string, string>; infoText?: Record<string, string> } {
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
  // input room, and a 1-token deviation is noise, not news.
  const configuredOutput = effectiveOutputTokens ?? resolveOutputBudgetScalar(override?.maxOutputTokens) ?? config.maxOutputTokens;
  const desiredOutput = Number.isFinite(configuredOutput)
    ? Math.max(1, Math.floor(configuredOutput))
    : 1;
  if (budget.maxOutputTokens < desiredOutput * 0.95) {
    const providerCapped = reportedMaxOutputTokens !== undefined
      && !Number.isNaN(reportedMaxOutputTokens)
      && reportedMaxOutputTokens < desiredOutput;
    warningText.output_limit = providerCapped
      ? `The provider caps responses to ${budget.maxOutputTokens} tokens — below the configured output budget of ${desiredOutput}.`
      : `The ${budget.maxModelLen}-token context window caps responses to ${budget.maxOutputTokens} tokens — below the configured output budget of ${desiredOutput}.`;
    // When a length dropdown actually renders for this model, point at it —
    // it is the actionable control for working within the cap. Same inputs as
    // the schema builder, so the banner can never advertise an absent dropdown.
    if (resolveOutputLengthOptions(override?.maxOutputTokens, budget.maxOutputTokens)) {
      warningText.output_limit += ' Pick a response length in the Output Length dropdown to work within this cap.';
    }
  }

  // Non-default OpenRouter routing changes which backend actually serves the
  // request — purely informational, exactly what infoText is for.
  if (serverType === 'openrouter' && override) {
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
 * 2. `maxOutputTokens` — the output-LENGTH dropdown (see
 *    {@link resolveOutputLengthOptions}). Emitted ONLY when the model declares
 *    a VECTOR-form `maxOutputTokens` AND at least two entries survive the
 *    ceiling — never auto-derived, in keeping with the no-generic-fallback
 *    contract the mode dropdown follows. Orthogonal to modes by design: the
 *    length menu is identical for every mode.
 *
 * Returns undefined when neither dropdown has anything to show.
 *
 * @param override - Per-model override from `vllm-copilot.models` settings
 * @param outputCeiling - The output budget the menu is scaled against (discovery
 *   passes the static pre-pick ceiling); the picker never offers more than the
 *   model promised.
 */
export function buildConfigurationSchema(
  override: Pick<ModelConfig, 'modelModes' | 'defaultMode' | 'maxOutputTokens'> | undefined,
  outputCeiling: number
): { properties: Record<string, unknown> } | undefined {
  const properties: Record<string, unknown> = {};

  if (override?.modelModes && Object.keys(override.modelModes).length > 0) {
    const modes = Object.keys(override.modelModes);
    const defaultMode = override.defaultMode && modes.includes(override.defaultMode)
      ? override.defaultMode
      : modes[0];
    properties.reasoningEffort = {
      type: 'string',
      title: 'Model Mode',
      enum: modes,
      enumItemLabels: modes,
      default: defaultMode,
      group: 'navigation',
    };
  }

  const lengths = resolveOutputLengthOptions(override?.maxOutputTokens, outputCeiling);
  if (lengths) {
    properties.maxOutputTokens = {
      type: 'number',
      title: 'Output Length',
      enum: lengths.values,
      enumItemLabels: lengths.labels,
      default: lengths.values[0],
      // NOT 'navigation' — that slot belongs to the mode dropdown, and the
      // renderer keeps only one property per group. See the header comment.
      group: 'tokens',
    };
  }

  return Object.keys(properties).length > 0 ? { properties } : undefined;
}

/**
 * Resolve the output-length dropdown's options and labels from a VECTOR-form
 * `maxOutputTokens` (ordered; FIRST element is the default). There is
 * deliberately NO derived fallback: a scalar budget renders no length
 * dropdown, same no-generic-fallback contract the mode dropdown
 * follows — preset authors own the menu, runtime invents nothing.
 *
 * Entries above `ceiling` are dropped — the menu never offers what the model
 * was not advertised to deliver (VS Code reserves prompt space against the
 * advertised output, so an over-ceiling pick could only 400). If the first
 * vector entry is dropped, the next surviving entry becomes the default.
 * Returns undefined for the scalar form or when fewer than two distinct valid
 * options survive.
 */
export function resolveOutputLengthOptions(
  maxOutputTokens: number | number[] | undefined,
  ceiling: number,
): { values: number[]; labels: string[] } | undefined {
  if (!Array.isArray(maxOutputTokens) || !Number.isFinite(ceiling)) {
    return undefined;
  }
  const values = resolveOutputLengthVector(maxOutputTokens)?.filter(n => n <= ceiling);
  if (!values || values.length < 2) {
    return undefined;
  }
  // Compact labels: 512 → "512", 16384 → "16K", 1536 → "1.5K".
  const labels = values.map(n => {
    if (n < 1024) return String(n);
    const k = n / 1024;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  });
  return { values, labels };
}

/**
 * Build LanguageModelChatInformation from a server model and an optional user override.
 * When `override` is undefined, defaults are used for all fields.
 *
 * @param serverModel - The vLLM wire model (`id` is the vLLM model id, not the picker id).
 * @param override - Per-model override from `vllm-copilot.models`.
 * @param config - Resolved token/transport settings.
 * @param serverType - The resolved backend type of the model's server. Drives the
 *   OpenRouter routing banner.
 * @param onFamilyFallback - Called once with `(family, modelId)` when the family had to
 *   be estimated from the model id via the org-name fallback (no preset/HF family).
 */
export function buildModelInfo(
  serverModel: { id: string; max_model_len?: number },
  override: Partial<ModelConfig> | undefined,
  config: { maxOutputTokens: number },
  serverType: import('./config.js').ServerType,
  /**
   * Server-reported output ceiling (e.g. OpenRouter per-request completion
   * limit). Clamps the derived output budget; undefined leaves it unchanged.
   */
  reportedMaxOutputTokens?: number,
  /**
   * Invoked once with `(family, modelId)` when no preset/HuggingFace family was
   * available and the family had to be estimated from the model id via the
   * org-name fallback. Callers with an OutputChannel can route this to a
   * `[WARN]` line. Optional — omit to suppress.
   */
  onFamilyFallback?: (family: string, modelId: string) => void,
  /**
   * The output budget to advertise and wire (discovery passes the tracked
   * output-length pick, or the legacy mode/config chain value, pre window- and
   * provider-clamp). Replaces the old contract of CLONING the override with
   * this scalar — the raw override must stay intact because a vector-form
   * `maxOutputTokens` inside it IS the Output length menu: a scalar clone
   * would silently delete the dropdown. Undefined (direct callers, tests)
   * falls back to the override's own budget — the legacy path.
   */
  effectiveOutputTokens?: number,
  /**
   * Static output budget the Output-length menu and clamp banners are scaled
   * against (discovery passes the model budget under the physical clamps only
   * — window + server-reported, never a mode's `max_tokens`, never the picked
   * value). The menu must keep offering lengths above the current pick, a
   * deliberate shorter pick must not read as a clamp warning, and a legacy
   * per-mode budget must not shrink the menu on a mode switch. Falls back to
   * the advertised budget when omitted.
   */
  outputMenuCeiling?: number,
): vscode.LanguageModelChatInformation {
  const budget = deriveTokenBudget(
    serverModel.max_model_len,
    config.maxOutputTokens,
    effectiveOutputTokens !== undefined
      ? { ...override, maxOutputTokens: effectiveOutputTokens }
      : override,
    serverModel.id,
    reportedMaxOutputTokens,
  );

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

  // Picker id: the override's required `id` IS the unique extension key.
  const presetId = override?.id || serverModel.id;
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
    statusIcon: new vscode.ThemeIcon('vllm-copilot-model'),
    isBYOK: true,
  };

  const schema = buildConfigurationSchema(override, outputMenuCeiling ?? budget.maxOutputTokens);
  if (schema) {
    info.configurationSchema = schema;
  }

  // Clamp banners compare against the STATIC ceiling, not the picked budget:
  // a deliberate shorter pick is the feature working, not a clamp to warn about.
  const bannerBudget = outputMenuCeiling !== undefined
    ? { ...budget, maxOutputTokens: Math.max(budget.maxOutputTokens, outputMenuCeiling) }
    : budget;
  const banners = buildPickerBanners(
    override,
    config,
    bannerBudget,
    reportedMaxOutputTokens,
    isVersionAtLeast(INFO_TEXT_MIN_VSCODE, vscode.version),
    effectiveOutputTokens,
    serverType,
  );
  if (banners.warningText) {
    info.warningText = banners.warningText;
  }
  if (banners.infoText) {
    info.infoText = banners.infoText;
  }

  return info;
}
