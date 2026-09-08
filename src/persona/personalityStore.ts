/**
 * The personality store: ONE folder, in global storage.
 *
 * `context.globalStorageUri/personalities/*.json` is the single home for every
 * personality — the shipped presets, the shared common file, and anything the
 * user drops in there (the dropdown finds those automatically).
 *
 * At activation, {@link syncBundledPersonalities} seeds/refreshes the folder
 * from the extension's `prompt-replacements/` dir: bundled basenames are
 * extension-owned and are overwritten mercilessly (that is the 1.35.2
 * stale-copy policy carried to its conclusion), everything else is user-owned
 * and never touched. Because seeding runs before any view can open, the
 * folder always exists with current content, so applying a personality is
 * just "store the path" — no copy-on-apply, no collision detection, no
 * bundled/global twin to dedup.
 *
 * Seeding keeps a live copy of the common file right next to the presets —
 * that is the file their `include` names — and everything an `include`
 * resolves at runtime lives in this folder: the version-stamped install path
 * is only ever READ (the source this seeding copies from, plus the "+ New
 * file" template's live read of the Raw preset), never referenced by a stored
 * path or an include.
 *
 * Note: workspace copies (`.vllm/prompt-replacements-*.json`) are deliberately
 * NOT discovered as picker personalities. They remain fully functional custom
 * replacement files at request time (attached via Model Settings "Use file from
 * disk", see systemMessagePipeline.ts) — the picker lists the global folder
 * plus the model's own attached file, nothing else.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadPersonalityMeta, clearPersonalityCache, COMMON_REPLACEMENTS_FILENAME } from './promptReplacer.js';
import { resolveWorkspaceRelativePath, pathsEquivalent } from '../state/config.js';

export interface PersonalityEntry {
  name: string;
  description: string;
  /** absolute path to the personality file (inside the global folder). */
  sourcePath: string;
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
 * ONE join (audit P17-1) — seeding and the "+ New" template's live Raw read
 * both point through here, so a packaging path change is a one-line edit.
 * Nothing stored or included ever references this (version-stamped) path:
 * discovery and request-time reads go to the seeded global folder alone. */
export function getBundledPersonalitiesDir(context: vscode.ExtensionContext): string {
  return path.join(context.extensionUri.fsPath, 'prompt-replacements');
}

/**
 * Discover all personalities: the global folder, and nothing else. Seeding
 * (activation) guarantees the bundled presets live there; user-dropped files
 * are picked up by the same scan.
 *
 * Duplicate `meta.name`s are not possible inside one file but trivially
 * created by copying one (a copied preset keeps its name). Pickers LABEL
 * entries by name, so twins are indistinguishable in every list; `onWarn`
 * gets one message per duplicated name so each surface can tell the user
 * where they can still fix it. Both entries stay listed regardless — hiding
 * a user's file is not dedup, it is disappearance.
 */
export async function discoverPersonalities(
  context: vscode.ExtensionContext,
  onWarn?: (message: string) => void
): Promise<PersonalityEntry[]> {
  const entries = await scanPersonalityDir(getGlobalPersonalitiesDir(context));
  // Curated display order: bundled presets follow BUNDLED_PRESET_ORDER (rank 0..n),
  // anything else (user-created or unknown) sorts after, alphabetically.
  const sorted = entries.sort((a, b) => {
    const ai = BUNDLED_PRESET_ORDER.indexOf(a.name);
    const bi = BUNDLED_PRESET_ORDER.indexOf(b.name);
    const ar = ai === -1 ? BUNDLED_PRESET_ORDER.length : ai;
    const br = bi === -1 ? BUNDLED_PRESET_ORDER.length : bi;
    if (ar !== br) return ar - br;
    // Deterministic ordering — fixed locale so the sort never varies by machine.
    return a.name.localeCompare(b.name, 'en');
  });

  // One warning per duplicated name, naming the colliding files.
  const filesByName = new Map<string, string[]>();
  for (const e of sorted) {
    const list = filesByName.get(e.name);
    if (list) list.push(path.basename(e.sourcePath));
    else filesByName.set(e.name, [path.basename(e.sourcePath)]);
  }
  for (const [name, files] of filesByName) {
    if (files.length > 1) {
      onWarn?.(
        `Personality name collision: ${files.join(', ')} all claim the name "${name}". ` +
        'They appear identically in the personality pickers. Give each file a unique meta.name.',
      );
    }
  }
  return sorted;
}

