/**
 * Running the dsh CLI the same way the supervisor runs the harness: `node`
 * plus the package's own launcher, no shell. `dsh plugin add` and
 * `--dump-config` are the two calls the bridge needs before a boot, and both
 * must fail loudly with the CLI's own words, because a silently missing bundle
 * row means the harness answers with a different provider than configured.
 *
 * Async on purpose, and this is the bug that earned the ruling: these calls
 * used to be `spawnSync` on the extension host's event loop, so a first boot
 * (npm installing ~300 packages, then plugin add, then dump-config) froze the
 * entire window for tens of seconds while the user watched unrelated spinners
 * like "Initializing 'tsconfig.json'" stall. An extension host that blocks
 * stops every other extension AND the UI protocol messages routed through it.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveHarnessNode } from './supervisor.js'
import { deletableWithin } from './disk.js'

export interface DshResult {
  code: number
  stdout: string
  stderr: string
}

export interface DshRunOptions {
  binPath: string
  dshHome: string
  args: string[]
  timeoutMs?: number
}

const MAX_OUTPUT_CHARS = 64 * 1024 * 1024

export async function runDsh(opts: DshRunOptions): Promise<DshResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  return new Promise<DshResult>((resolve, reject) => {
    // Same law as the harness spawn: a REAL node, never the editor's Electron.
    // dsh's launcher fingerprints V8 and refuses Electron builds, and leaving
    // ELECTRON_RUN_AS_NODE in the environment of a real node binary is a
    // suggestion no node should receive.
    const env = { ...process.env, DSH_HOME: opts.dshHome } as NodeJS.ProcessEnv
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(resolveHarnessNode(), [opts.binPath, ...opts.args], {
      cwd: opts.dshHome,
      env,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const kill = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already dead */
      }
    }
    // Rejecting without killing leaves a child writing into pipes nobody
    // reads: a chatty dsh keeps running forever behind a failed prepare.
    const failRun = (message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      kill()
      reject(new Error(message))
    }
    const timer = setTimeout(() => {
      failRun(`dsh ${opts.args.join(' ')} did not finish within ${timeoutMs} ms and was killed`)
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > MAX_OUTPUT_CHARS) failRun(`dsh ${opts.args.join(' ')} produced more output than the bridge will buffer`)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > MAX_OUTPUT_CHARS) failRun(`dsh ${opts.args.join(' ')} produced more output than the bridge will buffer`)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`dsh ${opts.args.join(' ')} could not run: ${err.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Run and throw with the CLI's own diagnostics attached. */
export async function requireDsh(opts: DshRunOptions): Promise<DshResult> {
  const result = await runDsh(opts)
  if (result.code !== 0) {
    const detail = `${result.stderr.trim() || result.stdout.trim()}`.slice(-1200)
    throw new Error(`dsh ${opts.args.slice(0, 3).join(' ')} failed (exit ${result.code}): ${detail || 'no output'}`)
  }
  return result
}

/**
 * Create the bridge profile from the shipped `web` template. The profile IS
 * the entry mode in dsh 0.2.x: `dsh web --profile x` is rejected outright, and
 * a profile built from `headless` has no web server at all, so this template
 * choice is what makes "Open harness" possible.
 *
 * The manifest must PARSE to count as created: a window closed mid-creation
 * can leave a half-written directory, and trusting its mere existence wedges
 * every later prepare on a profile nothing can load.
 */
export async function ensureProfile(opts: { binPath: string; dshHome: string; profile: string; manifestFile: string }): Promise<void> {
  if (profileManifestUsable(opts.manifestFile)) return
  if (existsSync(opts.manifestFile)) {
    // Present but broken: rebuild from scratch rather than build on rubble -
    // but only rubble inside the harness home. A junction planted at the
    // profile directory is not ours to delete recursively.
    const profileDir = path.dirname(opts.manifestFile)
    if (!deletableWithin(profileDir, opts.dshHome)) {
      throw new Error(`refusing to rebuild ${profileDir}: it does not resolve inside the harness home`)
    }
    rmSync(profileDir, { recursive: true, force: true })
  }
  await requireDsh({ ...opts, args: ['--profile', opts.profile, '--from-default-profile', 'web', '--dump-config'], timeoutMs: 300_000 })
}

function profileManifestUsable(manifestFile: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(manifestFile, 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/**
 * Install (or refresh) the staged adapter into the profile's pnpm tree.
 *
 * The version stamp alone cannot be trusted as the whole truth: pnpm does
 * not re-copy a `file:` directory dependency whose version did not change,
 * so `plugin add` on a bridge update (plugin stays 0.0.1) is a silent no-op
 * that leaves the profile holding the PREVIOUS plugin build while vendor/
 * is current. Observed in the wild: the profile kept a copy without
 * `terminal.js`, the preset child `vllmc-terminal` answered
 * `agent-preset/invalid: ... never started`, session creation died, and the
 * Preview Notice acknowledgement stopped persisting. The copy set is
 * therefore compared against vendor/ on every prepare, a stale copy is
 * deleted before the reinstall (the only thing that makes pnpm re-materialise
 * it), and the result is re-verified or the boot stops.
 */
export async function ensureAdapterInstalled(opts: {
  binPath: string
  dshHome: string
  profile: string
  adapterDir: string
  coreDir: string
  profileModules: string
  stampFile: string
  run?: (o: DshRunOptions) => DshResult | Promise<DshResult>
}): Promise<void> {
  const stagedVersion = readStagedAdapterVersion(opts.adapterDir)
  const stamp = readStamp(opts.stampFile)
  const copies = profileCopies(opts.profileModules, opts.adapterDir, opts.coreDir)
  if (stamp === stagedVersion && copies.every((c) => manifestsMatch(c.vendorDir, c.copyDir))) return
  const run = opts.run ?? requireDsh
  for (const c of copies) {
    // Only ours: the guard refuses to delete anything not named for our pair.
    if (existsSync(c.copyDir)) rmSync(c.copyDir, { recursive: true, force: true })
  }
  await run({ binPath: opts.binPath, dshHome: opts.dshHome, args: ['plugin', '--profile', opts.profile, 'add', `file:${toPosix(opts.adapterDir)}`], timeoutMs: 600_000 })
  for (const c of copies) {
    if (!manifestsMatch(c.vendorDir, c.copyDir)) {
      throw new Error(
        `after reinstalling the adapter, the profile's copy of ${path.basename(c.copyDir)} still differs from the staged vendor tree; refusing to boot a harness whose plugin tree is stale`,
      )
    }
  }
  writeStamp(opts.stampFile, stagedVersion)
}

