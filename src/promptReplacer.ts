/**
 * Load and apply find/replace rules to system message text.
 *
 * Design:
 * - JSON array of { "ruleName": "...", "find": "...", "replace": "..." } objects
 * - Exact substring match (no regex)
 * - Applied sequentially in array order
 * - Empty "replace" removes the matched text
 * - Optional "ruleName" field identifies the rule in logs and capture files
 *
 * Module-level cache: personality files are read+parsed only once per session
 * so that discovery (loadPersonalityMeta) and application (loadPromptReplacements)
 * of the same file do not duplicate the I/O+parse cost.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// ── Module-level cache ───────────────────────────────────────────────
// Keyed by resolved absolute path. Populated on first read; lifetime is the
// extension session. Personality files are either bundled extension assets
// (immutable) or user copies in .vllm/ (only changeable via the Set Personality
// command which clears the cache when it copies a new file).
const personalityCache = new Map<string, { meta: PersonalityMeta | null; rules: PromptReplacement[] }>();

/**
 * Internal: read, parse, and cache a personality file once.
 * Returns both meta (null for legacy/array format files) and rules.
 */
async function readPersonalityFile(absPath: string): Promise<{ meta: PersonalityMeta | null; rules: PromptReplacement[] }> {
  const cached = personalityCache.get(absPath);
  if (cached) return cached;

  const content = await fs.readFile(absPath, 'utf-8');
  const trimmed = content.trim();

  const result: { meta: PersonalityMeta | null; rules: PromptReplacement[] } = {
    meta: null,
    rules: [],
  };

  if (!trimmed) {
    personalityCache.set(absPath, result);
    return result;
  }

  const parsed = JSON.parse(trimmed) as unknown;

  // New format: { meta: { name, description }, rules: [...] }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    // Extract meta
    const metaRaw = obj.meta;
    if (
      typeof metaRaw === 'object' &&
      metaRaw !== null &&
      typeof (metaRaw as any).name === 'string' &&
      typeof (metaRaw as any).description === 'string'
    ) {
      result.meta = {
        name: (metaRaw as any).name,
        description: (metaRaw as any).description,
      };
    }
    // Extract rules
    const rulesRaw = obj.rules;
    if (Array.isArray(rulesRaw)) {
      result.rules = parseRules(rulesRaw);
    } else {
      throw new Error('Prompt replacements file with { meta, rules } format requires "rules" to be an array');
    }
  } else if (Array.isArray(parsed)) {
    // Legacy format: raw array of { find, replace }
    result.rules = parseRules(parsed);
  } else {
    throw new Error('Prompt replacements file must contain a JSON array or a { meta, rules } object');
  }

  personalityCache.set(absPath, result);
  return result;
}

/**
 * Clear the personality file cache. Useful when a file is known to have changed
 * (e.g. after copying a new personality preset via the Set Personality command).
 */
export function clearPersonalityCache(): void {
  personalityCache.clear();
}

// ── Public API ───────────────────────────────────────────────────────
/**
 * A single find/replace rule for system message text.
 */
export interface PromptReplacement {
  ruleName?: string;
  find: string;
  replace: string;
}

/**
 * Metadata for a personality preset file.
 */
export interface PersonalityMeta {
  name: string;
  description: string;
}

/**
 * Load prompt replacements from a JSON file.
 * Supports both legacy (raw array) and new ({ meta, rules }) formats.
 * Returns an empty array if the file doesn't exist or is empty.
 *
 * Delegates to {@link readPersonalityFile} for I/O and parsing, so
 * calling this after {@link loadPersonalityMeta} on the same file does
 * NOT re-read the file (module-level cache hit).
 */
export async function loadPromptReplacements(filePath: string): Promise<PromptReplacement[]> {
  try {
    const absPath = path.resolve(filePath);
    const { rules } = await readPersonalityFile(absPath);
    return rules;
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as any).code === 'ENOENT') {
      // File not found — caller (provider.ts) is responsible for logging if needed.
      return [];
    }
    throw err;
  }
}

/** Parse an array of raw replacement objects into PromptReplacement[]. */
function parseRules(parsed: unknown[]): PromptReplacement[] {
  const replacements: PromptReplacement[] = [];
  for (const entry of parsed) {
    if (typeof entry === 'object' && entry !== null && 'find' in entry && 'replace' in entry) {
      const item = entry as Record<string, unknown>;
      if (typeof item.find === 'string' && typeof item.replace === 'string') {
        replacements.push({
          find: item.find,
          replace: item.replace,
          ruleName: typeof item.ruleName === 'string' ? item.ruleName : undefined,
        });
      } else {
        throw new Error(`Each replacement entry must have "find" and "replace" as strings: ${JSON.stringify(entry).slice(0, 100)}`);
      }
    } else if (typeof entry === 'object' && entry !== null) {
      throw new Error(`Each replacement entry must have "find" and "replace" properties: ${JSON.stringify(entry).slice(0, 100)}`);
    }
  }
  return replacements;
}

/**
 * Load the personality metadata from a JSON file (new { meta, rules } format).
 * Returns null if the file is in legacy format or has no meta block.
 *
 * Delegates to {@link readPersonalityFile} for I/O and parsing, so
 * calling this after {@link loadPromptReplacements} on the same file does
 * NOT re-read the file (module-level cache hit).
 */
export async function loadPersonalityMeta(filePath: string): Promise<PersonalityMeta | null> {
  try {
    const absPath = path.resolve(filePath);
    const { meta } = await readPersonalityFile(absPath);
    return meta;
  } catch {
    return null;
  }
}

/** Result of applying replacements to a system message. */
export interface ApplyResult {
  /** The processed text after all replacements. */
  result: string;
  /** List of ruleNames that matched (in order). */
  matchedRuleNames: string[];
}

/**
 * Apply all find/replace rules to the given system message text.
 * Each replacement is applied sequentially to the result of the previous one.
 * Returns the processed text and which rules matched.
 */
export function applyPromptReplacements(
  text: string,
  replacements: PromptReplacement[]
): ApplyResult {
  if (!replacements.length) return { result: text, matchedRuleNames: [] };

  const matchedRuleNames: string[] = [];
  let result = text;

  for (const { find, replace, ruleName } of replacements) {
    if (!find) continue;
    const count = result.split(find).length - 1;
    if (count > 0) {
      result = result.split(find).join(replace);
      if (ruleName) matchedRuleNames.push(ruleName);
    }
  }

  return { result, matchedRuleNames };
}