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
import * as vscode from 'vscode';
import {
  discoverPersonalities,
  syncBundledPersonalities,
  resolveModelReplacements,
  migratePersonalityPathRefs,
  presetBasenameOf,
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

  it('flags shipped presets with bundled, user files without', async () => {
    // The dropdown's name-vs-path storage split hangs off this flag.
    fsMock.files.set(path.join(BUNDLED, 'prompt-replacements-sarcastic-robot.json'), personality('Sarcastic Robot', 'bundled'));
    fsMock.dirContents[BUNDLED] = ['prompt-replacements-sarcastic-robot.json'];
    fsMock.files.set(path.join(globalDir, 'prompt-replacements-sarcastic-robot.json'), personality('Sarcastic Robot', 'bundled'));
    fsMock.files.set(path.join(globalDir, 'my-thing.json'), personality('My Thing', 'user'));
    fsMock.dirContents[globalDir] = ['prompt-replacements-sarcastic-robot.json', 'my-thing.json'];

    const entries = await discoverPersonalities(context);

    expect(entries.find(e => e.name === 'Sarcastic Robot')?.bundled).toBe(true);
    expect(entries.find(e => e.name === 'My Thing')?.bundled).toBe(false);
  });
});

// ── resolveModelReplacements (the ONE resolver: dropdown label + request path) ──
// The cross-OS bug this fixes: a preset stored as a Windows globalStorage path
// is unreachable on a Linux host — the dropdown degraded to "(user file)" and
// chat silently ran WITHOUT the personality. FILENAME IS THE IDENTITY (owner
// ruling): bundled basenames are extension-owned, so a stored path naming a
// shipped file remaps to this machine's copy instead of dying quietly.

describe('resolveModelReplacements (portable personality resolution)', () => {
  const context = { extensionUri: { fsPath: EXT }, globalStorageUri: { fsPath: GLOBAL } } as any;
  const globalDir = path.join(GLOBAL, 'personalities');
  const robotBundled = path.join(BUNDLED, 'prompt-replacements-sarcastic-robot.json');
  const robotSeeded = path.join(globalDir, 'prompt-replacements-sarcastic-robot.json');

  beforeEach(() => {
    fsMock.files.clear();
    for (const k of Object.keys(fsMock.dirContents)) delete fsMock.dirContents[k];
    vi.clearAllMocks();
    fsMock.files.set(robotBundled, personality('Sarcastic Robot', 'bundled'));
    fsMock.dirContents[BUNDLED] = ['prompt-replacements-sarcastic-robot.json'];
    fsMock.files.set(robotSeeded, personality('Sarcastic Robot', 'bundled'));
  });

  it('a name reference resolves to THIS machine\u2019s seeded copy', async () => {
    const r = await resolveModelReplacements(context, { personality: 'Sarcastic Robot' });
    expect(r).toEqual({ sourcePath: robotSeeded, personality: 'Sarcastic Robot' });
  });

  it('an unknown name does not fabricate a source and logs the fallback', async () => {
    const logs: string[] = [];
    const r = await resolveModelReplacements(context, { personality: 'Ghost Persona' }, (m) => logs.push(m));
    expect(r).toBeNull();
    expect(logs.join('\n')).toContain('does not name a shipped preset');
  });

  it('a Windows-stored shipped path remaps to the local seeded copy', async () => {
    // Exactly the reported shape: settings carried the Windows globalStorage
    // path; on Linux the file is unreachable, the basename names a shipped
    // preset, so THIS machine's copy answers.
    const windowsPath = 'c:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\System-Sciences.vllm-copilot\\personalities\\prompt-replacements-sarcastic-robot.json';
    const logs: string[] = [];
    const r = await resolveModelReplacements(context, { systemMessageReplacementsFile: windowsPath }, (m) => logs.push(m));
    expect(r).toEqual({ sourcePath: robotSeeded, personality: 'Sarcastic Robot' });
    expect(logs.join('\n')).toContain('not reachable from this machine');
  });

  it('an unreachable shipped path OUTSIDE any personalities dir still remaps (filename is identity)', async () => {
    // Owner ruling: bundled basenames are extension-owned (seeding clobbers a
    // user edit to one), so a dead path naming a shipped file names the preset
    // wherever it lived. Only a READABLE file elsewhere stays the user's own.
    const elsewhere = path.join(ROOT, 'backup', 'old-stuff', 'prompt-replacements-sarcastic-robot.json');
    const r = await resolveModelReplacements(context, { systemMessageReplacementsFile: elsewhere });
    expect(r).toEqual({ sourcePath: robotSeeded, personality: 'Sarcastic Robot' });
  });

  it('a readable shipped path inside the local folder reports its name (heal signal), no remap', async () => {
    const r = await resolveModelReplacements(context, { systemMessageReplacementsFile: robotSeeded });
    expect(r).toEqual({ sourcePath: robotSeeded, personality: 'Sarcastic Robot' });
  });

  it('a readable user file outside the folder stays a plain path - never hijacked by basename', async () => {
    const mine = path.join(ROOT, 'workspace', '.vllm', 'prompt-replacements-sarcastic-robot.json');
    fsMock.files.set(mine, personality('My Fork', 'custom'));
    const r = await resolveModelReplacements(context, { systemMessageReplacementsFile: mine });
    expect(r).toEqual({ sourcePath: mine });
  });

  it('an unreachable user file (not a shipped basename) resolves to nothing', async () => {
    const r = await resolveModelReplacements(context, { systemMessageReplacementsFile: path.join(ROOT, 'gone', 'my-personality.json') });
    expect(r).toBeNull();
  });

  it('presetBasenameOf splits on BOTH separators regardless of platform', () => {
    expect(presetBasenameOf('c:\\x\\prompt-replacements-raw.json')).toBe('prompt-replacements-raw.json');
    expect(presetBasenameOf('/x/prompt-replacements-raw.json')).toBe('prompt-replacements-raw.json');
    expect(presetBasenameOf('prompt-replacements-raw.json')).toBe('prompt-replacements-raw.json');
  });
});

