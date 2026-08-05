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
} from '../src/personalityStore.js';

const fsMock = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirContents: Record<string, string[]> = {};
  return {
    files,
    dirContents,
    readdir: vi.fn(async (dir: string) => dirContents[dir] || []),
    stat: vi.fn(async (p: string) => ({ isFile: () => files.has(p) })),
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
    it('merges bundled and global personalities', async () => {
      const bundled = path.join(EXT, 'prompt-replacements');
      const globalDir = getGlobalPersonalitiesDir(context);
      const wsDir = path.join(WS, '.vllm');

      fsMock.dirContents[path.join(bundled)] = ['prompt-replacements-tough-love.json'];
      fsMock.files.set(path.join(bundled, 'prompt-replacements-tough-love.json'), personality('Tough Love', 'bundled'));

      fsMock.dirContents[globalDir] = ['my-personality.json'];
      fsMock.files.set(path.join(globalDir, 'my-personality.json'), personality('Mine', 'user-made'));

      // Workspace `.vllm` copies are no longer discovered as personalities.
      fsMock.dirContents[wsDir] = ['prompt-replacements-spartan.json'];
      fsMock.files.set(path.join(wsDir, 'prompt-replacements-spartan.json'), personality('Spartan', 'legacy'));

      const found = await discoverPersonalities(context);
      expect(found.map(p => p.name).sort()).toEqual(['Mine', 'Tough Love']);
      expect(found.find(p => p.name === 'Tough Love')?.source).toBe('bundled');
      expect(found.find(p => p.name === 'Mine')?.source).toBe('global');
    });

    it('dedupes by name with global winning over bundled', async () => {
      const bundled = path.join(EXT, 'prompt-replacements');
      const globalDir = getGlobalPersonalitiesDir(context);

      fsMock.dirContents[path.join(bundled)] = ['prompt-replacements-tough-love.json'];
      fsMock.files.set(path.join(bundled, 'prompt-replacements-tough-love.json'), personality('Tough Love', 'bundled'));
      fsMock.dirContents[globalDir] = ['prompt-replacements-tough-love.json'];
      fsMock.files.set(path.join(globalDir, 'prompt-replacements-tough-love.json'), personality('Tough Love', 'user-edited'));

      const found = await discoverPersonalities(context);
      expect(found).toHaveLength(1);
      expect(found[0].source).toBe('global');
      expect(found[0].description).toBe('user-edited');
    });

    it('ignores files without a meta block and missing dirs', async () => {
      const globalDir = getGlobalPersonalitiesDir(context);
      fsMock.dirContents[globalDir] = ['legacy-array.json'];
      fsMock.files.set(path.join(globalDir, 'legacy-array.json'), JSON.stringify([{ find: 'a', replace: 'b' }]));

      const found = await discoverPersonalities(context);
      expect(found).toEqual([]);
    });
  });

  describe('ensureGlobalPersonality', () => {
    it('copies a bundled preset into global storage (atomically)', async () => {
      const bundled = path.join(EXT, 'prompt-replacements');
      const src = path.join(bundled, 'prompt-replacements-tough-love.json');
      fsMock.files.set(src, personality('Tough Love', 'bundled'));

      const dest = await ensureGlobalPersonality(context, src);
      const tmp = `${dest}.tmp`;
      expect(dest).toBe(path.join(GLOBAL, 'personalities', 'prompt-replacements-tough-love.json'));
      // Written to a temp file, then renamed over the destination.
      expect(fsMock.writeFile).toHaveBeenCalledWith(tmp, personality('Tough Love', 'bundled'), 'utf-8');
      expect(fsMock.rename).toHaveBeenCalledWith(tmp, dest);
      expect(fsMock.files.get(dest)).toBe(personality('Tough Love', 'bundled'));
      expect(fsMock.files.has(tmp)).toBe(false);
    });

    it('does not clobber an existing global copy', async () => {
      const src = path.join(EXT, 'prompt-replacements', 'x.json');
      fsMock.files.set(src, personality('X', 'bundled'));
      const dest = path.join(GLOBAL, 'personalities', 'x.json');
      fsMock.files.set(dest, personality('X', 'user-edited'));

      await ensureGlobalPersonality(context, src);
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it('throws when the existing global file is a different personality sharing the basename', async () => {
      const src = path.join(EXT, 'prompt-replacements', 'a.json');
      fsMock.files.set(src, personality('Alpha', 'bundled'));
      const dest = path.join(GLOBAL, 'personalities', 'a.json');
      fsMock.files.set(dest, personality('Beta', 'unrelated'));

      await expect(ensureGlobalPersonality(context, src)).rejects.toThrow(/collides/);
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it('is a no-op when the source is already in global storage', async () => {
      const src = path.join(GLOBAL, 'personalities', 'x.json');
      fsMock.files.set(src, personality('X', 'global'));

      const dest = await ensureGlobalPersonality(context, src);
      expect(dest).toBe(src);
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('resolveActivePersonality', () => {
    it('resolves an absolute global-storage path to its personality', async () => {
      const globalDir = getGlobalPersonalitiesDir(context);
      fsMock.dirContents[globalDir] = ['my-personality.json'];
      const file = path.join(globalDir, 'my-personality.json');
      fsMock.files.set(file, personality('Mine', 'user-made'));

      const active = await resolveActivePersonality(context, file);
      expect(active?.name).toBe('Mine');
    });

    it('does not resolve a workspace .vllm path as a personality', async () => {
      // Workspace personalities are removed — a custom `.vllm` replacement file is
      // not a known personality, so it must NOT resolve (no basename fallback).
      const wsDir = path.join(WS, '.vllm');
      fsMock.dirContents[wsDir] = ['prompt-replacements-spartan.json'];
      fsMock.files.set(path.join(wsDir, 'prompt-replacements-spartan.json'), personality('Spartan', 'legacy'));

      const active = await resolveActivePersonality(context, '.vllm/prompt-replacements-spartan.json');
      expect(active).toBeNull();
    });

    it('does not fall back to a same-named personality when the configured file is not discovered', async () => {
      // A model pointing at a file that is not a known personality (e.g. a deleted
      // or custom path) must resolve to null even if a bundled personality shares
      // its basename — exact path matching only.
      const bundled = path.join(EXT, 'prompt-replacements');
      fsMock.dirContents[path.join(bundled)] = ['prompt-replacements-tough-love.json'];
      fsMock.files.set(path.join(bundled, 'prompt-replacements-tough-love.json'), personality('Tough Love', 'bundled'));

      const active = await resolveActivePersonality(context, '.vllm/prompt-replacements-tough-love.json');
      expect(active).toBeNull();
    });

    it('returns null for an empty/clear value', async () => {
      expect(await resolveActivePersonality(context, '')).toBeNull();
      expect(await resolveActivePersonality(context, undefined)).toBeNull();
    });
  });
});
