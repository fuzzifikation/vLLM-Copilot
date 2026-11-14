/**
 * Core staging: turn a compiled vLLM-Copilot `out/core` tree into a local npm
 * package the dsh profile can install. Used by `scripts/harness/stage-core.mjs`
 * (dev and the rails, from this repository's own compiled `out/core`) and by the
 * extension (production, from the installed extension's own `out/`). Both paths
 * must produce a byte-equivalent package or the certified boot check certifies a
 * layout the user never gets, so the math lives here once.
 *
 * The generated manifest derives its dependencies from the staged tree's own
 * bare imports: tsc emits one import per line, so a line-anchored scan is
 * exact, and a new upstream import that upstream's manifest does not declare
 * fails this scan loudly instead of failing at runtime inside a dsh process
 * where nobody will read the log.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'

const CORE_PACKAGE_NAME = 'vllm-copilot-core'

function walkJs(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walkJs(p, visit)
    else if (entry.name.endsWith('.js')) visit(p)
  }
}

/**
 * Bare (non-relative, non-builtin) package specifiers the tree imports.
 * Over-inclusion is safe (an unmanifested name fails the build loudly below);
 * under-inclusion is the killer: a missing dependency resolves only until the
 * harness imports it, so double quotes and side-effect imports must match too.
 */
const BARE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'".][^'"]*)['"]/

export function scanBareImports(coreDir) {
  const names = new Set()
  walkJs(coreDir, (file) => {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      // Doc comments quote example text ("a value from "data: <json>"") and
      // compiled JS keeps them; a prose line is not an import no matter what
      // it quotes. Real imports never start with a comment marker.
      const trimmed = line.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
      const m = line.match(BARE_IMPORT)
      if (!m) continue
      const spec = m[1]
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      if (!builtinModules.includes(name) && !name.startsWith('node:')) names.add(name)
    }
  })
  return [...names].sort()
}

/**
 * Build the staged package manifest. Every bare import must appear in the
 * source manifest's dependencies (or optionalDependencies): copying a version
 * we invented ourselves would let the harness resolve a library the core was
 * never tested against.
 */
export function buildCoreManifest({ bareImports, sourceManifest, coreVersion, description }) {
  const available = { ...(sourceManifest.dependencies ?? {}), ...(sourceManifest.optionalDependencies ?? {}) }
  const dependencies = {}
  const undeclared = []
  for (const name of bareImports) {
    if (available[name]) dependencies[name] = available[name]
    else undeclared.push(name)
  }
  if (undeclared.length) {
    throw new Error(
      `staged core imports packages the source manifest does not declare: ${undeclared.join(', ')}. ` +
        'Refusing to guess versions for a request-path dependency.',
    )
  }
  return {
    name: CORE_PACKAGE_NAME,
    version: coreVersion,
    private: true,
    type: 'module',
    ...(description ? { description } : {}),
    // The `types` condition resolves for consumers since vLLM-Copilot 1.37.1
    // ships declarations inside out/core; the cpSync above carries them.
    exports: { '.': { types: './core/index.d.ts', import: './core/index.js' } },
    files: ['core', 'LICENSE', 'THIRD-PARTY-NOTICES.txt'],
    license: 'SEE LICENSE IN LICENSE',
    ...(Object.keys(dependencies).length ? { dependencies } : {}),
  }
}

/**
 * Stage the core into `targetDir`. Replaces any previous staging so an
 * extension upgrade never leaves stale modules behind. Returns the manifest it
 * wrote, which the caller stamps into `core-version.json`.
 *
 * @param opts.coreDir compiled `out/core` directory of the installed extension
 * @param opts.sourceManifest parsed package.json of that extension
 * @param opts.targetDir vendor directory for the core package
 * @param opts.docsDir directory holding LICENSE / THIRD-PARTY-NOTICES.txt
 */
export function stageCore({ coreDir, sourceManifest, targetDir, docsDir, coreVersion, description }) {
  if (!coreDir || !existsSync(path.join(coreDir, 'index.js'))) {
    throw new Error(`no compiled core at ${coreDir}: expected index.js (is vLLM-Copilot installed and activated?)`)
  }
  const source = docsDir ?? path.dirname(path.dirname(coreDir))
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  // Sourcemaps point at upstream src that never ships inside a profile.
  cpSync(coreDir, path.join(targetDir, 'core'), { recursive: true, filter: (s) => !s.endsWith('.map') })
  // ...and the dangling pointer has to go with them, or every tool that loads
  // the staged core spends its time reporting a missing file it was told to read.
  walkJs(path.join(targetDir, 'core'), (file) => {
    const text = readFileSync(file, 'utf8')
    const stripped = text.replace(/^\n?\/\/# sourceMappingURL=.*$/gm, '')
    if (stripped !== text) writeFileSync(file, stripped)
  })
  for (const doc of ['LICENSE', 'THIRD-PARTY-NOTICES.txt']) {
    if (existsSync(path.join(source, doc))) cpSync(path.join(source, doc), path.join(targetDir, doc))
  }
  const manifest = buildCoreManifest({
    bareImports: scanBareImports(path.join(targetDir, 'core')),
    sourceManifest,
    coreVersion: coreVersion ?? sourceManifest.version ?? '0.0.0',
    ...(description ? { description } : {}),
  })
  writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

/**
 * Stage the adapter plugin beside the core. The plugin's manifest depends on
 * `vllm-copilot-core` through `file:../vllm-copilot-core`, which pnpm resolves
 * when the profile installs the plugin, pulling the core's own dependencies up
 * into the profile's top-level node_modules.
 */
export function stageAdapter({ pluginDir, targetDir }) {
  if (!pluginDir || !existsSync(path.join(pluginDir, 'package.json'))) {
    throw new Error(`no adapter plugin at ${pluginDir}`)
  }
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(path.dirname(targetDir), { recursive: true })
  cpSync(pluginDir, targetDir, {
    recursive: true,
    filter: (s) => !s.endsWith('.map') && !s.includes(`${path.sep}node_modules${path.sep}`),
  })
  return JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf8'))
}

/** Read the vendor stamp, or undefined when nothing is staged yet. */
export function readCoreStamp(stampFile) {
  try {
    return JSON.parse(readFileSync(stampFile, 'utf8'))
  } catch {
    return undefined
  }
}

export function writeCoreStamp(stampFile, stamp) {
  mkdirSync(path.dirname(stampFile), { recursive: true })
  const text = JSON.stringify(stamp, null, 2) + '\n'
  // tmp + rename: a crash never leaves a half-written stamp that makes the next
  // activation believe a different core version is on disk than actually is.
  writeFileSync(`${stampFile}.tmp`, text)
  renameSync(`${stampFile}.tmp`, stampFile)
  return stamp
}
