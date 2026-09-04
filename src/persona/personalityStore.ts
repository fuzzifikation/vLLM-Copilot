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
 * request time (see systemMessagePipeline.ts), but the picker only knows bundled and global ones.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadPersonalityMeta, clearPersonalityCache, COMMON_REPLACEMENTS_FILENAME } from './promptReplacer.js';
import { resolveWorkspaceRelativePath } from '../state/config.js';

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

/** The extension-shipped personality JSONs (authoritative bundled presets).
 * ONE join (audit P17-1) — discovery, copy-in, and upgrade re-sync all read
 * through here so a packaging path change is a one-line edit. */
function getBundledPersonalitiesDir(context: vscode.ExtensionContext): string {
  return path.join(context.extensionUri.fsPath, 'prompt-replacements');
}

/**
 * Discover all personalities from the two sources, deduped by name.
 *
 * Precedence on name collision: **global > bundled**. A user-owned copy (global)
 * wins over the shipped preset — it is the one that is actually referenced by a
 * stored `systemMessageReplacementsFile`, so showing the bundled twin would
 * offer a phantom second entry that resolves to the same file.
 */
export async function discoverPersonalities(
  context: vscode.ExtensionContext
): Promise<PersonalityEntry[]> {
  const sources: Array<{ dir: string; source: PersonalitySource }> = [
    { dir: getBundledPersonalitiesDir(context), source: 'bundled' },
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
    // The shared rules file is extension infrastructure applied on top of every
    // personality — it is never a selectable personality itself (both the
    // bundled and any stray global copy are skipped here).
    if (name === COMMON_REPLACEMENTS_FILENAME) continue;

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
  const bundledSource = path.join(getBundledPersonalitiesDir(context), path.basename(sourcePath));
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
 * Re-sync stale global copies of **bundled** presets with the files shipped in
 * this extension version, at activation.
 *
 * Why this exists: applying a personality copies the bundled file into global
 * storage and stores that absolute path in `systemMessageReplacementsFile`.
 * The copy was only ever refreshed when the user re-applied the personality
 * (`ensureGlobalPersonality`), so after an extension upgrade that changed a
 * bundled preset, existing models kept applying the *old* rules forever —
 * silently, with no way for the user to notice short of re-selecting.
 *
 * Policy (matches {@link ensureGlobalPersonality}): bundled presets are
 * extension-owned. A global file whose basename has a bundled twin is our
 * file, and the shipped content is authoritative. User-created personalities
 * (no bundled twin, their own filenames) are never touched, nor are workspace
 * `.vllm/` custom replacement files.
 *
 * Idempotent: files already identical are skipped, no cache clear, no write.
 * Returns the basenames that were refreshed so the caller can log.
 */
export async function syncBundledPersonalities(
  context: vscode.ExtensionContext
): Promise<{ updated: string[] }> {
  const dir = getGlobalPersonalitiesDir(context);
  const bundledDir = getBundledPersonalitiesDir(context);

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { updated: [] }; // no global personalities yet
  }

  const updated: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (name === COMMON_REPLACEMENTS_FILENAME) continue;

    // Only files with a bundled twin are extension-owned; anything else is
    // a user-created personality and stays exactly as the user left it.
    let bundledContent: string;
    try {
      bundledContent = await fs.readFile(path.join(bundledDir, name), 'utf-8');
    } catch {
      continue;
    }

    const dest = path.join(dir, name);
    let current: string;
    try {
      current = await fs.readFile(dest, 'utf-8');
    } catch {
      continue;
    }
    if (current === bundledContent) continue;

    await writePersonalityAtomically(dest, bundledContent);
    updated.push(name);
  }
  return { updated };
}
