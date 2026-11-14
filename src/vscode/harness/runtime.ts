/**
 * Installing the harness into the bridge's own runtime directory.
 *
 * Why not `npx` on every launch: `npx` is a `.cmd` shim on Windows, and Node
 * refuses to spawn `.cmd` without a shell, which forces `shell: true` and hands
 * our arguments to cmd.exe for string concatenation. The bridge's own storage
 * path contains spaces, so every launch would depend on hand-rolled quoting.
 * Installing once and launching `node <bin.js>` removes the entire quoting
 * problem class and makes the version deterministic instead of "whatever npx
 * resolves today".
 *
 * The package itself is untouched upstream: this is the published artifact,
 * never a patched copy.
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface RuntimeLog {
  info(message: string): void
}

export interface DshRuntime {
  /** Absolute path to the launcher script, ready for `node <path>`. */
  binPath: string
  version: string
  dir: string
}

/**
 * A version spec is the only dynamic part of an npm command line, and it comes
 * from a user setting, so anything outside a version shape is refused rather
 * than pasted into a shell.
 */
const SAFE_VERSION_SPEC = /^(?:latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/

export function isSafeVersionSpec(spec: string): boolean {
  return SAFE_VERSION_SPEC.test(spec)
}

/**
 * Characters an npm argument may legitimately contain, nothing else. Shell
 * metacharacters are absent on purpose: this string is concatenated, not
 * escaped, and `>` redirects into a file while cmd's `^` escapes the next
 * character. Range specifiers never reach here; the version is validated
 * separately as an exact spec.
 */
const SAFE_NPM_ARG = /^[A-Za-z0-9@._/\-+]+$/

/**
 * npm is a `.cmd` on Windows and Node refuses to spawn `.cmd` without a shell,
 * so this runs through a shell. With a shell, Node concatenates rather than
 * escapes its arguments, which means every word must be checked on the way in:
 * this command line is executed, and one part of it is user input.
 */
function npmCommand(args: string[]): string {
  return ['npm', ...args]
    .map((arg) => {
      if (!SAFE_NPM_ARG.test(arg)) throw new Error(`refusing to pass "${arg}" to the shell: not a safe npm argument`)
      return arg
    })
    .join(' ')
}

const execAsync = promisify(exec)

/**
 * Records that an npm install into `runtimeDir` ran to completion. Exported
 * because the commands that install, update, repair, and uninstall speak of
 * this file by name; deleting it is the only supported way to tell an
 * installer "your stamp no longer counts".
 */
export const INSTALL_STAMP_FILE = '.install-complete'

/**
 * Awaited, not `spawnSync`: this runs on the extension host during a first
 * boot, and a synchronous npm install of the whole dsh tree would freeze the
 * window (and every spinner in it) for as long as the registry takes.
 */
async function npm(args: string[], cwd: string): Promise<void> {
  const command = npmCommand(args)
  try {
    await execAsync(command, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  } catch (err) {
    const e = err as { code?: number | string; killed?: boolean; message: string; stderr?: string; stdout?: string }
    if (typeof e.code === 'number') {
      throw new Error(`${command} failed (exit ${e.code}): ${String(e.stderr || e.stdout || '').slice(-400)}`)
    }
    throw new Error(`${command} could not run: ${e.message}`)
  }
}

function manifestBin(binDir: string): string {
  const manifest = JSON.parse(readFileSync(path.join(binDir, 'package.json'), 'utf8')) as {
    version?: string
    bin?: unknown
  }
  const bin = manifest.bin
  const entry = typeof bin === 'string' ? bin : typeof bin === 'object' && bin !== null ? (bin as Record<string, string>).dsh : undefined
  if (!entry) throw new Error(`${binDir} declares no launcher entry in its package.json "bin"`)
  const binPath = path.resolve(binDir, entry)
  if (!existsSync(binPath)) throw new Error(`${binDir} declares bin "${entry}" but the file is missing`)
  return binPath
}

/**
 * Make sure `@deepseek-ai/dsh@version` is installed under `runtimeDir` and
 * return its launcher. Reuses an existing install when the version already
 * matches, so an editor restart does not re-download the world.
 */
export async function ensureDshRuntime(opts: { runtimeDir: string; version: string; log?: RuntimeLog }): Promise<DshRuntime> {
  const { runtimeDir, version } = opts
  const log = opts.log ?? { info() {} }
  if (!isSafeVersionSpec(version)) {
    throw new Error(`refusing to install dsh version ${JSON.stringify(version)}: expected "latest" or an exact version`)
  }
  mkdirSync(runtimeDir, { recursive: true })
  const marker = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
  const installedVersion = (): string | undefined => {
    try {
      return (JSON.parse(readFileSync(path.join(marker, 'package.json'), 'utf8')) as { version?: string }).version
    } catch {
      return undefined
    }
  }
  const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
  // An exact pin must match what is on disk; a range only has to be present,
  // otherwise a range would reinstall on every single editor start.
  const matches = (current: string | undefined): boolean =>
    current !== undefined && (EXACT.test(version) ? current === version : true)
  // dsh's own package.json lands long before npm finishes its dependencies, so a window closed mid-install leaves a tree that looks installed.
  const stamp = path.join(runtimeDir, INSTALL_STAMP_FILE)
  if (!matches(installedVersion()) || !existsSync(stamp)) {
    rmSync(stamp, { force: true })
    rmSync(path.join(runtimeDir, 'node_modules'), { recursive: true, force: true })
    const stub = path.join(runtimeDir, 'package.json')
    if (!existsSync(stub)) {
      writeFileSync(stub, `${JSON.stringify({ name: 'dsh-bridge-runtime', private: true, description: 'Installed dsh runtime for the DeepSeek Harness Bridge. Not a project.' }, null, 2)}\n`)
    }
    log.info(`installing @deepseek-ai/dsh@${version} into the bridge runtime`)
    await npm(['install', '--no-audit', '--no-fund', '--no-save', `@deepseek-ai/dsh@${version}`], runtimeDir)
  }
  const found = installedVersion()
  if (!found) throw new Error(`dsh install reported success but ${marker} is not present`)
  // tmp + rename: existence of the stamp is the promise that the install
  // completed, and a crash mid-write must not leave a half file making that
  // promise. The name is already taken by npm's own debris? Force through.
  writeFileSync(`${stamp}.tmp`, `${found}\n`)
  renameSync(`${stamp}.tmp`, stamp)
  return { binPath: manifestBin(marker), version: found, dir: runtimeDir }
}
