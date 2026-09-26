import * as fs from 'fs/promises';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { stripJsonc } from './jsonc.js';

/**
 * Wipes Copilot/VS Code session residue for selected workspaces.
 *
 * SECURITY TOOL, not a disk-cleanup helper — and the magnitude is the opposite
 * of what it looks like. The per-workspace session INDEX is a few MB; the
 * conversation text itself lives in `session-store.db` (user_message /
 * assistant_response) plus a full-text FTS5 copy of it in `search_index`.
 * Deleting only the index (what this command used to do) left every prompt and
 * reply in a 3.7 MB file anyone can grep. A row DELETE also leaves the bytes in
 * freed pages, so the catalog is VACUUMed afterwards; that can fail while
 * Copilot holds the file open, and the failure is REPORTED rather than assumed.
 *
 * Every location here is private VS Code / Copilot storage with no public API,
 * and the format has already moved twice (index key renamed; `chatSessions/`
 * joined by `transcripts/`). `AGENT_TABLES_BY_SESSION_ID` plus the schema
 * tripwire test keep the catalog delete honest as Copilot evolves.
 *
 * Copilot memory (`memory-tool/memories`) is deliberately NOT in the default
 * wipe: it is the user's to keep, and Copilot ships its own command for it.
 * See the `repoMemory` / `userMemory` targets on `clean()`.
 */

// Both are set by setSessionManagerOutput() at activation, before a single
// command is registered — VS Code cannot invoke a command from a provider it
// has not finished activating, and every activation failure before that call
// leaves the extension with zero commands. No pre-init buffering, no
// os.homedir() product-name guessing: an unset root crashes loudly instead of
// silently reading some OTHER product's state.vscdb.
let outputChannel: { appendLine(line: string): void };
let activeVsCodeUserRoot: string;

export function setSessionManagerOutput(
  channel: { appendLine(line: string): void },
  extensionGlobalStoragePath: string,
): void {
  outputChannel = channel;
  activeVsCodeUserRoot = userDataRootFromGlobalStorage(extensionGlobalStoragePath);
}

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  outputChannel.appendLine(`[sessionManager] [${level}] ${msg}`);
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Session index key in ItemTable. Lives in global + per-workspace DBs. */
const SESSION_INDEX_KEY = 'chat.ChatSessionStore.index';

/** Bucket for catalog sessions with no folder (empty windows). */
const NULL_CWD = ' <null>';

/**
 * Copilot-owned tables holding session data, keyed by `session_id`. The
 * `sessions` table itself is keyed by `id` and handled separately.
 *
 * `search_index` is an fts5 virtual table carrying `session_id` as an
 * UNINDEXED column and NO TRIGGERS — Copilot maintains it in application code,
 * so nothing cascades into it. Forget it and the deleted text stays greppable by
 * anyone holding a copy of the file. It must be deleted explicitly.
 */
export const AGENT_TABLES_BY_SESSION_ID = [
  'turns',
  'session_files',
  'session_refs',
  'checkpoints',
  'search_index',
] as const;

/** Per-workspace directories holding session residue. Deleted recursively. */
const WORKSPACE_SESSION_DIRS = [
  'chatSessions',
  'chatEditingSessions',
  'GitHub.copilot-chat/transcripts',
  'GitHub.copilot-chat/debug-logs',
  'GitHub.copilot-chat/chat-session-resources',
] as const;

/** Copilot repo memory for one workspace. Opt-in only. */
const WORKSPACE_MEMORY_DIR = 'GitHub.copilot-chat/memory-tool/memories';

/** Global session residue and user-level memory. */
const GLOBAL_SESSION_DIRS = ['emptyWindowChatSessions'] as const;
const GLOBAL_MEMORY_DIR = 'github.copilot-chat/memory-tool/memories';

/** Copilot's session catalog: conversation text plus the FTS index. */
const AGENT_STORE_REL = 'github.copilot-chat/session-store.db';

// ── Path helpers (cross-platform) ──────────────────────────────────────────

/**
 * Derive the active VS Code user-data root from this extension's global storage:
 * `<user-data>/User/globalStorage/<publisher.extension>` → `<user-data>/User`.
 * This follows the running product automatically (Stable, Insiders, VSCodium,
 * portable/custom `--user-data-dir`) instead of guessing its directory name.
 * Exported for testing; production reads it only through setSessionManagerOutput.
 */
export function userDataRootFromGlobalStorage(extensionGlobalStoragePath: string): string {
  return path.dirname(path.dirname(path.resolve(extensionGlobalStoragePath)));
}

function vsCodeRoot(): string {
  return activeVsCodeUserRoot;
}

function globalDbPath(): string {
  return path.join(vsCodeRoot(), 'globalStorage', 'state.vscdb');
}

function workspaceStorageRoot(): string {
  return path.join(vsCodeRoot(), 'workspaceStorage');
}

function wsDir(wsId: string, ...rest: string[]): string {
  return path.join(workspaceStorageRoot(), wsId, ...rest);
}

function wsDbPath(wsId: string): string {
  return wsDir(wsId, 'state.vscdb');
}

function agentStorePath(): string {
  return path.join(vsCodeRoot(), 'globalStorage', ...AGENT_STORE_REL.split('/'));
}

/**
 * Absolute path of a storage-relative directory, for a workspace id or for the
 * global store. The two live under different roots, and every caller used to
 * carry its own copy of that branch.
 */
function storageDir(wsId: string, relDir: string): string {
  const parts = relDir.split('/');
  return wsId === GLOBAL_ID
    ? path.join(vsCodeRoot(), 'globalStorage', ...parts)
    : wsDir(wsId, ...parts);
}

