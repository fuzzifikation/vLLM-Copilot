/**
 * Harness supervision: one clean dsh web process, no matter how the previous
 * window ended.
 *
 * Two facts drive the design. First, dispose() does not run when the extension
 * host dies (window closed hard, VS Code crash, machine sleep-kill), so a
 * pid file plus a reap at activation is the only way to guarantee a single
 * instance. Second, on Windows a child outlives its parent, so an orphaned
 * harness keeps holding the port and the model.
 *
 * No `vscode` import: the whole file runs under plain node, which is what makes
 * the reap path testable with a real live process instead of a mock.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { drainActiveRequests } from './ingest.js'

export interface SupervisorLog {
  info(message: string): void
  warn(message: string): void
  /** Optional verbosity tier: every harness line is mirrored here when present. */
  debug?(message: string): void
}

export interface PidRecord {
  pid: number
  startedAt: string
  profile: string
  dshVersion: string
  /**
   * The URL the announcing window read from stdout, token included. It is what
   * lets a second window recognise the record as a live harness it can reuse
   * instead of an orphan to destroy.
   */
  url: string
}

const isWindows = process.platform === 'win32'

/**
 * The harness needs a REAL Node. Inside the extension host `process.execPath`
 * is the editor's own Electron binary, and dsh's native loader fingerprints
 * V8, sees `...-electron.0`, and dies with "unsupported Electron runtime
 * fingerprint" before it can report a URL (observed in production, not in any
 * node-run rail, because rails are never Electron). So: plain-Node callers
 * keep their own binary; inside Electron, the first `node` on PATH wins.
 */
export function findNodeOnPath(envPath: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  const exe = platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of (envPath ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, exe)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export function resolveHarnessNode(): string {
  if (!process.versions.electron) return process.execPath
  const found = findNodeOnPath(process.env.PATH)
  if (!found) {
    throw new Error(
      'the DeepSeek Harness needs a real Node.js on PATH; the editor\'s embedded runtime is an Electron build and dsh refuses to run on it. Install Node 22 or newer and restart the editor.',
    )
  }
  return found
}

export function readPidRecord(pidFile: string): PidRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(pidFile, 'utf8')) as Partial<PidRecord>
    return typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0
      ? {
          pid: raw.pid,
          startedAt: String(raw.startedAt ?? ''),
          profile: String(raw.profile ?? ''),
          dshVersion: String(raw.dshVersion ?? ''),
          url: String(raw.url ?? ''),
        }
      : undefined
  } catch {
    return undefined
  }
}

export function writePidRecord(pidFile: string, record: PidRecord): void {
  mkdirSync(path.dirname(pidFile), { recursive: true })
  // tmp + rename: a torn pid file is worse than none, because the next window
  // cannot tell which pid to reap and may leave the orphan running. The mode
  // bit matters on POSIX: the record carries the harness UI token.
  writeFileSync(`${pidFile}.tmp`, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  renameSync(`${pidFile}.tmp`, pidFile)
}

export function clearPidRecord(pidFile: string): void {
  try {
    unlinkSync(pidFile)
  } catch {
    /* already gone */
  }
}

/** Signal 0 probes existence without touching the process. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the pid exists but belongs to someone else: still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function terminateOnce(pid: number, force: boolean): boolean {
  try {
    if (isWindows) {
      // Tree kill: the harness can leave grandchildren behind, and an orphaned
      // grandchild still holds the model and the port.
      //
      // Windows gets no polite version. `taskkill` without `/F` posts a
      // close message to a window, and a console host has none, so the polite
      // attempt just burns the timeout and forces anyway. Gracefulness lives in
      // the drain that runs before this call: by the time we terminate, the
      // in-flight requests are already finished or reported as cut.
      const args = ['/pid', String(pid), '/T', '/F']
      return spawnSyncTaskkill(args) === 0
    }
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
    return true
  } catch {
    return false
  }
}

function spawnSyncTaskkill(args: string[]): number {
  // taskkill is a system .exe (not a .cmd shim), so it spawns without a shell.
  try {
    return spawnSync('taskkill.exe', args, { windowsHide: true }).status ?? 1
  } catch {
    return 1
  }
}

/** Await a best-effort helper process: resolves on close, kills at the timeout, never rejects. */
function waitForProcess(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolve()
    }, timeoutMs)
    timer.unref?.()
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * Kill every leftover process whose command line references this DSH_HOME.
 *
 * dsh server and session processes detach from the launcher, so a launcher
 * tree kill can leave them holding the model, the port, and the PREVIOUS
 * plugin build (observed: nine survivors across restart cycles, serving a
 * stale composition after the vendor tree was updated). Called after the
 * owned pid is gone: nothing under this home should live. Best effort: a
 * failed sweep never fails the stop. Awaited async: the CIM scan is a full
 * process-table query and must not run synchronously on the extension host.
 */
