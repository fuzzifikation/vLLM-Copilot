/**
 * Global personality store.
 *
 * Personalities live in one of two places:
 * - **bundled** — extension install dir `prompt-replacements/*.json` (immutable, shipped with the VSIX)
 * - **global**  — `context.globalStorageUri/personalities/*.json` (user-owned, follows the user across workspaces)
 *
 * This module owns discovery (merging the two sources, deduped by name) and the
 * copy-to-global operation that the Set Personality command and the Server Settings
 * webview use. Every applied personality ends up as a user-owned file in global
 * storage, so it survives extension upgrades and workspace switches, and is
 * editable later.
 *
 * Note: legacy workspace copies (`.vllm/prompt-replacements-*.json`) are deliberately
 * NOT discovered as personalities. They still function as custom replacement files at
 * request time (see provider.ts), but the picker only knows bundled and global ones.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadPersonalityMeta, clearPersonalityCache } from './promptReplacer.js';
import { resolveWorkspaceRelativePath, type ModelConfig } from './config.js';

export type PersonalitySource = 'bundled' | 'global';

export interface PersonalityEntry {
  name: string;
  description: string;
  /** absolute path to the personality file. */
  sourcePath: string;
  source: PersonalitySource;
}

/** Subdirectory of global storage that holds user personalities. */
const PERSONALITIES_DIR = 'personalities';

/**
 * Legacy bundled preset file name before the "Tough Love" → "Supportive Mentor"
 * rename. A stale global copy of this file is migrated on activation.
 */
const LEGACY_TOUGH_LOVE_FILE = 'prompt-replacements-tough-love.json';
/** Legacy bundled preset display name (matches its `meta.name`). */
const LEGACY_TOUGH_LOVE_NAME = 'Tough Love';
/** New bundled preset file name. */
const SUPPORTIVE_MENTOR_FILE = 'prompt-replacements-supportive-mentor.json';

/**
 * Curated display order for the bundled presets, by personality name.
 * Anything not in this list (e.g. user-created global personalities, or a
 * future preset) sorts after the shipped lineup, alphabetically — so the
 * bundled presets are always first and predictable, and custom ones never
 * disturb the curated order.
 */
const BUNDLED_PRESET_ORDER = [
  'Critical Senior Dev',
  'Sarcastic Robot',
  'Supportive Mentor',
  'Spartan',
  'Raw (Model Natural)',
];

/** Absolute path to the user personality directory inside global storage. */
export function getGlobalPersonalitiesDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, PERSONALITIES_DIR);
}

/**
 * Discover all personalities from the two sources, deduped by name.
 *
 * Precedence on name collision: **global > bundled**. A user-owned copy (global)
 * wins over the shipped preset — it is the one that is actually referenced by a
 * stored `systemMessageReplacementsFile`, so showing the bundled twin would offer
 * a phantom second "Tough Love" that resolves to the same file.
 */
export async function discoverPersonalities(
  context: vscode.ExtensionContext
): Promise<PersonalityEntry[]> {
  const sources: Array<{ dir: string; source: PersonalitySource }> = [
    { dir: path.join(context.extensionUri.fsPath, 'prompt-replacements'), source: 'bundled' },
    { dir: getGlobalPersonalitiesDir(context), source: 'global' },
  ];

  const entries: PersonalityEntry[] = [];
  for (const { dir, source } of sources) {
    entries.push(...(await scanPersonalityDir(dir, source)));
  }

  // Dedupe by name, highest-priority source wins.
  const order: Record<PersonalitySource, number> = { global: 0, bundled: 1 };
  const seen = new Map<string, PersonalityEntry>();
  for (const e of entries) {
    const prev = seen.get(e.name);
    if (!prev || order[e.source] < order[prev.source]) {
      seen.set(e.name, e);
    }
  }
  // Curated display order: bundled presets follow BUNDLED_PRESET_ORDER (rank 0..n),
  // anything else (user-created or unknown) sorts after, alphabetically.
  return [...seen.values()].sort((a, b) => {
    const ai = BUNDLED_PRESET_ORDER.indexOf(a.name);
    const bi = BUNDLED_PRESET_ORDER.indexOf(b.name);
    const ar = ai === -1 ? BUNDLED_PRESET_ORDER.length : ai;
    const br = bi === -1 ? BUNDLED_PRESET_ORDER.length : bi;
    if (ar !== br) return ar - br;
    // Deterministic ordering — fixed locale so the sort never varies by machine.
    return a.name.localeCompare(b.name, 'en');
  });
}

