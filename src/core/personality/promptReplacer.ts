/**
 * Load and apply find/replace rules to system message text.
 *
 * Design:
 * - File format: { "meta": { name, description }, "rules": [...] } (legacy raw
 *   arrays of rules still load). A position in "rules" may instead hold
 *   { "include": "<path>" }, which splices that file's rules in at its
 *   position — see resolveRules.
 * - Rules are { "ruleName": "...", "find": "...", "replace": "..." } objects
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

// ── Shared (common) replacements ─────────────────────────────────────

/**
 * File name of the personality-neutral replacement rules that ship with the
 * extension. Personalities pull it in with an include entry: a plain
 * `"prompt-replacements-common.json"` works for files that live next to it
 * (the seeded presets do exactly that), any absolute path reaches it from
 * elsewhere — `include` only ever means a path, no symbolic tokens. In user
 * files that include line is theirs to keep, move, or delete. Not a selectable
 * personality itself: discovery skips this file name. Seeded into the
 * global `personalities/` folder at activation — bundled basenames are
 * extension-owned and update with the VSIX (personalityStore.ts).
 */
export const COMMON_REPLACEMENTS_FILENAME = 'prompt-replacements-common.json';

// ── Module-level cache ───────────────────────────────────────────────
// Keyed by resolved absolute path, revalidated by mtime+size so edits to global
// personality files are picked up without a restart. Bundled extension assets
// never change; global copies (in `personalities/`) do when the user edits them,
// and this lets those edits apply on the next load. A cheap `stat` replaces a
// full read+parse on every unchanged file.
const personalityCache = new Map<string, {
  meta: PersonalityMeta | null;
  rules: StoredRule[];
  mtimeMs: number;
  size: number;
}>();

/**
 * Internal: read, parse, and cache a personality file.
 * Returns both meta (null for legacy/array format files) and the raw rule
 * entries (includes NOT yet resolved — resolution is per-load so the cache
 * never freezes the state of an included file whose mtime differs from the
 * including file's).
 */
async function readPersonalityFile(absPath: string): Promise<{ meta: PersonalityMeta | null; rules: StoredRule[] }> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    // File gone — don't serve a stale copy; callers treat ENOENT as "no file".
    personalityCache.delete(absPath);
    throw err;
  }

  const cached = personalityCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }

  const content = await fs.readFile(absPath, 'utf-8');
  const trimmed = content.trim();

  const result: { meta: PersonalityMeta | null; rules: StoredRule[] } = {
    meta: null,
    rules: [],
  };

  if (!trimmed) {
    personalityCache.set(absPath, { ...result, mtimeMs: stat.mtimeMs, size: stat.size });
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

  personalityCache.set(absPath, { ...result, mtimeMs: stat.mtimeMs, size: stat.size });
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
 * Category of an include warning, so callers can judge severity instead of
 * parsing prose:
 * - `include-failed`: the target is missing, unreadable, or malformed -
 *   rules that should be there are NOT (a degradation).
 * - `include-dedup`: the file was already loaded in this chain (cycle or
 *   diamond) - by design, nothing is lost, the rules are already present
 *   at their first position.
 */
export type IncludeWarnKind = 'include-failed' | 'include-dedup';

/**
 * Load prompt replacements from a JSON file.
 * Supports both legacy (raw array) and new ({ meta, rules }) formats.
 * Returns an empty array if the file doesn't exist or is empty.
 *
 * `onWarn` reports include problems with their {@link IncludeWarnKind}; see
 * {@link resolveRules} for what each kind means.
 *
 * Delegates to {@link readPersonalityFile} for I/O and parsing, so
 * calling this after {@link loadPersonalityMeta} on the same file does
 * NOT re-read the file (module-level cache hit).
 */
export async function loadPromptReplacements(
  filePath: string,
  onWarn?: (message: string, kind: IncludeWarnKind) => void,
): Promise<PromptReplacement[]> {
  try {
    return await resolveRules(path.resolve(filePath), new Set(), onWarn);
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as any).code === 'ENOENT') {
      // File not found — caller (systemMessagePipeline.ts) is responsible for logging if needed.
      return [];
    }
    throw err;
  }
}