export async function sweepDetachedHarnesses(dshHome: string): Promise<void> {
  // The path travels through a shell command line, so only plainly safe
  // characters may pass; anything exotic skips the sweep rather than risks
  // injecting into somebody else's process list.
  if (!/^[\w .:\\/-]{4,}$/.test(dshHome)) return
  try {
    if (isWindows) {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${dshHome}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ],
        { windowsHide: true },
      )
      await waitForProcess(child, 20_000)
    } else {
      await waitForProcess(spawn('pkill', ['-f', dshHome]), 20_000)
    }
  } catch {
    /* best effort */
  }
}

/**
 * What the pid file is telling us, without touching anything.
 *
 * Deliberately not a killer. The pid file is shared by every editor window, so
 * a live pid there usually means "another window is happily serving the same
 * harness", not "orphan". A window that killed live pids on activation would
 * make two windows kick each other's harness off the same port forever. And a
 * pid we did not spawn could have been recycled by an unrelated program at any
 * moment, which is how a bridge ends up terminating the user's browser.
 */
export type PidRecordState = { kind: 'none' } | { kind: 'stale'; pid: number } | { kind: 'live'; record: PidRecord }

export function classifyPidRecord(pidFile: string, log?: SupervisorLog): PidRecordState {
  const record = readPidRecord(pidFile)
  if (!record) {
    // Absent or unreadable: either way nothing may trust it, and leaving a
    // corrupt file behind would wedge every later start.
    clearPidRecord(pidFile)
    return { kind: 'none' }
  }
  if (!isProcessAlive(record.pid)) {
    log?.info(`clearing pid file of harness ${record.pid} that is no longer running`)
    clearPidRecord(pidFile)
    return { kind: 'stale', pid: record.pid }
  }
  return { kind: 'live', record }
}

/**
 * Positive identification of a live harness: only something answering on the
 * recorded port with an HTTP response is treated as ours. An `error` status is
 * still an answer; a refused connection or timeout is not.
 */
export async function probeHarness(url: string, timeoutMs = 1500): Promise<boolean> {
  if (!url) return false
  // The bridge only ever talks to a harness it launched, on loopback. A pid
  // record or stdout line naming any other host is a bug or a hostile dsh
  // build; probing it would hand a stranger our tokens and liveness.
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) return false
  } catch {
    return false
  }
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    return true
  } catch (err) {
    // A non-2xx arrives as a response, so anything thrown here is transport level.
    return (err as { name?: string }).name === 'Response'
  }
}

/** `dsh web: http://127.0.0.1:58370/?token=<secret>` on stdout. Loopback
 * hosts only: a build announcing some other origin gets no URL, and the
 * start fails like the harness never reported one. */
const URL_LINE = /dsh web:\s*(http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?(?:\/\S*)?)/