/**
 * Fold a folder path into the form used to join `workspace.json` against
 * `sessions.cwd`: forward slashes, no trailing separator, and — only where the
 * filesystem is case-insensitive — lowercase.
 *
 * The two sources disagree on separators (`g:/JitterPaper` from a decoded
 * `file://` URI vs `g:\JitterPaper` in SQLite), so both sides are folded before
 * they are joined. Case is folded ONLY on win32: on a case-sensitive
 * filesystem `/src/Alpha` and `/src/alpha` are different directories, and
 * folding them together would make selecting one delete the other's history.
 * Over-deletion is the dangerous direction for a tool whose job is deletion.
 *
 * Backslashes are folded ONLY on win32 for the same reason. A backslash is a
 * legal character in a POSIX filename, so `/repo\old` and `/repo/old` are two
 * DIFFERENT directories there; folding them together let a project delete
 * another project's catalog history by name collision alone.
 */
export function normalizeCwd(p: string): string {
  const folded = process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p;
  if (process.platform === 'win32' && /^[a-z]:\/+$/i.test(folded)) return folded.slice(0, 3);
  return folded.replace(/\/+$/, '') || folded;
}

// ── Types ───────────────────────────────────────────────────────────────────

/** One entry describing a workspace (or global) that has Copilot sessions. */
export interface WorkspaceEntry {
  /** Unique id for the picker ("__global__" or a workspace-storage id). */
  id: string;
  /** Human-readable label (first folder, or a "+N more" summary). */
  label: string;
  /**
   * Every folder in `workspace.json`. Multi-root workspaces have several, and
   * the catalog stores one row per FOLDER, so a multi-root workspace owns the
   * history of all of its roots. Empty for an empty-window workspace.
   */
  folders: string[];
  unresolvedFolders?: boolean;
  /**
   * Files under the deletable session directories. These are NOT conversations —
   * one conversation can own several files — so the picker shows them apart
   * rather than adding them into a "total" that would read as a chat count.
   */
  fsSessions: number;
  /** Conversations shown in the picker: state.vscdb index plus catalog rows. */
  conversations: number;
}

/** Picker id for the global entry: history not attributable to one workspace. */
export const GLOBAL_ID = '__global__';

/**
 * Picker id for the wipe-everything entry. Distinct from GLOBAL_ID on purpose:
 * the global entry only touches the global index, empty-window chats and the
 * folderless catalog rows, while this one removes the catalog of EVERY project.
 * Collapsing the two would be the single most destructive label bug available
 * in this command.
 */
export const ALL_ID = '__all__';

/** Honest per-target outcome: a true flag means it was actually done. */
export interface CleanOutcome {
  removedKeys: number;
  /** Directories actually removed. An absent path is NOT counted as removed. */
  removedDirs: number;
  /** A session directory existed but could not be checked or removed. */
  dirError: boolean;
  /** Copilot catalog sessions removed, with all dependent rows. */
  removedAgentSessions: number;
  /** Child rows with no surviving session removed by a whole-catalog wipe. */
  removedOrphanRows: number;
  /** Unattributable child rows still present after scoped catalog cleanup. */
  orphanedRowsRemaining: number;
  /** A `state.vscdb` could not be opened or written. */
  dbError: boolean;
  agentStoreError: boolean;
  /** VACUUM and the WAL checkpoint both ran after the catalog transaction committed. */
  compacted: boolean;
  compactionAttempted: boolean;
  /**
    * Unknown session-keyed tables holding selected data. Non-empty means the
    * catalog deletion was blocked before any selected session was removed.
   */
  unhandledTables: string[];
  /**
    * Selected workspaces that resolved to no folder. Their catalog rows cannot
    * be attributed to the workspace selection, even if an unattributed-catalog
    * selection separately reaches some of those rows.
   */
  unresolvedWorkspaces: string[];
  /** True when at least one selected repo-memory directory was actually removed. */
  repoMemoryRemoved: boolean;
  repoMemoryError: boolean;
  /** Recursive removal failed after starting; some repo-memory files may be gone. */
  repoMemoryMayBePartial: boolean;
  userMemoryRemoved: boolean;
  userMemoryError: boolean;
  userMemoryMayBePartial: boolean;
}

function emptyOutcome(): CleanOutcome {
  return {
    removedKeys: 0,
    removedDirs: 0,
    dirError: false,
    removedAgentSessions: 0,
    removedOrphanRows: 0,
    orphanedRowsRemaining: 0,
    dbError: false,
    agentStoreError: false,
    compacted: false,
    compactionAttempted: false,
    unhandledTables: [],
    unresolvedWorkspaces: [],
    repoMemoryRemoved: false,
    repoMemoryError: false,
    repoMemoryMayBePartial: false,
    userMemoryRemoved: false,
    userMemoryError: false,
    userMemoryMayBePartial: false,
  };
}

function mergeOutcome(into: CleanOutcome, from: CleanOutcome): void {
  into.removedKeys += from.removedKeys;
  into.removedDirs += from.removedDirs;
  into.dirError ||= from.dirError;
  into.removedAgentSessions += from.removedAgentSessions;
  into.removedOrphanRows += from.removedOrphanRows;
  into.orphanedRowsRemaining += from.orphanedRowsRemaining;
  into.dbError ||= from.dbError;
  into.agentStoreError ||= from.agentStoreError;
  into.compacted ||= from.compacted;
  into.compactionAttempted ||= from.compactionAttempted;
  into.unhandledTables.push(...from.unhandledTables);
}

// ── Discovery ───────────────────────────────────────────────────────────────

/**
 * Scan VS Code storage and the Copilot catalog. Catalog paths without a readable
 * workspace folder are offered separately rather than attributed by guesswork.
 */
