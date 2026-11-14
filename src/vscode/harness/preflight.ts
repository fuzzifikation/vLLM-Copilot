/**
 * Machine-level prerequisites, answered before any npm traffic.
 *
 * The start path used to discover a missing Node by watching `npm install`
 * fail with cmd.exe's standard "not recognized as an internal or external
 * command", and a machine missing `pnpm` died mid-install on dsh's own plugin
 * step. All three are machine facts the bridge can ask in half a second with
 * three `--version` calls, so the answer arrives as a named tool and a fix, not
 * as a forensics exercise.
 *
 * The Node floor is not ours to guess. The certified dsh states it:
 * `dsh/dsh.json` carries `requiresNode`, written by the adoption rail from that
 * exact version's `engines.node`, so it is current by construction (`>=24.9.0`
 * today). Reading it here
 * instead of hardcoding a number means a new pin moves the floor with it, and a
 * metadata file that cannot be read fails THIS check loudly rather than quietly
 * reusing a stale number. It is read when a check is asked for, never at module
 * import: the harness is an optional feature and a broken file in it must not
 * take the whole extension down.
 *
 * The check is worth having because npm only WARNS about an engine mismatch and
 * installs it anyway unless `engine-strict` is set, and this repository does not
 * set it (`npm config get engine-strict` answers false). Without this gate such
 * a machine gets a full download of a composition that was never certified.
 *
 * Checks never throw and never hang a caller: every probe is awaited with a
 * timeout, and a probe that misbehaves is simply a failed check.
 *
 * No `vscode` import: plain node, testable in the vitest run.
 */
import { exec, execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { findNodeOnPath } from './supervisor.js'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

/** Three numbers: a stated floor, or a version banner that was parsed. */
export interface NodeTriple {
  major: number
  minor: number
  patch: number
}

export interface PrereqCheck {
  name: 'node' | 'npm' | 'pnpm'
  ok: boolean
  /** One honest line: the version found, or the tool that is not there. */
  summary: string
  /** What the human must do, including the editor restart the fix implies. Absent when ok. */
  fix?: string
  /**
   * The exact paste-able command that performs the fix, offered for copying
   * but never run by the bridge: installing a tool ON the machine is the
   * human's decision (owner ruling 2026-11-12), so the product asks with the
   * command in the clipboard's reach instead of reaching for the shell.
   */
  command?: string
}

/**
 * The only supported spelling of a Node requirement is `>=MAJOR.MINOR.PATCH`,
 * because that is what dsh writes in `engines.node`. Anything else (`>=24.9`,
 * `^24.9.0`, `20 || 22`, an empty string, a number) is undefined and the caller
 * reports it: this is one support contract being read, not a range language to
 * solve, and inventing semantics for a form nobody certified is how a floor
 * starts lying.
 */
export function parseNodeFloor(stated: unknown): NodeTriple | undefined {
  if (typeof stated !== 'string') return undefined
  const m = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(stated.trim())
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : undefined
}

/** The same three numbers as text, for a message a human reads. */
export function formatNodeFloor(value: NodeTriple): string {
  return `${value.major}.${value.minor}.${value.patch}`
}

/**
 * `v24.10.3` → {24,10,3}. A stable three-part banner and nothing else, so a
 * prerelease (`v24.9.0-rc.1`), a nightly tag, an extra component or trailing
 * garbage is undefined and the caller reports the banner it could not read.
 * A certified floor is a stable-release contract: 24.9.0-rc.1 is NOT 24.9.0.
 */
export function parseNodeVersion(banner: string): NodeTriple | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(banner.trim())
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : undefined
}

/**
 * All three components count, so a future floor of 24.9.1 cannot be met by a
 * 24.9.0 that the major-and-minor reading would have waved through. Against a
 * 24.9.0 floor, 24.8.999 fails as surely as 22.0.0.
 */
export function nodeBelowFloor(version: NodeTriple, floor: NodeTriple): boolean {
  if (version.major !== floor.major) return version.major < floor.major
  if (version.minor !== floor.minor) return version.minor < floor.minor
  return version.patch < floor.patch
}

/** The certified floor, or the honest reason there is none. Never a default. */
function certifiedNodeFloor(metadataDir: string): { floor?: NodeTriple; problem?: string } {
  const file = path.join(metadataDir, 'dsh.json')
  let stated: unknown
  try {
    stated = (JSON.parse(readFileSync(file, 'utf8')) as { requiresNode?: unknown }).requiresNode
  } catch (err) {
    return { problem: `${file} could not be read as JSON (${(err as Error).message})` }
  }
  const floor = parseNodeFloor(stated)
  if (!floor) {
    return {
      problem:
        `${file} states no Node requirement in the supported ">=MAJOR.MINOR.PATCH" form (got ` +
        `${JSON.stringify(stated ?? null)})`,
    }
  }
  return { floor }
}

/**
 * The ask for a broken certification, written for the person holding an
 * installed extension: the certification rail lives in `scripts/` and is not
 * shipped, so pointing at it here would be an instruction nobody can carry out.
 * This is not a "go install Node.js" case either - the machine is fine, the
 * package is not, and the exact file and cause stay in the summary the log
 * records.
 */
const METADATA_FIX =
  'This vLLM-Copilot installation carries a damaged harness certification file, so its Node requirement is unknown and nothing is downloaded. Update or reinstall vLLM-Copilot and reload the window; if it persists, report the installation as damaged, quoting the "DeepSeek Harness" output log.'