/** Scan a directory for valid personality files (`{ meta: { name, description } }` format). */
async function scanPersonalityDir(dir: string, source: PersonalitySource): Promise<PersonalityEntry[]> {
  const results: PersonalityEntry[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return results; // dir missing (e.g. no global personalities yet) — not an error
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue;

    const filePath = path.join(dir, name);
    const meta = await loadPersonalityMeta(filePath); // null on unreadable/legacy files
    if (meta) {
      results.push({ name: meta.name, description: meta.description, sourcePath: filePath, source });
    }
  }
  return results;
}

/**
 * Resolve which personality a model's `systemMessageReplacementsFile` refers to.
 * Relative paths are resolved against the workspace root (matches provider.ts).
 * Returns null for empty/clear values and for files that aren't a known personality
 * (e.g. a custom `.vllm/` replacement file — those are not personalities).
 *
 * `known` optionally supplies an already-discovered list (from
 * {@link discoverPersonalities}) to avoid re-scanning the personality dirs.
 */
export async function resolveActivePersonality(
  context: vscode.ExtensionContext,
  replacementsFile: string | undefined,
  known?: PersonalityEntry[]
): Promise<PersonalityEntry | null> {
  const value = (replacementsFile || '').trim();
  if (!value) return null;
  const abs = resolveWorkspaceRelativePath(value);
  const all = known ?? (await discoverPersonalities(context));
  return all.find(e => path.resolve(e.sourcePath) === abs) ?? null;
}

/**
 * Ensure a personality file exists in global storage, returning its absolute path.
 *
 * **Extension-defined (bundled) presets are authoritative.** If the requested
 * source corresponds to a bundled preset (matching basename in the extension's
 * `prompt-replacements/` dir), the bundled file is the source of truth and is
 * ALWAYS copied over the global copy — the extension owns those personalities,
 * so user edits to a bundled preset's global copy are deliberately clobbered on
 * re-apply. This also heals stale global copies left by older extension versions
 * (e.g. a pre-de-Bender Sarcastic Robot) even when discovery resolved the source
 * to the global file (dedup: global wins).
 *
 * **User-created personalities** (no bundled twin, stored directly in global
 * storage) keep the legacy contract: created on first apply, never clobbered
 * afterwards, collision-checked by name.
 *
 * Safe to call with a path already inside global storage. Clears the promptReplacer
 * cache when a copy is written.
 */
export async function ensureGlobalPersonality(
  context: vscode.ExtensionContext,
  sourcePath: string
): Promise<string> {
  const dir = getGlobalPersonalitiesDir(context);
  const dest = path.join(dir, path.basename(sourcePath));
  await fs.mkdir(dir, { recursive: true });

  // Bundled presets always win — resolve the authoritative content from the
  // extension dir and overwrite the global copy unconditionally.
  const bundledSource = path.join(
    context.extensionUri.fsPath,
    'prompt-replacements',
    path.basename(sourcePath)
  );
  let isBundled = false;
  try {
    await fs.access(bundledSource);
    isBundled = true;
  } catch {
    isBundled = false;
  }

  if (isBundled) {
    const content = await fs.readFile(bundledSource, 'utf-8');
    await writePersonalityAtomically(dest, content);
    return dest;
  }

  // User-created personality: no bundled twin, so the file the user points at is
  // the source of truth.
  if (dest === path.resolve(sourcePath)) return dest; // already in global storage

  let destExists = true;
  try {
    await fs.access(dest);
  } catch {
    destExists = false;
  }

  if (!destExists) {
    const content = await fs.readFile(sourcePath, 'utf-8');
    await writePersonalityAtomically(dest, content);
    return dest;
  }

  // The destination already exists. If it's a DIFFERENT personality that happens
  // to share the basename, that's a collision — surface it instead of silently
  // binding this personality to the wrong file. If it's the same personality
  // (possibly user-edited), keep the existing global copy (edits are never
  // clobbered).
  const sourceMeta = await loadPersonalityMeta(sourcePath);
  const destMeta = await loadPersonalityMeta(dest);
  if (sourceMeta?.name && (!destMeta || destMeta.name !== sourceMeta.name)) {
    throw new Error(
      `Personality "${sourceMeta.name}" collides with an existing global file "${dest}"` +
      (destMeta?.name ? ` (personality "${destMeta.name}")` : ` (not a recognized personality)`) +
      `. Rename or remove that file first.`
    );
  }
  return dest;
}

