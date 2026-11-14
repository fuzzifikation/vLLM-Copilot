/**
 * Tripwires for the certification write in `scripts/harness/dsh-version.mjs`.
 * The adoption rail is the only thing allowed to move `dsh/dsh.json`, and
 * preflight now reads its Node floor from there with no fallback, so a partial
 * write is a file that lies: a new pin behind an old requirement would gate
 * every install against a version nobody certified.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertNodeFloor, compareVersions, readNodeFloor, readPin, writePin } from '../../scripts/harness/dsh-version.mjs'

const repo = path.resolve(import.meta.dirname, '..', '..')

const tempDirs = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A copy of the real certification file, in a directory this test owns. */
function pinCopy(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-cert-'))
  tempDirs.push(dir)
  const file = path.join(dir, 'dsh.json')
  const source = JSON.parse(readFileSync(path.join(repo, 'dsh', 'dsh.json'), 'utf8'))
  writeFileSync(file, JSON.stringify({ ...source, ...overrides }, null, 2) + '\n', 'utf8')
  return file
}

describe('certifying a dsh version', () => {
  it('writes the pin and its Node requirement as one act', () => {
    const file = pinCopy()
    const before = readFileSync(file, 'utf8')
    expect(writePin('9.9.9', '>=30.1.2', file)).toBe('9.9.9')
    expect(readPin(file)).toBe('9.9.9')
    expect(readNodeFloor(file)).toBe('>=30.1.2')
    // The write is a rename: no half file is left beside the certification.
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(readFileSync(file, 'utf8')).not.toBe(before)
  })

  it('leaves the previous certification standing when the floor is unusable', () => {
    for (const unusable of ['>=24.9', '24.9.0', '^24.9.0', '>=24.9.0 <25', '', '   ', undefined, null, 24.9]) {
      const file = pinCopy()
      const before = readFileSync(file, 'utf8')
      expect(() => writePin('9.9.9', unusable, file), JSON.stringify(unusable)).toThrow(/>=MAJOR\.MINOR\.PATCH/)
      expect(readFileSync(file, 'utf8'), JSON.stringify(unusable)).toBe(before)
      expect(readPin(file)).not.toBe('9.9.9')
    }
  })

  it('leaves the previous certification standing when the version is unusable', () => {
    const file = pinCopy({ pinned: '1.2.3', requiresNode: '>=24.9.0' })
    const before = readFileSync(file, 'utf8')
    expect(() => writePin('^1.2.3', '>=24.9.0', file)).toThrow(/exact semver/)
    expect(() => writePin('latest', '>=24.9.0', file)).toThrow(/exact semver/)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readPin(file)).toBe('1.2.3')
    expect(readNodeFloor(file)).toBe('>=24.9.0')
  })

  it('refuses to read back a certification with no floor stated', () => {
    const file = pinCopy({ requiresNode: undefined })
    expect(() => readNodeFloor(file)).toThrow(/requiresNode/)
    expect(() => assertNodeFloor('>=24.9', 'engines.node')).toThrow(/>=MAJOR\.MINOR\.PATCH/)
    expect(assertNodeFloor(' >=24.9.0 ', 'engines.node')).toBe('>=24.9.0')
  })
})

/**
 * The freshness rail run as a command, against a throwaway tree. It resolves
 * every path from its own file, so a fixture tree is a whole offline test
 * subject. The registry is stubbed for EVERY case, including the ones that must
 * fail before reaching it: a guard that regresses has to hit a fixture-owned
 * `npm` and leave a mark, never the real registry. The stub is written for the
 * shell that runs it, `npm.cmd` for cmd.exe and an executable `npm` everywhere
 * else, because the rail asks npm through `shell: true`. A developer's own
 * DSH_VERSION is removed so it cannot rewrite the verdict a case asserts.
 */
