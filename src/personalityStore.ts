/**
 * Global personality store.
 *
 * Personalities live in one of three places:
 * - **bundled**   — extension install dir `prompt-replacements/*.json` (immutable, shipped with the VSIX)
 * - **global**    — `context.globalStorageUri/personalities/*.json` (user-owned, follows the user across workspaces)
 * - **workspace** — `<workspace>/.vllm/*.json` (legacy copies created by older versions)
 *
 * This module owns discovery (merging the three sources, deduped by name) and the
 * copy-to-global operation that the Set Personality command and the Server Settings
 * webview use. Every applied personality ends up as a user-owned file in global
 * storage, so it survives extension upgrades and workspace switches, and is
 * editable later.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadPersonalityMeta, clearPersonalityCache } from './promptReplacer.js';

export type PersonalitySource = 'bundled' | 'global' | 'workspace';

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
 * Discover all personalities from the three sources, deduped by name.
 *
 * Precedence on name collision: **global > bundled > workspace**. A user-owned
 * copy (global) wins over the shipped preset — it is the one that is actually
 * referenced by a stored `systemMessageReplacementsFile`, so showing the bundled
 * twin would offer a phantom second "Tough Love" that resolves to the same file.
 */
export async function discoverPersonalities(
  context: vscode.ExtensionContext
): Promise<PersonalityEntry[]> {
  const sources: Array<{ dir: string; source: PersonalitySource }> = [
    { dir: path.join(context.extensionUri.fsPath, 'prompt-replacements'), source: 'bundled' },
    { dir: getGlobalPersonalitiesDir(context), source: 'global' },
  ];
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (ws) sources.push({ dir: path.join(ws.uri.fsPath, '.vllm'), source: 'workspace' });

  const entries: PersonalityEntry[] = [];
  for (const { dir, source } of sources) {
    entries.push(...(await scanPersonalityDir(dir, source)));
  }

  // Dedupe by name, highest-priority source wins.
  const order: Record<PersonalitySource, number> = { global: 0, bundled: 1, workspace: 2 };
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
 * Returns null for empty/clear values and for files that aren't a known personality.
 *
 * `known` optionally supplies an already-discovered list (from
 * {@link discoverPersonalities}) to avoid re-scanning the personality dirs.
 *
 * Fallback: a legacy `.vllm/` reference whose workspace copy was deduped out by a
 * same-named bundled/global personality matches by basename, so it still resolves.
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
  const exact = all.find(e => path.resolve(e.sourcePath) === abs);
  if (exact) return exact;
  const base = path.basename(abs);
  return all.find(e => path.basename(e.sourcePath) === base) ?? null;
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
  if (dest !== path.resolve(sourcePath)) {
    try {
      await fs.access(dest);
    } catch {
      const content = await fs.readFile(sourcePath, 'utf-8');
      await fs.writeFile(dest, content, 'utf-8');
      // Content changed — force re-read on next load.
      clearPersonalityCache();
    }
  }
  return dest;
}
