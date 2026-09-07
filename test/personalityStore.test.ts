/**
 * Tests for the global personality folder (personalityStore.ts).
 * Covers the activation seeding (syncBundledPersonalities): missing bundled
 * files are created, stale bundled copies overwritten, user-created files and
 * already-current files untouched. Also pins the duplicate-name warning
 * contract of discoverPersonalities (pickers label by name, so twins must be
 * reported). Active-personality resolution is a production-only path, not
 * pinned here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';
import {
  discoverPersonalities,
  syncBundledPersonalities,
} from '../src/persona/personalityStore.js';

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
const BUNDLED = path.join(EXT, 'prompt-replacements');

function personality(name: string, description: string): string {
  return JSON.stringify({ meta: { name, description }, rules: [] });
}

describe('syncBundledPersonalities (activation seeding)', () => {
  const context = { extensionUri: { fsPath: EXT }, globalStorageUri: { fsPath: GLOBAL } } as any;
  const globalDir = path.join(GLOBAL, 'personalities');

  beforeEach(() => {
    fsMock.files.clear();
    // Mutate in place (vi.mock returns the factory object by reference).
    for (const k of Object.keys(fsMock.dirContents)) delete fsMock.dirContents[k];
    vi.clearAllMocks();
  });

  it('seeds missing bundled files, including the common file, atomically', async () => {
    const robot = personality('Sarcastic Robot', 'bundled');
    const common = personality('Shared Boilerplate Removal', 'shared');
    fsMock.files.set(path.join(BUNDLED, 'prompt-replacements-sarcastic-robot.json'), robot);
    fsMock.files.set(path.join(BUNDLED, 'prompt-replacements-common.json'), common);
    fsMock.dirContents[BUNDLED] = ['prompt-replacements-sarcastic-robot.json', 'prompt-replacements-common.json'];

    const result = await syncBundledPersonalities(context);

    expect(result.updated.sort()).toEqual(['prompt-replacements-common.json', 'prompt-replacements-sarcastic-robot.json']);
    const dest = path.join(globalDir, 'prompt-replacements-sarcastic-robot.json');
    // Written to a temp file, then renamed over the destination.
    expect(fsMock.writeFile).toHaveBeenCalledWith(`${dest}.tmp`, robot, 'utf-8');
    expect(fsMock.rename).toHaveBeenCalledWith(`${dest}.tmp`, dest);
    expect(fsMock.files.get(dest)).toBe(robot);
    expect(fsMock.files.get(path.join(globalDir, 'prompt-replacements-common.json'))).toBe(common);
  });

  it('overwrites a stale global copy of a bundled preset (extension owns bundled basenames)', async () => {
    fsMock.files.set(path.join(BUNDLED, 'x.json'), personality('X', 'v2 bundled'));
    fsMock.dirContents[BUNDLED] = ['x.json'];
    const dest = path.join(globalDir, 'x.json');
    fsMock.files.set(dest, personality('X', 'v1 stale or user-edited'));

    const result = await syncBundledPersonalities(context);

    expect(result).toEqual({ updated: ['x.json'] });
    expect(fsMock.files.get(dest)).toBe(personality('X', 'v2 bundled'));
  });

  it('never touches user-created personalities or already-current files', async () => {
    const spartan = personality('Spartan', 'bundled');
    fsMock.files.set(path.join(BUNDLED, 'prompt-replacements-spartan.json'), spartan);
    fsMock.dirContents[BUNDLED] = ['prompt-replacements-spartan.json'];
    fsMock.files.set(path.join(globalDir, 'prompt-replacements-spartan.json'), spartan); // identical
    const userFile = path.join(globalDir, 'my-thing.json');
    fsMock.files.set(userFile, personality('My Thing', 'user edits, hands off'));

    const result = await syncBundledPersonalities(context);

    expect(result).toEqual({ updated: [] });
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(fsMock.files.get(userFile)).toBe(personality('My Thing', 'user edits, hands off'));
  });

  it('is a silent no-op when the bundled dir is missing (broken VSIX)', async () => {
    fsMock.dirContents[BUNDLED] = [];
    const result = await syncBundledPersonalities(context);
    expect(result).toEqual({ updated: [] });
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });
});

describe('discoverPersonalities (duplicate meta.name)', () => {
  const context = { extensionUri: { fsPath: EXT }, globalStorageUri: { fsPath: GLOBAL } } as any;
  const globalDir = path.join(GLOBAL, 'personalities');

  beforeEach(() => {
    fsMock.files.clear();
    for (const k of Object.keys(fsMock.dirContents)) delete fsMock.dirContents[k];
    vi.clearAllMocks();
  });

  it('warns once per duplicated name, names both files, and lists both entries', async () => {
    // A copied preset keeps its meta.name: the pickers would show two
    // identical labels. Breakage caught here: the warning goes missing, or a
    // dedup "fix" starts hiding the user's file.
    fsMock.files.set(path.join(globalDir, 'prompt-replacements-sarcastic-robot.json'), personality('Sarcastic Robot', 'bundled'));
    fsMock.files.set(path.join(globalDir, 'my-copy.json'), personality('Sarcastic Robot', 'my fork'));
    fsMock.dirContents[globalDir] = ['prompt-replacements-sarcastic-robot.json', 'my-copy.json'];

    const warnings: string[] = [];
    const entries = await discoverPersonalities(context, (m) => warnings.push(m));

    expect(entries.map(e => e.sourcePath)).toEqual([
      path.join(globalDir, 'prompt-replacements-sarcastic-robot.json'),
      path.join(globalDir, 'my-copy.json'),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"Sarcastic Robot"');
    expect(warnings[0]).toContain('prompt-replacements-sarcastic-robot.json');
    expect(warnings[0]).toContain('my-copy.json');
  });

  it('stays silent when every name is unique', async () => {
    fsMock.files.set(path.join(globalDir, 'a.json'), personality('Alpha', 'a'));
    fsMock.files.set(path.join(globalDir, 'b.json'), personality('Beta', 'b'));
    fsMock.dirContents[globalDir] = ['a.json', 'b.json'];

    const warnings: string[] = [];
    await discoverPersonalities(context, (m) => warnings.push(m));

    expect(warnings).toEqual([]);
  });
});
