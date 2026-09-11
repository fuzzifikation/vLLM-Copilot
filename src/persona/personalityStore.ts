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
 * and never touched. Because seeding runs before any view can open, the folder
 * always exists with current content, so applying a personality stores a
 * reference and never copies a file — no copy-on-apply, no collision
 * detection, no bundled/global twin to dedup. Shipped presets store the
 * portable NAME (`ModelConfig.personality`), user files the path
 * (`systemMessageReplacementsFile`) — see {@link resolveModelReplacements}.
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
import { normalizeModelEntry, resolveWorkspaceRelativePath, pathsEquivalent, type ModelConfig } from '../state/config.js';
import { readModels, writeModels } from '../state/configStore.js';

export interface PersonalityEntry {
  name: string;
  description: string;
  /** absolute path to the personality file (inside the global folder). */
  sourcePath: string;
  /** True when this file is one the extension SHIPS (its basename lives in
   *  the bundled dir). Shipped presets are referenced by NAME in config —
   *  portable across machines and OSes — user-dropped files by path. */
  bundled?: boolean;
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
  // Flag the shipped presets (basename match — the seeded global copies carry
  // the shipped filenames verbatim). Pickers store these by NAME (portable),
  // everything else by path.
  const bundled = await getBundledPresetBasenames(context);
  for (const e of entries) e.bundled = bundled.has(path.basename(e.sourcePath));
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

/**
 * Shipped-preset index — basenames plus the meta.name → basename map — memoized
 * per (dir, listing). A NAME reference is resolved on every chat request, and
 * rebuilding the map by hand meant a readdir plus a metadata read per preset,
 * every prompt. Extension files are immutable while an install is loaded (an
 * update lands in a new version-stamped dir) and the seeded global copies are
 * extension-owned, so the listing is the whole signature that matters. The
 * returned Set/Map are read-only by contract — callers must not mutate them.
 */
let presetIndex: { key: string; basenames: Set<string>; nameToBasename: Map<string, string> } | undefined;

async function readPresetIndex(
  context: vscode.ExtensionContext
): Promise<{ basenames: Set<string>; nameToBasename: Map<string, string> }> {
  const dir = getBundledPersonalitiesDir(context);
  let listing: string[];
  try {
    // The common include is infrastructure, never a selectable preset.
    listing = (await fs.readdir(dir)).filter(n => n.endsWith('.json') && n !== COMMON_REPLACEMENTS_FILENAME);
  } catch {
    listing = []; // unreadable bundled dir (dev checkout, broken VSIX)
  }
  const key = `${dir}\u0000${listing.join('\u0000')}`;
  if (presetIndex && presetIndex.key === key) return presetIndex;
  const basenames = new Set(listing);
  const nameToBasename = new Map<string, string>();
  for (const base of listing) {
    const meta =
      (await loadPersonalityMeta(path.join(getGlobalPersonalitiesDir(context), base))) ??
      (await loadPersonalityMeta(path.join(dir, base)));
    if (meta) nameToBasename.set(meta.name, base);
  }
  presetIndex = { key, basenames, nameToBasename };
  return presetIndex;
}

/**
 * Basenames of the SHIPPED personality files (the bundled dir minus the common
 * include). An unreadable bundled dir yields an empty set: nothing is treated
 * as shipped, every reference degrades to its path form — the pre-1.36.10 shape.
 */
export async function getBundledPresetBasenames(context: vscode.ExtensionContext): Promise<Set<string>> {
  return (await readPresetIndex(context)).basenames;
}

/**
 * meta.name → bundled basename, from this machine's copies (seeded global
 * folder first, bundled dir as fallback before activation seeding ran).
 * A name reference in config resolves through THIS map, so it can only ever
 * select a shipped preset — a user-dropped twin wearing the same meta.name
 * cannot hijack the reference.
 */
export async function getBundledPresetNameToBasename(
  context: vscode.ExtensionContext
): Promise<Map<string, string>> {
  return (await readPresetIndex(context)).nameToBasename;
}

/**
 * Basename of a stored replacements path WITHOUT `path.basename`: the stored
 * string may name a path from ANOTHER OS (Settings Sync, a carried-over
 * workspace) and `path` splits by the CURRENT platform only. Splitting on
 * both separators makes the shipped-preset detection work Windows→Linux and
 * back, which is exactly when it matters.
 */
function presetBasenameOf(storedPath: string): string {
  return storedPath.split(/[\\/]/).pop() ?? '';
}

/** Output of {@link resolveModelReplacements}. */
export interface ResolvedReplacements {
  /** Absolute path to load on THIS machine. */
  sourcePath: string;
  /** Set when the resolved file is a shipped preset (by name reference, by a
   *  path inside this machine's personality folder, or by an unreachable path
   *  whose basename names a shipped file). */
  personality?: string;
}

/**
 * THE single replacements resolver — request pipeline and Model Settings both
 * go through this one function (the dropdown lying while chat ran vanilla was
 * exactly the cost of two resolvers drifting).
 *
 * Resolution order:
 * 1. `personality` name → this machine's copy of the shipped preset (seeded
 *    global folder, then the bundled dir). Only SHIPPED names resolve — the
 *    map is built from the bundled files, so a user twin cannot answer.
 * 2. `systemMessageReplacementsFile` path → used as-is when readable; a
 *    readable path INSIDE this machine's personality folder naming a shipped
 *    file reports its preset name (activation then migrates the stale path to
 *    a name reference — see {@link migratePersonalityPathRefs}).
 * 3. Unreachable path whose basename names a shipped file → this machine's
 *    seeded copy. FILENAME IS THE IDENTITY: bundled basenames are extension-
 *    owned (seeding clobbers a user edit to one), so a stored path naming a
 *    shipped file IS that preset — which is exactly what lets a Windows-
 *    stored globalStorage path keep working on a Linux host instead of
 *    silently degrading to no personality. A readable path elsewhere is still
 *    the user's own file (rule 2 answers first).
 *
 * `context` undefined (headless tests) → path form only, pre-fix semantics.
 */
export async function resolveModelReplacements(
  context: vscode.ExtensionContext | undefined,
  model: { personality?: string; systemMessageReplacementsFile?: string },
  onLog?: (message: string) => void
): Promise<ResolvedReplacements | null> {
  const name = (model.personality || '').trim();
  if (context && name) {
    const base = (await getBundledPresetNameToBasename(context)).get(name);
    if (base) {
      for (const candidate of [
        path.join(getGlobalPersonalitiesDir(context), base),
        path.join(getBundledPersonalitiesDir(context), base),
      ]) {
        try {
          await fs.access(candidate);
          return { sourcePath: candidate, personality: name };
        } catch { /* try the next home */ }
      }
      onLog?.(`Personality "${name}" is a shipped preset but this machine has no copy yet - it is seeded at next activation.`);
    } else {
      onLog?.(`Personality "${name}" does not name a shipped preset - falling back to systemMessageReplacementsFile.`);
    }
  }
  const file = (model.systemMessageReplacementsFile || '').trim();
  if (!file) return null;
  const abs = resolveWorkspaceRelativePath(file);
  try {
    await fs.access(abs);
    // Readable HERE: a path INSIDE this machine's personality folder that
    // names a shipped file IS that preset (a file elsewhere with the same
    // basename is the user's own file — twin doctrine, never hijacked).
    if (context) {
      const bundled = await getBundledPresetBasenames(context);
      const shippedBase = presetBasenameOf(abs);
      if (bundled.has(shippedBase) && pathsEquivalent(path.dirname(abs), getGlobalPersonalitiesDir(context))) {
        const meta = await loadPersonalityMeta(abs);
        return { sourcePath: abs, personality: meta?.name };
      }
    }
    return { sourcePath: abs };
  } catch { /* unreachable here — maybe it names a shipped preset */ }
  if (!context) return null;
  // FILENAME IS THE IDENTITY (owner ruling): bundled basenames are
  // extension-owned — seeding clobbers a user edit to one mercilessly — so a
  // stored path naming a shipped file IS that preset, wherever it was written
  // and whether or not this machine can see the original.
  const shippedBase = presetBasenameOf(file);
  if ((await getBundledPresetBasenames(context)).has(shippedBase)) {
    const seeded = path.join(getGlobalPersonalitiesDir(context), shippedBase);
    try {
      await fs.access(seeded);
      const meta = await loadPersonalityMeta(seeded);
      onLog?.(
        `Personality path "${file}" is not reachable from this machine - using this machine's copy of the ` +
        `shipped preset${meta ? ` "${meta.name}"` : ''} at ${seeded}. Re-applying the preset stores the portable name reference.`
      );
      return { sourcePath: seeded, personality: meta?.name };
    } catch { /* not seeded (activation seeding never ran) — honest miss */ }
  }
  return null;
}

/**
 * One-time repair of machine-bound personality references: a SHIPPED preset
 * still stored as a PATH (written by an older version, or carried over from
 * another OS) becomes the portable NAME. Runs at activation right after
 * seeding — deliberately NOT from a view refresh, which turned every render
 * into a settings write plus a re-entrant config refresh. Self-terminating: a
 * migrated entry has `personality` set, so the next activation finds nothing.
 *
 * User files are never touched: `resolveModelReplacements` reports a
 * `personality` name only for shipped presets, so a custom path — reachable or
 * not — keeps its own reference. Returns the number of entries rewritten.
 */
export async function migratePersonalityPathRefs(context: vscode.ExtensionContext): Promise<number> {
  const next: ModelConfig[] = [];
  let changed = 0;
  for (const model of readModels()) {
    if ((model.personality || '').trim() || !(model.systemMessageReplacementsFile || '').trim()) {
      next.push(model);
      continue;
    }
    const resolved = await resolveModelReplacements(context, model);
    if (!resolved?.personality) {
      next.push(model);
      continue;
    }
    // '' is normalizeModelEntry's delete signal: the machine-bound path is gone.
    next.push(normalizeModelEntry({ ...model, personality: resolved.personality, systemMessageReplacementsFile: '' }));
    changed++;
  }
  if (changed > 0) await writeModels(next);
  return changed;
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
 * Write a personality file atomically (temp + rename) so a crash mid-write can't
 * leave a truncated JSON file. Clears the promptReplacer cache so the new
 * content is re-read on next load.
 */
async function writePersonalityAtomically(dest: string, content: string): Promise<void> {
  const tmpPath = `${dest}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, dest);
  // Seeding can change a preset's meta.name in place (extension update), which
  // is exactly the signature the shipped-preset index memoizes — drop it.
  presetIndex = undefined;
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