/** Scan a directory for valid personality files (`{ meta: { name, description } }` format). */
async function scanPersonalityDir(dir: string): Promise<PersonalityEntry[]> {
  const results: PersonalityEntry[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return results; // dir missing (e.g. activation seeding not run yet) — not an error
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    // The shared rules file is extension infrastructure included by the
    // personalities that want it — it is never a selectable personality itself.
    if (name === COMMON_REPLACEMENTS_FILENAME) continue;

    const filePath = path.join(dir, name);
    const meta = await loadPersonalityMeta(filePath); // null on unreadable/legacy files
    if (meta) {
      results.push({ name: meta.name, description: meta.description, sourcePath: filePath });
    }
  }
  return results;
}

/**
 * Resolve which personality a model's `systemMessageReplacementsFile` refers to.
 * Relative paths are resolved against the workspace root (matches provider.ts).
 * Matching is file-system-equivalent (case-insensitive on Windows), never exact
 * string equality — a stored path whose casing drifted from the live
 * `globalStorageUri` casing still names the same preset (regression: 1.36.4
 * path-equality matching made such presets show as "(user file)").
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
  return all.find(e => pathsEquivalent(e.sourcePath, abs)) ?? null;
}

/**
 * Write a personality file atomically (temp + rename) so a crash mid-write can't
 * leave a truncated JSON file. Clears the promptReplacer cache so the new
 * content is re-read on next load.
 */
async function writePersonalityAtomically(dest: string, content: string): Promise<void> {
  const tmpPath = `${dest}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, dest);
  clearPersonalityCache();
}

/**
 * Seed and refresh the global personality folder from the shipped
 * `prompt-replacements/` dir, at activation. Creates files that are missing,
 * overwrites every bundled basename whose content differs (including the
 * common file — bundled basenames are extension-owned, user edits to them are
 * deliberately clobbered), and never touches user-created files (their own
 * filenames have no bundled twin).
 *
 * Why at activation, not at apply: applying a personality is a bare path
 * write now, which requires the folder to already hold current bundled files.
 * (Before this, copies happened at apply and were only refreshed at the next
 * re-apply — the 1.35.2 bug where upgraded presets never reached existing
 * models. Seeding at activation makes staleness structurally impossible.)
 *
 * Idempotent: files already identical are skipped, no write, no cache clear.
 * Returns the basenames that were written so the caller can log.
 */
export async function syncBundledPersonalities(
  context: vscode.ExtensionContext
): Promise<{ updated: string[] }> {
  const dir = getGlobalPersonalitiesDir(context);
  const bundledDir = getBundledPersonalitiesDir(context);
  await fs.mkdir(dir, { recursive: true });

  let names: string[];
  try {
    names = await fs.readdir(bundledDir);
  } catch {
    return { updated: [] }; // no bundled dir (broken VSIX) — nothing to seed
  }

  const updated: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;

    // Iterate the BUNDLED dir: only files with a bundled twin are
    // extension-owned; anything else sitting in global storage is a
    // user-created personality and stays exactly as the user left it.
    let bundledContent: string;
    try {
      bundledContent = await fs.readFile(path.join(bundledDir, name), 'utf-8');
    } catch {
      continue;
    }

    const dest = path.join(dir, name);
    let current: string | null = null;
    try {
      current = await fs.readFile(dest, 'utf-8');
    } catch {
      // Missing global copy — seed it.
    }
    if (current === bundledContent) continue;

    await writePersonalityAtomically(dest, bundledContent);
    updated.push(name);
  }
  return { updated };
}
