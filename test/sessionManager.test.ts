import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_TABLES_BY_SESSION_ID,
  normalizeCwd,
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
  it('folds separators and trailing slashes on every platform', () => {
    const canonical = normalizeCwd('g:/JitterPaper');
    for (const form of ['g:\\JitterPaper', 'g:/JitterPaper', 'g:\\JitterPaper\\', 'g:/JitterPaper/']) {
      expect(normalizeCwd(form)).toBe(canonical);
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
    // Real pairing from the field: workspace.json `file:///g%3A/JitterPaper`
    // decodes to `g:/JitterPaper`; SQLite stores `g:\JitterPaper`.
    const fromUri = decodeURIComponent('file:///g%3A/JitterPaper')
      .replace(/^file:\/\//, '')
      .replace(/^\//, '');
    expect(normalizeCwd(fromUri)).toBe(normalizeCwd('g:\\JitterPaper'));
  });

  it('keeps distinct folders distinct', () => {
    expect(normalizeCwd('g:\\vLLM-Copilot')).not.toBe(normalizeCwd('g:\\vLLM-2-Copilot'));
    expect(normalizeCwd('g:\\vLLM-Copilot')).not.toBe(normalizeCwd('g:\\vLLM-Copilot\\sub'));
  });

  it('does not collapse a drive root into an empty string', () => {
    // `g:\` is a real cwd in the catalog; trimming the slash must not make every
    // path that trims to nothing compare equal to it.
    expect(normalizeCwd('g:\\')).toBe('g:');
  });
});

/**
 * TRIPWIRE, not a coverage metric. The Copilot catalog carries the actual
 * conversation text, and `search_index` is an fts5 virtual table with NO
 * triggers — nothing cascades into it. A table Copilot adds later (or one this
 * list already misses) is a table whose rows survive the wipe while the summary
 * claims the sessions are gone.
 *
 * When this fails: add the new table to `AGENT_TABLES_BY_SESSION_ID` in
 * `src/shared/sessionManager.ts` and confirm it is keyed by `session_id`.
 */
describe('Copilot catalog delete coverage', () => {
  it('covers every session-keyed table Copilot stores', () => {
    // Observed in the shipped 1.139 session-store.db schema. `sessions` is keyed
    // by `id` and deleted by the parent statement; `schema_version` and the fts5
    // shadow tables (`search_index_data`, `_idx`, `_content`, `_docsize`,
    // `_config`) are internal to the fts5 virtual table, which SQLite maintains.
    const SESSION_KEYED = ['turns', 'session_files', 'session_refs', 'checkpoints', 'search_index'];
    expect([...AGENT_TABLES_BY_SESSION_ID].sort()).toEqual([...SESSION_KEYED].sort());
  });

  it('deletes the fts index explicitly rather than relying on a cascade', () => {
    // search_index holds UNINDEXED copies of the text. If it ever drops out of
    // the list, deleted turns stay greppable by anyone with a copy of the .db.
    expect(AGENT_TABLES_BY_SESSION_ID).toContain('search_index');
  });

  it('does not try to delete the parent through the session_id list', () => {
    // `sessions` is keyed by `id`, not `session_id`; listing it here would make
    // the child delete target the wrong column.
    expect(AGENT_TABLES_BY_SESSION_ID).not.toContain('sessions');
  });
});