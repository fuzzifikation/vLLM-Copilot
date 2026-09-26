/**
 * TRIPWIRE suite for the Clean Copilot Sessions command and the storage it
 * acts on: the repo/global memory path collision, catalog transaction
 * integrity, FTS5 tombstones, WAL compaction, and honest reporting. The
 * dual-license staging invariants live in test/packageStaging.test.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { registerCleanSessionsCommand } from '../src/commands/commands.js';
import { AGENT_TABLES_BY_SESSION_ID, clean, discoverWorkspaces, maintainAgentStore, normalizeCwd, setSessionManagerOutput } from '../src/shared/sessionManager.js';

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, access: vi.fn(actual.access), readdir: vi.fn(actual.readdir), rm: vi.fn(actual.rm) };
});

/**
 * TRIPWIRE for the worst bug in this command's history: repo memory and global
 * user memory resolving to the SAME directory.
 *
 * The global store's repo-memory path is `GitHub.copilot-chat/...` and the
 * global USER-memory path is `github.copilot-chat/...`. They differ only in
 * case, so on Windows and macOS they are one directory. A global entry reaching
 * the repo-memory list therefore deleted user memory while the summary reported
 * it as kept. Selecting "All global sessions" plus "Repo memory" is enough to
 * trigger it, so the guard is asserted here at the manager, where the id is
 * dropped, not only at the command, where it is filtered.
 */
