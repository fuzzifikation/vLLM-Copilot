#!/usr/bin/env node
/**
 * Step 2 manual boot check (harness gate 2, real-dsh half).
 *
 * Boots real dsh headless with the STAGED core + plugin (the production
 * vendor/ sibling layout: plugin depends on vllm-copilot-core via a relative
 * file: specifier, resolved by pnpm into the profile) pointed at a loopback
 * wiretap backend. Proves the outbound chat-completions body carries OUR
 * sampling params and headers while dsh's model `compat` stays unset (ruling 6),
 * and that completed requests reach the usage outbox.
 *
 * Usage: npm run harness:boot-check  (node scripts/harness/step2-boot-check.mjs [--fresh])
 * Requires Node >= 22, npm, pnpm on PATH.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDemoBackend } from '../../test/harness/demo-backend.mjs'
import { describeDshVersion } from './dsh-version.mjs'

const { version: DSH_VERSION, overridden } = describeDshVersion()
const PROFILE = 'vllmc-step2'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const work = path.join(root, 'temp', 'step2')
const dshHome = path.join(work, 'dsh-home')
const dshBin = path.join(work, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const pluginStage = path.join(root, 'temp', 'stage', 'dsh-adapter-vllmc')
if (!existsSync(path.join(pluginStage, 'package.json'))) {
  console.error('FAIL: staged plugin missing; run `npm run harness:stage` first')
  process.exit(1)
}

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? work,
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: opts.shell === true,
  })
  if (r.error) throw r.error
  return r
}
const dsh = (args, opts) => run(process.execPath, [dshBin, ...args], opts)
const fail = (label, r) => {
  console.error(`FAIL: ${label} (exit ${r?.status})`)
  if (r) console.error('--- stdout\n' + (r.stdout ?? '').slice(-3000) + '\n--- stderr\n' + (r.stderr ?? '').slice(-3000))
  process.exit(1)
}

if (process.argv.includes('--fresh')) rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
console.log(`dsh ${DSH_VERSION}${overridden ? ' (DSH_VERSION override, not the certified pin)' : ''}`)
if (!existsSync(dshBin)) {
  writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'dsh-step2-scratch', private: true }, null, 2) + '\n')
  const install = run('npm', ['install', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${DSH_VERSION}`], { cwd: work, shell: true })
  if (install.status !== 0) fail('npm install dsh', install)
}

// Loopback wiretap: serves /v1/models and answers chat completions, recording bodies.
const backend = await startDemoBackend({
  models: [
    { id: 'wire-probe', max_model_len: 131072 },
    { id: 'wire-cheap', max_model_len: 8192 },
  ],
})
backend.script({ reply: 'VLLMC-STEP2-MARKER: bridge reached the wiretap through the real core' }, { reply: 'short title' })

const snapshot = {
  version: 1,
  config: {
    servers: [{ id: 'wire-server', serverUrl: backend.url, serverType: 'vllm', requestHeaders: { 'X-Vllmc-Boot': '1' } }],
    models: [
      { id: 'probe', server: 'wire-server', vllmModelId: 'wire-probe', displayName: 'Probe', maxOutputTokens: 128, defaultParams: { temperature: 0.42, top_k: 7 } },
      { id: 'cheap', server: 'wire-server', vllmModelId: 'wire-cheap', maxOutputTokens: 64 },
    ],
  },
  defaultModelId: 'probe',
  aux: { 'session-title': { modelId: 'cheap', maxTokens: 64 } },
  maxRetries: 0,
}
const snapDir = path.join(dshHome, 'vllmc')
mkdirSync(snapDir, { recursive: true })
writeFileSync(path.join(snapDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2))

const outboxDir = path.join(snapDir, 'usage-outbox')

try {
  if (!existsSync(path.join(dshHome, 'profiles', PROFILE, 'package.json'))) {
    const created = dsh(['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'])
    if (created.status !== 0) fail('profile creation', created)
  }

  // Force a genuine re-link from the CURRENT stage. A file: dependency whose
  // copy already sits in the profile's store makes `plugin add` a silent
  // no-op, and the boot check then certifies the PREVIOUS plugin build: a
  // broken adapter sails through a green gate. Nuke the resolved tree, keep
  // the lockfile so the store does the fast work.
  rmSync(path.join(dshHome, 'profiles', PROFILE, 'node_modules'), { recursive: true, force: true })
  const added = dsh(['plugin', '--profile', PROFILE, 'add', 'file:' + pluginStage.replace(/\\/g, '/')])
  if (added.status !== 0) fail('dsh plugin add (staged plugin with core file: dep)', added)

  // Certify the claim instead of trusting the command's exit code: the bytes
  // the profile resolves must be the bytes we just staged.
  const linkedAdapter = path.join(dshHome, 'profiles', PROFILE, 'node_modules', '@fuzzifikation', 'dsh-adapter-vllmc', 'adapter.js')
  if (
    !existsSync(linkedAdapter) ||
    readFileSync(linkedAdapter, 'utf8') !== readFileSync(path.join(pluginStage, 'adapter.js'), 'utf8')
  ) {
    fail('the profile does not run the staged adapter (stale link)', null)
  }

  const dumped = dsh(['--profile', PROFILE, '--dump-config'])
  if (dumped.status !== 0) fail('dump-config', dumped)
  const dumpFile = path.join(work, 'dump-config.yml')
  writeFileSync(dumpFile, dumped.stdout)
  if (!dumped.stdout.includes('vllmc-adapter')) fail('composed tree missing the vllmc-adapter bundle row', dumped)

  const overlay = path.join(work, 'overlay.yml')
  const gen = run(process.execPath, [path.join(root, 'scripts', 'harness', 'generate-overlay.mjs'), '--dump', dumpFile, '--out', overlay, '--model', 'probe'])
  if (gen.status !== 0) fail('overlay generation', gen)

  // MUST be async: the wiretap server shares this event loop, and spawnSync
  // would freeze it while the child is trying to call it.
  const { spawn } = await import('node:child_process')
  const boot = await new Promise((resolve) => {
    const child = spawn(process.execPath, [dshBin, '--profile', PROFILE, '--patch', overlay, 'ping'], {
      cwd: work,
      env: { ...process.env, DSH_HOME: dshHome },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const watchdog = setTimeout(() => child.kill(), 180_000)
    child.on('close', (status) => {
      clearTimeout(watchdog)
      resolve({ status, stdout, stderr })
    })
  })
  if (boot.status !== 0) fail('headless boot', boot)
  if (!boot.stdout.includes('VLLMC-STEP2-MARKER')) fail('marker absent from session output', boot)

  const chat = backend.requests.filter((r) => r.body && r.body.messages)
  if (chat.length === 0) fail('wiretap recorded no chat completion request', boot)
  const main = chat.find((r) => r.body.model === 'wire-probe')
  if (!main) fail('no request reached the configured wire-probe model', boot)
  const body = main.body
  if (body.temperature !== 0.42 || body.top_k !== 7) {
    fail(`outbound body missing our sampling params (got temperature=${body.temperature} top_k=${body.top_k})`, boot)
  }
  if (main.headers['x-vllmc-boot'] !== '1') fail('configured server header did not reach the wire', boot)
  if ('compat' in body) fail('dsh compat leaked into the outbound body (ruling 6 violation)', boot)

  const records = existsSync(outboxDir) ? (await import('node:fs')).readdirSync(outboxDir).filter((f) => f.endsWith('.json')) : []
  if (records.length === 0) fail('usage outbox received no completed-request record', boot)

  console.log('PASS: real dsh routed a turn through the staged vLLM-Copilot core')
  console.log(`       wire body: model=${body.model} temperature=${body.temperature} top_k=${body.top_k}, server header present, compat unset`)
  console.log(`       usage outbox records: ${records.length}`)
} finally {
  await backend.close()
}
