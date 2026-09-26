import * as fs from 'fs/promises';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

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
 * See `cleanWorkspaceMemory` / `cleanGlobalMemory`.
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
 */
export function normalizeCwd(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
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
  /** Copilot catalog sessions removed, with all dependent rows. */
  removedAgentSessions: number;
  /** A `state.vscdb` could not be opened or written. */
  dbError: boolean;
  agentStoreError: boolean;
  /** VACUUM ran, so freed pages in the main database file are gone. */
  compacted: boolean;
}

function emptyOutcome(): CleanOutcome {
  return {
    removedKeys: 0,
    removedDirs: 0,
    removedAgentSessions: 0,
    dbError: false,
    agentStoreError: false,
    compacted: false,
  };
}

function mergeOutcome(into: CleanOutcome, from: CleanOutcome): void {
  into.removedKeys += from.removedKeys;
  into.removedDirs += from.removedDirs;
  into.removedAgentSessions += from.removedAgentSessions;
  into.dbError ||= from.dbError;
  into.agentStoreError ||= from.agentStoreError;
  into.compacted ||= from.compacted;
}

// ── Discovery ───────────────────────────────────────────────────────────────

/**
 * Scan all VS Code storage and return every workspace (plus global) that holds
 * sessions. The counts deliberately include the Copilot catalog, so the picker
 * does not understate what the wipe is about to remove.
 */