/** The token authenticates the harness UI, so it never goes near a log. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.search ? `${parsed.origin}${parsed.pathname}<redacted query>` : url
  } catch {
    return '<unparseable url>'
  }
}

export interface SupervisorOptions {
  binPath: string
  dshHome: string
  profile: string
  pidFile: string
  activeDir: string
  /**
   * Exact dsh version, or a reader of it. A thunk lets a settings edit take
   * effect on the next restart without rebuilding the supervisor, and the pid
   * record then states the version the harness was actually launched with.
   */
  dshVersion: string | (() => string)
  log: SupervisorLog
  /** Fired when the process exits without `stop()` having been called. */
  onUnexpectedExit?(info: { code: number | null; signal: string | null }): void
  urlTimeoutMs?: number
  nodePath?: string
  env?: Record<string, string> | (() => Record<string, string>)
  /** Process sweep for this home; injectable so tests never touch the process table. */
  sweep?: (dshHome: string) => void | Promise<void>
  /**
   * The profile directory to watch while the harness is live, and the
   * callback fired when one of its plugin-toggle files changes on disk from
   * somewhere else. The plugin manager persists toggles to the profile but
   * cannot hot-apply them (docs/harness-upstream-issues.md), so the manager's write
   * is the moment the user deserves to hear "restart to apply". Only armed
   * by the window that SPAWNS the harness: a borrowing window neither owns
   * the restart nor the restart's own patch-layer writes.
   */
  profileDir?: string
  onProfileEdit?: (file: string) => void
}

export class Supervisor {
  private child: ChildProcess | undefined
  private exitPromise: Promise<{ code: number | null; signal: string | null }> | undefined
  private stopping = false
  private adoptedPid: number | undefined
  private tail = ''
  private profileWatcher: FSWatcher | undefined
  private profileEditTimers = new Map<string, NodeJS.Timeout>()
  /**
   * Exact contents of the last profile files WE wrote, by basename. The
   * bridge regenerates the patch layer on every prepare, and the watcher
   * must not present our own regeneration as a change the user should
   * restart for; a byte-equal file is not an event.
   */
  private ownProfileWrites = new Map<string, string>()

  constructor(private readonly opts: SupervisorOptions) {}

  get running(): boolean {
    if (this.child) return this.child.exitCode === null && !this.child.killed
    return this.adoptedPid !== undefined && isProcessAlive(this.adoptedPid)
  }

  /** True when this window borrowed another window's harness instead of spawning one. */
  get adopted(): boolean {
    return this.child === undefined && this.adoptedPid !== undefined
  }

  url: string | undefined

  /**
   * Take over a harness another window announced. The caller has already proven
   * it is alive by probing its URL, which is as close to positive process
   * identity as a shared pid file ever gets.
   */
  adopt(record: PidRecord): void {
    if (this.child) throw new Error('this supervisor already owns a harness process')
    this.adoptedPid = record.pid
    this.url = record.url || undefined
    this.opts.log.info(`reusing the harness already running as pid ${record.pid} from another window`)
  }

  /** Forget an adoption whose process turned out to be unreachable. */
  dropAdoption(): void {
    this.adoptedPid = undefined
    this.url = undefined
    clearPidRecord(this.opts.pidFile)
  }

  /**
   * Forget a borrowed harness WITHOUT touching it: this window never spawned
   * it, so no kill, no pid clear, no sweep. Sweeping would kill the owner's
   * detached server just because a borrowing window closed.
   */
  release(): void {
    this.adoptedPid = undefined
    this.url = undefined
  }

  /** Claim a profile-file write as our own, so the watcher stays silent for it. */
  recordOwnProfileWrite(file: string, content: string): void {
    this.ownProfileWrites.set(path.basename(file), content)
  }

  /**
   * The two files a plugin toggle rewrites: enablement lands in the
   * manifest's bundle list, disables and overrides in the patch layer
   * (coexisting with the generated block, which the manager preserves
   * comment-for-comment).
   */
  private static readonly WATCHED_PROFILE_FILES = new Set(['cordis.patch.yml', 'package.json'])

