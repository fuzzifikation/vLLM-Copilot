/**
 * Pure token-budget derivation.
 * No vscode imports — fully unit-testable.
 */

export interface ModelOverride {
  maxInputTokens?: number;
  /**
   * Scalar output budget OR an ordered vector of response lengths (first entry
   * = default). Always consumed through {@link resolveOutputBudgetScalar} so a
   * vector never silently degrades to the config default.
   */
  maxOutputTokens?: OutputBudgetValue;
}

/**
 * Accepted shapes of the per-model output budget field: a plain scalar cap, or
 * an ordered vector of response lengths whose FIRST entry is the default (the
 * vector form also renders the model picker's Output Length dropdown).
 */
export type OutputBudgetValue = number | number[];

/**
 * The one accepted shape of a configured context window (the hidden
 * `contextWindow` fallback): a WHOLE NUMBER ABOVE 50,000 tokens. No upper
 * bound — an absurdly large value is the user's problem, and clamping it here
 * would reject honest answers while pretending to protect something. The floor
 * is policy, not paranoia: below ~50k, Copilot has no usable headroom
 * (prompt + output), so "fixing" a gateway with 8192 just relocates the
 * failure. Shared by the runtime resolver, the settings validator and both UI
 * input prompts — no surface may accept a value another surface rejects
 * (`000`, `2.5`, `40000` are not context windows).
 */
export function isValidContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 50000;
}

/**
 * Sanitize a vector-form output budget into Output length menu options:
 * integers > 0 only, de-duplicated (declared order preserved — the first entry
 * is the default), capped at 8 entries. Returns undefined for the scalar form
 * or a vector with no valid entry — callers treat that as "no dropdown".
 */
export function resolveOutputLengthVector(value: OutputBudgetValue | undefined): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<number>();
  const vector = value
    .filter(n => Number.isInteger(n) && n > 0)
    .filter(n => (seen.has(n) ? false : (seen.add(n), true)))
    .slice(0, 8);
  return vector.length > 0 ? vector : undefined;
}

/**
 * Scalar output budget for any accepted field shape: the vector's FIRST entry
 * when a vector is declared (head = default = desired budget), the number
 * itself for the scalar form, undefined when absent or non-finite. This is the
 * single choke point that keeps array values from poisoning arithmetic — a
 * bare `typeof === 'number'` check would silently drop vectors to defaults.
 */
export function resolveOutputBudgetScalar(value: OutputBudgetValue | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return resolveOutputLengthVector(value)?.[0];
}

/**
 * Output-budget policy constants, shared by every add path (OpenRouter catalog,
 * HuggingFace auto-discovery, preset/model-config application). The former
 * twin copies in `backends/openRouter.ts` and `commands/hfDiscovery.ts` claimed
 * an import cycle as their excuse; this module imports nothing, so there was
 * never one. If the convention changes, it changes HERE.
 */
export const OUTPUT_TOKEN_FACTOR = 0.1;
export const OUTPUT_TOKEN_CAP = 81920;
/** Lowest rung of the auto-generated Output length ladder (see buildOutputLengthLadder). Internal to this module's policy. */
const OUTPUT_MENU_FLOOR = 16384;

/**
 * Build the Output length ladder for a model whose offered output budget is
 * large enough to starve the prompt: halve the offered value down stepwise to
 * `OUTPUT_MENU_FLOOR` (131072 -> 131072, 65536, 32768, 16384).
 *
 * The HEAD is the rung closest to 10% of the context window, because the head
 * is the advertised/default budget and VS Code derives prompt space as
 * window - output: a 262k-window model offering 131k output advertises 32k by
 * default instead of reserving 131k for output, freeing ~229k for the prompt.
 * The remaining rungs follow in descending order and all stay selectable —
 * discovery scales the menu by the vector's MAX, not the head. Returns
 * undefined when the offered value is at or below the floor: small models
 * keep the plain scalar budget and render no menu, exactly as before.
 */
export function buildOutputLengthLadder(offered: number, contextWindow: number): number[] | undefined {
  if (offered <= OUTPUT_MENU_FLOOR) return undefined;
  const rungs: number[] = [];
  for (let v = offered; v > OUTPUT_MENU_FLOOR; v = Math.floor(v / 2)) rungs.push(v);
  rungs.push(OUTPUT_MENU_FLOOR);
  const target = contextWindow * OUTPUT_TOKEN_FACTOR;
  const head = rungs.reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best), rungs.at(0)!);
  return [head, ...rungs.filter(v => v !== head)];
}