/**
 * Write a personality file atomically (temp + rename) so a crash mid-write can't
 * leave a truncated JSON file that would then be treated as the user's copy.
 * Clears the promptReplacer cache so the new content is re-read on next load.
 */
async function writePersonalityAtomically(dest: string, content: string): Promise<void> {
  const tmpPath = `${dest}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, dest);
  clearPersonalityCache();
}

/**
 * One-time migration for the "Tough Love" → "Supportive Mentor" rename.
 *
 * Users who applied the old bundled preset have a global copy at
 * `personalities/prompt-replacements-tough-love.json` whose `meta.name` still
 * says "Tough Love". Once the bundled file was renamed, that stale global copy
 * would otherwise surface as a phantom *user-created* personality (no bundled
 * twin → never clobbered, never re-synced) next to the new bundled
 * "Supportive Mentor" in the picker.
 *
 * Migration (idempotent — a no-op when the legacy copy is absent):
 *   1. Confirm the legacy file is genuinely the stale bundled copy (meta.name
 *      is "Tough Love") — never delete a user file that happens to share the
 *      name (e.g. a legacy-array replacement file, which has no meta block).
 *   2. Materialize the new bundled "Supportive Mentor" file into global storage
 *      (bundled content is authoritative, matching {@link ensureGlobalPersonality}).
 *   3. Rewrite any model config whose `systemMessageReplacementsFile` resolves
 *      to the legacy global path so it points at the new file — otherwise the
 *      model would silently lose its personality on the next request. This runs
 *      BEFORE the legacy file is deleted: if the rewrite fails, the legacy file
 *      is still present and the migration self-heals on the next activation.
 *   4. Delete the stale legacy global copy.
 *
 * Returns counts so the caller can log what happened. Never throws on config
 * rewrite failure (best-effort); the file migration is the critical part.
 */
export async function migrateLegacyPersonalities(
  context: vscode.ExtensionContext
): Promise<{ migrated: boolean; configsUpdated: number }> {
  const dir = getGlobalPersonalitiesDir(context);
  const legacyPath = path.join(dir, LEGACY_TOUGH_LOVE_FILE);
  const newPath = path.join(dir, SUPPORTIVE_MENTOR_FILE);

  // Only migrate if the legacy file is the genuine stale bundled copy. A
  // legacy-array-format file (no meta) or a differently-named personality at
  // this path is user data — leave it untouched.
  const legacyMeta = await loadPersonalityMeta(legacyPath);
  if (!legacyMeta || legacyMeta.name !== LEGACY_TOUGH_LOVE_NAME) {
    return { migrated: false, configsUpdated: 0 };
  }

  // Bundled content is authoritative (extension owns bundled presets).
  const bundledSource = path.join(
    context.extensionUri.fsPath,
    'prompt-replacements',
    SUPPORTIVE_MENTOR_FILE
  );
  const content = await fs.readFile(bundledSource, 'utf-8');
  await fs.mkdir(dir, { recursive: true });
  await writePersonalityAtomically(newPath, content);

  // Rewrite model configs that pointed at the legacy global path. Runs before
  // the legacy file is deleted so a failed rewrite retries next activation.
  let configsUpdated = 0;
  try {
    const config = vscode.workspace.getConfiguration('vllm-copilot');
    const models = config.get<ModelConfig[]>('models') || [];
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    let changed = false;
    for (const m of models) {
      const ref = (m.systemMessageReplacementsFile || '').trim();
      if (!ref) continue;
      const abs = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(root, ref);
      if (abs === path.resolve(legacyPath)) {
        m.systemMessageReplacementsFile = newPath;
        changed = true;
        configsUpdated++;
      }
    }
    if (changed) {
      await config.update('models', models, vscode.ConfigurationTarget.Global);
    }
  } catch {
    // Best-effort: the file migration already succeeded; a config rewrite
    // failure must not fail activation.
  }

  // Delete the stale legacy copy last.
  await fs.unlink(legacyPath);

  return { migrated: true, configsUpdated };
}
