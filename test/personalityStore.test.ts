/**
 * Tests for the global personality store (personalityStore.ts).
 * Covers discovery (bundled + global, deduped by name),
 * materialization into global storage, and active-personality resolution.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  discoverPersonalities,
  ensureGlobalPersonality,
  resolveActivePersonality,
  getGlobalPersonalitiesDir,
  migrateLegacyPersonalities,
} from '../src/personalityStore.js';

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
    it('sorts bundled presets in the curated order, user presets after', async () => {
      const bundled = path.join(EXT, 'prompt-replacements');
      const globalDir = getGlobalPersonalitiesDir(context);

      // Filesystem order is arbitrary — the curated BUNDLED_PRESET_ORDER must win.
      fsMock.dirContents[path.join(bundled)] = [
        'prompt-replacements-raw.json',
        'prompt-replacements-supportive-mentor.json',
        'prompt-replacements-spartan.json',
        'prompt-replacements-critical-senior.json',
        'prompt-replacements-sarcastic-robot.json',
      ];
      fsMock.files.set(path.join(bundled, 'prompt-replacements-raw.json'), personality('Raw (Model Natural)', 'bundled'));
      fsMock.files.set(path.join(bundled, 'prompt-replacements-supportive-mentor.json'), personality('Supportive Mentor', 'bundled'));
      fsMock.files.set(path.join(bundled, 'prompt-replacements-spartan.json'), personality('Spartan', 'bundled'));
      fsMock.files.set(path.join(bundled, 'prompt-replacements-critical-senior.json'), personality('Critical Senior Dev', 'bundled'));
      fsMock.files.set(path.join(bundled, 'prompt-replacements-sarcastic-robot.json'), personality('Sarcastic Robot', 'bundled'));

      fsMock.dirContents[globalDir] = ['zeta.json', 'alpha.json'];
      fsMock.files.set(path.join(globalDir, 'zeta.json'), personality('Zeta', 'user-made'));
      fsMock.files.set(path.join(globalDir, 'alpha.json'), personality('Alpha', 'user-made'));

      const found = await discoverPersonalities(context);
      expect(found.map(p => p.name)).toEqual([
        'Critical Senior Dev',
        'Sarcastic Robot',
        'Supportive Mentor',
        'Spartan',
        'Raw (Model Natural)',
        'Alpha',
        'Zeta',
      ]);
    });

    it('merges bundled and global personalities', async () => {
      const bundled = path.join(EXT, 'prompt-replacements');
      const globalDir = getGlobalPersonalitiesDir(context);
      const wsDir = path.join(WS, '.vllm');

      fsMock.dirContents[path.join(bundled)] = ['prompt-replacements-supportive-mentor.json'];
      fsMock.files.set(path.join(bundled, 'prompt-replacements-supportive-mentor.json'), personality('Supportive Mentor', 'bundled'));

      fsMock.dirContents[globalDir] = ['my-personality.json'];
      fsMock.files.set(path.join(globalDir, 'my-personality.json'), personality('Mine', 'user-made'));

      // Workspace `.vllm` copies are no longer discovered as personalities.
      fsMock.dirContents[wsDir] = ['prompt-replacements-spartan.json'];
      fsMock.files.set(path.join(wsDir, 'prompt-replacements-spartan.json'), personality('Spartan', 'legacy'));

      const found = await discoverPersonalities(context);
      expect(found.map(p => p.name).sort()).toEqual(['Mine', 'Supportive Mentor']);
      expect(found.find(p => p.name === 'Supportive Mentor')?.source).toBe('bundled');
      expect(found.find(p => p.name === 'Mine')?.source).toBe('global');
    });

    it('dedupes by name with global winning over bundled', async () => {
      const bundled = path.join(EXT, 'prompt-replacements');
      const globalDir = getGlobalPersonalitiesDir(context);

      fsMock.dirContents[path.join(bundled)] = ['prompt-replacements-supportive-mentor.json'];
      fsMock.files.set(path.join(bundled, 'prompt-replacements-supportive-mentor.json'), personality('Supportive Mentor', 'bundled'));
      fsMock.dirContents[globalDir] = ['prompt-replacements-supportive-mentor.json'];
      fsMock.files.set(path.join(globalDir, 'prompt-replacements-supportive-mentor.json'), personality('Supportive Mentor', 'user-edited'));

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
      fsMock.dirContents[path.join(bundled)] = ['prompt-replacements-supportive-mentor.json'];
      fsMock.files.set(path.join(bundled, 'prompt-replacements-supportive-mentor.json'), personality('Supportive Mentor', 'bundled'));

      const active = await resolveActivePersonality(context, '.vllm/prompt-replacements-supportive-mentor.json');
      expect(active).toBeNull();
    });

    it('returns null for an empty/clear value', async () => {
      expect(await resolveActivePersonality(context, '')).toBeNull();
      expect(await resolveActivePersonality(context, undefined)).toBeNull();
    });
  });

  describe('migrateLegacyPersonalities', () => {
    afterEach(() => {
      (vscode.workspace as any)._mockConfig = {};
    });

    it('is a no-op when no legacy global copy exists', async () => {
      const result = await migrateLegacyPersonalities(context);
      expect(result).toEqual({ migrated: false, configsUpdated: 0 });
      expect(fsMock.files.size).toBe(0);
    });

    it('does not delete a legacy-array user file at the legacy path', async () => {
      const bundled = path.join(EXT, 'prompt-replacements');
      const bundledFile = path.join(bundled, 'prompt-replacements-supportive-mentor.json');
      fsMock.files.set(bundledFile, personality('Supportive Mentor', 'bundled'));

      const globalDir = getGlobalPersonalitiesDir(context);
      const legacyFile = path.join(globalDir, 'prompt-replacements-tough-love.json');
      const userLegacyArray = JSON.stringify([{ find: 'a', replace: 'b' }]);
      fsMock.files.set(legacyFile, userLegacyArray);

      const result = await migrateLegacyPersonalities(context);
      expect(result).toEqual({ migrated: false, configsUpdated: 0 });
      // User data preserved — no new file, no deletion, no config rewrite.
      expect(fsMock.files.get(legacyFile)).toBe(userLegacyArray);
      expect(fsMock.files.has(path.join(globalDir, 'prompt-replacements-supportive-mentor.json'))).toBe(false);
    });

    it('does not delete a differently-named personality at the legacy path', async () => {
      const bundled = path.join(EXT, 'prompt-replacements');
      const bundledFile = path.join(bundled, 'prompt-replacements-supportive-mentor.json');
      fsMock.files.set(bundledFile, personality('Supportive Mentor', 'bundled'));

      const globalDir = getGlobalPersonalitiesDir(context);
      const legacyFile = path.join(globalDir, 'prompt-replacements-tough-love.json');
      fsMock.files.set(legacyFile, personality('My Custom Thing', 'user-made'));

      const result = await migrateLegacyPersonalities(context);
      expect(result).toEqual({ migrated: false, configsUpdated: 0 });
      expect(fsMock.files.has(legacyFile)).toBe(true);
      expect(fsMock.files.has(path.join(globalDir, 'prompt-replacements-supportive-mentor.json'))).toBe(false);
    });

    it('replaces a stale global Tough Love copy and rewrites model configs', async () => {
      const bundled = path.join(EXT, 'prompt-replacements');
      const bundledFile = path.join(bundled, 'prompt-replacements-supportive-mentor.json');
      fsMock.files.set(bundledFile, personality('Supportive Mentor', 'bundled'));

      const globalDir = getGlobalPersonalitiesDir(context);
      const legacyFile = path.join(globalDir, 'prompt-replacements-tough-love.json');
      fsMock.files.set(legacyFile, personality('Tough Love', 'user-edited'));

      const models: any[] = [{
        id: 'm1',
        serverUrl: 'http://localhost:8000',
        systemMessageReplacementsFile: legacyFile,
      }];
      const updateSpy = vi.fn().mockResolvedValue(undefined);
      (vscode.workspace as any)._mockConfig = {
        get: (key: string) => (key === 'models' ? models : undefined),
        update: updateSpy,
        inspect: () => undefined,
      };

      const result = await migrateLegacyPersonalities(context);

      expect(result).toEqual({ migrated: true, configsUpdated: 1 });
      // Legacy file removed; new file materialized from the bundled content.
      expect(fsMock.files.has(legacyFile)).toBe(false);
      const newFile = path.join(globalDir, 'prompt-replacements-supportive-mentor.json');
      expect(fsMock.files.get(newFile)).toBe(personality('Supportive Mentor', 'bundled'));
      // Model config rewritten to the new path.
      expect(models[0].systemMessageReplacementsFile).toBe(newFile);
      expect(updateSpy).toHaveBeenCalledWith('models', models, vscode.ConfigurationTarget.Global);
    });

    it('migrates the file but leaves unrelated model configs untouched', async () => {
      const bundled = path.join(EXT, 'prompt-replacements');
      const bundledFile = path.join(bundled, 'prompt-replacements-supportive-mentor.json');
      fsMock.files.set(bundledFile, personality('Supportive Mentor', 'bundled'));

      const globalDir = getGlobalPersonalitiesDir(context);
      const legacyFile = path.join(globalDir, 'prompt-replacements-tough-love.json');
      fsMock.files.set(legacyFile, personality('Tough Love', 'user-edited'));

      const custom = path.join(WS, '.vllm', 'custom.json');
      const models: any[] = [
        { id: 'm1', serverUrl: 'http://localhost:8000', systemMessageReplacementsFile: custom },
        { id: 'm2', serverUrl: 'http://localhost:8001' },
      ];
      const updateSpy = vi.fn().mockResolvedValue(undefined);
      (vscode.workspace as any)._mockConfig = {
        get: (key: string) => (key === 'models' ? models : undefined),
        update: updateSpy,
        inspect: () => undefined,
      };

      const result = await migrateLegacyPersonalities(context);

      expect(result).toEqual({ migrated: true, configsUpdated: 0 });
      expect(fsMock.files.has(legacyFile)).toBe(false);
      expect(fsMock.files.has(path.join(globalDir, 'prompt-replacements-supportive-mentor.json'))).toBe(true);
      // No model pointed at the legacy path → no config rewrite.
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });
});
