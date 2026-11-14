/**
 * Workspace handoff: register the editor's folder as a dsh workspace so a
 * harness started from this window opens where the user is actually working.
 *
 * dsh persists its workspace registry at `$DSH_HOME/storages/workspace.json`
 * (storage unit `workspace`, version 2): a `workspaces` table keyed by uuid
 * with `{ path, title, sessionIds, createdAt, updatedAt }`, plus
 * `global.workspaceIds` and `global.defaultWorkspaceId`. New sessions start
 * in the default; the UI picker lists the rest. Spike-verified 2026-10-05:
 * an entry written before boot appears in the picker and sessions run in it.
 *
 * This is live user data, so the rules are strict: upsert by path (never
 * duplicate an entry across restarts), never touch a registry we cannot parse
 * or whose schema version is not the one we verified, and write atomically.
 * Registering only immediately before our own spawn is deliberate: a harness
 * booted by another window (adoption) already told dsh its folder, and
 * rewriting the file under a running process races its in-memory state.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Relative to the `dsh-home` root; owned by dsh's storage layer. */
export const WORKSPACE_STORE_FILE = path.join('storages', 'workspace.json')

/** The single schema version this module has been verified against. */
const STORE_VERSION = 2

interface WorkspaceRow {
  path: string
  title: string
  sessionIds?: string[]
  createdAt?: string
  updatedAt?: string
}

interface WorkspaceStore {
  unit?: { name?: string; version?: number }
  global?: {
    initialized?: boolean
    workspaceIds?: string[]
    archivedSessionIds?: string[]
    pinnedSessionIds?: string[]
    defaultWorkspaceId?: string
  }
  tables?: { workspaces?: Record<string, WorkspaceRow> }
}

export interface WorkspaceLog {
  info(message: string): void
  warn(message: string): void
}

/**
 * The path form dsh itself resolves to: Node canonicalizes a Windows drive
 * letter to uppercase while resolving a session's cwd, but VS Code hands over
 * `workspaceFolders[0].uri.fsPath` with the drive letter exactly as the
 * window was opened, lowercase included. Writing the raw string put a
 * `g:\...` row beside dsh's canonical `G:\...` world, and every session then
 * died at attach: `could not attach to workspace ... its cwd resolves to
 * 'G:\...'`. Comparing and storing the canonical form is the fix.
 */
export function canonicalWorkspacePath(dir: string): string {
  return process.platform === 'win32' ? dir.replace(/^[a-z](?=:)/, (c) => c.toUpperCase()) : dir
}

/**
 * Make `dir` the default workspace of the harness home rooted at `dshHome`.
 * Returns true when the registry was written, false when it was deliberately
 * left alone (never a throw: a missing workspace must not kill the harness).
 */
export function registerDefaultWorkspace(dshHome: string, inputDir: string, log: WorkspaceLog): boolean {
  const file = path.join(dshHome, WORKSPACE_STORE_FILE)
  let store: WorkspaceStore = {}
  if (existsSync(file)) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      log.warn(`could not read the dsh workspace registry: ${(err as Error).message}`)
      return false
    }
    try {
      store = JSON.parse(text) as WorkspaceStore
    } catch {
      // Corrupt user data is dsh's to heal, not ours to overwrite.
      log.warn('the dsh workspace registry is not valid JSON; leaving the workspace choice to the harness UI')
      return false
    }
    const version = store.unit?.version
    if (version !== undefined && version !== STORE_VERSION) {
      log.warn(`dsh workspace registry schema is version ${version}; this bridge only writes version ${STORE_VERSION}, not touching it`)
      return false
    }
  }

  store.tables = store.tables ?? {}
  const workspaces = (store.tables.workspaces = store.tables.workspaces ?? {})
  const dir = canonicalWorkspacePath(inputDir)
  // Upsert by path: restarting from the same folder reuses the existing row,
  // so its session history and id survive instead of piling up duplicates.
  // Windows paths are case-insensitive while dsh resolves them, so an exact
  // miss falls back to a case-insensitive match, and a row that an older
  // bridge wrote with the drive letter left as VS Code reported it is healed
  // in place (same id, same sessions, canonical path).
  const keys = Object.keys(workspaces)
  const existing =
    keys.find((key) => workspaces[key]?.path === dir) ??
    (process.platform === 'win32' ? keys.find((key) => (workspaces[key]?.path ?? '').toLowerCase() === dir.toLowerCase()) : undefined)
  const now = new Date().toISOString()
  const id = existing ?? randomUUID()
  if (existing) {
    const row = workspaces[existing]!
    row.path = dir
    row.title = row.title || titleOf(dir)
    row.updatedAt = now
  } else {
    workspaces[id] = { path: dir, title: titleOf(dir), sessionIds: [], createdAt: now, updatedAt: now }
  }

  const global = (store.global ??= {})
  global.initialized = true
  global.workspaceIds = [...new Set([...(global.workspaceIds ?? []), id])]
  global.defaultWorkspaceId = id
  store.unit ??= { name: 'workspace', version: STORE_VERSION }

  // Prune duplicate corpses of the very directory being registered. A bridge
  // from before the drive-letter fix (or a stale window running it) wrote the
  // path exactly as VS Code reported it, and dsh lists every row in its
  // workspace picker: two identical titles, and sessions attached to the
  // non-canonical twin die at once. A row with sessions is live data and
  // never touched; a sessionless twin of the registered path is a trap, so
  // it is removed while the harness is not running yet.
  let pruned = 0
  if (process.platform === 'win32') {
    for (const key of keys) {
      if (key === id) continue
      const row = workspaces[key]
      if (!row || (row.sessionIds?.length ?? 0) > 0) continue
      if ((row.path ?? '').toLowerCase() !== dir.toLowerCase()) continue
      delete workspaces[key]
      pruned++
    }
  }
  if (pruned > 0) {
    global.workspaceIds = (global.workspaceIds ?? []).filter((workspaceId) => workspaces[workspaceId] !== undefined)
    log.info(`removed ${pruned} duplicate workspace row(s) for "${titleOf(dir)}" from the picker`)
  }

  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `${path.basename(file)}.bridge.tmp`)
  writeFileSync(tmp, JSON.stringify(store, null, 2))
  renameSync(tmp, file)
  log.info(`harness default workspace set to the editor folder "${titleOf(dir)}"`)
  return true
}

function titleOf(dir: string): string {
  const name = path.basename(dir.replace(/[\\/]+$/, ''))
  return name || dir
}