/**
 * Probe the machine. Order is the install order: node first, because npm is
 * just a file in node's toolbox, and a user missing both performs one fix.
 *
 * @param metadataDir directory holding `dsh.json`, the certified version and its
 *   Node requirement (the installed extension's own `dsh` directory)
 */
export async function runPreflight(metadataDir: string): Promise<PrereqCheck[]> {
  const checks: PrereqCheck[] = []
  const certified = certifiedNodeFloor(metadataDir)
  // Same law as the supervisor's launcher choice: inside the editor host the
  // execPath is Electron, which dsh's loader refuses, so only a real node on
  // PATH counts there. Outside Electron the caller IS a real node.
  const nodePath = process.versions.electron ? findNodeOnPath(process.env.PATH) : process.execPath
  if (certified.problem || !certified.floor) {
    // Without a floor there is no honest verdict about the machine to give, so
    // the check names the broken file rather than waving through an unknown.
    checks.push({
      name: 'node',
      ok: false,
      summary: `the harness cannot state its Node floor: ${certified.problem ?? 'no floor parsed'}`,
      fix: METADATA_FIX,
    })
  } else {
    const floor = certified.floor
    const floorText = formatNodeFloor(floor)
    const nodeFix = `Install Node.js ${floorText} or newer from https://nodejs.org and restart the editor. VS Code\'s own runtime cannot run the harness; vLLM-Copilot launches dsh with the node from your PATH.`
    if (!nodePath) {
      checks.push({ name: 'node', ok: false, summary: 'no Node.js found on PATH', fix: nodeFix })
    } else {
      try {
        const { stdout } = await execFileAsync(nodePath, ['--version'], { timeout: 15_000, windowsHide: true })
        const version = parseNodeVersion(stdout)
        if (!version) {
          checks.push({
            name: 'node',
            ok: false,
            summary: `the node at ${nodePath} answered --version with "${stdout.trim().slice(0, 60)}"`,
            fix: nodeFix,
          })
        } else if (nodeBelowFloor(version, floor)) {
          checks.push({
            name: 'node',
            ok: false,
            summary: `Node.js ${formatNodeFloor(version)} on PATH, but the certified harness needs ${floorText}+`,
            fix: `Upgrade Node.js to ${floorText} or newer (https://nodejs.org) and restart the editor. vLLM-Copilot found ${nodePath}.`,
          })
        } else {
          checks.push({ name: 'node', ok: true, summary: `${stdout.trim()} at ${nodePath}` })
        }
      } catch (err) {
        checks.push({ name: 'node', ok: false, summary: `the node at ${nodePath} could not run: ${(err as Error).message}`, fix: nodeFix })
      }
    }
  }
  // npm and pnpm are asked whatever the Node verdict was, so one run names every
  // missing tool at once instead of one per attempt.
  const npmFloorText = certified.floor ? ` ${formatNodeFloor(certified.floor)} or newer` : ''
  try {
    // Through the shell on purpose: npm is a `.cmd` on Windows, exactly the
    // shim the runtime module refuses to spawn directly. `exec` gives us the
    // shell instead of us giving it our arguments.
    const { stdout } = await execAsync('npm --version', { timeout: 20_000 })
    const version = stdout.trim()
    checks.push(
      version
        ? { name: 'npm', ok: true, summary: `npm ${version}` }
        : { name: 'npm', ok: false, summary: 'npm answered "npm --version" with nothing', fix: `Reinstall Node.js${npmFloorText} (npm ships with it) and restart the editor.` },
    )
  } catch {
    checks.push({
      name: 'npm',
      ok: false,
      summary: 'npm did not answer "npm --version"',
      fix: `Install Node.js${npmFloorText} from https://nodejs.org (npm ships with it) and restart the editor. If Node is already installed, its directory must be on PATH.`,
    })
  }
  // pnpm is not a formality we chose: dsh installs every profile plugin by
  // forwarding `pnpm add` (observed: exit 127 "pnpm was not found" on a
  // pnpm-free machine, AFTER the multi-minute npm runtime install). npm does
  // not ship it, so it is a third prerequisite with its own name and fix,
  // asked before any download rather than discovered at the plugin step.
  try {
    // Shell on purpose, same law as npm: pnpm is a `.cmd` shim on Windows too.
    const { stdout } = await execAsync('pnpm --version', { timeout: 20_000 })
    const version = stdout.trim()
    checks.push(
      version
        ? { name: 'pnpm', ok: true, summary: `pnpm ${version}` }
        : { name: 'pnpm', ok: false, summary: 'pnpm answered "pnpm --version" with nothing', fix: pnpmFix, command: PNPM_COMMAND },
    )
  } catch {
    checks.push({
      name: 'pnpm',
      ok: false,
      summary: 'no pnpm found on PATH',
      fix: pnpmFix,
      command: PNPM_COMMAND,
    })
  }
  return checks
}

const PNPM_COMMAND = 'npm install -g pnpm'
const pnpmFix =
  `Install pnpm and restart the editor: "${PNPM_COMMAND}" works on every platform ("corepack enable" also provides it, and a global npm install may need sudo where Node is system-owned). The harness installs its plugins with pnpm; npm cannot do this step.`
