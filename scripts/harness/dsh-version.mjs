/**
 * The one place this repo reads a dsh version from.
 *
 * `dsh/dsh.json` carries the certified pin. `DSH_VERSION` overrides it for a
 * one-off certification run (a canary against a candidate release), and
 * `describeDshVersion()` reports the override so no log silently lies about
 * which build produced a result.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const pinFile = path.join(repoRoot, 'dsh', 'dsh.json')
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

export function assertExact(version, label) {
  if (!EXACT.test(version)) {
    throw new Error(`${label}: expected an exact semver version, got ${JSON.stringify(version)}`)
  }
  return version
}

export function readPin(file = pinFile) {
  return assertExact(JSON.parse(readFileSync(file, 'utf8')).pinned, file)
}

/** Adopt a version only after it has been certified by the boot check. */
export function writePin(version, file = pinFile) {
  assertExact(version, 'writePin')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.pinned = version
  writeFileSync(`${file}.tmp`, JSON.stringify(raw, null, 2) + '\n')
  renameSync(`${file}.tmp`, file)
  return version
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
