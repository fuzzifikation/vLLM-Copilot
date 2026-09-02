/**
 * Tests for the global personality store (personalityStore.ts).
 * Covers discovery (bundled + global, deduped by name),
 * materialization into global storage, and active-personality resolution.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  discoverPersonalities,
  ensureGlobalPersonality,
  resolveActivePersonality,
  getGlobalPersonalitiesDir,
  syncBundledPersonalities,
} from '../src/personalityStore.js';
import { COMMON_REPLACEMENTS_FILENAME } from '../src/promptReplacer.js';

const fsMock = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirContents: Record<string, string[]> = {};
  return {
    files,
    dirContents,
    readdir: vi.fn(async (dir: string) => dirContents[dir] || []),
    stat: vi.fn(async (p: string) => {
      const content = files.get(p);
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      // Derive mtimeMs/size from content so readPersonalityFile's module-level
      // cache invalidates when mock content changes (real fs would use mtime).
      let mtimeMs = 0;
      for (let i = 0; i < content.length; i++) mtimeMs = (mtimeMs * 31 + content.charCodeAt(i)) | 0;
      return { isFile: () => true, mtimeMs, size: content.length };
    }),
    readFile: vi.fn(async (p: string) => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p)!;
    }),
    access: vi.fn(async (p: string) => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
    rename: vi.fn(async (from: string, to: string) => {
      const content = files.get(from);
      if (content !== undefined) {
        files.delete(from);
        files.set(to, content);
      }
    }),
    unlink: vi.fn(async (p: string) => { files.delete(p); }),
  };
});
vi.mock('fs/promises', () => fsMock);

const ROOT = path.parse(process.cwd()).root; // 'C:\\' on Windows, '/' on posix
const EXT = path.join(ROOT, 'ext');
const GLOBAL = path.join(ROOT, 'global');
const WS = path.join(ROOT, 'ws');

function personality(name: string, description: string): string {
  return JSON.stringify({ meta: { name, description }, rules: [] });
}

describe('personalityStore', () => {
  const context = { extensionUri: { fsPath: EXT }, globalStorageUri: { fsPath: GLOBAL } } as any;

  beforeEach(() => {
    fsMock.files.clear();
    // Mutate in place (vi.mock returns the factory object by reference).
    for (const k of Object.keys(fsMock.dirContents)) delete fsMock.dirContents[k];
    vi.clearAllMocks();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: WS } }];
  });

  describe('discoverPersonalities', () => {

    it('copies a bundled preset into global storage (atomically)', async () => {
      const bundled = path.join(EXT, 'prompt-replacements');
      const src = path.join(bundled, 'prompt-replacements-supportive-mentor.json');
      fsMock.files.set(src, personality('Supportive Mentor', 'bundled'));

      const dest = await ensureGlobalPersonality(context, src);
      const tmp = `${dest}.tmp`;
      expect(dest).toBe(path.join(GLOBAL, 'personalities', 'prompt-replacements-supportive-mentor.json'));
      // Written to a temp file, then renamed over the destination.
      expect(fsMock.writeFile).toHaveBeenCalledWith(tmp, personality('Supportive Mentor', 'bundled'), 'utf-8');
      expect(fsMock.rename).toHaveBeenCalledWith(tmp, dest);
      expect(fsMock.files.get(dest)).toBe(personality('Supportive Mentor', 'bundled'));
      expect(fsMock.files.has(tmp)).toBe(false);
    });

    it('does not clobber an existing global copy of a USER-created personality (no bundled twin)', async () => {
      const src = path.join(WS, 'my-personality.json');
      fsMock.files.set(src, personality('Mine', 'custom'));
      const dest = path.join(GLOBAL, 'personalities', 'my-personality.json');
      fsMock.files.set(dest, personality('Mine', 'user-edited'));

      await ensureGlobalPersonality(context, src);
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it('bundled preset overwrites its stale global copy (extension owns presets)', async () => {
      // A stale global copy (e.g. old pre-de-Bender Sarcastic Robot) must be
      // replaced by the current bundled file on re-apply.
      const src = path.join(EXT, 'prompt-replacements', 'x.json');
      fsMock.files.set(src, personality('X', 'bundled'));
      const dest = path.join(GLOBAL, 'personalities', 'x.json');
      fsMock.files.set(dest, personality('X', 'user-edited'));

      await ensureGlobalPersonality(context, src);
      expect(fsMock.writeFile).toHaveBeenCalled();
      expect(fsMock.files.get(dest)).toBe(personality('X', 'bundled'));
    });

    it('bundled preset overwrites a global file with a DIFFERENT name (no collision throw)', async () => {
      const src = path.join(EXT, 'prompt-replacements', 'a.json');
      fsMock.files.set(src, personality('Alpha', 'bundled'));
      const dest = path.join(GLOBAL, 'personalities', 'a.json');
      fsMock.files.set(dest, personality('Beta', 'unrelated'));

      await ensureGlobalPersonality(context, src);
      expect(fsMock.files.get(dest)).toBe(personality('Alpha', 'bundled'));
    });

    it('bundled preset overwrites a legacy-array global file sharing the basename', async () => {
      const src = path.join(EXT, 'prompt-replacements', 'a.json');
      fsMock.files.set(src, personality('Alpha', 'bundled'));
      const dest = path.join(GLOBAL, 'personalities', 'a.json');
      // Legacy-array format — no meta block.
      fsMock.files.set(dest, JSON.stringify([{ find: 'x', replace: 'y' }]));

      await ensureGlobalPersonality(context, src);
      // The bundled preset wins over the legacy file.
      expect(fsMock.files.get(dest)).toBe(personality('Alpha', 'bundled'));
    });

    it('user-created personality (no bundled twin) colliding by name still throws', async () => {
      const src = path.join(WS, 'a.json');
      fsMock.files.set(src, personality('Alpha', 'custom'));
      const dest = path.join(GLOBAL, 'personalities', 'a.json');
      fsMock.files.set(dest, personality('Beta', 'unrelated'));

      await expect(ensureGlobalPersonality(context, src)).rejects.toThrow(/collides/);
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it('user-created personality (no bundled twin) colliding with legacy array still throws', async () => {
      const src = path.join(WS, 'a.json');
      fsMock.files.set(src, personality('Alpha', 'custom'));
      const dest = path.join(GLOBAL, 'personalities', 'a.json');
      // Legacy-array format — no meta block, so we cannot confirm it is "Alpha".
      fsMock.files.set(dest, JSON.stringify([{ find: 'x', replace: 'y' }]));

      await expect(ensureGlobalPersonality(context, src)).rejects.toThrow(/collides/);
      expect(fsMock.writeFile).not.toHaveBeenCalled();
      // The user's legacy file must not be clobbered.
      expect(fsMock.files.get(dest)).toBe(JSON.stringify([{ find: 'x', replace: 'y' }]));
    });

    it('refreshes stale global copies of bundled presets', async () => {
      const bundled = path.join(EXT, 'prompt-replacements');
      const globalDir = getGlobalPersonalitiesDir(context);

      fsMock.files.set(path.join(bundled, 'prompt-replacements-sarcastic-robot.json'), personality('Sarcastic Robot', 'v2 bundled'));
      fsMock.dirContents[globalDir] = ['prompt-replacements-sarcastic-robot.json'];
      const globalFile = path.join(globalDir, 'prompt-replacements-sarcastic-robot.json');
      fsMock.files.set(globalFile, personality('Sarcastic Robot', 'v1 stale copy'));

      const result = await syncBundledPersonalities(context);

      expect(result).toEqual({ updated: ['prompt-replacements-sarcastic-robot.json'] });
      expect(fsMock.files.get(globalFile)).toBe(personality('Sarcastic Robot', 'v2 bundled'));
    });

    it('never touches user-created personalities or already-current files', async () => {
      const bundled = path.join(EXT, 'prompt-replacements');
      const globalDir = getGlobalPersonalitiesDir(context);

      fsMock.files.set(path.join(bundled, 'prompt-replacements-spartan.json'), personality('Spartan', 'bundled'));
      fsMock.dirContents[globalDir] = ['prompt-replacements-spartan.json', 'my-thing.json'];
      const currentFile = path.join(globalDir, 'prompt-replacements-spartan.json');
      const userFile = path.join(globalDir, 'my-thing.json');
      fsMock.files.set(currentFile, personality('Spartan', 'bundled')); // identical
      fsMock.files.set(userFile, personality('My Thing', 'user edits, hands off'));

      const result = await syncBundledPersonalities(context);

      expect(result).toEqual({ updated: [] });
      expect(fsMock.writeFile).not.toHaveBeenCalled();
      expect(fsMock.files.get(userFile)).toBe(personality('My Thing', 'user edits, hands off'));
    });

    it('leaves a bundled-basename workspace .vllm file untouched (not global storage)', async () => {
      // Sync only ever looks at global storage; legacy workspace copies are
      // user-owned custom files by policy.
      const bundled = path.join(EXT, 'prompt-replacements');
      fsMock.files.set(path.join(bundled, 'prompt-replacements-spartan.json'), personality('Spartan', 'bundled v2'));
      const wsCopy = path.join(WS, '.vllm', 'prompt-replacements-spartan.json');
      fsMock.files.set(wsCopy, personality('Spartan', 'old workspace copy'));

      const result = await syncBundledPersonalities(context);

      expect(result).toEqual({ updated: [] });
      expect(fsMock.files.get(wsCopy)).toBe(personality('Spartan', 'old workspace copy'));
    });
  });
});
