#!/usr/bin/env node
/**
 * Live harness driver: boots the supervised dsh against YOUR OWN configured
 * vLLM-Copilot server, so a turn runs through the same connection the editor
 * uses (credentials and Cloudflare Access headers are read from your local
 * VS Code settings and never leave this process or these logs).
 *
 *   node scripts/harness/live-harness.mjs up       boot and stay attached (run in background)
 *   node scripts/harness/live-harness.mjs status   what is running, what is queued
 *   node scripts/harness/live-harness.mjs ingest   fold completed requests into a ledger
 *   node scripts/harness/live-harness.mjs down     drain then stop
 *
 * Display law: only wire model ids and display names are printed. The harness
 * URL with its UI token goes to temp/live-url.txt (gitignored) and nowhere else.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { bridgePaths, ensureBridgeDirs } from '../../out/vscode/harness/paths.js'
import { Bridge } from '../../out/vscode/harness/bridge.js'
import { classifyPidRecord } from '../../out/vscode/harness/supervisor.js'
import { readPin } from './dsh-version.mjs'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const mode = process.argv[2] ?? 'up'
const urlFile = path.join(root, 'temp', 'live-url.txt')

const { stripJsonc } = await import(pathToFileURL(path.join(root, 'temp', 'stage', 'vllm-copilot-core', 'core', 'shared', 'jsonc.js')).href)

/** Your own vLLM-Copilot registry, read the way the live e2e rail reads it. */
function readOwnerRegistry() {
  const file = path.join(process.env.APPDATA, 'Code', 'User', 'settings.json')
  const settings = JSON.parse(stripJsonc(readFileSync(file, 'utf8')))
  const servers = settings['vllm-copilot.servers'] ?? []
  const models = settings['vllm-copilot.models'] ?? []
  return {
    servers,
    models,
    fixEmptyToolParameters: settings['vllm-copilot.fixEmptyToolParameters'],
  }
}

const registry = readOwnerRegistry()
const usable = registry.models.filter((m) => registry.servers.some((s) => s.id === m.server))
if (usable.length === 0) {
  console.error('FAIL: no registry model points at a configured server; nothing to run')
  process.exit(1)
}
// The owner picked the model; wire id selects it, the generated config id stays internal.
const WIRE_MODEL = process.env.LIVE_WIRE_MODEL ?? 'Qwen/Qwen3.8-Flash-Next-FP8'
const chosen = usable.find((m) => (m.vllmModelId ?? m.id) === WIRE_MODEL)
if (!chosen) {
  console.error(`FAIL: no usable registry model with wire id ${WIRE_MODEL}`)
  process.exit(1)
}

const paths = bridgePaths(path.join(root, 'temp', 'live-home'))
ensureBridgeDirs(paths)

const log = {
  info: (m) => console.log(`[bridge] ${m}`),
  warn: (m) => console.log(`[bridge warn] ${m}`),
  error: (m) => console.log(`[bridge error] ${m}`),
}

const mainVersion = String(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? 'unknown')

// Stand-in "editor": the rail cannot host a real VS Code terminal, so this
// local control server serves the MCP surface whose run_terminal tool executes
// commands with pwsh directly. It proves the full chain
// (model -> dsh-mcp-client -> HTTP -> executor) minus the one parts only an
// editor can provide.
const controlToken = randomUUID()
const commandLog = path.join(root, 'temp', 'live-control-commands.log')
let control
if (mode === 'up') {
  const { ControlServer } = await import(pathToFileURL(path.join(root, 'out', 'vscode', 'harness', 'control-server.js')).href)
  control = new ControlServer({
    token: controlToken,
    activeDir: paths.active,
    log,
    mcp: {
      serverInfo: { name: 'rail-stand-in-editor', version: '0.0.0' },
      tools: () => [
        {
          name: 'run_terminal',
          description: 'Run a shell command on the rail machine (stand-in for the editor terminal).',
          inputSchema: {
            type: 'object',
            properties: { command: { type: 'string' }, timeoutMs: { type: 'number' } },
            required: ['command'],
            additionalProperties: false,
          },
          run: async (args) => {
            const command = typeof args.command === 'string' ? args.command.trim() : ''
            if (!command) throw new Error('command must be a non-empty string')
            const output = await new Promise((resolve, reject) => {
              const child = spawn('pwsh', ['-NoProfile', '-Command', command], { windowsHide: true })
              let text = ''
              child.stdout.on('data', (d) => (text += d))
              child.stderr.on('data', (d) => (text += d))
              const timer = setTimeout(() => child.kill('SIGKILL'), typeof args.timeoutMs === 'number' ? args.timeoutMs : 120_000)
              child.on('close', (code) => {
                clearTimeout(timer)
                appendFileSync(commandLog, `${new Date().toISOString()} :: exit=${code} :: ${command}\n`)
                resolve({ text, code })
              })
              child.on('error', reject)
            })
            return { text: `\`\`\`console\n${output.text.replace(/\n+$/, '')}\n\`\`\`\n[exit code: ${output.code ?? 'unknown'}]` }
          },
        },
      ],
    },
  })
}

