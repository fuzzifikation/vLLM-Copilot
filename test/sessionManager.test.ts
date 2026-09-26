import * as path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_TABLES_BY_SESSION_ID,
  discoverWorkspaces,
  normalizeCwd,
  readWorkspaceFolders,
  setSessionManagerOutput,
  unhandledSessionKeyedTables,
  userDataRootFromGlobalStorage,
} from '../src/shared/sessionManager.js';

describe('userDataRootFromGlobalStorage', () => {
  it('derives the active user-data root without assuming a VS Code product name', () => {
    const userRoot = path.join('custom-data', 'Code - Insiders', 'User');
    const extensionStorage = path.join(userRoot, 'globalStorage', 'System-Sciences.vllm-copilot');

    expect(userDataRootFromGlobalStorage(extensionStorage)).toBe(path.resolve(userRoot));
  });
});

/**
 * The `workspace.json` folder and the `sessions.cwd` column disagree on
 * separators and case, so both sides are folded before they are joined. If this
 * stops matching, the picker counts and the wipe silently diverge: the user
 * selects a workspace, the summary says "0 agent sessions removed", and real
 * history survives.
 */
describe('normalizeCwd', () => {
  it('folds separators only on Windows and trailing slashes on both platforms', () => {
    const canonical = normalizeCwd('g:/JitterPaper');
    expect(normalizeCwd('g:/JitterPaper/')).toBe(canonical);
    if (process.platform === 'win32') {
      expect(normalizeCwd('g:\\JitterPaper')).toBe(canonical);
      expect(normalizeCwd('g:\\JitterPaper\\')).toBe(canonical);
    } else {
      expect(normalizeCwd('g:\\JitterPaper')).not.toBe(canonical);
      expect(normalizeCwd('g:\\JitterPaper\\')).not.toBe(canonical);
    }
    expect(canonical).toMatch(/^g:\/jitterpaper$/i);
  });

  it('folds case only where the filesystem does', () => {
    // On win32 the two are the same directory and must join. On a
    // case-sensitive filesystem they are DIFFERENT directories, and folding
    // them would make selecting one delete the other's history — the one
    // direction of error this command must never make.
    const upper = 'G:/JitterPaper';
    const lower = 'g:/jitterpaper';
    if (process.platform === 'win32') {
      expect(normalizeCwd(upper)).toBe(normalizeCwd(lower));
    } else {
      expect(normalizeCwd(upper)).not.toBe(normalizeCwd(lower));
    }
  });

  it('joins a decoded workspace.json URI to a stored sessions.cwd', () => {
    if (process.platform === 'win32') {
      // Real pairing from the field: the URI decodes to a Windows path, while
      // SQLite stores the same folder with backslashes.
      expect(normalizeCwd(fileURLToPath('file:///g%3A/JitterPaper'))).toBe(normalizeCwd('g:\\JitterPaper'));
    } else {
      expect(normalizeCwd(fileURLToPath('file:///repo%20name/JitterPaper'))).toBe('/repo name/JitterPaper');
    }
  });

  it('keeps distinct folders distinct', () => {
    expect(normalizeCwd('g:\\vLLM-Copilot')).not.toBe(normalizeCwd('g:\\vLLM-2-Copilot'));
    expect(normalizeCwd('g:\\vLLM-Copilot')).not.toBe(normalizeCwd('g:\\vLLM-Copilot\\sub'));
  });

  it('keeps filesystem roots distinct from empty and drive-relative paths', () => {
    if (process.platform === 'win32') {
      expect(normalizeCwd('g:\\')).toBe('g:/');
      expect(normalizeCwd('g:\\')).not.toBe(normalizeCwd('g:'));
    } else {
      expect(normalizeCwd('/')).toBe('/');
      expect(normalizeCwd('/')).not.toBe(normalizeCwd(''));
    }
  });
});

