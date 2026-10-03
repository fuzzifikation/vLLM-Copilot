/**
 * The personality store — host wrapper. The rules, discovery, seeding and the
 * ONE replacements resolver live in the host-neutral core
 * (`core/persona/store.ts`) over explicit directory paths. This file supplies
 * what only the host has: the two directory paths derived from the extension
 * context, the workspace-relative path adapter, and
 * {@link migratePersonalityPathRefs} — the one operation that MUTATES USER
 * SETTINGS (rewriting machine-bound path references into portable names),
 * which is configuration ownership, not file ownership.
 */

import * as path from 'path';
import type * as vscode from 'vscode';
import {
  discoverPersonalities as coreDiscover,
  resolveModelReplacements as coreResolve,
  syncBundledPersonalities as coreSync,
  type PersonalityDirs,
  type ResolvedReplacements,
} from '../core/persona/store.js';
import { resolveWorkspaceRelativePath } from '../state/config.js';
import { normalizeModelEntry, type ModelConfig } from '../core/config/config.js';
import { readModels, writeModels } from '../state/configStore.js';

export type { PersonalityEntry, ResolvedReplacements } from '../core/persona/store.js';

/** Subdirectory of global storage that holds user personalities. */
const PERSONALITIES_DIR = 'personalities';

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

function dirsOf(context: vscode.ExtensionContext): PersonalityDirs {
  return {
    globalDir: getGlobalPersonalitiesDir(context),
    bundledDir: getBundledPersonalitiesDir(context),
  };
}

/**
 * Discover all personalities (global folder, seeded presets, user drops) —
 * core policy over this install's directories. See `core/persona/store.ts`.
 */
export function discoverPersonalities(
  context: vscode.ExtensionContext,
  onWarn?: (message: string) => void
): Promise<import('../core/persona/store.js').PersonalityEntry[]> {
  return coreDiscover(dirsOf(context), onWarn);
}

/**
 * THE single replacements resolver (chat + Model Settings). See
 * `core/persona/store.ts` for the resolution rules; this adapter supplies
 * this install's dirs (or none → path-only mode) and the workspace-root
 * adapter for relative stored paths.
 */
export function resolveModelReplacements(
  context: vscode.ExtensionContext | undefined,
  model: { personality?: string; systemMessageReplacementsFile?: string },
  onLog?: (message: string) => void
): Promise<ResolvedReplacements | null> {
  return coreResolve(context ? dirsOf(context) : undefined, model, {
    onLog,
    resolveRelativePath: resolveWorkspaceRelativePath,
  });
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

/**
 * Seed and refresh the global personality folder from the shipped
 * `prompt-replacements/` dir, at activation. Core policy over this install's
 * dirs; see `core/persona/store.ts`.
 */
export function syncBundledPersonalities(
  context: vscode.ExtensionContext
): Promise<{ updated: string[] }> {
  return coreSync(dirsOf(context));
}