// The rail has no editor ledger process here, so this local stand-in runs the
// contract's law itself: unseen recordIds are accepted, a replayed id is
// reported duplicate, and every bucket is returned. Records handed to it are
// settled in this process only; the editor's real ledger lives in the
// extension and never reads this rail home.
const ledgerSeen = new Set()
async function recordUsage(records) {
  const accepted = []
  const duplicate = []
  for (const record of records) {
    if (ledgerSeen.has(record.recordId)) duplicate.push(record.recordId)
    else accepted.push(record.recordId)
    ledgerSeen.add(record.recordId)
  }
  return { accepted, duplicate, preReset: [], rejected: [] }
}

const bridge = new Bridge({
  extensionRoot: root,
  extensionVersion: mainVersion,
  paths,
  log,
  dshVersion: readPin(),
  registry: async () => registry,
  choices: () => ({ defaultModelId: chosen.id, title: undefined, compaction: undefined, drainTimeoutMs: 120_000 }),
  recordUsage,
  // Stands in for `vscode.workspace.workspaceFolders[0]`, so the rail drives
  // the exact same workspace-handoff code the extension runs.
  editorWorkspaceFolder: () => process.env.LIVE_WORKSPACE || undefined,
  controlEndpoint: () => (control?.url ? { url: control.url, token: controlToken } : undefined),
})

if (mode === 'status') {
  const state = classifyPidRecord(paths.pid, log)
  const active = existsSync(paths.active) ? readdirSync(paths.active).filter((n) => n.endsWith('.json')).length : 0
  const queued = existsSync(paths.outbox) ? readdirSync(paths.outbox).filter((n) => n.endsWith('.json')).length : 0
  console.log(`pid record: ${state.kind}${state.kind === 'live' ? ` (pid ${state.record.pid}, started ${state.record.startedAt})` : ''}`)
  console.log(`in-flight requests: ${active}`)
  console.log(`usage records awaiting the ledger: ${queued}`)
  console.log(`registry: ${registry.servers.length} server(s), ${usable.length} usable model(s) (${usable.map((m) => m.vllmModelId ?? m.id).join(', ')})`)
  process.exit(0)
}

if (mode === 'down') {
  const result = await bridge.stop()
  console.log(result.drained ? 'stopped cleanly' : `stopped after cutting ${result.remaining} in-flight request(s)`)
  process.exit(0)
}

if (mode === 'ingest') {
  // The editor's real ledger lives in the extension process; here the local
  // stand-in settles records. The point of this mode is to show they are
  // complete and countable before any ledger ever sees them.
  const files = existsSync(paths.outbox) ? readdirSync(paths.outbox).filter((n) => n.endsWith('.json')) : []
  let tokens = { prompt: 0, completion: 0, reasoning: 0 }
  const purposes = {}
  for (const f of files) {
    const rec = JSON.parse(readFileSync(path.join(paths.outbox, f), 'utf8'))
    const r = rec.lastRequest ?? rec.request ?? {}
    tokens.prompt += r.promptTokens ?? 0
    tokens.completion += r.completionTokens ?? 0
    tokens.reasoning += r.reasoningTokens ?? 0
    purposes[rec.purpose ?? 'agent'] = (purposes[rec.purpose ?? 'agent'] ?? 0) + 1
  }
  console.log(`${files.length} completed request(s): ${JSON.stringify(purposes)}`)
  console.log(`tokens: ${JSON.stringify(tokens)}`)
  const outcome = await bridge.ingest()
  console.log(`ingest through the bridge: accepted ${outcome.accepted}, duplicate ${outcome.duplicate}, deferred ${outcome.deferred} (settled against this process's local ledger)`)
  process.exit(0)
}

if (mode !== 'up') {
  console.error(`unknown mode ${mode}; expected up | status | ingest | down`)
  process.exit(1)
}

console.log(`owner core ${mainVersion}, dsh ${readPin()}, ${usable.length} model(s) available`)
if (control) await control.listen()
const url = await bridge.start().catch((err) => {
  console.error(`FAIL: ${err.message}`)
  process.exit(1)
})
writeFileSync(urlFile, url)
console.log(`harness up; URL written to ${urlFile}`)
console.log('attached: Ctrl+C or `live-harness.mjs down` from another terminal to stop')

// Stay alive so the supervised child keeps its pipes and the pid file stays
// meaningful. SIGINT goes through the bridge's drain, not a raw kill.
const shutdown = async () => {
  const result = await bridge.stop()
  console.log(result.drained ? 'stopped cleanly' : `stopped after cutting ${result.remaining} in-flight request(s)`)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
setInterval(() => undefined, 1 << 30)