/**
 * TRIPWIRE, not a coverage metric. The Copilot catalog carries the actual
 * conversation text, and `search_index` is an fts5 virtual table with NO
 * triggers — nothing cascades into it. A table Copilot adds later is a table
 * whose rows survive the wipe while the summary claims the sessions are gone.
 *
 * The previous version of this compared the production list against a second
 * hard-coded list in this file, which cannot fail: an upstream table lands in
 * neither, so the test passed while the delete under-reached. These fixtures
 * instead pin the DETECTOR, which is what production runs against the live
 * schema, so they fail when a session-keyed table would go unnoticed.
 *
 * When this fails: add the new table to `AGENT_TABLES_BY_SESSION_ID` in
 * `src/shared/sessionManager.ts` and confirm it is keyed by `session_id`.
 */
describe('Copilot catalog delete coverage', () => {
  it('flags a session-keyed table the delete list does not know about', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT)');
    db.exec('CREATE TABLE copilot_added_this_release (id TEXT PRIMARY KEY, session_id TEXT)');
    // A decoy with no session_id: flagging it would train the user to ignore
    // the warning, which is the same failure as not warning at all.
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');

    expect(unhandledSessionKeyedTables(db)).toEqual(['copilot_added_this_release']);
    db.close();
  });

  it('does not flag the parent table, which is keyed by id', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)');

    expect(unhandledSessionKeyedTables(db)).toEqual([]);
    db.close();
  });

  it('does not flag fts5 shadow tables, which SQLite maintains itself', () => {
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE VIRTUAL TABLE search_index USING fts5(txt, session_id UNINDEXED)");
    db.exec('CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT)');

    // `search_index_data`, `_idx`, `_content`, `_docsize` and `_config` exist
    // behind the virtual table and are SQLite's business, not the wipe's.
    expect(unhandledSessionKeyedTables(db)).toEqual([]);
    db.close();
  });

  it('keeps search_index in the delete list: nothing cascades into it', () => {
    // search_index holds UNINDEXED copies of the text. If it ever drops out of
    // the list, deleted turns stay greppable by anyone with a copy of the .db,
    // and the runtime detector would start warning about it on every run.
    expect(AGENT_TABLES_BY_SESSION_ID).toContain('search_index');
  });

  it('does not try to delete the parent through the session_id list', () => {
    // `sessions` is keyed by `id`, not `session_id`; listing it here would make
    // the child delete target the wrong column.
    expect(AGENT_TABLES_BY_SESSION_ID).not.toContain('sessions');
  });
});

/**
 * TRIPWIRE for the folder paths that decide WHAT GETS DELETED. Nothing here
 * throws when it breaks: a folder that fails to resolve simply matches no
 * stored `sessions.cwd`, the DELETE finds no rows, and the summary reports a
 * clean workspace while the conversation text is still in the database. Silent
 * under-deletion of user data is the exact failure mode worth a test.
 *
 * The three cases are the ones that actually shipped broken: the hand-rolled
 * `file://` strip ate the leading slash of every POSIX path and the authority of
 * every UNC path, and a saved `.code-workspace` pointer was never followed at
 * all (three such entries sat in a live profile with zero resolvable folders).
 */
