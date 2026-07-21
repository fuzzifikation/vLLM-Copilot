/**
 * Pure model utility functions.
 * No dependencies — fully unit-testable.
 */

/**
 * Extract a short family name from a full model ID.
 * e.g. "meta-llama/Llama-3-70B-Instruct" → "llama"
 */
export function extractFamily(modelId: string): string {
  // Check for known family names using word-boundary-like checks.
  // Look for the family name preceded by start-of-string, '/', '-', '_', or '.'
  // to avoid false matches (e.g. "anti-llama-detector" shouldn't match "llama").
  const lower = modelId.toLowerCase();
  const families = ['codellama', 'llama', 'qwen', 'mistral', 'phi', 'gemma', 'deepseek', 'falcon'];
  for (const family of families) {
    const idx = lower.indexOf(family);
    if (idx === -1) continue;
    // Check character before match (if any) — should be a separator or start of string
    const before = idx === 0 ? '' : lower[idx - 1];
    if (before === '/' || before === '-' || before === '_' || before === '.' || before === '') {
      return family;
    }
  }
  // Fallback: org name (everything before '/'), or full model ID if no '/'
  const slashIndex = modelId.indexOf('/');
  return slashIndex > 0 ? modelId.slice(0, slashIndex).toLowerCase() : modelId.toLowerCase();
}
