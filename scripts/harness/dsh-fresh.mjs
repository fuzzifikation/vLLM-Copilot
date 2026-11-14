#!/usr/bin/env node
/**
 * dsh freshness and adoption rail.
 *
 * `npm run harness:fresh`  (node scripts/harness/dsh-fresh.mjs)
 *   Reports npm `latest`/`alpha` against our certified pin and FAILS when
 *   `latest` drifts, so upstream movement becomes a red rail, not a production
 *   surprise. dsh's semver is decorative; never trust it silently.
 *
 * `node scripts/harness/dsh-fresh.mjs --probe <version>`
 *   Certify a candidate WITHOUT adopting: temporarily point the plugin's
 *   dsh-llm peer at that version, re-stage, run the boot check, then restore
 *   every byte. Never writes dsh/dsh.json.
 *
 * `node scripts/harness/dsh-fresh.mjs --adopt <version>`
 *   Probe first; on PASS write the pin and the peer permanently. A version
 *   that has not streamed through the harness is not adopted.
 *
 * Peer rule: `@deepseek-ai/dsh-llm` is NOT a dependency of the dsh package, it
 * is the lockstep sibling (`dsh@X` ships `dsh-llm@X`). dsh's plugin manager
 * polices our declared peer at install, so the peer must equal the target
 * version exactly, and that version must exist on npm.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeDshVersion, readPin, writePin, assertExact } from './dsh-version.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DSH_PKG = '@deepseek-ai/dsh'
const LLM_PKG = '@deepseek-ai/dsh-llm'
const pluginManifest = path.join(repoRoot, 'dsh', 'plugin', 'package.json')
const rootManifest = path.join(repoRoot, 'package.json')

const npmView = (args) => JSON.parse(execFileSync('npm', ['view', ...args, '--json'], { encoding: 'utf8', shell: true, maxBuffer: 16 * 1024 * 1024 }))
const npmExists = (spec) => {
  try {
    return npmView([spec, 'version']) !== undefined
  } catch {
    return false
  }
}
function distTags() {
  return npmView([DSH_PKG, 'dist-tags'])
}

/**
 * Set the plugin's declared dsh-llm peer (and the root devDependency used by
 * fixtures) by rewriting exactly the dependency line. A full JSON round trip
 * would reflow the hand-compacted menu rows into dozens of changed lines, and
 * an adoption that shows up as 150 lines of formatting noise hides the one
 * line that matters. The existing range prefix (^ or exact) is preserved.
 */
function setPeer(version) {
  const needle = new RegExp(`("${LLM_PKG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*"\\^?)[^"]+(")`)
  for (const file of [pluginManifest, rootManifest]) {
    const text = readFileSync(file, 'utf8')
    if (!needle.test(text)) throw new Error(`setPeer: no ${LLM_PKG} dependency line in ${file}; the rail's assumption about the manifests broke`)
    writeFileSync(file, text.replace(needle, `$1${version}$2`))
  }
}

function restoreFrom(backups) {
  for (const [file, text] of backups) writeFileSync(file, text)
}

/**
 * Run the boot check against `version` with the peer it requires, restoring the
 * manifests afterwards. Stages first: dsh installs the staged plugin copy, so a
 * peer edit only takes effect once re-staged.
 */
function probe(version) {
  if (!npmExists(`${LLM_PKG}@${version}`)) {
    console.error(`FAIL: ${LLM_PKG}@${version} is not on npm. dsh and dsh-llm ship in lockstep; refusing to declare a peer that cannot resolve.`)
    return false
  }
  const backups = new Map([[pluginManifest, readFileSync(pluginManifest, 'utf8')], [rootManifest, readFileSync(rootManifest, 'utf8')]])
  try {
    setPeer(version)
    console.log(`staging with ${LLM_PKG}@${version} peer...`)
    const stage = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'harness', 'stage-core.mjs')], { cwd: repoRoot, stdio: 'inherit' })
    if (stage.status !== 0) {
      console.error('FAIL: staging failed, candidate not certified.')
      return false
    }
    console.log(`certifying dsh ${version} with the boot check...`)
    const boot = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'harness', 'step2-boot-check.mjs'), '--fresh'], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, DSH_VERSION: version },
    })
    return boot.status === 0
  } finally {
    restoreFrom(backups)
  }
}

function adopt(version) {
  if (!probe(version)) {
    console.error(`dsh ${version} NOT adopted; pin stays ${readPin()}.`)
    process.exit(1)
  }
  // probe() restores the manifests, so the certified peer must be written
  // permanently here or the pin and the declared peer drift apart, and dsh's
  // plugin manager polices exactly that pair at install time. Peer first:
  // if anything fails between the two writes, the older pin still matches the
  // older certified state instead of a fresh pin pointing at a stale peer.
  setPeer(version)
  writePin(version)
  console.log(`\nadopted dsh ${version} (peer ${LLM_PKG}@${version}).`)
  console.log('Re-run `npm install` to sync the lockfile, then `npm test`.')
}

const flagIndex = process.argv.findIndex((a) => a === '--adopt' || a === '--probe')
if (flagIndex !== -1) {
  const mode = process.argv[flagIndex]
  let version
  try {
    // The version continues into `npm view ... --json` under shell:true on
    // Windows: an exact semver here is the only place that can say so, and
    // adopt() passes the same string to setPeer. Guard once, trust everywhere.
    version = assertExact(process.argv[flagIndex + 1], mode)
  } catch (err) {
    console.error(err.message)
    process.exit(2)
  }
  if (mode === '--adopt') adopt(version)
  else process.exit(probe(version) ? 0 : 1)
  process.exit(0)
}

const tags = distTags()
const { pinned, overridden } = describeDshVersion()
console.log(`${DSH_PKG}: latest=${tags.latest} alpha=${tags.alpha ?? '-'} | certified pin=${pinned}${overridden ? ' (DSH_VERSION override active)' : ''}`)
if (overridden) {
  console.log('DSH_VERSION is set: this run certifies a candidate, it does not move the pin.')
  process.exit(0)
}
if (tags.latest !== pinned) {
  console.error(`DRIFT: upstream latest ${JSON.stringify(tags.latest)} != certified pin ${pinned}.`)
  // The suggested lines below are made to be pasted into a shell, and their
  // version comes from the registry: only an exact semver gets printed.
  let exactLatest
  try {
    exactLatest = assertExact(tags.latest, 'registry dist-tag "latest"')
  } catch {
    console.error('  the registry served a dist-tag that is not an exact version; refusing to print a copy-paste command for it.')
    process.exit(1)
  }
  console.error(`  probe:  node scripts/harness/dsh-fresh.mjs --probe ${exactLatest}`)
  console.error(`  adopt:  node scripts/harness/dsh-fresh.mjs --adopt ${exactLatest}`)
  process.exit(1)
}
console.log(`up to date: certified pin equals upstream latest (${pinned})`)
if (tags.alpha && tags.alpha !== tags.latest) {
  let exactAlpha
  try {
    exactAlpha = assertExact(tags.alpha, 'registry dist-tag "alpha"')
  } catch {
    exactAlpha = undefined
  }
  if (exactAlpha) console.log(`alpha available for a canary: node scripts/harness/dsh-fresh.mjs --probe ${exactAlpha}`)
}