describe('readWorkspaceFolders', () => {
  /** Point the module at a throwaway user-data root and return its path. */
  function fakeProfile(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'vllm-copilot-ws-'));
    setSessionManagerOutput({ appendLine: () => {} }, path.join(root, 'globalStorage', 'pub.ext'));
    return root;
  }

  function writeWorkspaceJson(root: string, wsId: string, json: unknown): void {
    const dir = path.join(root, 'workspaceStorage', wsId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(json));
  }

  it('keeps the leading separator of a POSIX folder path', () => {
    // Only observable on POSIX: on Windows `file:///home/me/project` is a
    // root-relative path with no drive, which is not a valid Windows path, so
    // the decoder rightly rejects it and there is no such folder to miss.
    if (process.platform === 'win32') return;

    const root = fakeProfile();
    writeWorkspaceJson(root, 'posix', { folder: 'file:///home/me/project' });

    return readWorkspaceFolders('posix').then(folders => {
      expect(folders).toHaveLength(1);
      // The old decoder produced `home/me/project`, which matches no stored
      // cwd. The separator is what makes it absolute.
      expect(normalizeCwd(folders[0]).startsWith('/')).toBe(true);
      expect(folders[0]).toContain('home/me/project');
    });
  });

  it('resolves a drive-letter folder to the path SQLite stores', () => {
    // The Windows half of the same decoder. This shape already worked, and it
    // is pinned here because the UNC case above depends on drive-and-authority
    // handling staying intact.
    const root = fakeProfile();
    const drive = process.platform === 'win32' ? 'g%3A' : '';
    if (!drive) return;
    writeWorkspaceJson(root, 'drive', { folder: 'file:///g%3A/JitterPaper' });

    return readWorkspaceFolders('drive').then(folders => {
      expect(folders).toHaveLength(1);
      expect(normalizeCwd(folders[0])).toBe(normalizeCwd('g:\\JitterPaper'));
    });
  });

  it('keeps the authority of a UNC folder path', () => {
    const root = fakeProfile();
    writeWorkspaceJson(root, 'unc', { folder: 'file://server/share/project' });

    return readWorkspaceFolders('unc').then(folders => {
      if (process.platform === 'win32') {
        // `//server/share/project`, not the relative-looking `server/share/project`.
        expect(normalizeCwd(folders[0]).startsWith('//')).toBe(true);
      } else {
        // A UNC authority is not a local path on a POSIX filesystem, so there
        // is nothing to reconstruct and the entry contributes no folder.
        expect(folders).toEqual([]);
      }
    });
  });

  it('follows a saved .code-workspace pointer, comments and trailing commas included', () => {
    const root = fakeProfile();
    const wsFileDir = path.join(root, 'saved-workspaces');
    mkdirSync(wsFileDir, { recursive: true });
    const wsFile = path.join(wsFileDir, 'agent-sessions.code-workspace');
    writeFileSync(
      wsFile,
      [
        '{',
        '  // saved by VS Code, and a URL in a string must survive the stripper',
        '  "folders": [',
        '    { "path": "sub", "name": "sub" },',
        '  ],',
        '  /* block comment */',
        '  "settings": { "editor.tabSize": 2 },',
        '}',
      ].join('\n'),
    );
    writeWorkspaceJson(root, 'saved', {
      workspace: `file:///${wsFile.replace(/\\/g, '/').replace(/^\//, '')}`,
    });

    return readWorkspaceFolders('saved').then(folders => {
      expect(folders).toHaveLength(1);
      expect(folders[0]).toBe(path.resolve(wsFileDir, 'sub'));
    });
  });

  it('flags an unresolved root alongside a valid folder in a saved workspace', async () => {
    const root = fakeProfile();
    const wsFileDir = path.join(root, 'saved-workspaces');
    const wsFile = path.join(wsFileDir, 'partial.code-workspace');
    const sessionDir = path.join(root, 'workspaceStorage', 'partial', 'chatSessions');
    mkdirSync(wsFileDir, { recursive: true });
    writeFileSync(wsFile, JSON.stringify({
      folders: [{ path: 'sub' }, { uri: 'vscode-remote://ssh-remote+box/other' }],
    }));
    writeWorkspaceJson(root, 'partial', { workspace: pathToFileURL(wsFile).href });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, 's1.json'), 'local session');
    try {
      const discovery = await discoverWorkspaces();
      expect(discovery.workspaces).toEqual([
        expect.objectContaining({
          id: 'partial',
          folders: [path.resolve(wsFileDir, 'sub')],
          unresolvedFolders: true,
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops a remote workspace, whose catalog rows no local path can match', () => {
    const root = fakeProfile();
    writeWorkspaceJson(root, 'remote', { folder: 'vscode-remote://ssh-remote+box/home/me/project' });

    return readWorkspaceFolders('remote').then(folders => {
      expect(folders).toEqual([]);
    });
  });
});
