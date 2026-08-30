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
 * vector form also renders the model picker's Output length dropdown).
 */
export type OutputBudgetValue = number | number[];

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
 *   - `maxModelLen` comes from the server `max_model_len` (fetched during discovery).
 *     If missing, throws — the server is authoritative and there is no fallback.
 *   - `maxOutputTokens` priority: per-model override > the resolved `configMaxOutputTokens`.
 *     The override may be a scalar or a vector — the vector's head is the desired budget.
 *   - A server-reported output ceiling (`reportedMaxOutputTokens`) clamps the output
 *     budget when present (used by backends that report an explicit completion limit).
 *   - `maxInputTokens` computed as `maxModelLen - maxOutputTokens` (unless overridden).
 */
export function deriveTokenBudget(
  serverMaxModelLen: number | undefined,
  configMaxOutputTokens: number,
  override?: ModelOverride,
  modelId?: string,
  reportedMaxOutputTokens?: number
): TokenBudget {
  if (!serverMaxModelLen || serverMaxModelLen < 0) {
    throw new Error(
      `Server did not report max_model_len for model ${modelId ?? 'unknown'} (got ${serverMaxModelLen}). ` +
      `Ensure the vLLM server is accessible and returns model metadata.`
    );
  }
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
  // A NaN ceiling is garbage, not a bound: NaN would propagate through
  // Math.min/Math.max and poison the whole budget, so it is ignored. Callers are
  // expected to normalize malformed values to undefined (per the plan), but the
  // shared function defends itself.
  if (reportedMaxOutputTokens !== undefined && !Number.isNaN(reportedMaxOutputTokens)) {
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
