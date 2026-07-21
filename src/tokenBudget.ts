/**
 * Pure token-budget derivation.
 * No vscode imports — fully unit-testable.
 */

export interface ModelOverride {
  maxInputTokens?: number;
  maxOutputTokens?: number;
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
 *   - `maxInputTokens` computed as `maxModelLen - maxOutputTokens` (unless overridden).
 */
export function deriveTokenBudget(
  serverMaxModelLen: number | undefined,
  configMaxOutputTokens: number,
  override?: ModelOverride,
  modelId?: string
): TokenBudget {
  if (!serverMaxModelLen || serverMaxModelLen < 0) {
    throw new Error(
      `Server did not report max_model_len for model ${modelId ?? 'unknown'} (got ${serverMaxModelLen}). ` +
      `Ensure the vLLM server is accessible and returns model metadata.`
    );
  }
  const maxModelLen = serverMaxModelLen;
  let maxOutputTokens = override?.maxOutputTokens ?? configMaxOutputTokens;
  maxOutputTokens = Math.min(maxOutputTokens, maxModelLen);
  // Clamp maxInputTokens so input + output never exceeds maxModelLen.
  // When the user overrides maxInputTokens but it conflicts with maxOutputTokens,
  // output wins (the server will enforce it) and input is clamped down.
  const remainingForInput = maxModelLen - maxOutputTokens;
  const maxInputTokens = Math.max(0, (override?.maxInputTokens ?? remainingForInput));
  return { maxModelLen, maxOutputTokens, maxInputTokens: Math.min(maxInputTokens, remainingForInput) };
}
