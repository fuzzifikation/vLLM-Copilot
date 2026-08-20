import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;
let activeVsCodeUserRoot: string | undefined;
/** Buffer for log messages produced before setSessionManagerOutput() is called. */
const preInitQueue: Array<{ level: string; msg: string }> = [];

export function setSessionManagerOutput(
  channel: vscode.OutputChannel,
  extensionGlobalStoragePath: string,
): void {
  outputChannel = channel;
  activeVsCodeUserRoot = userDataRootFromGlobalStorage(extensionGlobalStoragePath);
  // Flush any messages that accumulated before init
  for (const entry of preInitQueue) {
    outputChannel.appendLine(`[sessionManager] [${entry.level}] ${entry.msg}`);
  }
  preInitQueue.length = 0;
}

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  const line = `[sessionManager] [${level}] ${msg}`;
  if (outputChannel) {
    outputChannel.appendLine(line);
  } else {
    preInitQueue.push({ level, msg });
  }
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Keys in ItemTable that hold Copilot chat/session state. */
const CHAT_KEYS = [
  'chat.ChatSessionStore.index',
  'chat.terminalSessions',
  'agentSessions.state.cache',
  'agentSessions.model.cache',
  'agentSessions.readDateBaseline2',
  'memento/interactive-session',
  'memento/interactive-session-view-copilot',
  'memento/chat-todo-list',
  'chat.untitledInputState',
  'terminalChat.toolSessionMappings',
];

// ── Path helpers (cross-platform) ──────────────────────────────────────────

/**
 * Derive the active VS Code user-data root from this extension's global storage:
 * `<user-data>/User/globalStorage/<publisher.extension>` → `<user-data>/User`.
 * This follows the running product automatically (Stable, Insiders, VSCodium,
 * portable/custom `--user-data-dir`) instead of guessing its directory name.
 */
export function userDataRootFromGlobalStorage(extensionGlobalStoragePath: string): string {
  return path.dirname(path.dirname(path.resolve(extensionGlobalStoragePath)));
}

function vsCodeRoot(): string {
  if (activeVsCodeUserRoot) return activeVsCodeUserRoot;

  // Defensive fallback for direct module use before extension activation.
  const home = os.homedir();
  const p = os.platform();
  const productDir = /insiders/i.test(vscode.env.appName) ? 'Code - Insiders' : 'Code';
  if (p === 'win32') return path.join(home, 'AppData', 'Roaming', productDir, 'User');
  if (p === 'darwin') return path.join(home, 'Library', 'Application Support', productDir, 'User');
  return path.join(home, '.config', productDir, 'User');
}

function globalDbPath(): string {
  return path.join(vsCodeRoot(), 'globalStorage', 'state.vscdb');
}

function workspaceStorageRoot(): string {
  return path.join(vsCodeRoot(), 'workspaceStorage');
}

function wsDbPath(wsId: string): string {
  return path.join(workspaceStorageRoot(), wsId, 'state.vscdb');
}

function wsJsonPath(wsId: string): string {
  return path.join(workspaceStorageRoot(), wsId, 'workspace.json');
}

function chatDirPath(wsId: string): string {
  return path.join(workspaceStorageRoot(), wsId, 'GitHub.copilot-chat');
}

/** chatSessions/ — side panel chat history (JSON files per session). */
function chatSessionsDirPath(wsId: string): string {
  return path.join(workspaceStorageRoot(), wsId, 'chatSessions');
}

/** chatEditingSessions/ — inline chat/edit history (JSON files per session). */
function chatEditingSessionsDirPath(wsId: string): string {
  return path.join(workspaceStorageRoot(), wsId, 'chatEditingSessions');
}

// ── Types ───────────────────────────────────────────────────────────────────

/** One entry describing a workspace (or global) that has Copilot sessions. */
export interface WorkspaceEntry {
  /** Unique id for the picker ("__global__" or a hashed workspace id). */
  id: string;
  /** Human-readable label (folder path or "All global sessions"). */
  label: string;
  /** Number of DB session index entries. */
  dbSessions: number;
  /** Number of filesystem session files (chatSessions + chatEditingSessions). */
  fsSessions: number;
  /** Total sessions (dbSessions + fsSessions). */
  sessions: number;
}

/** QuickPick item for session cleanup (extends vscode.QuickPickItem with an id). */
export interface SessionPickedItem extends vscode.QuickPickItem {
  id: string;
}

// ── Discovery ───────────────────────────────────────────────────────────────