  private armProfileWatcher(): void {
    const o = this.opts
    if (!o.profileDir || !o.onProfileEdit) return
    const dir = o.profileDir
    try {
      this.profileWatcher = watch(dir, (_event, name) => {
        if (typeof name !== 'string' || !Supervisor.WATCHED_PROFILE_FILES.has(name)) return
        // Windows delivers each rename as several events; one settle window
        // per file, and the byte compare decides whether it was anyone's
        // business at all.
        const pending = this.profileEditTimers.get(name)
        if (pending) clearTimeout(pending)
        const timer = setTimeout(() => {
          this.profileEditTimers.delete(name)
          let content: string
          try {
            content = readFileSync(path.join(dir, name), 'utf8')
          } catch {
            return
          }
          if (this.ownProfileWrites.get(name) === content) return
          this.ownProfileWrites.set(name, content)
          o.onProfileEdit?.(name)
        }, 600)
        timer.unref?.()
        this.profileEditTimers.set(name, timer)
      })
      this.profileWatcher.unref?.()
    } catch (err) {
      // A missing watch only costs the courtesy notice, never the harness.
      o.log.warn(`profile edit watch unavailable: ${String(err)}`)
    }
  }

  private closeProfileWatcher(): void {
    this.profileWatcher?.close()
    this.profileWatcher = undefined
    for (const timer of this.profileEditTimers.values()) clearTimeout(timer)
    this.profileEditTimers.clear()
  }

  /**
   * The launcher path is only known once the runtime install has resolved it,
   * which can happen again after an upgrade, so it stays mutable rather than
   * being frozen into a supervisor built at activation.
   */
  setBinPath(binPath: string): void {
    if (this.running) throw new Error('cannot change the launcher while the harness is running')
    this.opts.binPath = binPath
  }

