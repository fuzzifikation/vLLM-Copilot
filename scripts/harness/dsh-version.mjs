/**
 * The one place this repo reads a dsh version, and the Node version that
 * version requires, from `dsh/dsh.json`.
 *
 * `dsh/dsh.json` carries the certified pin and its `requiresNode`. `DSH_VERSION`
 * overrides the pin for a one-off certification run (a canary against a
 * candidate release), and `describeDshVersion()` reports the override so no log
 * silently lies about which build produced a result.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const pinFile = path.join(repoRoot, 'dsh', 'dsh.json')
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const FLOOR = /^>=(\d+)\.(\d+)\.(\d+)$/

export function assertExact(version, label) {
  if (!EXACT.test(version)) {
    throw new Error(`${label}: expected an exact semver version, got ${JSON.stringify(version)}`)
  }
  return version
}

export function readPin(file = pinFile) {
  return assertExact(JSON.parse(readFileSync(file, 'utf8')).pinned, file)
}

/**
 * The Node requirement this repo can act on: `>=MAJOR.MINOR.PATCH`, the spelling
 * dsh uses in `engines.node`. Anything else is refused with the value quoted,
 * because a half-read range would turn into a floor nobody certified.
 */
export function assertNodeFloor(stated, label) {
  const text = typeof stated === 'string' ? stated.trim() : ''
  if (!FLOOR.test(text)) {
    throw new Error(`${label}: expected a Node requirement of the form ">=MAJOR.MINOR.PATCH", got ${JSON.stringify(stated ?? null)}`)
  }
  return text
}

/** The certified Node requirement, as adopt() wrote it beside the pin. */
export function readNodeFloor(file = pinFile) {
  return assertNodeFloor(JSON.parse(readFileSync(file, 'utf8')).requiresNode, `${file} requiresNode`)
}

/**
 * Adopt a version only after the boot check certified it. Pin and Node
 * requirement are ONE write: a new pin beside an old floor (or the reverse) is a
 * file that lies, so anything thrown before the rename leaves the previous
 * certification standing untouched.
 */
export function writePin(version, nodeFloor, file = pinFile) {
  assertExact(version, 'writePin')
  const floor = assertNodeFloor(nodeFloor, 'writePin')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.pinned = version
  raw.requiresNode = floor
  writeFileSync(`${file}.tmp`, JSON.stringify(raw, null, 2) + '\n')
  renameSync(`${file}.tmp`, file)
  return version
}

/**
 * Order two exact versions the way npm does, over exactly the shapes
 * `assertExact` admits: `X.Y.Z` and `X.Y.Z-prerelease`. The rail needs ordering
 * because a certified pin is allowed to sit AHEAD of `latest`: `--adopt` is the
 * only writer of the pin and it writes nothing a real boot has not streamed,
 * so adopting a prerelease published under another dist-tag is a legitimate
 * state. A rail that reads "newer than upstream" as drift tells the next human
 * to paste a command that downgrades a deliberate decision.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    assertExact(v, 'compareVersions')
    const [core, pre = ''] = v.split(/-(.*)/s)
    return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [] }
  }
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1
  }
  // Semver: a version carrying a prerelease sorts BELOW the same version bare.
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const [numericP, numericQ] = [/^\d+$/.test(p), /^\d+$/.test(q)]
    if (numericP && numericQ) return Number(p) < Number(q) ? -1 : 1
    // Numeric identifiers rank below alphanumeric ones; equal-length text is lexical.
    if (numericP !== numericQ) return numericP ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/** Effective version for this process, with any override made visible. */
export function describeDshVersion(env = process.env) {
  const override = env.DSH_VERSION?.trim()
  // The override string is interpolated into an `npm install` command line,
  // so it gets the pin's exactness discipline or the canary runs whatever
  // `DSH_VERSION` was set to, range specifiers and shell metacharacters included.
  if (override) assertExact(override, 'DSH_VERSION override')
  const pinned = readPin()
  return { version: override || pinned, pinned, overridden: Boolean(override && override !== pinned) }
}
