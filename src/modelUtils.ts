/**
 * Pure model utility functions.
 * No dependencies — fully unit-testable.
 */

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
 * Extract a short family name from a full model ID.
 * e.g. "meta-llama/Llama-3-70B-Instruct" → "llama"
 *
 * Pure wrapper around {@link extractFamilyWithSource} for callers that do not
 * need to distinguish the fallback case.
 */
export function extractFamily(modelId: string): string {
  return extractFamilyWithSource(modelId).family;
}