/**
 * Resolve one file's rule entries, splicing each `include` target's resolved
 * rules in at the entry's POSITION — order is the contract (persona rules
 * before boilerplate removals lives in the file now, not in code).
 *
 * The `visited` set marks every file already loaded in this chain: a repeated
 * include resolves once, at its first position; later occurrences are skipped
 * with an `include-dedup` warning. Include failures (`include-failed`) never
 * discard the including file's own rules — a missing, unreadable, or malformed
 * target degrades to skip-with-warning, the same independent-degradation
 * doctrine the request pipeline applied to the persona/common split before
 * includes existed.
 */
async function resolveRules(
  absPath: string,
  visited: Set<string>,
  onWarn?: (message: string, kind: IncludeWarnKind) => void,
): Promise<PromptReplacement[]> {
  if (visited.has(absPath)) {
    onWarn?.(`Include skipped (already loaded in this chain): ${absPath}`, 'include-dedup');
    return [];
  }
  visited.add(absPath);

  const { rules: stored } = await readPersonalityFile(absPath);
  const out: PromptReplacement[] = [];
  for (const entry of stored) {
    if (!('include' in entry)) {
      out.push(entry);
      continue;
    }
    // An include is only ever a path: absolute as written, bare/relative
    // against the INCLUDING file's directory (like tsconfig extends, so a
    // folder of personality files stays self-contained).
    const target = path.isAbsolute(entry.include)
      ? path.resolve(entry.include)
      : path.resolve(path.dirname(absPath), entry.include);
    try {
      out.push(...(await resolveRules(target, visited, onWarn)));
    } catch (err) {
      onWarn?.(
        `Include "${entry.include}" failed (${target}): ${err instanceof Error ? err.message : String(err)}` +
        ' - continuing without it.',
        'include-failed',
      );
    }
  }
  return out;
}

/**
 * A rule entry exactly as stored in the file: either a find/replace rule or an
 * `include` reference to another replacements file. Includes are position-
 * preserving until {@link resolveRules} splices them.
 */
type StoredRule = PromptReplacement | { include: string };

/** Parse an array of raw replacement objects into StoredRule[] (includes kept as markers). */
function parseRules(parsed: unknown[]): StoredRule[] {
  const replacements: StoredRule[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Each replacement entry must be an object with "find"/"replace" or "include": ${JSON.stringify(entry).slice(0, 100)}`);
    }
    const item = entry as Record<string, unknown>;
    if ('include' in item) {
      if (typeof item.include !== 'string' || !item.include.trim()) {
        throw new Error(`An include entry must have "include" as a non-empty string: ${JSON.stringify(entry).slice(0, 100)}`);
      }
      replacements.push({ include: item.include });
    } else if ('find' in item && 'replace' in item) {
      if (typeof item.find === 'string' && typeof item.replace === 'string') {
        replacements.push({
          find: item.find,
          replace: item.replace,
          ruleName: typeof item.ruleName === 'string' ? item.ruleName : undefined,
        });
      } else {
        throw new Error(`Each replacement entry must have "find" and "replace" as strings: ${JSON.stringify(entry).slice(0, 100)}`);
      }
    } else {
      throw new Error(`Each replacement entry must have "find" and "replace" properties, or "include": ${JSON.stringify(entry).slice(0, 100)}`);
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
    // Single pass: split once to detect + replace all occurrences. `split`/`join`
    // (not `replaceAll`) keeps replacement literal — `$&`/`$1` in `replace` must
    // not be interpreted as pattern references.
    const parts = result.split(find);
    if (parts.length > 1) {
      result = parts.join(replace);
      if (ruleName) matchedRuleNames.push(ruleName);
    }
  }

  return { result, matchedRuleNames };
}