function railFixture(contents, distTags = '[{"latest":"9.9.9"}]') {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-rail-'))
  tempDirs.push(dir)
  mkdirSync(path.join(dir, 'scripts', 'harness'), { recursive: true })
  mkdirSync(path.join(dir, 'dsh'), { recursive: true })
  for (const name of ['dsh-fresh.mjs', 'dsh-version.mjs']) {
    cpSync(path.join(repo, 'scripts', 'harness', name), path.join(dir, 'scripts', 'harness', name))
  }
  writeFileSync(path.join(dir, 'dsh', 'dsh.json'), `${JSON.stringify(contents, null, 2)}\n`, 'utf8')
  const bin = path.join(dir, 'bin')
  const marker = path.join(dir, 'registry-was-asked')
  mkdirSync(bin, { recursive: true })
  if (process.platform === 'win32') {
    // cmd.exe takes quotes literally, so the JSON keeps its own.
    writeFileSync(path.join(bin, 'npm.cmd'), `@echo off\r\necho asked>"${marker}"\r\necho ${distTags}\r\n`, 'utf8')
  } else {
    // /bin/sh would eat those double quotes, so the JSON goes inside single ones.
    writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nprintf asked >'${marker}'\nprintf '%s\\n' '${distTags}'\n`, 'utf8')
    chmodSync(path.join(bin, 'npm'), 0o755)
  }
  const env = { ...process.env, PATH: bin }
  delete env.DSH_VERSION
  return { script: path.join(dir, 'scripts', 'harness', 'dsh-fresh.mjs'), env, marker }
}

describe('the freshness rail against its own certification', () => {
  it('fails a tree whose mandatory Node requirement is missing or malformed', () => {
    for (const broken of [{ pinned: '0.2.2-rc.1' }, { pinned: '0.2.2-rc.1', requiresNode: '>=24.9' }, { pinned: '0.2.2-rc.1', requiresNode: '^24.9.0' }]) {
      const fixture = railFixture(broken)
      const out = spawnSync(process.execPath, [fixture.script], { encoding: 'utf8', env: fixture.env })
      expect(out.status, JSON.stringify(broken)).toBe(1)
      expect(out.stderr, JSON.stringify(broken)).toMatch(/certified Node requirement is unreadable/)
      expect(out.stderr, JSON.stringify(broken)).toMatch(/--adopt/)
      // Nothing was reported as healthy first: the certification is read before
      // the registry, so a broken tree cannot print a drift line and then fail.
      expect(out.stdout, JSON.stringify(broken)).toBe('')
      // And nothing asked the stub either: failing this tree took no registry
      // traffic at all, real or pretend.
      expect(existsSync(fixture.marker), JSON.stringify(broken)).toBe(false)
    }
  })

  it('lets a certified tree through the gate and all the way to its drift verdict', () => {
    // The stub answers a NEWER version, so the only way this run exits 1 with a
    // drift line is by getting past the certification gate, and the mark says
    // the answer came from the fixture rather than the registry. (It used to
    // answer an OLDER one: with ordering understood, an older `latest` is a
    // deliberately adopted pin, not drift — see the describe below.)
    const fixture = railFixture({ pinned: '0.2.2-rc.1', requiresNode: '>=24.9.0' }, '[{"latest":"9.9.9"}]')
    const out = spawnSync(process.execPath, [fixture.script], { encoding: 'utf8', env: fixture.env })
    expect(out.status).toBe(1)
    expect(existsSync(fixture.marker)).toBe(true)
    expect(out.stderr).not.toMatch(/certified Node requirement/)
    expect(out.stdout).toMatch(/requires node >=24\.9\.0/)
    expect(out.stderr).toMatch(/DRIFT: upstream latest "9\.9\.9"/)
    expect(out.stderr).toMatch(/--adopt 9\.9\.9/)
  })
})

describe('the drift verdict separates upstream movement from a decision', () => {
  it('orders prereleases the way npm does', () => {
    const below = (a, b) => expect(compareVersions(a, b), `${a} should sort below ${b}`).toBe(-1)
    below('0.2.2-rc.1', '0.2.2-rc.3') // the adoption this repo actually made
    below('0.2.2-rc.2', '0.2.2-rc.10') // numerically, not lexically: rc.10 > rc.2
    below('0.2.2-alpha.3', '0.2.2-rc.1') // alpha < rc
    below('0.2.2-rc.3', '0.2.2') // a prerelease sorts below the release it precedes
    below('0.2.9', '0.10.0') // and the core is numeric too
    expect(compareVersions('0.2.2-rc.3', '0.2.2-rc.3')).toBe(0)
    expect(compareVersions('0.2.2', '0.2.2-rc.3')).toBe(1)
    // A range is not a version: the exactness rule that guards the pin guards
    // this comparison too, rather than guessing an order from garbage.
    expect(() => compareVersions('>=0.2.2', '0.2.2')).toThrow(/compareVersions/)
  })

  it('calls a pin newer than latest a decision, and never offers to undo it', () => {
    // The state after adopting a prerelease: certified pin rc.3, upstream latest
    // still rc.1. Downgrade advice here is a rail arguing with its own result.
    const fixture = railFixture({ pinned: '0.2.2-rc.3', requiresNode: '>=24.9.0' }, '[{"latest":"0.2.2-rc.1","next":"0.2.2-rc.3"}]')
    const out = spawnSync(process.execPath, [fixture.script], { encoding: 'utf8', env: fixture.env })
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toMatch(/newer than latest 0\.2\.2-rc\.1/)
    expect(out.stdout).toMatch(/deliberate adoption/)
    expect(out.stdout + out.stderr).not.toMatch(/--adopt 0\.2\.2-rc\.1/)
    // rc.3 is what we run, so it is not a canary either.
    expect(out.stdout).not.toMatch(/canary: node scripts\/harness\/dsh-fresh\.mjs --probe 0\.2\.2-rc\.3/)
  })

  it('names a prerelease parked on another tag instead of calling itself current', () => {
    // The real 2026-11-14 blind spot: rc.1 certified and current, rc.3 published
    // under `next`, and a latest-only rail printing "up to date" while a release
    // nobody had looked at sat one tag away.
    const fixture = railFixture({ pinned: '0.2.2-rc.1', requiresNode: '>=24.9.0' }, '[{"latest":"0.2.2-rc.1","next":"0.2.2-rc.3","alpha":"0.2.2-alpha.3"}]')
    const out = spawnSync(process.execPath, [fixture.script], { encoding: 'utf8', env: fixture.env })
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toMatch(/up to date/)
    expect(out.stdout).toMatch(/next available for a canary: node scripts\/harness\/dsh-fresh\.mjs --probe 0\.2\.2-rc\.3/)
    expect(out.stdout).toMatch(/alpha available for a canary: node scripts\/harness\/dsh-fresh\.mjs --probe 0\.2\.2-alpha\.3/)
  })

  it('stays red, with the same commands, when upstream really is newer', () => {
    const fixture = railFixture({ pinned: '0.2.2-rc.3', requiresNode: '>=24.9.0' }, '[{"latest":"0.2.3"}]')
    const out = spawnSync(process.execPath, [fixture.script], { encoding: 'utf8', env: fixture.env })
    expect(out.status).toBe(1)
    expect(out.stderr).toMatch(/DRIFT: upstream latest "0\.2\.3"/)
    expect(out.stderr).toMatch(/--probe 0\.2\.3/)
    expect(out.stderr).toMatch(/--adopt 0\.2\.3/)
  })
})