// migratePersonalityPathRefs runs ONCE at activation (never from a view refresh
// — that turned every render into a settings write plus a re-entrant config
// refresh). It rewrites a machine-bound shipped-preset PATH into the portable
// NAME, and leaves user files alone.
describe('migratePersonalityPathRefs (activation, path -> portable name)', () => {
  const context = { extensionUri: { fsPath: EXT }, globalStorageUri: { fsPath: GLOBAL } } as any;
  const globalDir = path.join(GLOBAL, 'personalities');
  const robotBundled = path.join(BUNDLED, 'prompt-replacements-sarcastic-robot.json');
  const foreignRobot = 'c:\\Users\\me\\globalStorage\\System-Sciences.vllm-copilot\\personalities\\prompt-replacements-sarcastic-robot.json';

  let models: unknown[] = [];
  let written: unknown = null;

  beforeEach(() => {
    fsMock.files.clear();
    for (const k of Object.keys(fsMock.dirContents)) delete fsMock.dirContents[k];
    vi.clearAllMocks();
    fsMock.files.set(robotBundled, personality('Sarcastic Robot', 'bundled'));
    fsMock.dirContents[BUNDLED] = ['prompt-replacements-sarcastic-robot.json'];
    // Remapping answers from the SEEDED copy — activation guarantees it exists.
    fsMock.files.set(path.join(globalDir, 'prompt-replacements-sarcastic-robot.json'), personality('Sarcastic Robot', 'bundled'));
    models = [];
    written = null;
    (vscode.workspace as any)._mockConfig = {
      get: (key: string) => (key === 'models' ? models : []),
      update: vi.fn(async (_key: string, value: unknown) => { written = value; }),
      inspect: () => ({}),
    };
  });

  it('rewrites a shipped preset stored as a path, and clears the path', async () => {
    models = [{ id: 'm', server: 's', vllmModelId: 'v', systemMessageReplacementsFile: foreignRobot }];

    expect(await migratePersonalityPathRefs(context)).toBe(1);
    expect(written).toEqual([{ id: 'm', server: 's', vllmModelId: 'v', personality: 'Sarcastic Robot' }]);
  });

  it('leaves a user file alone, even an unreachable one whose name is not shipped', async () => {
    models = [{ id: 'm', server: 's', systemMessageReplacementsFile: path.join(ROOT, 'gone', 'my-fork.json') }];

    expect(await migratePersonalityPathRefs(context)).toBe(0);
    expect(written).toBeNull();
  });

  it('is a silent no-op when every entry already stores a name (self-terminating)', async () => {
    models = [{ id: 'm', server: 's', personality: 'Sarcastic Robot' }, { id: 'n', server: 's' }];

    expect(await migratePersonalityPathRefs(context)).toBe(0);
    expect(written).toBeNull();
  });

  it('a readable path inside the local folder migrates too (older builds stored it)', async () => {
    fsMock.files.set(path.join(globalDir, 'prompt-replacements-sarcastic-robot.json'), personality('Sarcastic Robot', 'bundled'));
    models = [{ id: 'm', server: 's', systemMessageReplacementsFile: path.join(globalDir, 'prompt-replacements-sarcastic-robot.json') }];

    expect(await migratePersonalityPathRefs(context)).toBe(1);
    expect((written as Array<{ personality?: string }>)[0].personality).toBe('Sarcastic Robot');
  });
});