/** Our two `file:` trees inside the profile's node_modules, beside their vendor sources. */
function profileCopies(profileModules: string, adapterDir: string, coreDir: string): Array<{ vendorDir: string; copyDir: string }> {
  return [
    { vendorDir: adapterDir, copyDir: path.join(profileModules, '@fuzzifikation', 'dsh-adapter-vllmc') },
    { vendorDir: coreDir, copyDir: path.join(profileModules, 'vllm-copilot-core') },
  ]
}

/** Sorted `name:size` list of every file, `node_modules` excluded. Cheap, and size lies are rare between our own trees. */
function fileManifest(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules') continue
      if (entry.isDirectory()) walk(path.join(d, entry.name), `${rel}${entry.name}/`)
      else out.push(`${rel}${entry.name}:${statSync(path.join(d, entry.name)).size}`)
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return out
}

function manifestsMatch(vendorDir: string, copyDir: string): boolean {
  return fileManifest(vendorDir).join('\n') === fileManifest(copyDir).join('\n')
}

function toPosix(p: string): string {
  // dsh accepts a `file:` specifier; forward slashes avoid cmd-style escapes
  // entirely, and pnpm handles them on every platform.
  return p.replace(/\\/g, '/')
}

function readStagedAdapterVersion(dir: string): string {
  try {
    return String((JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown')
  } catch {
    throw new Error(`staged adapter at ${dir} has no readable package.json`)
  }
}

function readStamp(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

function writeStamp(file: string, value: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${value}\n`)
}