describe('repo memory can never reach global user memory', () => {
  it('ignores a global id in the repo-memory list and keeps user memory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-memguard-'));
    const userMemory = join(root, 'globalStorage', 'github.copilot-chat', 'memory-tool', 'memories');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    // Write through the GLOBAL_ID repo-memory path, which is the one that
    // collides. The file must survive, because user memory was not requested.
    const { existsSync } = await import('node:fs');
    mkdirSync(userMemory, { recursive: true });
    const note = join(userMemory, 'note.md');
    writeFileSync(note, 'copilot wrote this');
    try {
      const outcome = await clean({
        global: true,
        all: false,
        // The global id, exactly as an unguarded caller would pass it.
        workspaces: [{ id: '__global__', folders: [] }],
        repoMemory: true,
        userMemory: false,
      });
      expect(outcome.repoMemoryRemoved).toBe(false);
      expect(existsSync(note), 'global user memory was deleted by a repo-memory request').toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports repo memory as NOT removed rather than claiming success', async () => {
    // Nothing was asked to be deleted, so the honest outcome is false, and the
    // summary renders that as "NOT deleted" rather than "DELETED".
    const root = mkdtempSync(join(tmpdir(), 'vllm-memguard-'));
    try {
      setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
      const outcome = await clean({ global: false, all: false, workspaces: [], repoMemory: true, userMemory: false });
      expect(outcome.repoMemoryRemoved).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('memory stays selectable after session history is cleared', () => {
  it('offers global user memory when no sessions or catalog remain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-memory-only-user-'));
    const memoryDir = join(root, 'globalStorage', 'github.copilot-chat', 'memory-tool', 'memories');
    const note = join(memoryDir, 'note.md');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(note, 'global preference');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    (vscode.commands as any)._registrations = [];
    const picker = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([
      { id: '__user_memory__', label: 'Global user memory' },
    ] as any);
    const confirmation = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(picker.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({ id: '__user_memory__' })]));
      expect(picker.mock.calls[0][0]).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: '__all__' })]));
      expect(confirmation.mock.calls[0][0]).toContain('Copilot GLOBAL user memory');
      expect(existsSync(note)).toBe(false);
    } finally {
      disposable.dispose();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('offers repo memory for a workspace with no session residue', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-memory-only-repo-'));
    const workspaceDir = join(root, 'workspaceStorage', 'selected');
    const memoryDir = join(workspaceDir, 'GitHub.copilot-chat', 'memory-tool', 'memories');
    const note = join(memoryDir, 'repo', 'note.md');
    mkdirSync(join(memoryDir, 'repo'), { recursive: true });
    writeFileSync(join(workspaceDir, 'workspace.json'), '{"folder":"file:///g%3A/project"}');
    writeFileSync(note, 'repo note');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    (vscode.commands as any)._registrations = [];
    const picker = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([
      { id: 'selected', label: 'selected' },
      { id: '__repo_memory__', label: 'Repo memory' },
    ] as any);
    const confirmation = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(picker.mock.calls[0][0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'selected' }),
        expect.objectContaining({ id: '__repo_memory__' }),
      ]));
      expect(picker.mock.calls[0][0]).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: '__all__' })]));
      expect(confirmation.mock.calls[0][0]).toContain('Copilot repo memory for 1 workspace(s)');
      expect(confirmation.mock.calls[0][0]).not.toContain('Session history for 1 workspace(s)');
      expect(existsSync(note)).toBe(false);
    } finally {
      disposable.dispose();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not block session cleanup when unselected global memory is inaccessible', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-memory-scan-denied-'));
    const indexPath = join(root, 'globalStorage', 'state.vscdb');
    const memoryDir = join(root, 'globalStorage', 'github.copilot-chat', 'memory-tool', 'memories');
    const note = join(memoryDir, 'note.md');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(note, 'keep global memory');
    const db = new DatabaseSync(indexPath);
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('chat.ChatSessionStore.index', '{"entries":{"s1":{}}}');
    db.close();
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    const actualAccess = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).access;
    const access = vi.mocked(fsPromises.access).mockImplementation(async (...args) => {
      if (String(args[0]) === memoryDir) throw Object.assign(new Error('memory directory access denied'), { code: 'EACCES' });
      return actualAccess(...args);
    });
    (vscode.commands as any)._registrations = [];
    const picker = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([
      { id: '__global__', label: 'All global sessions' },
    ] as any);
    const errors = vi.spyOn(vscode.window, 'showErrorMessage');
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
    const summary = vi.spyOn(vscode.window, 'showInformationMessage');
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(picker).toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      expect(summary.mock.calls[0][0]).toContain('Removed 1 session index key(s)');
      expect(readFileSync(note, 'utf8')).toBe('keep global memory');
      const remaining = new DatabaseSync(indexPath, { readOnly: true });
      try {
        expect(remaining.prepare('SELECT value FROM ItemTable WHERE key = ?').get('chat.ChatSessionStore.index')).toBeUndefined();
      } finally {
        remaining.close();
      }
    } finally {
      disposable.dispose();
      access.mockImplementation(actualAccess);
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports removed, failed, and already-absent global memory accurately', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-memory-status-'));
    const catalogDir = join(root, 'globalStorage', 'github.copilot-chat');
    const dbPath = join(catalogDir, 'session-store.db');
    const memoryDir = join(catalogDir, 'memory-tool', 'memories');
    const note = join(memoryDir, 'note.md');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(note, 'user preference');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)');
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run('s1', 'g:/project');
    db.close();
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    const actualAccess = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).access;
    let failOnConfirm = false;
    let denyMemory = false;
    const access = vi.mocked(fsPromises.access).mockImplementation(async (...args) => {
      if (denyMemory && String(args[0]) === memoryDir) throw Object.assign(new Error('memory denied'), { code: 'EACCES' });
      return actualAccess(...args);
    });
    (vscode.commands as any)._registrations = [];
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([{ id: '__user_memory__', label: 'Global user memory' }] as any);
    vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(async () => {
      denyMemory = failOnConfirm;
      return 'Delete' as any;
    });
    const summary = vi.spyOn(vscode.window, 'showInformationMessage');
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(existsSync(note)).toBe(false);
      expect(summary.mock.calls[0][0]).toContain('Removed global user memory');
      expect(summary.mock.calls[0][0]).not.toContain('Nothing was found to delete');

      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(note, 'user preference');
      failOnConfirm = true;
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(existsSync(note)).toBe(true);
      expect(summary.mock.calls[1][0]).toContain('Global user memory: NOT deleted');
      expect(summary.mock.calls[1][0]).not.toContain('the storage has already been cleaned');

      denyMemory = false;
      failOnConfirm = false;
      rmSync(memoryDir, { recursive: true, force: true });
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(summary.mock.calls[2][0]).toContain('Global user memory: already absent');
      expect(summary.mock.calls[2][0]).not.toContain('Global user memory: DELETED');
      const remaining = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(remaining.prepare('SELECT id FROM sessions WHERE id = ?').get('s1')).toBeDefined();
      } finally {
        remaining.close();
      }
    } finally {
      disposable.dispose();
      access.mockImplementation(actualAccess);
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['repo', 'user'] as const)('reports incomplete %s memory when removal fails after deleting a note', async kind => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-memory-remove-interrupted-'));
    const workspaceDir = join(root, 'workspaceStorage', 'selected');
    const memoryDir = kind === 'repo'
      ? join(workspaceDir, 'GitHub.copilot-chat', 'memory-tool', 'memories')
      : join(root, 'globalStorage', 'github.copilot-chat', 'memory-tool', 'memories');
    const note = join(memoryDir, 'note.md');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(note, 'some memory');
    if (kind === 'repo') writeFileSync(join(workspaceDir, 'workspace.json'), '{"folder":"file:///g%3A/project"}');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    const actualRm = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).rm;
    const rm = vi.mocked(fsPromises.rm).mockImplementation(async (...args) => {
      if (String(args[0]) === memoryDir) {
        rmSync(note);
        throw Object.assign(new Error('removal interrupted'), { code: 'EACCES' });
      }
      return actualRm(...args);
    });
    (vscode.commands as any)._registrations = [];
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(kind === 'repo'
      ? [{ id: 'selected', label: 'selected' }, { id: '__repo_memory__', label: 'Repo memory' }] as any
      : [{ id: '__user_memory__', label: 'Global user memory' }] as any);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
    const summary = vi.spyOn(vscode.window, 'showInformationMessage');
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(rm).toHaveBeenCalledWith(memoryDir, { recursive: true, force: true });
      expect(existsSync(note)).toBe(false);
      expect(existsSync(memoryDir)).toBe(true);
      expect(summary.mock.calls[0][0]).toContain('No complete removals confirmed.');
      expect(summary.mock.calls[0][0]).toContain(
        `${kind === 'repo' ? 'Repo memory' : 'Global user memory'}: INCOMPLETE - removal failed; some notes may have been removed`,
      );
      expect(summary.mock.calls[0][0]).not.toContain('NOT deleted');
    } finally {
      disposable.dispose();
      rm.mockImplementation(actualRm);
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports repo memory as partial when one selected workspace cannot be cleared', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-memory-partial-'));
    const first = join(root, 'workspaceStorage', 'first');
    const second = join(root, 'workspaceStorage', 'second');
    const firstMemory = join(first, 'GitHub.copilot-chat', 'memory-tool', 'memories');
    const secondMemory = join(second, 'GitHub.copilot-chat', 'memory-tool', 'memories');
    mkdirSync(firstMemory, { recursive: true });
    mkdirSync(secondMemory, { recursive: true });
    writeFileSync(join(first, 'workspace.json'), '{"folder":"file:///g%3A/first"}');
    writeFileSync(join(second, 'workspace.json'), '{"folder":"file:///g%3A/second"}');
    writeFileSync(join(firstMemory, 'note.md'), 'first repo note');
    writeFileSync(join(secondMemory, 'note.md'), 'second repo note');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    const actualAccess = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).access;
    let denySecond = false;
    const access = vi.mocked(fsPromises.access).mockImplementation(async (...args) => {
      if (denySecond && String(args[0]) === secondMemory) throw Object.assign(new Error('repo memory denied'), { code: 'EACCES' });
      return actualAccess(...args);
    });
    (vscode.commands as any)._registrations = [];
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([
      { id: 'first', label: 'first' }, { id: 'second', label: 'second' },
      { id: '__repo_memory__', label: 'Repo memory' },
    ] as any);
    vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(async () => {
      denySecond = true;
      return 'Delete' as any;
    });
    const summary = vi.spyOn(vscode.window, 'showInformationMessage');
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(existsSync(join(firstMemory, 'note.md'))).toBe(false);
      expect(existsSync(join(secondMemory, 'note.md'))).toBe(true);
      expect(summary.mock.calls[0][0]).toContain('Repo memory: PARTIALLY deleted');
      expect(summary.mock.calls[0][0]).not.toContain('Nothing removed');
    } finally {
      disposable.dispose();
      access.mockImplementation(actualAccess);
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * TRIPWIRE for the FTS5 tombstones, and for the VACUUM claim they undermine.
 *
 * Deleting a row from an fts5 table does NOT remove its postings: the index
 * keeps them until the segments are merged or the index is rebuilt, and VACUUM
 * copies those live pages verbatim. Measured before the fix: after the row
 * delete, VACUUM and a truncating WAL checkpoint, the deleted conversation's
 * indexed term was still present in the main database file while the table
 * correctly returned zero rows for it. `compacted: true` was true and the text
 * was still there, which is the one thing this command must never report.
 */
describe('the catalog wipe leaves no recoverable text behind', () => {
  /** A catalog shaped like the shipped one: all delete targets, plus fts5. */
  function makeCatalog(dbPath: string, secret: string): void {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)');
    db.exec('CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT, body TEXT)');
    db.exec('CREATE TABLE session_files (id TEXT PRIMARY KEY, session_id TEXT)');
    db.exec('CREATE TABLE session_refs (id TEXT PRIMARY KEY, session_id TEXT)');
    db.exec('CREATE TABLE checkpoints (id TEXT PRIMARY KEY, session_id TEXT)');
    db.exec('CREATE VIRTUAL TABLE search_index USING fts5(txt, session_id UNINDEXED)');
    db.exec("INSERT INTO sessions VALUES ('s1', 'g:/project')");
    db.exec(`INSERT INTO turns VALUES ('t1', 's1', '${secret}')`);
    db.exec(`INSERT INTO search_index(txt, session_id) VALUES('the secret word is ${secret} here', 's1')`);
    // Filler, so the index has real segments rather than a single tiny one.
    for (let i = 0; i < 300; i++) {
      db.exec(`INSERT INTO search_index(txt, session_id) VALUES('filler row ${i} about widgets', 'keep')`);
    }
    db.close();
  }

  function makeOrphanCatalog(dbPath: string, orphanText: string, withLiveSession: boolean): void {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)');
    db.exec('CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), body TEXT)');
    db.exec('CREATE TABLE session_files (id TEXT PRIMARY KEY, session_id TEXT)');
    db.exec('CREATE TABLE session_refs (id TEXT PRIMARY KEY, session_id TEXT)');
    db.exec('CREATE TABLE checkpoints (id TEXT PRIMARY KEY, session_id TEXT)');
    db.exec('CREATE VIRTUAL TABLE search_index USING fts5(txt, session_id UNINDEXED)');
    if (withLiveSession) {
      db.prepare('INSERT INTO sessions VALUES (?, ?)').run('live', process.platform === 'win32' ? 'g:/project' : '/g:/project');
      db.prepare('INSERT INTO turns VALUES (?, ?, ?)').run('t_live', 'live', 'current conversation');
      db.prepare('INSERT INTO search_index(txt, session_id) VALUES (?, ?)').run('current conversation', 'live');
    }
    db.prepare('INSERT INTO turns VALUES (?, ?, ?)').run('t_old', 'deleted', orphanText);
    db.prepare('INSERT INTO search_index(txt, session_id) VALUES (?, ?)').run(orphanText, 'deleted');
    db.close();
  }

  it('removes the indexed terms of deleted conversations, not just the rows', async () => {
    const SECRET = 'zzqxunmqrk';
    const root = mkdtempSync(join(tmpdir(), 'vllm-ftsguard-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    const { existsSync } = await import('node:fs');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    makeCatalog(dbPath, SECRET);
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    try {
      const outcome = await clean({ global: false, all: true, workspaces: [] });

      expect(outcome.agentStoreError).toBe(false);
      expect(outcome.removedAgentSessions).toBe(1);
      // The claim under test: a successful wipe means the bytes are gone.
      expect(outcome.compacted).toBe(true);
      expect(outcome.unhandledTables).toEqual([]);

      const main = readFileSync(dbPath);
      expect(main.includes(SECRET), 'the deleted turn body survived in the main database file').toBe(false);
      const walPath = `${dbPath}-wal`;
      if (existsSync(walPath)) {
        expect(readFileSync(walPath).includes(SECRET), 'the deleted text survived in the -wal sidecar').toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns when scoped cleanup leaves orphaned catalog text with unknown workspace ownership', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-scoped-orphan-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    const workspaceDir = join(root, 'workspaceStorage', 'selected');
    const orphanText = 'zzqxpreviouslyorphaned';
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, 'workspace.json'), '{"folder":"file:///g%3A/project"}');
    makeOrphanCatalog(dbPath, orphanText, true);
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    (vscode.commands as any)._registrations = [];
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([{ id: 'selected', label: 'selected' }] as any);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
    const summary = vi.spyOn(vscode.window, 'showInformationMessage');
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      const remaining = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(remaining.prepare('SELECT id FROM sessions').all()).toEqual([]);
        expect(remaining.prepare('SELECT body FROM turns WHERE session_id = ?').get('deleted')).toBeDefined();
        expect(remaining.prepare('SELECT txt FROM search_index WHERE search_index MATCH ?').get(orphanText)).toBeDefined();
      } finally {
        remaining.close();
      }
      expect(readFileSync(dbPath).includes(orphanText)).toBe(true);
      expect(summary.mock.calls[0][0]).toContain('Removed 1 conversation(s)');
      expect(summary.mock.calls[0][0]).toContain('INCOMPLETE: 2 orphaned catalog row(s)');
      expect(summary.mock.calls[0][0]).toContain('EVERY conversation on this machine');
    } finally {
      disposable.dispose();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('offers a confirmed whole-catalog wipe for orphan-only text that maintenance cannot remove', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-orphan-only-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    const orphanText = 'zzqxlastorphan';
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    makeOrphanCatalog(dbPath, orphanText, false);
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    (vscode.commands as any)._registrations = [];
    const picker = vi.spyOn(vscode.window, 'showQuickPick')
      .mockResolvedValueOnce([{ id: '__catalog_maintenance__', label: 'Maintain Copilot catalog' }] as any)
      .mockResolvedValueOnce([{ id: '__all__', label: 'EVERY conversation' }] as any);
    const confirmation = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
    const summary = vi.spyOn(vscode.window, 'showInformationMessage');
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(picker.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({ id: '__all__' })]));
      expect(summary.mock.calls[0][0]).toContain('Catalog maintenance completed');
      const afterMaintenance = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(afterMaintenance.prepare('SELECT txt FROM search_index WHERE search_index MATCH ?').get(orphanText)).toBeDefined();
      } finally {
        afterMaintenance.close();
      }

      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(confirmation.mock.calls[0][0]).toContain('EVERY Copilot conversation on this machine');
      expect(confirmation.mock.calls[0][0]).toContain('2 orphaned catalog row(s)');
      expect(summary.mock.calls[1][0]).toContain('Removed 2 orphaned catalog row(s)');
      expect(summary.mock.calls[1][0]).not.toContain('Nothing was found to delete');
      const afterWipe = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(afterWipe.prepare('SELECT body FROM turns').all()).toEqual([]);
        expect(afterWipe.prepare('SELECT txt FROM search_index WHERE search_index MATCH ?').get(orphanText)).toBeUndefined();
      } finally {
        afterWipe.close();
      }
      expect(readFileSync(dbPath).includes(orphanText)).toBe(false);
      if (existsSync(`${dbPath}-wal`)) expect(readFileSync(`${dbPath}-wal`).includes(orphanText)).toBe(false);
    } finally {
      disposable.dispose();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps catalog and workspace data when a selected session has an unknown child table', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-unknown-session-table-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    const transcript = join(root, 'workspaceStorage', 'selected', 'chatSessions', 's1.json');
    const repoNote = join(root, 'workspaceStorage', 'selected', 'GitHub.copilot-chat', 'memory-tool', 'memories', 'repo.md');
    const userNote = join(root, 'globalStorage', 'github.copilot-chat', 'memory-tool', 'memories', 'user.md');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    mkdirSync(join(root, 'workspaceStorage', 'selected', 'chatSessions'), { recursive: true });
    mkdirSync(join(root, 'workspaceStorage', 'selected', 'GitHub.copilot-chat', 'memory-tool', 'memories'), { recursive: true });
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat', 'memory-tool', 'memories'), { recursive: true });
    writeFileSync(transcript, 'local session text');
    writeFileSync(repoNote, 'repo memory');
    writeFileSync(userNote, 'user memory');
    makeCatalog(dbPath, 'secret-session-text');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE extra_notes (session_id TEXT, body TEXT)');
    db.prepare('INSERT INTO extra_notes VALUES (?, ?)').run('s1', 'unknown session text');
    db.close();
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    try {
      const outcome = await clean({ global: false, all: false, workspaces: [{ id: 'selected', folders: ['g:/project'] }] });
      expect(outcome.unhandledTables).toEqual(['extra_notes']);
      expect(outcome.agentStoreError).toBe(true);
      expect(outcome.removedAgentSessions).toBe(0);
      expect(outcome.removedDirs).toBe(0);
      expect(readFileSync(transcript, 'utf8')).toBe('local session text');

      const remaining = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(remaining.prepare('SELECT id FROM sessions WHERE id = ?').get('s1')).toBeDefined();
        expect(remaining.prepare('SELECT body FROM extra_notes WHERE session_id = ?').get('s1')).toBeDefined();
      } finally {
        remaining.close();
      }

      (vscode.commands as any)._registrations = [];
      vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([
        { label: 'EVERY conversation', id: '__all__' },
        { label: 'Repo memory', id: '__repo_memory__' },
        { label: 'Global user memory', id: '__user_memory__' },
      ] as any);
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
      const summary = vi.spyOn(vscode.window, 'showInformationMessage');
      const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
      try {
        await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
        expect(summary.mock.calls[0][0]).toContain('BLOCKED: unknown session-keyed catalog table(s) hold selected data: extra_notes');
        expect(summary.mock.calls[0][0]).toContain('No selected catalog rows, workspace session files or memory were removed');
        expect(summary.mock.calls[0][0]).toContain('Repo memory: NOT attempted - catalog deletion failed');
        expect(summary.mock.calls[0][0]).toContain('Global user memory: NOT attempted - catalog deletion failed');
        expect(readFileSync(transcript, 'utf8')).toBe('local session text');
        expect(readFileSync(repoNote, 'utf8')).toBe('repo memory');
        expect(readFileSync(userNote, 'utf8')).toBe('user memory');
      } finally {
        disposable.dispose();
        vi.restoreAllMocks();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks cleanup when an unknown table uses a generated mixed-case session id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-generated-session-table-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    const transcript = join(root, 'workspaceStorage', 'selected', 'chatSessions', 's1.json');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    mkdirSync(join(root, 'workspaceStorage', 'selected', 'chatSessions'), { recursive: true });
    writeFileSync(transcript, 'local session text');
    makeCatalog(dbPath, 'secret-session-text');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE extra_notes (source_id TEXT, "Session_ID" TEXT GENERATED ALWAYS AS (source_id) STORED, body TEXT)');
    db.prepare('INSERT INTO extra_notes (source_id, body) VALUES (?, ?)').run('s1', 'unknown session text');
    db.close();
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    try {
      const outcome = await clean({ global: false, all: false, workspaces: [{ id: 'selected', folders: ['g:/project'] }] });
      expect(outcome.unhandledTables).toEqual(['extra_notes']);
      expect(outcome.agentStoreError).toBe(true);
      expect(outcome.removedAgentSessions).toBe(0);
      expect(readFileSync(transcript, 'utf8')).toBe('local session text');
      const remaining = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(remaining.prepare('SELECT id FROM sessions WHERE id = ?').get('s1')).toBeDefined();
        expect((remaining.prepare('SELECT body FROM extra_notes WHERE "Session_ID" = ?').get('s1') as { body: string }).body)
          .toBe('unknown session text');
      } finally {
        remaining.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves catalog and workspace data when catalog access is denied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-catalog-access-denied-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    const transcript = join(root, 'workspaceStorage', 'selected', 'chatSessions', 's1.json');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    mkdirSync(join(root, 'workspaceStorage', 'selected', 'chatSessions'), { recursive: true });
    writeFileSync(transcript, 'local session text');
    makeCatalog(dbPath, 'secret-session-text');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    const actualAccess = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).access;
    const access = vi.mocked(fsPromises.access).mockImplementation(async (...args) => {
      if (String(args[0]) === dbPath) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      return actualAccess(...args);
    });
    try {
      const outcome = await clean({ global: false, all: false, workspaces: [{ id: 'selected', folders: ['g:/project'] }] });
      expect(access).toHaveBeenCalledWith(dbPath);
      expect(outcome.agentStoreError).toBe(true);
      expect(outcome.removedAgentSessions).toBe(0);
      expect(outcome.removedDirs).toBe(0);
      expect(readFileSync(transcript, 'utf8')).toBe('local session text');

      const remaining = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(remaining.prepare('SELECT id FROM sessions WHERE id = ?').get('s1')).toBeDefined();
      } finally {
        remaining.close();
      }

      (vscode.commands as any)._registrations = [];
      const picker = vi.spyOn(vscode.window, 'showQuickPick');
      const errors = vi.spyOn(vscode.window, 'showErrorMessage');
      const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
      try {
        await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
        expect(errors).toHaveBeenCalledWith(expect.stringContaining('Cannot scan Copilot sessions'));
        expect(picker).not.toHaveBeenCalled();
        expect(readFileSync(transcript, 'utf8')).toBe('local session text');
      } finally {
        disposable.dispose();
        picker.mockRestore();
        errors.mockRestore();
      }
    } finally {
      access.mockImplementation(actualAccess);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['workspace storage', 'session files'])('refuses incomplete session discovery when %s cannot be listed', async scope => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-scan-denied-'));
    const workspaceRoot = join(root, 'workspaceStorage');
    const sessionDir = join(workspaceRoot, 'selected', 'chatSessions');
    const transcript = join(sessionDir, 's1.json');
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(workspaceRoot, 'selected', 'workspace.json'), '{"folder":"file:///g%3A/project"}');
    writeFileSync(transcript, 'local session text');
    makeCatalog(dbPath, 'secret-session-text');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    const deniedPath = scope === 'workspace storage' ? workspaceRoot : sessionDir;
    const actualReaddir = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).readdir;
    const readdir = vi.mocked(fsPromises.readdir).mockImplementation((...args) => {
      if (String(args[0]) === deniedPath) return Promise.reject(Object.assign(new Error('scan denied'), { code: 'EACCES' }));
      return actualReaddir(...args);
    });
    (vscode.commands as any)._registrations = [];
    const picker = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([{ id: '__all__', label: 'EVERY conversation' }] as any);
    const errors = vi.spyOn(vscode.window, 'showErrorMessage');
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('Cannot scan Copilot sessions'));
      expect(picker).not.toHaveBeenCalled();
      expect(readFileSync(transcript, 'utf8')).toBe('local session text');
      const remaining = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(remaining.prepare('SELECT id FROM sessions WHERE id = ?').get('s1')).toBeDefined();
      } finally {
        remaining.close();
      }
    } finally {
      disposable.dispose();
      readdir.mockImplementation(actualReaddir);
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['workspace index', 'Copilot catalog'])('refuses incomplete session discovery when %s cannot be counted', async scope => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-scan-count-denied-'));
    const indexPath = join(root, 'workspaceStorage', 'selected', 'state.vscdb');
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    mkdirSync(join(root, 'workspaceStorage', 'selected'), { recursive: true });
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    writeFileSync(join(root, 'workspaceStorage', 'selected', 'workspace.json'), '{"folder":"file:///g%3A/project"}');
    const index = new DatabaseSync(indexPath);
    index.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    index.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('chat.ChatSessionStore.index', '{"entries":{"s1":{}}}');
    index.close();
    makeCatalog(dbPath, 'secret-session-text');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    const failedQuery = scope === 'workspace index'
      ? 'SELECT value FROM ItemTable WHERE key = ?'
      : 'SELECT cwd, COUNT(*) AS c FROM sessions GROUP BY cwd';
    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === failedQuery) throw new Error('injected count failure');
      return originalPrepare.call(this, sql);
    });
    (vscode.commands as any)._registrations = [];
    const picker = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([{ id: '__all__', label: 'EVERY conversation' }] as any);
    const errors = vi.spyOn(vscode.window, 'showErrorMessage');
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('Cannot scan Copilot sessions'));
      expect(picker).not.toHaveBeenCalled();
      prepare.mockRestore();
      const remaining = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(remaining.prepare('SELECT id FROM sessions WHERE id = ?').get('s1')).toBeDefined();
      } finally {
        remaining.close();
      }
    } finally {
      disposable.dispose();
      prepare.mockRestore();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps workspace files when its session index cannot be accessed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-index-access-denied-'));
    const indexPath = join(root, 'workspaceStorage', 'selected', 'state.vscdb');
    const transcript = join(root, 'workspaceStorage', 'selected', 'chatSessions', 's1.json');
    mkdirSync(join(root, 'workspaceStorage', 'selected', 'chatSessions'), { recursive: true });
    writeFileSync(transcript, 'local session text');
    const db = new DatabaseSync(indexPath);
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('chat.ChatSessionStore.index', '{"entries":{"s1":{}}}');
    db.close();
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    const actualAccess = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).access;
    const access = vi.mocked(fsPromises.access).mockImplementation(async (...args) => {
      if (String(args[0]) === indexPath) throw Object.assign(new Error('index access denied'), { code: 'EACCES' });
      return actualAccess(...args);
    });
    try {
      const outcome = await clean({ global: false, all: false, workspaces: [{ id: 'selected', folders: ['g:/project'] }] });
      expect(access).toHaveBeenCalledWith(indexPath);
      expect(outcome.dbError).toBe(true);
      expect(outcome.removedDirs).toBe(0);
      expect(readFileSync(transcript, 'utf8')).toBe('local session text');
    } finally {
      access.mockImplementation(actualAccess);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports failed session-directory removal without claiming the workspace was clean', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-session-dir-denied-'));
    const sessionDir = join(root, 'workspaceStorage', 'selected', 'chatSessions');
    const transcript = join(sessionDir, 's1.json');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(transcript, 'local session text');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    const actualAccess = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).access;
    const access = vi.mocked(fsPromises.access).mockImplementation(async (...args) => {
      if (String(args[0]) === sessionDir) throw Object.assign(new Error('session directory access denied'), { code: 'EACCES' });
      return actualAccess(...args);
    });
    try {
      const outcome = await clean({ global: false, all: false, workspaces: [{ id: 'selected', folders: ['g:/project'] }] });
      expect(outcome.dirError).toBe(true);
      expect(outcome.removedDirs).toBe(0);
      expect(readFileSync(transcript, 'utf8')).toBe('local session text');

      writeFileSync(join(root, 'workspaceStorage', 'selected', 'workspace.json'), '{"folder":"file:///g%3A/project"}');
      (vscode.commands as any)._registrations = [];
      vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([{ id: 'selected', label: 'selected' }] as any);
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
      const summary = vi.spyOn(vscode.window, 'showInformationMessage');
      const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
      try {
        await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
        expect(summary.mock.calls[0][0]).toContain('Some session directories could not be removed');
        expect(summary.mock.calls[0][0]).not.toContain('the storage has already been cleaned');
        expect(readFileSync(transcript, 'utf8')).toBe('local session text');
      } finally {
        disposable.dispose();
        vi.restoreAllMocks();
      }
    } finally {
      access.mockImplementation(actualAccess);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports inaccessible opt-in memory as not deleted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-memory-access-denied-'));
    const memoryDir = join(root, 'globalStorage', 'github.copilot-chat', 'memory-tool', 'memories');
    const note = join(memoryDir, 'note.md');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(note, 'keep user memory');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    const actualAccess = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).access;
    const access = vi.mocked(fsPromises.access).mockImplementation(async (...args) => {
      if (String(args[0]) === memoryDir) throw Object.assign(new Error('memory access denied'), { code: 'EACCES' });
      return actualAccess(...args);
    });
    try {
      const outcome = await clean({ global: false, all: false, workspaces: [], userMemory: true });
      expect(access).toHaveBeenCalledWith(memoryDir);
      expect(outcome.userMemoryRemoved).toBe(false);
      expect(readFileSync(note, 'utf8')).toBe('keep user memory');
    } finally {
      access.mockImplementation(actualAccess);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows scoped cleanup when unknown child rows belong to another session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-unrelated-table-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    makeCatalog(dbPath, 'selected session');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE extra_notes (session_id TEXT, body TEXT)');
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run('s2', 'g:/other');
    db.prepare('INSERT INTO extra_notes VALUES (?, ?)').run('s2', 'keep other session');
    db.close();
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    try {
      const outcome = await clean({ global: false, all: false, workspaces: [{ id: 'selected', folders: ['g:/project'] }] });
      expect(outcome.agentStoreError).toBe(false);
      expect(outcome.unhandledTables).toEqual([]);
      expect(outcome.removedAgentSessions).toBe(1);

      const remaining = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect((remaining.prepare('SELECT id FROM sessions').all() as { id: string }[]).map(row => row.id)).toEqual(['s2']);
        expect((remaining.prepare('SELECT body FROM extra_notes').get() as { body: string }).body).toBe('keep other session');
      } finally {
        remaining.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a failed FTS5 rebuild reachable for retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-fts-failure-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    makeCatalog(dbPath, 'zzqxunmqrk');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === "INSERT INTO search_index(search_index) VALUES('rebuild')") {
        throw new Error('injected rebuild failure');
      }
      return originalPrepare.call(this, sql);
    });
    try {
      const found = await discoverWorkspaces();
      const targets = { global: false, all: false, workspaces: [], unattributedCwds: found.unattributed.cwds };
      const outcome = await clean(targets);
      expect(outcome.agentStoreError).toBe(true);
      expect(outcome.removedAgentSessions).toBe(0);
      expect(outcome.compacted).toBe(false);

      const afterFailure = await discoverWorkspaces();
      expect(afterFailure.unattributed.conversations).toBe(1);
      prepare.mockRestore();
      const retry = await clean({ ...targets, unattributedCwds: afterFailure.unattributed.cwds });
      expect(retry.agentStoreError).toBe(false);
      expect(retry.removedAgentSessions).toBe(1);
      expect(retry.compacted).toBe(true);
    } finally {
      prepare.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('offers catalog maintenance after compaction fails on the last session', async () => {
    const secret = 'zzqreclaimoldtext';
    const root = mkdtempSync(join(tmpdir(), 'vllm-catalog-maintenance-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    makeCatalog(dbPath, secret);
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    const originalExec = DatabaseSync.prototype.exec;
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === 'VACUUM') throw new Error('injected compaction failure');
      return originalExec.call(this, sql);
    });
    let disposable: vscode.Disposable | undefined;
    try {
      const deleted = await clean({ global: false, all: true, workspaces: [] });
      expect(deleted.removedAgentSessions).toBe(1);
      expect(deleted.compacted).toBe(false);
      const found = await discoverWorkspaces();
      expect(found.workspaces).toEqual([]);
      expect(found.unattributed.conversations).toBe(0);

      (vscode.commands as any)._registrations = [];
      const picker = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([
        { label: 'Maintain Copilot catalog', id: '__catalog_maintenance__' },
      ] as any);
      const info = vi.spyOn(vscode.window, 'showInformationMessage');
      disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');

      expect(picker.mock.calls[0][0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: '__catalog_maintenance__' }),
      ]));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('Catalog search index rebuilt, but VACUUM or the WAL checkpoint failed'), 'OK');

      exec.mockRestore();
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(info).toHaveBeenCalledWith(expect.stringContaining('Catalog maintenance completed'), 'OK');
      expect(readFileSync(dbPath).includes(secret)).toBe(false);
      const remaining = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect((remaining.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);
      } finally {
        remaining.close();
      }
    } finally {
      exec.mockRestore();
      disposable?.dispose();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not create a missing catalog while attempting maintenance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-absent-catalog-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    try {
      expect(await maintainAgentStore()).toEqual({ indexRebuilt: false, compacted: false });
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps live conversations intact and refuses mixed maintenance selections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-maintain-live-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    makeCatalog(dbPath, 'keep live conversation');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    (vscode.commands as any)._registrations = [];
    vi.spyOn(vscode.window, 'showQuickPick')
      .mockResolvedValueOnce([
        { label: 'Maintain Copilot catalog', id: '__catalog_maintenance__' },
        { label: 'EVERY conversation', id: '__all__' },
      ] as any)
      .mockResolvedValueOnce([{ label: 'Maintain Copilot catalog', id: '__catalog_maintenance__' }] as any);
    const warning = vi.spyOn(vscode.window, 'showWarningMessage');
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('Select catalog maintenance on its own'), 'OK');
      expect(info).not.toHaveBeenCalled();

      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(info).toHaveBeenCalledWith(expect.stringContaining('Catalog maintenance completed'), 'OK');
      const remaining = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(remaining.prepare('SELECT id FROM sessions WHERE id = ?').get('s1')).toBeDefined();
        expect((remaining.prepare('SELECT body FROM turns WHERE session_id = ?').get('s1') as { body: string }).body)
          .toBe('keep live conversation');
      } finally {
        remaining.close();
      }
    } finally {
      disposable.dispose();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports committed deletion separately from failed physical compaction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-catalog-compaction-report-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    makeCatalog(dbPath, 'deleted conversation text');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    (vscode.commands as any)._registrations = [];
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([
      { label: 'EVERY conversation', id: '__all__' },
    ] as any);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
    const summary = vi.spyOn(vscode.window, 'showInformationMessage');
    const originalExec = DatabaseSync.prototype.exec;
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === 'VACUUM') throw new Error('injected compaction failure');
      return originalExec.call(this, sql);
    });
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(summary.mock.calls[0][0]).toContain('Removed 1 conversation(s)');
      expect(summary.mock.calls[0][0]).toContain('Catalog VACUUM or WAL checkpoint did not finish');
      expect(summary.mock.calls[0][0]).toContain('Maintain Copilot catalog');
      expect((await discoverWorkspaces()).unattributed.conversations).toBe(0);
    } finally {
      disposable.dispose();
      exec.mockRestore();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a failed whole-catalog cleanup retryable without claiming success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-fts-warning-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    makeCatalog(dbPath, 'zzqxunmqrk');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    (vscode.commands as any)._registrations = [];
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([
      { label: 'EVERY conversation on this machine', id: '__all__' },
    ] as any);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
    const summary = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === "INSERT INTO search_index(search_index) VALUES('rebuild')") {
        throw new Error('injected rebuild failure');
      }
      return originalPrepare.call(this, sql);
    });
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(summary.mock.calls[0][0]).toContain('Copilot catalog deletion did not commit');
      expect(summary.mock.calls[0][0]).not.toContain('Nuked the Copilot session catalog');
      expect((await discoverWorkspaces()).unattributed.conversations).toBe(1);

      prepare.mockRestore();
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(summary.mock.calls[1][0]).toContain('Removed 1 conversation(s)');
      expect((await discoverWorkspaces()).unattributed.conversations).toBe(0);
    } finally {
      disposable.dispose();
      prepare.mockRestore();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exposes catalog-only sessions when no workspace entry can claim them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-orphan-catalog-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    makeCatalog(dbPath, 'zzqxunmqrk');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    try {
      const found = await discoverWorkspaces();
      expect(found.workspaces).toEqual([]);
      expect(found.unattributed).toEqual({ cwds: [normalizeCwd('g:/project')], conversations: 1 });

      const outcome = await clean({
        global: false,
        all: false,
        workspaces: [],
        unattributedCwds: found.unattributed.cwds,
      });
      expect(outcome.removedAgentSessions).toBe(1);
      expect(outcome.agentStoreError).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps matched workspace and global rows when only unattributed paths are selected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-orphan-scope-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    makeCatalog(dbPath, 'zzqxunmqrk');
    const known = join(root, 'workspaceStorage', 'known');
    mkdirSync(known, { recursive: true });
    writeFileSync(join(known, 'workspace.json'), JSON.stringify({
      folder: process.platform === 'win32' ? 'file:///g%3A/known' : 'file:///known',
    }));
    const db = new DatabaseSync(dbPath);
    db.prepare('INSERT INTO sessions (id, cwd) VALUES (?, ?)').run('known', process.platform === 'win32' ? 'g:/known' : '/known');
    db.prepare('INSERT INTO turns (id, session_id, body) VALUES (?, ?, ?)').run('known-turn', 'known', 'keep this conversation');
    db.prepare('INSERT INTO search_index (txt, session_id) VALUES (?, ?)').run('keep this conversation', 'known');
    db.prepare('INSERT INTO sessions (id, cwd) VALUES (?, NULL)').run('global');
    db.close();
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));

    try {
      const found = await discoverWorkspaces();
      expect(found.workspaces.map(ws => ws.id).sort()).toEqual(['__global__', 'known']);
      expect(found.unattributed).toEqual({ cwds: [normalizeCwd('g:/project')], conversations: 1 });
      const outcome = await clean({ global: false, all: false, workspaces: [], unattributedCwds: found.unattributed.cwds });
      expect(outcome.removedAgentSessions).toBe(1);

      const remaining = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect((remaining.prepare('SELECT id FROM sessions ORDER BY id').all() as { id: string }[]).map(row => row.id))
          .toEqual(['global', 'known']);
        expect((remaining.prepare('SELECT body FROM turns WHERE session_id = ?').get('known') as { body: string }).body)
          .toBe('keep this conversation');
      } finally {
        remaining.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns when a selected multi-root workspace has one unresolvable folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-partial-workspace-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    const workspaceDir = join(root, 'workspaceStorage', 'selected');
    const transcript = join(workspaceDir, 'chatSessions', 's1.json');
    const selectedCwd = process.platform === 'win32' ? 'g:/project' : '/project';
    const unmatchedCwd = process.platform === 'win32' ? 'g:/unmatched' : '/unmatched';
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    mkdirSync(join(workspaceDir, 'chatSessions'), { recursive: true });
    writeFileSync(join(workspaceDir, 'workspace.json'), JSON.stringify({
      folders: [
        { uri: process.platform === 'win32' ? 'file:///g%3A/project' : 'file:///project' },
        { uri: process.platform === 'win32' ? 'file:///g%3A/unmatched%ZZ' : 'file:///unmatched%ZZ' },
      ],
    }));
    writeFileSync(transcript, 'local session file');
    makeCatalog(dbPath, 'selected conversation');
    const db = new DatabaseSync(dbPath);
    db.prepare('DELETE FROM search_index WHERE session_id = ?').run('keep');
    db.prepare('UPDATE sessions SET cwd = ? WHERE id = ?').run(selectedCwd, 's1');
    db.prepare('INSERT INTO sessions (id, cwd) VALUES (?, ?)').run('unmatched', unmatchedCwd);
    db.prepare('INSERT INTO turns (id, session_id, body) VALUES (?, ?, ?)').run('unmatched-turn', 'unmatched', 'keep unmatched text');
    db.close();
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    (vscode.commands as any)._registrations = [];
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([{ id: 'selected', label: 'selected' }] as any);
    const confirmation = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
    const summary = vi.spyOn(vscode.window, 'showInformationMessage');
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(confirmation.mock.calls[0][0]).toContain('Some selected workspace folders could not be resolved; their catalog history may remain.');
      expect(existsSync(transcript)).toBe(false);
      expect(summary.mock.calls[0][0]).toContain('INCOMPLETE: 1 selected workspace(s) had unresolved folder(s)');
      expect(summary.mock.calls[0][0]).not.toContain('orphaned catalog row(s)');
      const remaining = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect((remaining.prepare('SELECT id FROM sessions ORDER BY id').all() as { id: string }[]).map(row => row.id))
          .toEqual(['unmatched']);
        expect(remaining.prepare('SELECT body FROM turns WHERE session_id = ?').get('unmatched')).toBeDefined();
      } finally {
        remaining.close();
      }
    } finally {
      disposable.dispose();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts duplicate normalized roots once in the workspace picker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-duplicate-roots-'));
    const workspaceDir = join(root, 'workspaceStorage', 'selected');
    const catalogDir = join(root, 'globalStorage', 'github.copilot-chat');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(catalogDir, { recursive: true });
    writeFileSync(join(workspaceDir, 'workspace.json'), JSON.stringify({
      folders: process.platform === 'win32'
        ? [{ uri: 'file:///g%3A/project' }, { uri: 'file:///G%3A/PROJECT/' }]
        : [{ uri: 'file:///project' }, { uri: 'file:///project/' }],
    }));
    const db = new DatabaseSync(join(catalogDir, 'session-store.db'));
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)');
    db.prepare('INSERT INTO sessions (id, cwd) VALUES (?, ?)').run('s1', process.platform === 'win32' ? 'g:/project' : '/project');
    db.close();
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    try {
      const found = await discoverWorkspaces();
      expect(found.unattributed.conversations).toBe(0);
      expect(found.workspaces).toEqual([expect.objectContaining({ id: 'selected', conversations: 1 })]);
      expect(found.workspaces[0].folders).toHaveLength(1);
      expect(found.workspaces[0].label).not.toContain('more');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('offers catalog-only history in the command when no workspace is discoverable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-orphan-picker-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    makeCatalog(dbPath, 'zzqxunmqrk');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    (vscode.commands as any)._registrations = [];
    const picker = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([
      { label: 'Unattributed catalog sessions', id: '__unattributed__' },
    ] as any);
    const confirmation = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(picker.mock.calls[0][0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: '__unattributed__', description: expect.stringContaining('catalog only') }),
      ]));
      expect(confirmation.mock.calls[0][0]).toContain('Unattributed catalog history (1 conversation(s)');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect((db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      disposable.dispose();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not report unresolved workspace folders after wiping the whole catalog', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-all-catalog-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    makeCatalog(dbPath, 'zzqxunmqrk');
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    try {
      const outcome = await clean({
        global: false,
        all: true,
        workspaces: [{ id: 'unresolved', folders: [] }],
      });
      expect(outcome.removedAgentSessions).toBe(1);
      expect(outcome.unresolvedWorkspaces).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses repo-memory deletion when only global sessions are selected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-global-memory-'));
    const dbPath = join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'globalStorage', 'github.copilot-chat'), { recursive: true });
    makeCatalog(dbPath, 'zzqxunmqrk');
    const db = new DatabaseSync(dbPath);
    db.prepare('INSERT INTO sessions (id, cwd) VALUES (?, NULL)').run('global');
    db.close();
    setSessionManagerOutput({ appendLine: () => {} }, join(root, 'globalStorage', 'pub.ext'));
    (vscode.commands as any)._registrations = [];
    const picker = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue([
      { label: 'All global sessions', id: '__global__' },
      { label: 'Repo memory', id: '__repo_memory__' },
    ] as any);
    const confirmation = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
    const disposable = registerCleanSessionsCommand({ appendLine: () => {} } as any);
    try {
      await (vscode.commands as any)._run('vllm-copilot.cleanCopilotSessions');
      expect(picker.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({ id: '__global__' })]));
      expect(confirmation).toHaveBeenCalledWith(expect.stringContaining('Repo memory applies only to workspace entries.'), 'OK');
      const remaining = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect((remaining.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(2);
      } finally {
        remaining.close();
      }
    } finally {
      disposable.dispose();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * TRIPWIRE for the separator fold. A backslash is a legal character in a POSIX
 * filename, so `/repo\old` and `/repo/old` are two different directories there.
 * Folding backslashes on every platform made them one catalog target, and a
 * project could delete another project's history by name collision.
 */
describe('normalizeCwd separator folding', () => {
  it('never merges a backslash name with a slash name on a POSIX filesystem', async () => {
    if (process.platform === 'win32') return; // win32 folds both to the same dir
    const { normalizeCwd } = await import('../src/shared/sessionManager.js');
    expect(normalizeCwd('/repo\\old')).not.toBe(normalizeCwd('/repo/old'));
  });

  it('still joins a Windows path to its stored catalog form', async () => {
    if (process.platform !== 'win32') return;
    const { normalizeCwd } = await import('../src/shared/sessionManager.js');
    expect(normalizeCwd('g:\\JitterPaper')).toBe(normalizeCwd('g:/JitterPaper'));
  });
});

/** The delete list must still name every table the catalog is built from. */
describe('catalog delete targets', () => {
  it('still deletes the fts5 index explicitly', () => {
    expect(AGENT_TABLES_BY_SESSION_ID).toContain('search_index');
  });
});
