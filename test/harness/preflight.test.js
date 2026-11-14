/**
 * Tripwires for the prerequisite gate. Named breakages:
 *  - a version parser that misreads `v22.11.0` (or survives garbage) starts a
 *    harness on a runtime dsh's engine guard will refuse, or refuses a good
 *    machine and sends the alpha tester chasing a phantom;
 *  - a preflight that throws or hangs hands the wedged start back to the user,
 *    which is the exact failure the gate was built to prevent.
 */
import { it, expect, describe } from 'vitest'
import { NODE_MAJOR_MIN, parseNodeMajor, runPreflight } from '../../src/vscode/harness/preflight.js'

describe('prerequisite preflight', () => {
  it('reads the major out of a node version banner', () => {
    expect(parseNodeMajor('v22.11.0')).toBe(22)
    expect(parseNodeMajor('v18.20.4\n')).toBe(18)
    expect(parseNodeMajor('26.0.0')).toBe(26)
    expect(parseNodeMajor('garbage')).toBeUndefined()
    expect(parseNodeMajor('')).toBeUndefined()
    expect(parseNodeMajor('electron v20.0.0')).toBeUndefined()
  })

  it('answers both checks without throwing, from inside a real node', async () => {
    // Vitest runs on plain node, so the in-process execPath is a legal harness
    // runtime. The floor verdict must track the runner's own major: an
    // environment below it is a fail the message names, never a false pass.
    const checks = await runPreflight()
    expect(checks.map((c) => c.name).sort()).toEqual(['node', 'npm', 'pnpm'])
    const runnerMajor = parseNodeMajor(process.versions.node)
    const node = checks.find((c) => c.name === 'node')
    expect(node.ok).toBe(runnerMajor >= NODE_MAJOR_MIN)
    if (!node.ok) expect(node.fix).toMatch(/restart the editor/i)
    const pnpm = checks.find((c) => c.name === 'pnpm')
    if (!pnpm.ok) {
      expect(pnpm.fix).toMatch(/pnpm/i)
      // The ask must be copy-able: the human installs it, the bridge only hands over the command.
      expect(pnpm.command).toBe('npm install -g pnpm')
    }
    for (const check of checks) expect(check.summary.length).toBeGreaterThan(0)
  })
})