export async function discoverWorkspaces(): Promise<{
  workspaces: WorkspaceEntry[];
  unattributed: { cwds: string[]; conversations: number };
  catalogPresent: boolean;
  userMemoryPresent: boolean;
  orphanedRows: number;
}> {
  const entries: WorkspaceEntry[] = [];

  let wsIds: string[] = [];
  try {
    wsIds = (await fs.readdir(workspaceStorageRoot(), { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name);
    log('INFO', `Discovered ${wsIds.length} workspace storage directory(ies).`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('WARN', `Cannot read workspace storage at ${workspaceStorageRoot()}: ${errStr(err)}`);
      throw err;
    }
  }

  const perWorkspace = await Promise.all(
    wsIds.map(async wsId => {
      const [indexEntries, fsSessions, folderResolution, repoMemoryPresent] = await Promise.all([
        countIndexEntries(wsDbPath(wsId)),
        countFilesInDirs(wsId, WORKSPACE_SESSION_DIRS),
        resolveWorkspaceFolders(wsId),
        memoryDirMayExist(storageDir(wsId, WORKSPACE_MEMORY_DIR)),
      ]);
      return { wsId, indexEntries, fsSessions, ...folderResolution, repoMemoryPresent };
    }),
  );

  // Copilot catalog rows, bucketed by the normalized cwd they belong to.
  const { agentByCwd, orphanedRows } = await scanAgentStore();
  const catalogPresent = await fileExists(agentStorePath());

  const globalDb = await countIndexEntries(globalDbPath());
  const globalAgent = agentByCwd.get(NULL_CWD) ?? 0;
  // The global entry also covers empty-window chats, so it has to stay visible
  // when those are the only residue left — otherwise the files exist and the
  // command that deletes them is not on the list.
  const globalFs = await countFilesInDirs(GLOBAL_ID, GLOBAL_SESSION_DIRS);
  const userMemoryPresent = await memoryDirMayExist(storageDir(GLOBAL_ID, GLOBAL_MEMORY_DIR));
  if (globalDb + globalAgent + globalFs > 0) {
    entries.push({
      id: GLOBAL_ID,
      label: 'All global sessions',
      folders: [],
      fsSessions: globalFs,
      conversations: globalDb + globalAgent,
    });
  }

  for (const { wsId, indexEntries, fsSessions, folders, unresolved, repoMemoryPresent } of perWorkspace) {
    // EVERY root counts: a multi-root workspace owns the history of each folder
    // it contains, and the catalog keys rows by folder, not by workspace.
    const agentEntries = folders.reduce((sum, f) => sum + (agentByCwd.get(normalizeCwd(f)) ?? 0), 0);
    // Keep workspaces with repo memory selectable after their last session is gone.
    if (indexEntries + agentEntries + fsSessions === 0 && !repoMemoryPresent) continue;
    entries.push({
      id: wsId,
      label: folders.length > 1 ? `${folders[0]} (+${folders.length - 1} more)` : (folders[0] ?? wsId),
      folders,
      unresolvedFolders: unresolved,
      fsSessions,
      conversations: indexEntries + agentEntries,
    });
  }

  const claimedCwds = new Set(perWorkspace.flatMap(ws => ws.folders.map(normalizeCwd)));
  const unattributed = [...agentByCwd].filter(([cwd]) => cwd !== NULL_CWD && !claimedCwds.has(cwd));
  return {
    workspaces: entries,
    catalogPresent,
    userMemoryPresent,
    orphanedRows,
    unattributed: {
      cwds: unattributed.map(([cwd]) => cwd).sort(),
      conversations: unattributed.reduce((count, [, sessions]) => count + sessions, 0),
    },
  };
}


// ── SQLite access (via node:sqlite) ────────────────────────────────────────
// node:sqlite ships with VS Code's bundled Node. The `--experimental-sqlite`
// flag was removed on Node 22.13.0 (Jan 2025, PR nodejs/node#55890), so any
// VS Code version bundling Node ≥ 22.13 has `DatabaseSync` available without a
// flag (it may emit an `ExperimentalWarning`, which is informational — the
// module is Stability 1.2/R release-candidate as of Node 26). The manifest
// floor is `^1.128.0`, comfortably past the unflag. No Python dependency, no
// native binding, no temp files.

// ── Copilot session catalog ─────────────────────────────────────────────────

/** What to remove from the Copilot catalog. */
type CatalogScope =
  /** The listed folders, and nothing else. */
  | { kind: 'folders'; cwds: string[] }
  /** The listed folders plus history that belongs to no folder (empty windows). */
  | { kind: 'folders+null'; cwds: string[] }
  /** Every row. */
  | { kind: 'all' };

/**
 * Delete the requested catalog rows, then reclaim the bytes.
 *
 * One scope, one `where`, ONE transaction. An earlier version resolved the
 * folderless rows in a second function, which meant a second open of the same
 * file and two independent transactions for what the user sees as one action —
 * a window where the first committed and the second did not.
 *
 * `cwd` matching folds both sides in JS and deletes with the EXACT stored
 * strings rather than using string functions in SQL: it stays portable and
 * avoids guessing at SQLite's case folding.
 */
export async function cleanAgentStore(scope: CatalogScope): Promise<CleanOutcome> {
  const outcome = emptyOutcome();
  const dbPath = agentStorePath();
  let db: DatabaseSync | undefined;
  try {
    if (!(await fileExists(dbPath))) {
      log('INFO', `Copilot session catalog not present at ${dbPath} - nothing to delete.`);
      return outcome;
    }
    db = new DatabaseSync(dbPath);
    if (scope.kind === 'all') {
      const deleted = deleteCatalogRows(db, '', [], outcome.unhandledTables);
      outcome.removedAgentSessions = deleted.sessions;
      outcome.removedOrphanRows = deleted.orphans;
      log('INFO', `Copilot catalog: removed ${deleted.sessions} session(s) and ${deleted.orphans} orphaned row(s) (ALL).`);
    } else {
      const targets = selectCwdStrings(db, new Set(scope.cwds.map(normalizeCwd)));
      // No matching folder means no statement runs at all. Falling through to an
      // empty `cwd IN ()` would be a syntax error, and widening to "everything"
      // because the selection matched nothing is the one outcome a delete command
      // must never produce. A selection of only the global entry legitimately
      // matches no folder and still has work to do via `cwd IS NULL`.
      if (targets.length > 0 || scope.kind === 'folders+null') {
        const where = [
          ...(targets.length > 0 ? [`cwd IN (${targets.map(() => '?').join(',')})`] : []),
          ...(scope.kind === 'folders+null' ? ['cwd IS NULL'] : []),
        ].join(' OR ');
        const deleted = deleteCatalogRows(db, where, targets, outcome.unhandledTables);
        outcome.removedAgentSessions = deleted.sessions;
        outcome.orphanedRowsRemaining = deleted.orphans;
      } else {
        outcome.orphanedRowsRemaining = countOrphanedCatalogRows(db);
      }
      log(
        'INFO',
        `Copilot catalog: removed ${outcome.removedAgentSessions} session(s) (${targets.join(', ') || 'no matching cwd'}).`,
      );
      if (outcome.orphanedRowsRemaining > 0) {
        log('WARN', `${outcome.orphanedRowsRemaining} orphaned catalog row(s) have no workspace attribution and were not removed.`);
      }
    }
  } catch (err) {
    log('ERROR', `Failed to clean Copilot catalog at ${dbPath}: ${errStr(err)}`);
    outcome.agentStoreError = true;
    return outcome;
  } finally {
    db?.close();
  }

  // Reclaim freed pages. A row DELETE alone leaves the text in freed pages, so
  // this is the difference between "not findable" and "not present". It can fail
  // while Copilot holds the file open, and that is reported, not assumed.
  outcome.compactionAttempted = true;
  outcome.compacted = await compactAgentStore();
  return outcome;
}

/** Rebuild the catalog search index and reclaim old bytes without deleting conversations. */
export async function maintainAgentStore(): Promise<{ indexRebuilt: boolean; compacted: boolean }> {
  const outcome = { indexRebuilt: false, compacted: false };
  const dbPath = agentStorePath();
  let db: DatabaseSync | undefined;
  try {
    if (!(await fileExists(dbPath))) {
      log('WARN', `Copilot catalog maintenance skipped: catalog not present at ${dbPath}.`);
      return outcome;
    }
    db = new DatabaseSync(dbPath);
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO search_index(search_index) VALUES('rebuild')").run();
    db.exec('COMMIT');
    outcome.indexRebuilt = true;
  } catch (err) {
    try {
      db?.exec('ROLLBACK');
    } catch {}
    log('WARN', `Copilot catalog maintenance could not rebuild the search index: ${errStr(err)}`);
    return outcome;
  } finally {
    db?.close();
  }

  outcome.compacted = await compactAgentStore();
  return outcome;
}

/**
 * Tables the catalog holds that are keyed by `session_id` but are NOT named in
 * {@link AGENT_TABLES_BY_SESSION_ID}, so their rows cannot be safely deleted.
 *
 * This is the runtime half of the catalog coverage check, and it is the half
 * that can actually notice an upstream change. The in-repo list is a guess
 * about a schema Copilot owns; when Copilot adds a session-keyed table, deletion
 * must stop before removing any selected parent whose data lives there. Reading
 * `sqlite_master` is the only way to notice a table nobody wrote down.
 *
 * `sessions` is excluded because it is keyed by `id` and handled as the parent
 * statement. fts5 shadow tables are excluded because SQLite maintains them
 * itself; their names are DERIVED from the virtual tables actually present
 * rather than hardcoded, so a second fts table is covered the same way.
 */
export function unhandledSessionKeyedTables(db: DatabaseSync): string[] {
  const known = new Set<string>(AGENT_TABLES_BY_SESSION_ID);
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string; sql: string | null }[];

  const internal = new Set<string>(['sessions']);
  for (const t of tables) {
    if (!/VIRTUAL TABLE/i.test(t.sql ?? '')) continue;
    for (const suffix of ['data', 'idx', 'content', 'docsize', 'config']) {
      internal.add(`${t.name}_${suffix}`);
    }
  }

  const unhandled: string[] = [];
  for (const t of tables) {
    if (known.has(t.name) || internal.has(t.name)) continue;
    const columns = db.prepare(`PRAGMA table_xinfo("${t.name.replace(/"/g, '""')}")`).all() as {
      name: string;
    }[];
    if (columns.some(c => c.name.toLowerCase() === 'session_id')) unhandled.push(t.name);
  }
  return unhandled;
}

/** The DISTINCT stored `cwd` strings that fold onto the wanted set. */
function selectCwdStrings(db: DatabaseSync, wanted: Set<string>): string[] {
  const out: string[] = [];
  for (const r of db.prepare('SELECT DISTINCT cwd FROM sessions').all() as { cwd: string | null }[]) {
    if (r.cwd !== null && wanted.has(normalizeCwd(r.cwd))) out.push(r.cwd);
  }
  return out;
}

function countOrphanedCatalogRows(db: DatabaseSync): number {
  let total = 0;
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
    .map(row => row.name.toLowerCase()));
  for (const table of AGENT_TABLES_BY_SESSION_ID) {
    if (!tables.has(table.toLowerCase())) continue;
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM "${table}" AS child WHERE NOT EXISTS ` +
        '(SELECT 1 FROM sessions WHERE sessions.id = child.session_id)',
    ).get() as { c: number | bigint };
    total += Number(row.c);
  }
  return total;
}

/**
 * Delete every catalog row matching `where` (empty = ALL rows) from every
 * session-owned table, in ONE transaction.
 *
 * The transaction is not optional tidiness: a failure halfway leaves a catalog
 * worse than either starting state — `sessions` rows whose turns are gone, or
 * turns whose session is gone, which is exactly a "deleted" session that still
 * holds its text. All or nothing.
 *
 * ONE `where` string feeds BOTH the parent and the child statements, so the two
 * can never disagree about the scope. An earlier version derived the child
 * filter from a separate boolean, and when the folderless scope passed
 * "delete everything" for the parent, the child delete became unconditional:
 * a global selection stripped every project's conversation text while leaving
 * the session rows. The single-source-of-truth signature makes that impossible.
 *
 * `where` is always a literal this module builds; caller values are bound, so
 * no user-controlled text reaches the SQL.
 */
function deleteCatalogRows(db: DatabaseSync, where: string, bound: readonly string[], blockedTables: string[]): { sessions: number; orphans: number } {
  const parentFilter = where ? ` WHERE ${where}` : '';
  // CHILDREN FIRST: the child deletes select through `sessions`, so the parent
  // rows must still be there for the subquery to match. Deleting the parent
  // first silently removes zero children and leaves every turn (and its FTS
  // copy) behind while the summary claims the sessions are gone.
  const childFilter = where ? ` WHERE session_id IN (SELECT id FROM sessions WHERE ${where})` : '';

  db.exec('BEGIN IMMEDIATE');
  try {
    const removedOrphans = where ? 0 : countOrphanedCatalogRows(db);
    const unknownFilter = where ? ` WHERE session_id IN (SELECT id FROM sessions${parentFilter})` : '';
    for (const table of unhandledSessionKeyedTables(db)) {
      const escapedName = table.replace(/"/g, '""');
      if (db.prepare(`SELECT 1 FROM "${escapedName}"${unknownFilter} LIMIT 1`).get(...bound)) {
        blockedTables.push(table);
      }
    }
    if (blockedTables.length > 0) {
      throw new Error(`Unknown session-keyed catalog table(s) contain selected data: ${blockedTables.join(', ')}`);
    }
    for (const table of AGENT_TABLES_BY_SESSION_ID) {
      try {
        const r = db.prepare(`DELETE FROM "${table}"${childFilter}`).run(...bound);
        log('INFO', `Copilot catalog: ${table} - removed ${r.changes} row(s).`);
      } catch (err) {
        // A table Copilot renames or drops is not a reason to abandon the tables
        // we do understand, but it does mean the run is incomplete, so it is
        // rolled back and surfaced rather than half-applied.
        log('WARN', `Copilot catalog: could not clean "${table}": ${errStr(err)}`);
        throw err;
      }
    }

    // `changes` is a number unless readBigInts is enabled (it is not), but the
    // type allows bigint — coerce for arithmetic safety.
    const changes = db.prepare(`DELETE FROM sessions${parentFilter}`).run(...bound).changes;
    const removed = typeof changes === 'number' ? changes : Number(changes);
    const remainingOrphans = where ? countOrphanedCatalogRows(db) : 0;
    // The fts5 index keeps postings for deleted rows as TOMBSTONES until its
    // segments are merged or the index is rebuilt, and VACUUM copies those live
    // pages verbatim. Measured on a WAL reproduction of this exact sequence:
    // after the row delete, VACUUM and a truncating checkpoint, the deleted
    // conversation's indexed terms were STILL in the main database file while
    // the table correctly returned zero rows for it. The row delete alone
    // therefore does not remove the indexed text, which is the entire point of
    // this command. 'rebuild' re-reads the table's remaining content and
    // discards every posting belonging to a deleted row.
    //
    // Keep the row delete and index rebuild atomic. A failed rebuild rolls
    // everything back, leaving the sessions discoverable for a later retry.
    db.prepare("INSERT INTO search_index(search_index) VALUES('rebuild')").run();
    db.exec('COMMIT');
    log('INFO', 'Copilot catalog: search_index rebuilt - postings for deleted rows discarded.');
    return { sessions: removed, orphans: where ? remainingOrphans : removedOrphans };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the transaction was already unwound */
    }
    log('ERROR', `Copilot catalog: delete rolled back, nothing was removed: ${errStr(err)}`);
    throw err;
  }
}

/**
 * Reopen the catalog to VACUUM it. A row DELETE alone leaves the text in freed
 * pages, so this is the difference between "not findable" and "not present".
 * It can fail while Copilot holds the file open, and that is reported, not
 * assumed.
 *
 * The checkpoint is not a second opinion, it is the other half of the claim.
 * Copilot runs this database in WAL mode, and VACUUM only rewrites the MAIN
 * file: the freed pages it produces are written to the `-wal` sidecar, which
 * measured 2.1 MB of still-greppable conversation text against a 4 KB clean
 * main file in a WAL reproduction of this exact sequence. Reporting `compacted`
 * off the VACUUM alone described a file that was not the file holding the text.
 */
async function compactAgentStore(): Promise<boolean> {
  const dbPath = agentStorePath();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    let vacuumed = false;
    try {
      db.exec('VACUUM');
      vacuumed = true;
      // TRUNCATE is the variant that also empties the sidecar; PASSIVE and
      // FULL only fold frames back into the main file. `busy` non-zero means a
      // concurrent reader blocked it, which is the one outcome that leaves text
      // behind, so it reports the run as incomplete. A no-op on a non-WAL file.
      const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
        | { busy?: number }
        | undefined;
      if (checkpoint?.busy) {
        log(
          'WARN',
          'Copilot catalog: WAL checkpoint blocked by a reader holding the database open. ' +
            'Retry catalog maintenance when other readers release the database.',
        );
        return false;
      }
      log(
        'INFO',
        'Copilot catalog: VACUUM and WAL checkpoint completed - freed pages removed from the ' +
          'main database file and the -wal sidecar.',
      );
      return true;
    } catch (err) {
      log(
        'WARN',
        `Copilot catalog: ${vacuumed ? 'WAL checkpoint' : 'VACUUM'} failed (${errStr(err)}). ` +
          'Old text bytes may remain; retry catalog maintenance when other readers release the database.',
      );
      return false;
    }
  } catch (err) {
    log('WARN', `Copilot catalog: compaction skipped (${errStr(err)}).`);
    return false;
  } finally {
    db?.close();
  }
}

// ── Cleaning ────────────────────────────────────────────────────────────────

/**
 * Wipe the given selection in one pass.
 *
 * The Copilot catalog file is global (one file holds every workspace), so it is
 * opened once for the whole selection rather than once per workspace.
 *
 * `all` is the wipe-everything entry and covers the GLOBAL files too —
 * empty-window chats are conversations, so a label that says "every conversation
 * on this machine" has to mean them. It is never inferred from an empty
 * selection: a memory-only run (checkbox ticked, no workspace chosen) must not be
 * read as "clean everything", or deleting one preferences file would silently
 * destroy unrelated history in every project.
 */
export async function clean(targets: {
  global: boolean;
  all: boolean;
  workspaces: { id: string; folders: string[]; unresolvedFolders?: boolean }[];
  /** Explicit catalog-only selection: paths not attributed to a workspace during discovery. */
  unattributedCwds?: readonly string[];
  /** Opt-in: also delete Copilot repo memory for the listed workspaces. */
  repoMemory?: boolean;
  /** Opt-in: also delete Copilot GLOBAL user memory (not workspace-scoped). */
  userMemory?: boolean;
}): Promise<CleanOutcome> {
  const outcome = emptyOutcome();

  if (targets.all) {
    mergeOutcome(outcome, await cleanAgentStore({ kind: 'all' }));
  } else if (targets.global || targets.workspaces.length > 0 || targets.unattributedCwds?.length) {
    // `global` reaches the folderless rows only: history that belongs to no
    // workspace is global history, not every project's history.
    // Deduplicated: a folder can be both a standalone workspace and one root of
    // a multi-root one, so the same catalog rows can arrive twice. The DELETE
    // would tolerate a repeated placeholder, but the bound-parameter count and
    // the reported figure should describe the selection, not the flattening.
    const cwds = [...new Set([...targets.workspaces.flatMap(w => w.folders), ...(targets.unattributedCwds ?? [])])];
    mergeOutcome(
      outcome,
      await cleanAgentStore(targets.global ? { kind: 'folders+null', cwds } : { kind: 'folders', cwds }),
    );
  }

  if (!outcome.agentStoreError) {
    for (const ws of targets.workspaces) {
      mergeOutcome(outcome, await cleanStore(ws.id, WORKSPACE_SESSION_DIRS));
    }
    if (targets.global || targets.all) {
      mergeOutcome(outcome, await cleanStore(GLOBAL_ID, GLOBAL_SESSION_DIRS));
    }

    if (targets.repoMemory || targets.userMemory) {
      await cleanMemory(targets.workspaces.map(w => w.id), targets.repoMemory, targets.userMemory, outcome);
    }
  }

  // Unresolved roots cannot be attributed to the selected workspace even when
  // other roots were readable or the separate unattributed scope was selected.
  outcome.unresolvedWorkspaces = targets.all
    ? []
    : targets.workspaces.filter(w => w.folders.length === 0 || w.unresolvedFolders).map(w => w.id);
  if (outcome.unresolvedWorkspaces.length > 0) {
    log(
      'WARN',
      `Selected workspace(s) had unresolved folders, so some catalog conversations could not be attributed: ${outcome.unresolvedWorkspaces.join(', ')}.`,
    );
  }
  return outcome;
}

/**
 * Session residue for ONE storage target: its index key plus the directories
 * under it. `GLOBAL_ID` selects the global store and the empty-window chats,
 * any other id a workspace-storage directory. Catalog and memory are separate
 * concerns with separate entry points (`cleanAgentStore`, `cleanMemory`).
 */
async function cleanStore(wsId: string, dirs: readonly string[]): Promise<CleanOutcome> {
  const outcome = emptyOutcome();
  const keys = await deleteIndexKey(wsId === GLOBAL_ID ? globalDbPath() : wsDbPath(wsId));
  if (keys < 0) {
    outcome.dbError = true;
    return outcome;
  }
  outcome.removedKeys += keys;
  const { removedDirs, dirError } = await removeDirs(wsId, dirs);
  outcome.removedDirs = removedDirs;
  outcome.dirError = dirError;
  return outcome;
}

/**
 * Opt-in memory deletion, recording what ACTUALLY happened.
 *
 * Repo memory is per workspace, so an empty `wsIds` means the option was ticked
 * with nothing to apply it to: the guard in the command catches the obvious
 * case, but a wipe-everything run plus the memory box reaches here with no
 * workspace and used to report a deletion that never had a target.
 *
 * A directory that was never there is neither removed nor a failure.
 */
async function cleanMemory(
  wsIds: string[],
  repo: boolean | undefined,
  user: boolean | undefined,
  outcome: CleanOutcome,
): Promise<void> {
  if (repo) {
    // GLOBAL_ID must never reach this loop. The global store's repo-memory path
    // (`GitHub.copilot-chat/memory-tool/memories`) and the global USER-memory
    // path (`github.copilot-chat/memory-tool/memories`) differ only in case,
    // so on Windows and macOS they are the SAME directory - verified by writing
    // through one path and reading through the other. A global entry here would
    // delete user memory while the summary says it was kept, so the id is
    // dropped rather than trusted, and the caller filters it too: one guard in
    // one place is exactly what failed to hold before.
    const ids = wsIds.filter(id => id !== GLOBAL_ID);
    if (wsIds.length !== ids.length) {
      log('WARN', 'Repo-memory list contained the global id; ignored so it cannot reach global user memory.');
    }
    for (const wsId of ids) {
      const result = await removeDir(storageDir(wsId, WORKSPACE_MEMORY_DIR));
      if (result === 'removed') outcome.repoMemoryRemoved = true;
      if (result === 'failed' || result === 'incomplete') outcome.repoMemoryError = true;
      if (result === 'incomplete') outcome.repoMemoryMayBePartial = true;
    }
  }
  if (user) {
    // NOT workspace-scoped: this file is read by every project on the machine,
    // which is why it gets its own confirm wording rather than riding along
    // with the workspace selection.
    const result = await removeDir(storageDir(GLOBAL_ID, GLOBAL_MEMORY_DIR));
    outcome.userMemoryRemoved = result === 'removed';
    outcome.userMemoryError = result === 'failed' || result === 'incomplete';
    outcome.userMemoryMayBePartial = result === 'incomplete';
  }
}

// ── Filesystem operations ──────────────────────────────────────────────────

/**
 * Remove a directory, distinguishing absence, precheck failure and interrupted removal.
 * `fs.rm(force:true)` succeeds on an absent path, so callers must pre-check
 * (see `removeDirs`) or they will report every target as removed on every run.
 */
async function removeDir(dirPath: string): Promise<'removed' | 'absent' | 'failed' | 'incomplete'> {
  try {
    if (!(await fileExists(dirPath))) return 'absent';
  } catch (err) {
    log('WARN', `Cannot inspect ${dirPath} before removal: ${errStr(err)}`);
    return 'failed';
  }
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
    log('INFO', `Removed directory: ${dirPath}`);
    return 'removed';
  } catch (err) {
    log('WARN', `Failed to remove ${dirPath}: ${errStr(err)}`);
    return 'incomplete';
  }
}

async function countFilesInDir(dirPath: string): Promise<number> {
  let count = 0;
  try {
    for (const entry of await fs.readdir(dirPath, { withFileTypes: true })) {
      count += entry.isDirectory() ? await countFilesInDir(path.join(dirPath, entry.name)) : 1;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    log('WARN', `Cannot count session files in ${dirPath}: ${errStr(err)}`);
    throw err;
  }
  return count;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Delete the session index key from a `state.vscdb`.
 * Returns the row count, or -1 when the database could not be written.
 *
 * The -1 matters: returning 0 for "nothing to delete" and 0 for "the file is
 * corrupt or locked" is the silent failure this report exists to prevent. A
 * caller that cannot tell them apart reports success for a wipe that did not
 * happen.
 */
async function deleteIndexKey(dbPath: string): Promise<number> {
  let db: DatabaseSync | undefined;
  try {
    if (!(await fileExists(dbPath))) return 0;
    db = new DatabaseSync(dbPath);
    const changes = db.prepare('DELETE FROM ItemTable WHERE key = ?').run(SESSION_INDEX_KEY).changes;
    const total = typeof changes === 'number' ? changes : Number(changes);
    log('INFO', `Deleted ${total} session index key(s) from ${dbPath}.`);
    return total;
  } catch (err) {
    log('ERROR', `Failed to delete session index from ${dbPath}: ${errStr(err)}`);
    return -1;
  } finally {
    db?.close();
  }
}

/**
 * Count entries in the session index key. A missing DB or key counts as 0;
 * malformed data or a read failure makes discovery incomplete.
 */
async function countIndexEntries(dbPath: string): Promise<number> {
  if (!(await fileExists(dbPath))) return 0;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get(SESSION_INDEX_KEY) as { value: string } | undefined;
    if (!row) return 0;
    const parsed = JSON.parse(row.value) as { entries?: unknown };
    return parsed.entries && typeof parsed.entries === 'object' ? Object.keys(parsed.entries).length : 0;
  } catch (err) {
    log('WARN', `Could not count sessions in ${dbPath}: ${errStr(err)}`);
    throw err;
  } finally {
    db?.close();
  }
}

/** Copilot catalog sessions by cwd, plus child rows without a surviving session. */
async function scanAgentStore(): Promise<{ agentByCwd: Map<string, number>; orphanedRows: number }> {
  const agentByCwd = new Map<string, number>();
  const dbPath = agentStorePath();
  if (!(await fileExists(dbPath))) return { agentByCwd, orphanedRows: 0 };
  let db: DatabaseSync | undefined;
  let orphanedRows = 0;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    for (const r of db.prepare('SELECT cwd, COUNT(*) AS c FROM sessions GROUP BY cwd').all() as {
      cwd: string | null;
      c: number;
    }[]) {
      const key = r.cwd === null ? NULL_CWD : normalizeCwd(r.cwd);
      agentByCwd.set(key, (agentByCwd.get(key) ?? 0) + r.c);
    }
    orphanedRows = countOrphanedCatalogRows(db);
  } catch (err) {
    log('WARN', `Could not scan Copilot catalog: ${errStr(err)}`);
    throw err;
  } finally {
    db?.close();
  }
  return { agentByCwd, orphanedRows };
}

/** Files under the given storage-relative directories. */
async function countFilesInDirs(wsId: string, dirs: readonly string[]): Promise<number> {
  const counts = await Promise.all(
    dirs.map(d => {
      const full = wsId === GLOBAL_ID
        ? path.join(vsCodeRoot(), 'globalStorage', ...d.split('/'))
        : wsDir(wsId, ...d.split('/'));
      return countFilesInDir(full);
    }),
  );
  return counts.reduce((a, b) => a + b, 0);
}

/**
 * Remove directories, counting only those that actually existed. See the
 * `removeDir` note: trusting `fs.rm`'s return on absent paths is the exact lie
 * this summary exists to stop telling.
 */
async function removeDirs(wsId: string, dirs: readonly string[]): Promise<{ removedDirs: number; dirError: boolean }> {
  let removedDirs = 0;
  let dirError = false;
  for (const d of dirs) {
    const result = await removeDir(storageDir(wsId, d));
    if (result === 'removed') removedDirs += 1;
    if (result === 'failed' || result === 'incomplete') dirError = true;
  }
  return { removedDirs, dirError };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** An unreadable optional memory target stays selectable without blocking session cleanup. */
async function memoryDirMayExist(dirPath: string): Promise<boolean> {
  try {
    return await fileExists(dirPath);
  } catch (err) {
    log('WARN', `Cannot inspect Copilot memory at ${dirPath}: ${errStr(err)}`);
    return true;
  }
}

/**
 * Resolve every folder in a workspace's `workspace.json`.
 *
 * Single-folder workspaces have `folder: "file:///c%3A/path"`; multi-root ones
 * have `folders: [{ uri: ... }, ...]`. Returning ALL of them is what makes a
 * multi-root workspace actually cleanable: the catalog stores one row per
 * folder, so taking only the first root leaves the other roots' conversations —
 * and their full text — behind with no entry that can ever reach them.
 *
 * A saved multi-root workspace (`.code-workspace`) and a saved untitled
 * workspace record the workspace FILE instead, so the pointer has to be
 * followed. Skipping it left those entries with no folders at all, which
 * undercounted them in the picker and gave the catalog DELETE no `cwd` to match
 * — the wipe reported the workspace as cleared while its text stayed in the
 * database.
 *
 * Exported for testing, the same as `userDataRootFromGlobalStorage`: the URI
 * decoding is the kind of thing that regresses silently, and a failure here
 * under-deletes rather than throwing.
 */
type WorkspaceFolderResolution = { folders: string[]; unresolved: boolean };

export async function readWorkspaceFolders(wsId: string): Promise<string[]> {
  return (await resolveWorkspaceFolders(wsId)).folders;
}

async function resolveWorkspaceFolders(wsId: string): Promise<WorkspaceFolderResolution> {
  try {
    const data = JSON.parse(
      await fs.readFile(path.join(workspaceStorageRoot(), wsId, 'workspace.json'), 'utf-8'),
    );
    const raws: string[] = [];
    let unresolved = false;
    if (typeof data.folder === 'string') raws.push(data.folder);
    if (Array.isArray(data.folders)) {
      for (const f of data.folders) {
        if (typeof f?.uri === 'string') raws.push(f.uri);
        else unresolved = true;
      }
    }
    if (typeof data.workspace === 'string') {
      try {
        const fromFile = await workspaceFileFolders(data.workspace);
        raws.push(...fromFile.folders);
        unresolved ||= fromFile.unresolved;
      } catch (err) {
        log('WARN', `Cannot read workspace file for ${wsId}: ${errStr(err)}`);
        unresolved = true;
      }
    }
    const folders: string[] = [];
    const seen = new Set<string>();
    for (const raw of raws) {
      const folder = localPathFrom(raw);
      if (folder === undefined) unresolved = true;
      else if (!seen.has(normalizeCwd(folder))) {
        seen.add(normalizeCwd(folder));
        folders.push(folder);
      }
    }
    return { folders, unresolved };
  } catch (err) {
    // An absent workspace.json is the normal empty-window case and says nothing.
    // A file that EXISTS and fails to parse is a real loss of scope: the folders
    // are unknown, so the catalog rows keyed to them become unreachable, and a
    // silent catch would turn that into a wipe reported as complete.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(
        'WARN',
        `Cannot read workspace.json for ${wsId} (${errStr(err)}). Its folders are unknown, so its ` +
          'catalog text cannot be matched by this command.',
      );
    }
    return { folders: [], unresolved: (err as NodeJS.ErrnoException).code !== 'ENOENT' };
  }
}

/**
 * Read the folders out of the workspace file a `workspace` pointer names.
 *
 * Two formats are reachable. A `.code-workspace` is JSONC carrying `path`
 * values resolved against the workspace file's own directory; a saved untitled
 * workspace is a `workspace.json` carrying `{ uri }` values exactly like the
 * multi-root storage file. Returns whatever each entry holds; `localPathFrom`
 * is what turns it into a path.
 */
async function workspaceFileFolders(workspaceUri: string): Promise<WorkspaceFolderResolution> {
  const filePath = localPathFrom(workspaceUri);
  if (!filePath) return { folders: [], unresolved: true };
  const data = JSON.parse(stripJsonc(await fs.readFile(filePath, 'utf-8')));
  if (!Array.isArray(data?.folders)) return { folders: [], unresolved: true };
  const base = path.dirname(filePath);
  const folders: string[] = [];
  let unresolved = false;
  for (const f of data.folders) {
    const value = typeof f?.path === 'string' ? f.path : typeof f?.uri === 'string' ? f.uri : undefined;
    const folder = value === undefined ? undefined : localPathFrom(value, base);
    if (folder === undefined) unresolved = true;
    else folders.push(folder);
  }
  // A `path` entry is relative to the workspace file unless it is absolute, and
  // a `uri` entry never is. Resolving both against the file's directory is
  // what makes the relative form land on the same `cwd` the catalog stored.
  return { folders, unresolved };
}

/**
 * Turn one folder entry into a local absolute path, or undefined when it is not
 * one. `base` is the directory a bare or relative path resolves against.
 *
 * `fileURLToPath` is the only correct URI decoder here. The hand-rolled
 * `slice off file://` chain this replaced ate the leading slash of every POSIX
 * path and flattened a Windows UNC authority into a relative-looking string.
 * Neither form folds onto the stored `sessions.cwd`, so those folders silently
 * counted as nothing in discovery and were unreachable by the catalog DELETE.
 *
 * A non-file scheme (a remote workspace, `vscode-remote://…`) has no local
 * folder path and its catalog rows are keyed by something that cannot be
 * reconstructed from here, so it yields undefined rather than a guess.
 */
function localPathFrom(value: string, base?: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      return fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  if (base !== undefined) return path.resolve(base, value);
  return path.isAbsolute(value) ? value : undefined;
}

function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

