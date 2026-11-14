/**
 * Tripwires for the prerequisite gate. Named breakages:
 *  - a version parser that misreads a banner, or survives garbage, either waves
 *    through a machine the certified harness does not support or refuses a good
 *    one and sends the tester chasing a phantom;
 *  - a Node floor that is remembered instead of read, so a new dsh pin keeps the
 *    previous pin's requirement, or a broken metadata file quietly defaults to
 *    whatever number is in the source;
 *  - a preflight that throws or hangs hands the wedged start back to the user,
 *    which is the exact failure the gate was built to prevent.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { formatNodeFloor, nodeBelowFloor, parseNodeFloor, parseNodeVersion, runPreflight } from '../../src/vscode/harness/preflight.js'

const repo = path.resolve(import.meta.dirname, '..', '..')
/** The shipped certification: the only place a Node floor comes from. */
const certified = JSON.parse(readFileSync(path.join(repo, 'dsh', 'dsh.json'), 'utf8'))
const FLOOR = parseNodeFloor(certified.requiresNode)

const tempDirs = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A directory holding a dsh.json with exactly the contents a case needs. */
function metadataDir(contents) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-meta-'))
  writeFileSync(path.join(dir, 'dsh.json'), typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8')
  tempDirs.push(dir)
  return dir
}

const nodeCheck = (checks) => checks.find((check) => check.name === 'node')

describe('the certified Node floor', () => {
  it('reads the one supported spelling and nothing else', () => {
    expect(parseNodeFloor('>=24.9.0')).toEqual({ major: 24, minor: 9, patch: 0 })
    expect(parseNodeFloor('  >=24.9.0  ')).toEqual({ major: 24, minor: 9, patch: 0 })
    // A partial, caret, range, bare or absent requirement is a contract this
    // repo cannot check, so it is undefined rather than a guessed floor.
    for (const unsupported of ['>=24.9', '>=24', '24.9.0', '^24.9.0', '>=24.9.0 <25', '20 || 22', 'latest', '', '   ']) {
      expect(parseNodeFloor(unsupported), unsupported).toBeUndefined()
    }
    for (const notText of [undefined, null, 24.9, { node: '>=24.9.0' }, ['>=24.9.0']]) {
      expect(parseNodeFloor(notText)).toBeUndefined()
    }
  })

  it('compares all three components, so a patch floor cannot be dodged', () => {
    expect(FLOOR).toBeDefined()
    const against = (banner) => nodeBelowFloor(parseNodeVersion(banner), FLOOR)
    expect(against('v22.20.0')).toBe(true)
    expect(against('v23.9.9')).toBe(true)
    expect(against('v24.0.0')).toBe(true)
    expect(against('v24.8.999')).toBe(true)
    expect(against('v24.9.0')).toBe(false)
    expect(against('v24.9.1')).toBe(false)
    expect(against('v24.10.0')).toBe(false)
    expect(against('v25.0.0')).toBe(false)
    // Same floor one patch higher: the version that passed a minute ago fails.
    expect(nodeBelowFloor({ major: 24, minor: 9, patch: 0 }, { major: 24, minor: 9, patch: 1 })).toBe(true)
  })

  it('parses what node prints and refuses what it does not', () => {
    expect(parseNodeVersion('v24.10.3')).toEqual({ major: 24, minor: 10, patch: 3 })
    expect(parseNodeVersion('v18.20.4\n')).toEqual({ major: 18, minor: 20, patch: 4 })
    expect(parseNodeVersion('26.0.0')).toEqual({ major: 26, minor: 0, patch: 0 })
    // A prerelease is not the stable release the floor promises, and nothing is
    // quietly dropped from a banner: an extra component or glued-on garbage
    // fails the way a missing tool does, by being reported.
    expect(parseNodeVersion('v24.9.0-rc.1')).toBeUndefined()
    expect(parseNodeVersion('v24.9.0-nightly')).toBeUndefined()
    expect(parseNodeVersion('v24.9.0.1')).toBeUndefined()
    expect(parseNodeVersion('v24.9.0garbage')).toBeUndefined()
    expect(parseNodeVersion('v24.9.0 \n')).toEqual({ major: 24, minor: 9, patch: 0 })
    expect(parseNodeVersion('24.9')).toBeUndefined()
    expect(parseNodeVersion('garbage')).toBeUndefined()
    expect(parseNodeVersion('')).toBeUndefined()
    expect(parseNodeVersion('electron v20.0.0')).toBeUndefined()
    expect(formatNodeFloor({ major: 24, minor: 9, patch: 0 })).toBe('24.9.0')
  })
})

