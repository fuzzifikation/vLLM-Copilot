/**
 * Load and apply find/replace rules to system message text.
 *
 * Design:
 * - JSON array of { "ruleName": "...", "find": "...", "replace": "..." } objects
 * - Exact substring match (no regex)
 * - Applied sequentially in array order
 * - Empty "replace" removes the matched text
 * - Optional "ruleName" field identifies the rule in logs and capture files
 */

import * as fs from 'fs/promises';
import * as path from 'path';

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
 */
export async function loadPromptReplacements(filePath: string): Promise<PromptReplacement[]> {
  try {
    const absPath = path.resolve(filePath);
    const content = await fs.readFile(absPath, 'utf-8');
    const trimmed = content.trim();
    if (!trimmed) return [];

    const parsed = JSON.parse(trimmed) as unknown;

    // New format: { meta: { name, description }, rules: [...] }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const rulesRaw = obj.rules;
      if (Array.isArray(rulesRaw)) {
        return parseRules(rulesRaw);
      }
      throw new Error('Prompt replacements file with { meta, rules } format requires "rules" to be an array');
    }

    // Legacy format: raw array of { find, replace }
    if (Array.isArray(parsed)) {
      return parseRules(parsed);
    }

    throw new Error('Prompt replacements file must contain a JSON array or a { meta, rules } object');
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
 */
export async function loadPersonalityMeta(filePath: string): Promise<PersonalityMeta | null> {
  try {
    const absPath = path.resolve(filePath);
    const content = await fs.readFile(absPath, 'utf-8');
    const trimmed = content.trim();
    if (!trimmed) return null;

    const parsed = JSON.parse(trimmed) as unknown;

    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const meta = obj.meta;
      if (
        typeof meta === 'object' &&
        meta !== null &&
        typeof (meta as any).name === 'string' &&
        typeof (meta as any).description === 'string'
      ) {
        return {
          name: (meta as any).name,
          description: (meta as any).description,
        };
      }
    }
    return null;
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