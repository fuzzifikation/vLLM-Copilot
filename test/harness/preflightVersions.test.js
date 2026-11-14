/**
 * The whole prerequisite probe, end to end, against banners a real runtime
 * answers. Only the tool on the other end of the pipe is pretend: the parse, the
 * three-component comparison, the certified floor read and the wording the user
 * sees are the shipped ones. A floor is worthless if a prerelease banner slips
 * past it in production while a unit test of the parser looks the other way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** What the tools answer. Set per case; every call is recorded. */
const tools = vi.hoisted(() => ({ node: 'v24.9.0', calls: [] }))

vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  // The probe calls these through `promisify`, which honors a custom
  // implementation. Both shapes are answered like the real ones so nothing in
  // the code under test has to know it is talking to a pipe puppet.
  const answer = (fn, invoke) => {
    fn[promisify.custom] = (...call) =>
      new Promise((resolve, reject) =>
        invoke(...call, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr }))),
      )
    return fn
  }
  const execFile = answer(
    (file, args, options, callback) => {
      const done = typeof options === 'function' ? options : callback
      tools.calls.push(['execFile', String(file), ...(Array.isArray(args) ? args.map(String) : [])])
      done(null, tools.node, '')
    },
    (file, args, options, callback) => execFile(file, args, options, callback),
  )
  const exec = answer(
    (command, options, callback) => {
      const done = typeof options === 'function' ? options : callback
      tools.calls.push(['exec', String(command)])
      done(null, /^npm\b/.test(String(command)) ? '12.2.2\n' : '10.28.2\n', '')
    },
    (command, options, callback) => exec(command, options, callback),
  )
  return { ...(await importOriginal()), execFile, exec }
})

const { runPreflight } = await import('../../src/vscode/harness/preflight.js')

const tempDirs = []
/** A certification file carrying the floor these cases are written against. */
function metadataDir(requiresNode) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-banner-'))
  writeFileSync(path.join(dir, 'dsh.json'), JSON.stringify({ pinned: '0.2.2-rc.1', requiresNode }), 'utf8')
  tempDirs.push(dir)
  return dir
}

const check = (checks, name) => checks.find((entry) => entry.name === name)

let dir
beforeEach(() => {
  tools.calls.length = 0
  tools.node = 'v24.9.0'
  dir = metadataDir('>=24.9.0')
})
afterEach(() => {
  for (const doomed of tempDirs.splice(0)) rmSync(doomed, { recursive: true, force: true })
})

const verdict = async (banner) => {
  tools.node = banner
  return runPreflight(dir)
}

describe('what the prerequisite probe accepts as a Node version', () => {
  it('takes the floor itself and every stable release above it', async () => {
    for (const banner of ['v24.9.0', 'v24.9.1', 'v24.10.0', 'v25.0.0', 'v26.13.0', '24.9.0\n']) {
      const checks = await verdict(banner)
      expect(check(checks, 'node').ok, banner).toBe(true)
    }
    // And it asked a runtime, not a memory.
    expect(tools.calls[0][0]).toBe('execFile')
    expect(tools.calls[0][2]).toBe('--version')
  })

  it('refuses every release below the floor, patch included', async () => {
    for (const banner of ['v22.20.0', 'v24.0.0', 'v24.8.999']) {
      const node = check(await verdict(banner), 'node')
      expect(node.ok, banner).toBe(false)
      expect(node.summary, banner).toMatch(/needs 24\.9\.0\+$/)
    }
  })

  it('refuses a banner that is not a stable triple instead of trusting its prefix', async () => {
    for (const banner of ['v24.9.0-rc.1', 'v24.9.0-nightly', 'v24.9.0.1', 'v24.9.0garbage', 'electron v20.0.0', '24.9', '']) {
      const node = check(await verdict(banner), 'node')
      expect(node.ok, banner).toBe(false)
      expect(node.summary, banner).toMatch(/answered --version with/)
      expect(node.summary, banner).toContain(banner.trim().slice(0, 8))
      expect(node.fix, banner).toMatch(/Install Node\.js 24\.9\.0 or newer/)
    }
  })

  it('still asks npm and pnpm when the Node banner is nonsense', async () => {
    const checks = await verdict('v24.9.0-rc.1')
    expect(checks.map((entry) => entry.name).sort()).toEqual(['node', 'npm', 'pnpm'])
    expect(check(checks, 'node').ok).toBe(false)
    expect(check(checks, 'npm').ok).toBe(true)
    expect(check(checks, 'pnpm').ok).toBe(true)
  })
})