/** Scan all VS Code storage and return every workspace (plus global) with sessions. */
export async function discoverWorkspaces(): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [];

  // Collect all DB paths at once, then batch-query them via node:sqlite
  const dbPathMap = new Map<string, string>(); // dbPath -> id

  const globalPath = globalDbPath();
  dbPathMap.set(globalPath, '__global__');

  const wsRoot = workspaceStorageRoot();
  const wsIds: string[] = [];
  try {
    const dirs = (await fs.readdir(wsRoot, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name);
    log('INFO', `Discovered ${dirs.length} workspace storage directory(ies).`);

    for (const wsId of dirs) {
      dbPathMap.set(wsDbPath(wsId), wsId);
      wsIds.push(wsId);
    }
  } catch (err) {
    log('WARN', `Cannot read workspace storage at ${wsRoot}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Batch count all DBs via node:sqlite
  const dbCounts = await countSessionsBatch([...dbPathMap.entries()]);

  // Also scan filesystem session directories for each workspace
  const fsCountTasks = wsIds.map(async (wsId) => {
    const chatSessionsCount = await countFilesInDir(chatSessionsDirPath(wsId));
    const chatEditingCount = await countFilesInDir(chatEditingSessionsDirPath(wsId));
    return { wsId, count: chatSessionsCount + chatEditingCount };
  });
  const fsCounts = await Promise.all(fsCountTasks);
  const fsCountMap = new Map<string, number>(fsCounts.map(({ wsId, count }) => [wsId, count]));

  // Build result for global — DB keys only; no filesystem session dirs exist in globalStorage
  {
    const dbCount = dbCounts.get(globalPath) ?? 0;
    if (dbCount > 0) {
      entries.push({ id: '__global__', label: 'All global sessions', dbSessions: dbCount, fsSessions: 0, sessions: dbCount });
    }
  }

  // Build result for each workspace
  for (const wsId of wsIds) {
    const dbPath = wsDbPath(wsId);
    const dbCount = dbCounts.get(dbPath) ?? 0;
    const fsCount = fsCountMap.get(wsId) ?? 0;
    const total = dbCount + fsCount;
    if (total === 0) continue;

    const folder = await readWorkspaceFolder(wsId);
    entries.push({ id: wsId, label: folder, dbSessions: dbCount, fsSessions: fsCount, sessions: total });
  }

  return entries;
}

// ── SQLite operations (via node:sqlite) ────────────────────────────────────
// node:sqlite ships with VS Code's bundled Node. The `--experimental-sqlite`
// flag was removed on Node 22.13.0 (Jan 2025, PR nodejs/node#55890), so any
// VS Code version bundling Node ≥ 22.13 has `DatabaseSync` available without a
// flag (it may emit an `ExperimentalWarning`, which is informational — the
// module is Stability 1.2/R release-candidate as of Node 26). VS Code 1.122
// (May 2026) ships Node 22.22.1 (`cgmanifest.json`, tag 1.122.0), well past the
// unflag — that is the basis for `engines.vscode` = ^1.122.0. No Python
// dependency, no native binding, no temp files.

/**
 * Delete the CHAT_KEYS from a given state.vscdb.
 * Returns the number of rows actually deleted.
 *
 * Each DELETE is parameterized (defense-in-depth; CHAT_KEYS is hardcoded but the
 * pattern matters for future maintenance). Uses `node:sqlite`'s synchronous API
 * — `changes` is the per-statement rowcount (0 if no row matched).
 */
export async function deleteChatKeys(dbPath: string): Promise<number> {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    const del = db.prepare('DELETE FROM ItemTable WHERE key = ?');
    let total = 0;
    for (const key of CHAT_KEYS) {
      const changes = del.run(key).changes;
      // changes is a number unless readBigInts is enabled (we don't enable it),
      // but the type allows bigint — coerce for arithmetic safety.
      total += typeof changes === 'number' ? changes : Number(changes);
    }
    log('INFO', `Deleted ${total} key(s) from ${dbPath}.`);
    return total;
  } catch (err) {
    log('ERROR', `Failed to delete keys from ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
    return -1; // distinguish "operation failed" from "no keys existed"
  } finally {
    db?.close();
  }
}

/**
 * Count sessions in multiple DBs.
 * Returns a map of dbPath -> session count (0 if the DB is missing, malformed,
 * or the session index key is absent — matches the previous Python behavior of
 * silently treating any per-DB failure as zero so one bad DB doesn't sink the
 * whole scan).
 */
async function countSessionsBatch(
  dbPathIdPairs: Array<[string, string]>,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  const existingPaths = (await Promise.all(
    dbPathIdPairs.map(async ([p]) => (await fileExists(p)) ? p : null),
  )).filter(Boolean) as string[];

  if (existingPaths.length === 0) {
    log('INFO', 'No database files found to scan.');
    return results;
  }
  log('INFO', `Scanning ${existingPaths.length} database(s) for session counts.`);

  for (const dbPath of existingPaths) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'")
        .get() as { value: string } | undefined;
      if (!row) {
        results.set(dbPath, 0);
      } else {
        const parsed = JSON.parse(row.value) as { entries?: unknown };
        results.set(dbPath, parsed.entries && typeof parsed.entries === 'object'
          ? Object.keys(parsed.entries).length
          : 0);
      }
    } catch (err) {
      log('WARN', `Could not count sessions in ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
      results.set(dbPath, 0);
    } finally {
      db?.close();
    }
  }

  log('INFO', `Session scan complete: ${[...results.entries()].map(([p, c]) => `${path.basename(p)}=${c}`).join(', ')}.`);
  return results;
}

// ── Filesystem operations ──────────────────────────────────────────────────

/** Remove the GitHub.copilot-chat directory for a workspace (transcripts, logs, etc.). */
export async function removeChatDir(wsId: string): Promise<boolean> {
  const dirPath = chatDirPath(wsId);
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
    log('INFO', `Removed chat directory: ${dirPath}`);
    return true;
  } catch (err) {
    log('WARN', `Failed to remove chat directory ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Remove the chatSessions directory for a workspace (side panel chat history files). */
export async function removeChatSessions(wsId: string): Promise<boolean> {
  const dirPath = chatSessionsDirPath(wsId);
  return removeDir(dirPath);
}

/** Remove the chatEditingSessions directory for a workspace (inline chat history files). */
export async function removeChatEditingSessions(wsId: string): Promise<boolean> {
  const dirPath = chatEditingSessionsDirPath(wsId);
  return removeDir(dirPath);
}

async function removeDir(dirPath: string): Promise<boolean> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
    log('INFO', `Removed directory: ${dirPath}`);
    return true;
  } catch (err) {
    log('WARN', `Failed to remove ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Count files recursively in a directory. Returns 0 if the directory doesn't exist.
 */
async function countFilesInDir(dirPath: string): Promise<number> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        count += await countFilesInDir(fullPath);
      } else {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Clean a single workspace (or global, if wsId === '__global__').
 * Returns summary of what was removed.
 */
export async function cleanWorkspace(wsId: string): Promise<{
  dbKeysRemoved: number;
  dbError: boolean;
  chatDirRemoved: boolean;
  chatSessionsRemoved: boolean;
  chatEditingSessionsRemoved: boolean;
}> {
  const dbPath = wsId === '__global__' ? globalDbPath() : wsDbPath(wsId);
  const keysRemoved = await deleteChatKeys(dbPath);
  const dbError = keysRemoved < 0;
  const dirRemoved = wsId !== '__global__' && (await removeChatDir(wsId));

  // Clean filesystem session directories (workspaceStorage only — globalStorage has none)
  let chatSessionsRemoved = false;
  let chatEditingSessionsRemoved = false;

  if (wsId !== '__global__') {
    chatSessionsRemoved = await removeChatSessions(wsId);
    chatEditingSessionsRemoved = await removeChatEditingSessions(wsId);
  }

  return { dbKeysRemoved: keysRemoved, dbError, chatDirRemoved: dirRemoved, chatSessionsRemoved, chatEditingSessionsRemoved };
}

// ── Internal helpers ───────────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readWorkspaceFolder(wsId: string): Promise<string> {
  const jsonPath = wsJsonPath(wsId);
  if (await fileExists(jsonPath)) {
    try {
      const data = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
      // Single-folder workspaces have `folder: "file:///c%3A/path"`
      // Multi-root workspaces have `folders: [{ uri: "file:///c%3A/path" }]`
      const raw = data.folder ?? data.folders?.[0]?.uri ?? '?';
      // Decode URI (e.g. file:///c%3A/Github%20Projects/foo → file:///c:/Github Projects/foo)
      const decoded = decodeURIComponent(raw);
      // Strip the file:// scheme and leading slash
      return decoded.replace(/^file:\/\//, '').replace(/^\//, '');
    } catch {
      /* fall through */
    }
  }
  return wsId;
}

