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
  return [...seen.values()];
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
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const abs = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const all = known ?? (await discoverPersonalities(context));
  return all.find(e => path.resolve(e.sourcePath) === abs) ?? null;
}

/**
 * Ensure a personality file exists in global storage, returning its absolute path.
 *
 * Copies `sourcePath` into `globalStorage/personalities/` under the same basename
 * unless a file with that name already exists there (user edits are never
 * clobbered). Safe to call with a path already inside global storage — it is a
 * no-op then. Clears the promptReplacer cache when a new copy is written.
 */
export async function ensureGlobalPersonality(
  context: vscode.ExtensionContext,
  sourcePath: string
): Promise<string> {
  const dir = getGlobalPersonalitiesDir(context);
  const dest = path.join(dir, path.basename(sourcePath));
  await fs.mkdir(dir, { recursive: true });

  if (dest === path.resolve(sourcePath)) return dest; // already in global storage

  let destExists = true;
  try {
    await fs.access(dest);
  } catch {
    destExists = false;
  }

  if (!destExists) {
    const content = await fs.readFile(sourcePath, 'utf-8');
    // Write atomically (temp + rename) so a crash mid-write can't leave a
    // truncated JSON file that would then be treated as the user's copy.
    const tmpPath = `${dest}.tmp`;
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, dest);
    // Content changed — force re-read on next load.
    clearPersonalityCache();
    return dest;
  }

  // The destination already exists. If it's a DIFFERENT personality that happens
  // to share the basename, that's a collision — surface it instead of silently
  // binding this personality to the wrong file. If it's the same personality
  // (possibly user-edited), keep the existing global copy (edits are never
  // clobbered).
  const sourceMeta = await loadPersonalityMeta(sourcePath);
  const destMeta = await loadPersonalityMeta(dest);
  // Collision rules: an existing global file may not silently stand in for the
  // personality being applied. If it's a DIFFERENT personality sharing the
  // basename, or it isn't a recognizable personality at all (legacy-array or
  // otherwise unreadable format — we can't confirm it's the same personality),
  // surface the conflict instead of binding the selected personality to the
  // wrong file. Only a global file with the same personality name (possibly
  // user-edited) is kept, so edits are never clobbered.
  if (sourceMeta?.name && (!destMeta || destMeta.name !== sourceMeta.name)) {
    throw new Error(
      `Personality "${sourceMeta.name}" collides with an existing global file "${dest}"` +
      (destMeta?.name ? ` (personality "${destMeta.name}")` : ` (not a recognized personality)`) +
      `. Rename or remove that file first.`
    );
  }
  return dest;
}