/**
 * Fit a declared output budget (preset/model-config scalar or menu) to the
 * context window the server ACTUALLY reports. Preset budgets encode the
 * official model card (e.g. 128k output on a 1M-window model); an IT department
 * hosting that model at 131k would advertise an output budget that leaves the
 * prompt under 10% of the window. Rules:
 *   - A budget is trusted when it leaves >= 10% of the window for the prompt
 *     (same trust line the OpenRouter catalog path applies to reported caps).
 *   - An author-declared menu whose EVERY rung fits is kept verbatim — a
 *     curated menu is intent, not a guess.
 *   - Everything else (a scalar, or a menu with at least one unfitting rung)
 *     is rebuilt from the largest fitting rung, or from the safe 10%-capped
 *     budget when none fit, as a halving ladder — so the add path always ends
 *     with a default near 10% of the live window and the large rungs stay
 *     selectable above it.
 * `undefined` passes through (no declared budget, runtime default applies).
 */
export function fitOutputBudgetToWindow(
  declared: OutputBudgetValue | undefined,
  contextWindow: number,
): OutputBudgetValue | undefined {
  if (declared === undefined) return undefined;
  const trustLine = contextWindow * (1 - OUTPUT_TOKEN_FACTOR);
  if (Array.isArray(declared) && declared.every(v => v < trustLine)) return declared;
  const values = Array.isArray(declared) ? declared : [declared];
  const fitting = values.filter(v => v < trustLine);
  const offered = fitting.length > 0
    ? Math.max(...fitting)
    : Math.min(Math.floor(contextWindow * OUTPUT_TOKEN_FACTOR), OUTPUT_TOKEN_CAP);
  return buildOutputLengthLadder(offered, contextWindow) ?? offered;
}

export interface TokenBudget {
  /** The total context window (input + output) used for derivation. */
  maxModelLen: number;
  /** Maximum tokens the model may generate per response. */
  maxOutputTokens: number;
  /** Maximum input tokens. Computed so input + output ≤ maxModelLen. */
  maxInputTokens: number;
}

/**
 * Derive per-model token budgets from the server-reported context window and
 * per-model settings/overrides.
 *
 * Rules:
 *   - `maxModelLen` is the server-resolved context window, required: every
 *     caller obtains it from `resolveRuntimeLimits`, which THROWS when the
 *     backend reports no window — the server is authoritative and there is no
 *     fallback here either (the pre-resolver missing-window throw is gone).
 *   - `maxOutputTokens` priority: per-model override > the resolved `configMaxOutputTokens`.
 *     The override may be a scalar or a vector — the vector's head is the desired budget.
 *   - A server-reported output ceiling (`reportedMaxOutputTokens`) clamps the output
 *     budget when present (used by backends that report an explicit completion
 *     limit). Callers normalize it to a finite value or undefined — the type
 *     is the contract, no NaN defense below.
 *   - `maxInputTokens` computed as `maxModelLen - maxOutputTokens` (unless overridden).
 */
export function deriveTokenBudget(
  serverMaxModelLen: number,
  configMaxOutputTokens: number,
  override?: ModelOverride,
  reportedMaxOutputTokens?: number
): TokenBudget {
  const maxModelLen = serverMaxModelLen;
  // Clamp a 0/negative maxOutputTokens override to at least 1 — a 0 would pass
  // straight through as `max_tokens: 0`, which vLLM rejects. A deliberate
  // misconfiguration degrades to a minimal (1-token) output instead of a
  // broken request.
  const configuredOutput = resolveOutputBudgetScalar(override?.maxOutputTokens);
  const requestedOutput = configuredOutput ?? configMaxOutputTokens;
  let maxOutputTokens = Math.max(1, Math.floor(requestedOutput));
  // Always reserve at least 1 token for input. Without this, a model whose
  // window is at or below the configured output budget (e.g. a 2k window vs the
  // default 4096) would have its output clamped to the full window and end up
  // with `maxInputTokens = 0` — advertised as a model that can take no prompt
  // at all, i.e. unusable. The output budget is reduced instead so a minimum
  // input capacity always survives.
  maxOutputTokens = Math.min(maxOutputTokens, Math.max(1, maxModelLen - 1));
  // Clamp to the server-reported output ceiling when present (e.g. OpenRouter's
  // per-request completion limit). A 0/negative ceiling degrades to a minimal
  // 1-token output instead of being ignored — same floor as the overrides above.
  if (reportedMaxOutputTokens !== undefined) {
    maxOutputTokens = Math.min(maxOutputTokens, Math.max(1, reportedMaxOutputTokens));
  }
  // Clamp maxInputTokens so input + output never exceeds maxModelLen.
  // When the user overrides maxInputTokens but it conflicts with maxOutputTokens,
  // output wins (the server will enforce it) and input is clamped down. A 0/
  // negative override is likewise clamped to at least 1 (subject to remaining
  // input room) so the picker never advertises a model with no input capacity.
  const remainingForInput = maxModelLen - maxOutputTokens;
  const configuredInput = override?.maxInputTokens;
  const requestedInput = typeof configuredInput === 'number' && Number.isFinite(configuredInput)
    ? configuredInput
    : remainingForInput;
  const maxInputTokens = Math.max(1, Math.floor(requestedInput));
  return { maxModelLen, maxOutputTokens, maxInputTokens: Math.min(maxInputTokens, remainingForInput) };
}