  /**
   * Boot the harness and resolve once it reports its URL. Rejects with the
   * captured stderr tail, which is the only diagnostic a user can act on.
   */
  async start(): Promise<string> {
    if (this.running && this.url) return this.url
    const o = this.opts
    mkdirSync(o.dshHome, { recursive: true })
    // Reap before spawn, always: when this window decides to spawn, the pid
    // record is already gone (adopt path returns earlier), so anything still
    // running under this home is a detached survivor of a launcher the editor
    // killed on the last close or reload. Left alone it holds its port and
    // serves its stale composition forever (observed: nine survivors).
    await (o.sweep ?? sweepDetachedHarnesses)(o.dshHome)
    const node = o.nodePath ?? resolveHarnessNode()
    // ELECTRON_RUN_AS_NODE leaks in from the extension host's environment. It
    // is meaningless to a real node binary, and a harness must never inherit
    // the suggestion that it may behave like an editor helper process.
    const env: Record<string, string | undefined> = { ...process.env, DSH_HOME: o.dshHome, ...(typeof o.env === 'function' ? o.env() : o.env) }
    delete env.ELECTRON_RUN_AS_NODE
    // The active-request ledger survives the process that wrote it. A spawn
    // happens only when no harness lives, so every record still in the
    // directory belongs to a process that died mid-turn (reload, crash,
    // kill): ghosts that haunt the pill with phantom "running requests" and
    // make the next drain wait on dead pids forever. A fresh start starts
    // with an honest ledger.
    try {
      const ghosts = readdirSync(o.activeDir)
      if (ghosts.length > 0) {
        for (const ghost of ghosts) {
          try {
            unlinkSync(path.join(o.activeDir, ghost))
          } catch {
            /* vanished mid-delete or not a file: either way, not a live request */
          }
        }
        o.log.info(`cleared ${ghosts.length} stale active-request record(s) left by a dead harness`)
      }
    } catch {
      /* no active directory yet: nothing to inherit */
    }
    // No --patch here, ever: upstream, ANY patch content at boot (this flag,
    // rows in the profile patch layer, even a bundle's own patch) leaves the
    // profile's root Include entry unregistered for the life of the process,
    // and every plugin toggle then dies with "profile reload requires the
    // root Include entry" (docs/harness-upstream-issues.md entry 6). Dropping the
    // flag is one poison source less; the generated rows reach the harness
    // through the profile's own patch layer instead, written by prepare.
    const child = spawn(
      node,
      [o.binPath, '--profile', o.profile, '--no-open', '--port', '0'],
      {
        cwd: o.dshHome,
        env: env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    this.child = child
    this.stopping = false
    this.adoptedPid = undefined
    this.url = undefined
    this.tail = ''

    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      // Only clear the pid record while it still names THIS child. After a
      // forced stop the exit event can land after a replacement harness has
      // written a fresh record, and erasing that would blind the next window
      // to a live harness (and a spawn that never got a pid must not clear
      // whatever record another window legitimately owns).
      const clearOwnPidRecord = (): void => {
        const record = readPidRecord(o.pidFile)
        if (record !== undefined && child.pid !== undefined && record.pid === child.pid) clearPidRecord(o.pidFile)
      }
      child.on('exit', (code, signal) => {
        clearOwnPidRecord()
        this.child = undefined
        this.url = undefined
        resolve({ code, signal })
      })
      child.on('error', () => {
        clearOwnPidRecord()
        this.child = undefined
        this.url = undefined
        resolve({ code: -1, signal: 'spawn-error' })
      })
    })
    this.exitPromise = exited

    if (child.pid === undefined) throw new Error('dsh process did not start (no pid)')
    const dshVersion = typeof o.dshVersion === 'function' ? o.dshVersion() : o.dshVersion
    writePidRecord(o.pidFile, { pid: child.pid, startedAt: new Date().toISOString(), profile: o.profile, dshVersion, url: '' })

    const urlFound = new Promise<string>((resolve, reject) => {
      const settle = (line: string, source: 'stdout' | 'stderr'): void => {
        this.tail = `${this.tail}${line}\n`.slice(-8000)
        // Mirror EVERY line at debug: launcher boot chatter, plugin activation
        // notes, and HMR events are the only window into a harness that is
        // alive but misbehaving, and they used to vanish unless the line
        // literally said "error". Gating is the channel level's job, not ours.
        const mirror = line.trim()
        if (mirror) o.log.debug?.(`[harness ${source}] ${mirror}`)
        const match = URL_LINE.exec(line)
        if (match?.[1]) {
          this.url = match[1]
          o.log.info(`harness listening at ${redactUrl(match[1])}`)
          resolve(match[1])
          return
        }
        if (source === 'stderr' && /\b(error|Error:)\b/.test(line)) o.log.warn(line.trim())
      }
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      let stdoutBuffer = ''
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) settle(line, 'stdout')
      })
      child.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) settle(line, 'stderr')
      })
      void exited.then((info) => {
        // The URL line can be the last bytes ever written, with no trailing
        // newline to trigger the split: flush the held buffer before
        // declaring failure, or a harness that announced itself correctly
        // dies as "exited before reporting a URL".
        if (stdoutBuffer) {
          const rest = stdoutBuffer
          stdoutBuffer = ''
          settle(rest, 'stdout')
        }
        if (!this.url) {
          reject(new Error(`harness exited before reporting a URL (code ${info.code}, signal ${info.signal})\n${this.tail.slice(-1500)}`))
        }
      })
      setTimeout(
        () => reject(new Error(`harness did not report a URL within ${o.urlTimeoutMs ?? 120_000} ms\n${this.tail.slice(-1500)}`)),
        o.urlTimeoutMs ?? 120_000,
      ).unref?.()
    })

    const url = await urlFound
    // Second half of the record: the URL only exists once dsh announces it, and
    // it is what lets the next window adopt this harness instead of replacing it.
    writePidRecord(o.pidFile, { pid: child.pid, startedAt: new Date().toISOString(), profile: o.profile, dshVersion, url })
    // Live now: plugin toggles from here on persist without applying, so the
    // owner window watches for them until this process is gone.
    this.armProfileWatcher()
    // A process that dies right after announcing itself must be reported, not
    // shown as a healthy status bar.
    void exited.then((info) => {
      this.closeProfileWatcher()
      if (this.stopping || info.code === 0) return
      // Another window's Stop clears (or replaces) the pid record while our
      // child dies: that exit is deliberate, and screaming "exited on its
      // own" at the owning window is a lie. A real crash leaves the record
      // naming our pid, so the warning keeps its teeth.
      const record = readPidRecord(o.pidFile)
      if (child.pid !== undefined && record?.pid !== child.pid) {
        o.log.info('harness exited after the pid record moved on; treating it as a deliberate stop from another window')
        return
      }
      o.onUnexpectedExit?.(info)
    })
    return url
  }

  /**
   * Stop the harness, optionally waiting for in-flight requests first. The
   * caller must surface an undrained stop: silently truncating a user's turn is
   * the failure mode this whole path exists to avoid.
   */
  async stop(opts: { drainMs?: number } = {}): Promise<{ drained: boolean; remaining: number }> {
    const o = this.opts
    const drain = await drainActiveRequests(o.activeDir, opts.drainMs ?? 0)
    this.stopping = true
    const adopted = this.adoptedPid
    this.adoptedPid = undefined
    const child = this.child
    if (!child || child.exitCode !== null) {
      // An adopted harness belongs to another window. Stopping it here is the
      // user's explicit request, and a tree kill is honest ONLY while the pid
      // record still names the very pid we adopted: minutes can pass between
      // adopt and Stop, the owner may have replaced the harness in that time,
      // and /F /T on a recycled pid is how unrelated processes die.
      const fresh = readPidRecord(o.pidFile)
      if (adopted !== undefined && fresh !== undefined && fresh.pid !== adopted) {
        o.log.info('the borrowed harness was already replaced by its owning window; leaving the replacement running')
        return drain
      }
      // Clear the record BEFORE the kill: the owning window's exit handler
      // reads it to tell a deliberate stop from a crash, and a record still
      // naming its child at exit time would scream a false alarm at it.
      clearPidRecord(o.pidFile)
      if (adopted !== undefined && isProcessAlive(adopted)) {
        terminateOnce(adopted, false)
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline && isProcessAlive(adopted)) await new Promise((r) => setTimeout(r, 150))
        if (isProcessAlive(adopted)) {
          terminateOnce(adopted, true)
          o.log.warn('adopted harness did not exit within 10 s, forced')
        }
      }
      this.child = undefined
      this.url = undefined
      // The sweep may not burn a replacement harness either; the early return
      // above already covered the replaced case.
      await (o.sweep ?? sweepDetachedHarnesses)(o.dshHome)
      return drain
    }
    const pid = child.pid
    if (pid !== undefined) terminateOnce(pid, false)
    const exited = this.exitPromise ?? Promise.resolve({ code: 0, signal: null })
    const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000).unref?.())
    const result = await Promise.race([exited, timer])
    if (result === 'timeout') {
      if (pid !== undefined) terminateOnce(pid, true)
      o.log.warn('harness did not exit within 10 s, forced')
    }
    // Same ownership law as the adopted branch: while we drained, the record
    // may have come to name another window's replacement. Clearing or sweeping
    // it down would blind or kill it.
    const freshOwn = readPidRecord(o.pidFile)
    const ownsRecord = freshOwn === undefined || (pid !== undefined && freshOwn.pid === pid)
    if (ownsRecord) clearPidRecord(o.pidFile)
    this.child = undefined
    this.url = undefined
    if (ownsRecord) await (o.sweep ?? sweepDetachedHarnesses)(o.dshHome)
    return drain
  }
}