describe('the prerequisite probe', () => {
  it('answers node, npm and pnpm without throwing, floored by the certified file', async () => {
    // Vitest runs on plain node, so the in-process execPath is a legal harness
    // runtime. The verdict must track the runner's own version against the
    // shipped metadata: never a pass the floor forbids, never a invented one.
    const checks = await runPreflight(path.join(repo, 'dsh'))
    expect(checks.map((check) => check.name).sort()).toEqual(['node', 'npm', 'pnpm'])
    for (const check of checks) expect(check.summary.length).toBeGreaterThan(0)
    const running = parseNodeVersion(`v${process.versions.node}`)
    expect(nodeCheck(checks).ok).toBe(!nodeBelowFloor(running, FLOOR))
    if (!nodeCheck(checks).ok) expect(nodeCheck(checks).fix).toMatch(/restart the editor/i)
    const pnpm = checks.find((check) => check.name === 'pnpm')
    if (!pnpm.ok) {
      expect(pnpm.fix).toMatch(/pnpm/i)
      // The ask must be copy-able: the human installs it, the bridge only hands over the command.
      expect(pnpm.command).toBe('npm install -g pnpm')
    }
  })

  it('fails this machine against a floor above it, in the metadata\u2019s own words', async () => {
    const checks = await runPreflight(metadataDir({ pinned: '9.9.9', requiresNode: '>=99.0.0' }))
    const node = nodeCheck(checks)
    const running = parseNodeVersion(`v${process.versions.node}`)
    expect(node.ok).toBe(false)
    expect(node.summary).toBe(`Node.js ${formatNodeFloor(running)} on PATH, but the certified harness needs 99.0.0+`)
    expect(node.fix).toMatch(/Upgrade Node\.js to 99\.0\.0 or newer/)
    expect(node.fix).toMatch(/restart the editor/i)
    // npm and pnpm are still asked, so one run names every missing tool at once.
    expect(checks.map((check) => check.name).sort()).toEqual(['node', 'npm', 'pnpm'])
  })

  it('waves this machine through a floor far below it', async () => {
    const checks = await runPreflight(metadataDir({ pinned: '0.0.1', requiresNode: '>=1.0.0' }))
    expect(nodeCheck(checks).ok).toBe(true)
    expect(nodeCheck(checks).summary).toMatch(/^v?\d+\.\d+\.\d+ at /)
  })

  it('refuses to guess when the certification states no readable floor', async () => {
    const broken = [
      { case: 'no field at all', contents: { pinned: '0.2.2-rc.1' } },
      { case: 'a partial requirement', contents: { pinned: '0.2.2-rc.1', requiresNode: '>=24.9' } },
      { case: 'a range', contents: { pinned: '0.2.2-rc.1', requiresNode: '20 || 22' } },
      { case: 'a number', contents: { pinned: '0.2.2-rc.1', requiresNode: 24.9 } },
      { case: 'not JSON at all', contents: 'pinned = 0.2.2-rc.1' },
    ]
    for (const { case: label, contents } of broken) {
      const checks = await runPreflight(metadataDir(contents))
      const node = nodeCheck(checks)
      expect(node.ok, label).toBe(false)
      expect(node.summary, label).toMatch(/cannot state its Node floor/)
      expect(node.summary, label).toMatch(/dsh\.json/)
      // The ask is one a person holding an installed extension can carry out;
      // the certification rail it needs lives in scripts/, which is not shipped.
      expect(node.fix, label).toMatch(/[Uu]pdate or reinstall vLLM-Copilot/)
      expect(node.fix, label).not.toMatch(/scripts[\\/]/)
    }
  })

  it('names the missing metadata file instead of defaulting to a number', async () => {
    const missing = mkdtempSync(path.join(tmpdir(), 'dsh-empty-'))
    tempDirs.push(missing)
    const checks = await runPreflight(missing)
    expect(nodeCheck(checks).ok).toBe(false)
    expect(nodeCheck(checks).summary).toMatch(/could not be read as JSON/)
    expect(nodeCheck(checks).summary).toMatch(/dsh\.json/)
  })
})
