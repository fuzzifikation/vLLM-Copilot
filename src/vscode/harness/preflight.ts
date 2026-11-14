/**
 * Machine-level prerequisites, answered before any npm traffic.
 *
 * The start path used to discover a missing Node by watching `npm install`
 * fail with cmd.exe's standard "not recognized as an internal or external
 * command", and a Node 18 machine installed the whole dsh tree happily and
 * then died inside dsh's own engine guard. Both are machine facts the bridge
 * can ask in half a second with three `--version` calls, so the answer arrives
 * as a named tool and a fix, not as a forensics exercise.
 *
 * Checks never throw and never hang a caller: every probe is awaited with a
 * timeout, and a probe that misbehaves is simply a failed check.
 *
 * No `vscode` import: plain node, testable in the vitest run.
 */
import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { findNodeOnPath } from './supervisor.js'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

/**
 * dsh's own engine floor (README: "Node.js 22+"). Below it npm installs the
 * tree without complaint and the launcher refuses to run, so the floor is
 * checked here rather than discovered there.
 */
export const NODE_MAJOR_MIN = 22

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

/** `v22.11.0` → 22; anything without a leading number is not a node version. */
export function parseNodeMajor(out: string): number | undefined {
  const m = /^v?(\d+)\./.exec(out.trim())
  return m?.[1] === undefined ? undefined : Number(m[1])
}

/**
 * Probe the machine. Order is the install order: node first, because npm is
 * just a file in node's toolbox, and a user missing both performs one fix.
 */
export async function runPreflight(): Promise<PrereqCheck[]> {
  const checks: PrereqCheck[] = []
  // Same law as the supervisor's launcher choice: inside the editor host the
  // execPath is Electron, which dsh's loader refuses, so only a real node on
  // PATH counts there. Outside Electron the caller IS a real node.
  const nodePath = process.versions.electron ? findNodeOnPath(process.env.PATH) : process.execPath
  const nodeFix = 'Install Node.js 22 or newer from https://nodejs.org and restart the editor. VS Code\'s own runtime cannot run the harness; vLLM-Copilot launches dsh with the node from your PATH.'
  if (!nodePath) {
    checks.push({ name: 'node', ok: false, summary: 'no Node.js found on PATH', fix: nodeFix })
  } else {
    try {
      const { stdout } = await execFileAsync(nodePath, ['--version'], { timeout: 15_000, windowsHide: true })
      const major = parseNodeMajor(stdout)
      if (major === undefined) {
        checks.push({
          name: 'node',
          ok: false,
          summary: `the node at ${nodePath} answered --version with "${stdout.trim().slice(0, 60)}"`,
          fix: nodeFix,
        })
      } else if (major < NODE_MAJOR_MIN) {
        checks.push({
          name: 'node',
          ok: false,
          summary: `Node.js ${major} on PATH, but the harness needs ${NODE_MAJOR_MIN}+`,
          fix: `Upgrade Node.js to 22 or newer (https://nodejs.org) and restart the editor. vLLM-Copilot found ${nodePath}.`,
        })
      } else {
        checks.push({ name: 'node', ok: true, summary: `${stdout.trim()} at ${nodePath}` })
      }
    } catch (err) {
      checks.push({ name: 'node', ok: false, summary: `the node at ${nodePath} could not run: ${(err as Error).message}`, fix: nodeFix })
    }
  }
  try {
    // Through the shell on purpose: npm is a `.cmd` on Windows, exactly the
    // shim the runtime module refuses to spawn directly. `exec` gives us the
    // shell instead of us giving it our arguments.
    const { stdout } = await execAsync('npm --version', { timeout: 20_000 })
    const version = stdout.trim()
    checks.push(
      version
        ? { name: 'npm', ok: true, summary: `npm ${version}` }
        : { name: 'npm', ok: false, summary: 'npm answered "npm --version" with nothing', fix: 'Reinstall Node.js 22 or newer (npm ships with it) and restart the editor.' },
    )
  } catch {
    checks.push({
      name: 'npm',
      ok: false,
      summary: 'npm did not answer "npm --version"',
      fix: 'Install Node.js 22 or newer from https://nodejs.org (npm ships with it) and restart the editor. If Node is already installed, its directory must be on PATH.',
    })
  }
  // pnpm is not a formality we chose: dsh installs every profile plugin by
  // forwarding `pnpm add` (observed: exit 127 "pnpm was not found" on a
  // pnpm-free machine, AFTER the multi-minute npm runtime install). npm does
  // not ship it, so it is a third prerequisite with its own name and fix,
  // asked before any download rather than discovered at the plugin step.
  try {
    // Shell on purpose, same law as npm: pnpm is a `.cmd` shim on Windows.
    const { stdout } = await execAsync('pnpm --version', { timeout: 20_000 })
    const version = stdout.trim()
    checks.push(
      version
        ? { name: 'pnpm', ok: true, summary: `pnpm ${version}` }
        : { name: 'pnpm', ok: false, summary: 'pnpm answered "pnpm --version" with nothing', fix: pnpmFix, command: PNPM_COMMAND },
    )
  } catch {
    checks.push({ name: 'pnpm', ok: false, summary: 'no pnpm found on PATH', fix: pnpmFix, command: PNPM_COMMAND })
  }
  return checks
}

const PNPM_COMMAND = 'npm install -g pnpm'
const pnpmFix =
  `Install pnpm and restart the editor: "${PNPM_COMMAND}" works on every platform ("corepack enable" also provides it, and a global npm install may need sudo where Node is system-owned). The harness installs its plugins with pnpm; npm cannot do this step.`