export async function discoverWorkspaces(): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [];

  let wsIds: string[] = [];
  try {
    wsIds = (await fs.readdir(workspaceStorageRoot(), { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name);
    log('INFO', `Discovered ${wsIds.length} workspace storage directory(ies).`);
  } catch (err) {
    log('WARN', `Cannot read workspace storage at ${workspaceStorageRoot()}: ${errStr(err)}`);
  }

  const perWorkspace = await Promise.all(
    wsIds.map(async wsId => {
      const [indexEntries, fsSessions, folders] = await Promise.all([
        countIndexEntries(wsDbPath(wsId)),
        countFilesInDirs(wsId, WORKSPACE_SESSION_DIRS),
        readWorkspaceFolders(wsId),
      ]);
      return { wsId, indexEntries, fsSessions, folders };
    }),
  );

  // Copilot catalog rows, bucketed by the normalized cwd they belong to.
  const agentByCwd = await countAgentSessionsByCwd();

  const globalDb = await countIndexEntries(globalDbPath());
  const globalAgent = agentByCwd.get(NULL_CWD) ?? 0;
  // The global entry also covers empty-window chats, so it has to stay visible
  // when those are the only residue left — otherwise the files exist and the
  // command that deletes them is not on the list.
  const globalFs = await countFilesInDirs(GLOBAL_ID, GLOBAL_SESSION_DIRS);
  if (globalDb + globalAgent + globalFs > 0) {
    entries.push({
      id: GLOBAL_ID,
      label: 'All global sessions',
      folders: [],
      fsSessions: globalFs,
      conversations: globalDb + globalAgent,
    });
  }

  for (const { wsId, indexEntries, fsSessions, folders } of perWorkspace) {
    // EVERY root counts: a multi-root workspace owns the history of each folder
    // it contains, and the catalog keys rows by folder, not by workspace.
    const agentEntries = folders.reduce((sum, f) => sum + (agentByCwd.get(normalizeCwd(f)) ?? 0), 0);
    // Files alone still make a workspace worth listing: they are deletable
    // residue even when no conversation is indexed for it.
    if (indexEntries + agentEntries + fsSessions === 0) continue;
    entries.push({
      id: wsId,
      label: folders.length > 1 ? `${folders[0]} (+${folders.length - 1} more)` : (folders[0] ?? wsId),
      folders,
      fsSessions,
      conversations: indexEntries + agentEntries,
    });
  }

  return entries;
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
  if (!(await fileExists(dbPath))) {
    log('INFO', `Copilot session catalog not present at ${dbPath} - nothing to delete.`);
    return outcome;
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    if (scope.kind === 'all') {
      outcome.removedAgentSessions = deleteCatalogRows(db, '', []);
      log('INFO', `Copilot catalog: removed ${outcome.removedAgentSessions} session(s) (ALL).`);
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
        outcome.removedAgentSessions = deleteCatalogRows(db, where, targets);
      }
      log(
        'INFO',
        `Copilot catalog: removed ${outcome.removedAgentSessions} session(s) (${targets.join(', ') || 'no matching cwd'}).`,
      );
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
  outcome.compacted = await compactAgentStore();
  return outcome;
}

/** The DISTINCT stored `cwd` strings that fold onto the wanted set. */
function selectCwdStrings(db: DatabaseSync, wanted: Set<string>): string[] {
  const out: string[] = [];
  for (const r of db.prepare('SELECT DISTINCT cwd FROM sessions').all() as { cwd: string | null }[]) {
    if (r.cwd !== null && wanted.has(normalizeCwd(r.cwd))) out.push(r.cwd);
  }
  return out;
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
function deleteCatalogRows(db: DatabaseSync, where: string, bound: readonly string[]): number {
  const parentFilter = where ? ` WHERE ${where}` : '';
  // CHILDREN FIRST: the child deletes select through `sessions`, so the parent
  // rows must still be there for the subquery to match. Deleting the parent
  // first silently removes zero children and leaves every turn (and its FTS
  // copy) behind while the summary claims the sessions are gone.
  const childFilter = where ? ` WHERE session_id IN (SELECT id FROM sessions WHERE ${where})` : '';

  db.exec('BEGIN IMMEDIATE');
  try {
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
    db.exec('COMMIT');
    return removed;
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
 */
async function compactAgentStore(): Promise<boolean> {
  const dbPath = agentStorePath();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    try {
      db.exec('VACUUM');
      log('INFO', 'Copilot catalog: VACUUM completed - freed pages removed from the main database file.');
      return true;
    } catch (err) {
      log(
        'WARN',
        `Copilot catalog: VACUUM skipped (${errStr(err)}). Deleted sessions are no longer findable, but their bytes stay in the file until VS Code closes and the database is rewritten.`,
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
  workspaces: { id: string; folders: string[] }[];
}): Promise<CleanOutcome> {
  const outcome = emptyOutcome();

  for (const ws of targets.workspaces) {
    mergeOutcome(outcome, await cleanWorkspace(ws.id));
  }
  if (targets.global || targets.all) {
    mergeOutcome(outcome, await cleanGlobal());
  }

  if (targets.all) {
    mergeOutcome(outcome, await cleanAgentStore({ kind: 'all' }));
  } else if (targets.global || targets.workspaces.length > 0) {
    // `global` reaches the folderless rows only: history that belongs to no
    // workspace is global history, not every project's history.
    // Deduplicated: a folder can be both a standalone workspace and one root of
    // a multi-root one, so the same catalog rows can arrive twice. The DELETE
    // would tolerate a repeated placeholder, but the bound-parameter count and
    // the reported figure should describe the selection, not the flattening.
    const cwds = [...new Set(targets.workspaces.flatMap(w => w.folders))];
    mergeOutcome(
      outcome,
      await cleanAgentStore(targets.global ? { kind: 'folders+null', cwds } : { kind: 'folders', cwds }),
    );
  }
  return outcome;
}

/** Remove session residue for one workspace. Catalog and memory are separate. */
export async function cleanWorkspace(wsId: string): Promise<CleanOutcome> {
  const outcome = emptyOutcome();
  const keys = await deleteIndexKey(wsDbPath(wsId));
  if (keys < 0) outcome.dbError = true;
  else outcome.removedKeys += keys;
  outcome.removedDirs += await removeDirs(wsId, WORKSPACE_SESSION_DIRS);
  return outcome;
}

/** Remove global session residue (index key + empty-window chats). */
export async function cleanGlobal(): Promise<CleanOutcome> {
  const outcome = emptyOutcome();
  const keys = await deleteIndexKey(globalDbPath());
  if (keys < 0) outcome.dbError = true;
  else outcome.removedKeys += keys;
  outcome.removedDirs += await removeDirs(GLOBAL_ID, GLOBAL_SESSION_DIRS);
  return outcome;
}

/** Opt-in: delete Copilot repo memory for one workspace only. */
export async function cleanWorkspaceMemory(wsId: string): Promise<boolean> {
  return removeDir(wsDir(wsId, ...WORKSPACE_MEMORY_DIR.split('/')));
}

/**
 * Opt-in: delete Copilot user-level memory. NOT workspace-scoped — this file is
 * read by every project on the machine, which is why it gets its own confirm
 * wording rather than riding along with the workspace selection.
 */
export async function cleanGlobalMemory(): Promise<boolean> {
  return removeDir(path.join(vsCodeRoot(), 'globalStorage', ...GLOBAL_MEMORY_DIR.split('/')));
}

// ── Filesystem operations ──────────────────────────────────────────────────

/**
 * Remove a directory, returning false when it was not there to begin with.
 * `fs.rm(force:true)` succeeds on an absent path, so callers must pre-check
 * (see `removeDirs`) or they will report every target as removed on every run.
 */
async function removeDir(dirPath: string): Promise<boolean> {
  if (!(await fileExists(dirPath))) return false;
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
    log('INFO', `Removed directory: ${dirPath}`);
    return true;
  } catch (err) {
    log('WARN', `Failed to remove ${dirPath}: ${errStr(err)}`);
    return false;
  }
}

async function countFilesInDir(dirPath: string): Promise<number> {
  let count = 0;
  try {
    for (const entry of await fs.readdir(dirPath, { withFileTypes: true })) {
      count += entry.isDirectory() ? await countFilesInDir(path.join(dirPath, entry.name)) : 1;
    }
  } catch {
    return 0;
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
  if (!(await fileExists(dbPath))) return 0;
  let db: DatabaseSync | undefined;
  try {
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
 * Count entries in the session index key. A missing DB, missing key, or
 * malformed JSON counts as 0 so one bad workspace cannot sink the whole scan.
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
    return 0;
  } finally {
    db?.close();
  }
}

/** Copilot catalog session counts, bucketed by normalized `cwd` (null folded in). */
async function countAgentSessionsByCwd(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const dbPath = agentStorePath();
  if (!(await fileExists(dbPath))) return map;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    for (const r of db.prepare('SELECT cwd, COUNT(*) AS c FROM sessions GROUP BY cwd').all() as {
      cwd: string | null;
      c: number;
    }[]) {
      const key = r.cwd === null ? NULL_CWD : normalizeCwd(r.cwd);
      map.set(key, (map.get(key) ?? 0) + r.c);
    }
  } catch (err) {
    log('WARN', `Could not count Copilot catalog sessions: ${errStr(err)}`);
  } finally {
    db?.close();
  }
  return map;
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
async function removeDirs(wsId: string, dirs: readonly string[]): Promise<number> {
  let removed = 0;
  for (const d of dirs) {
    const target = wsId === GLOBAL_ID
      ? path.join(vsCodeRoot(), 'globalStorage', ...d.split('/'))
      : wsDir(wsId, ...d.split('/'));
    if (await removeDir(target)) removed += 1;
  }
  return removed;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
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
 */
async function readWorkspaceFolders(wsId: string): Promise<string[]> {
  try {
    const data = JSON.parse(
      await fs.readFile(path.join(workspaceStorageRoot(), wsId, 'workspace.json'), 'utf-8'),
    );
    const raws: string[] = [];
    if (typeof data.folder === 'string') raws.push(data.folder);
    if (Array.isArray(data.folders)) {
      for (const f of data.folders) {
        if (typeof f?.uri === 'string') raws.push(f.uri);
      }
    }
    const folders = raws
      .map(raw => decodeURIComponent(raw).replace(/^file:\/\//, '').replace(/^\//, ''))
      .filter(Boolean);
    // A remote workspace (vscode-remote://…) has no local folder path, and its
    // catalog rows are keyed by a path we cannot reconstruct. Keep it listed so
    // its on-disk residue is still reachable, but never match it against `cwd`.
    return folders.filter(f => !/^[a-z][a-z0-9+.-]*:\/\//i.test(f));
  } catch {
    return [];
  }
}

function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

