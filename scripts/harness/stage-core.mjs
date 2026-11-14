#!/usr/bin/env node
/**
 * Stage this repository's compiled core as a local package, exactly as the
 * extension stages it from its own install directory in production. There is
 * no second repository any more: the core under test is the one in `out/core`
 * of this working tree, so a rail never certifies a core the extension cannot
 * ship.
 *
 * Output: temp/stage/vllm-copilot-core/ = { package.json, LICENSE, core/**.js }
 * with dependencies derived from the staged tree's own bare imports (never
 * hardcoded, so an import addition breaks this script, not the user).
 *
 * Compiles first when out/core/index.js is missing, because a fresh clone has
 * no out/ and the rails are run from the repo root.
 *
 * Usage: node scripts/harness/stage-core.mjs   (npm run harness:stage)
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageAdapter, stageCore } from '../../dsh/shared/core-staging.mjs'

const repo = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const work = path.join(repo, 'temp')
const compiledCore = path.join(repo, 'out', 'core', 'index.js')

const run = (cmd, args, opts = {}) => {
  // npm is a .cmd on Windows and needs a shell, and a shell concatenates its
  // arguments instead of escaping them, so the command is assembled as one
  // string here rather than passed as an argument vector.
  const shellMode = opts.shell === true
  const command = shellMode ? [cmd, ...args].join(' ') : cmd
  const r = spawnSync(command, shellMode ? [] : args, {
    cwd: opts.cwd ?? repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: shellMode,
  })
  if (r.error) throw r.error
  if (r.status !== 0) {
    console.error(`FAIL: ${command} ${args.join(' ')} (exit ${r.status})`)
    console.error((r.stdout ?? '').slice(-2000), (r.stderr ?? '').slice(-2000))
    process.exit(1)
  }
  return r
}

const manifest = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'))
if (!existsSync(compiledCore)) {
  console.log('no compiled core: running `npm run compile`')
  run('npm', ['run', 'compile'], { shell: true })
}
if (!existsSync(compiledCore)) {
  console.error('FAIL: compile produced no out/core/index.js')
  process.exit(1)
}

const stage = path.join(work, 'stage', 'vllm-copilot-core')
// The staging math lives in dsh/shared/core-staging.mjs, the same module the
// extension calls in production, so the dev layout and the shipped layout
// cannot drift into two different things.
const staged = stageCore({
  coreDir: path.join(repo, 'out', 'core'),
  sourceManifest: manifest,
  targetDir: stage,
  docsDir: repo,
  description: `vLLM-Copilot editor-free core (compiled out/core of vLLM-Copilot ${manifest.version}, staged locally by the rails).`,
})
// The profile installs the core's dependencies through pnpm in production; the
// dev stage needs its own node_modules so a bare import from the staged tree
// resolves without a root devDependency that could drift from what the core
// actually declared.
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, shell: true })
console.log(`staged vllm-copilot-core@${staged.version} -> ${stage}`)
console.log(`dependencies derived from imports: ${Object.keys(staged.dependencies ?? {}).join(', ') || '(none)'}`)

// The plugin stages as a sibling so its `file:../vllm-copilot-core` dependency
// resolves identically in dev and production (vendor/ sibling layout).
const pluginStage = path.join(work, 'stage', 'dsh-adapter-vllmc')
stageAdapter({ pluginDir: path.join(repo, 'dsh', 'plugin'), targetDir: pluginStage })
console.log(`staged dsh-adapter-vllmc -> ${pluginStage}`)
