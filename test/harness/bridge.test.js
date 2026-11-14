/**
 * Step 3 tripwires. Each test is named for the real breakage it catches, per
 * the project's test doctrine: no ceremony, no implementation mirrors.
 *
 * These run against the TypeScript sources in `src/vscode/harness/` (Vitest
 * resolves the `.js` specifiers to them), so no separate compile step is
 * needed; `npm run compile` and `npm run test:typecheck` own the type gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

import { bridgePaths, ensureBridgeDirs, legacyHomeDirs } from '../../src/vscode/harness/paths.js'
import { compositionIsCurrent } from '../../src/vscode/harness/bridge.js'
import { acquireStartLock } from '../../src/vscode/harness/start-lock.js'
import { buildSnapshot } from '../../src/vscode/harness/snapshot.js'
import { writeSnapshot } from '../../src/vscode/harness/snapshot-writer.js'
import { ingestOutbox, drainActiveRequests, emptyOutcome } from '../../src/vscode/harness/ingest.js'
import { classifyPidRecord, findNodeOnPath, isProcessAlive, probeHarness, readPidRecord, redactUrl, resolveHarnessNode, Supervisor, writePidRecord } from '../../src/vscode/harness/supervisor.js'
import { ensureDshRuntime, isSafeVersionSpec } from '../../src/vscode/harness/runtime.js'
import { ensureAdapterInstalled } from '../../src/vscode/harness/dsh-cli.js'
import { registerDefaultWorkspace } from '../../src/vscode/harness/workspace.js'
import { ControlServer } from '../../src/vscode/harness/control-server.js'
import { EmbedProxy } from '../../src/vscode/harness/embed-proxy.js'
import { connect as netConnect } from 'node:net'
import { buildOverlay, mergePatchLayer, PATCH_LAYER_START, PATCH_LAYER_END } from '../../dsh/shared/overlay.mjs'
import * as plugin from '../../dsh/plugin/snapshot.js'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dshb-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function paths() {
  const p = bridgePaths(dir)
  ensureBridgeDirs(p)
  return p
}

const registry = {
  servers: [{ id: 'srv-a', serverUrl: 'http://127.0.0.1:8123/v1', displayName: 'Home Box' }],
  models: [
    { id: 'm-1', vllmModelId: 'wire-one', server: 'srv-a', displayName: 'Big Model' },
    { id: 'm-2', vllmModelId: 'wire-two', server: 'srv-a', displayName: 'Small Model' },
  ],
}

describe('snapshot: bridge writes what the plugin reads', () => {
  it('produces a document the real plugin validator accepts, versioned by the plugin', () => {
    const p = paths()
    const payload = buildSnapshot({ ...registry, defaultModelId: 'm-1' })
    const written = writeSnapshot({ snapshotFile: p.snapshot, payload, plugin })
    expect(written.written).toBe(true)
    expect(written.version).toBe(plugin.SNAPSHOT_VERSION)

    // The cross-check that matters: if the bridge and the plugin ever drift on
    // the snapshot shape, dsh boots and then dies on every request. That must
    // be caught here, not by a user watching a spinner.
    const doc = plugin.parseSnapshot(readFileSync(p.snapshot, 'utf8'), 'test')
    // Snapshot ids are display keys, not registry ids: dsh prints the id in
    // its model chip, and registry ids embed hostnames.
    expect(doc.defaultModelId).toBe('Big Model')
    expect(doc.config.models).toHaveLength(2)
  })

  it('catches the vision wipe: capability flags survive the re-key and reach the plugin', () => {
    // Real breakage this catches: a build step that cherry-picks fields would
    // drop `capabilities`, the adapter's gate would read imageInput=false,
    // and every pasted screenshot degrades to placeholder text while the
    // model cheerfully lies about what it sees. The pass-through is the only
    // thing carrying vision, so the whole round trip is proven here.
    const withVision = {
      servers: registry.servers,
      models: [
        { ...registry.models[0], capabilities: { toolCalling: true, imageInput: true } },
        registry.models[1],
      ],
    }
    const payload = buildSnapshot({ ...withVision, defaultModelId: 'm-1' })
    const doc = plugin.parseSnapshot(
      JSON.stringify({ version: plugin.SNAPSHOT_VERSION, ...payload }),
      'vision round trip',
    )
    expect(doc.config.models.find((m) => m.id === 'Big Model').capabilities).toEqual({
      toolCalling: true,
      imageInput: true,
    })
    // A model without the field stays without it: absent is not false, the
    // adapter's core-computed default (text-only) applies unchanged.
    expect(doc.config.models.find((m) => m.id === 'Small Model').capabilities).toBeUndefined()
  })

  it('is a no-op while the registry is unchanged and rewrites when it changes', () => {
    const p = paths()
    const payload = buildSnapshot({ ...registry, defaultModelId: 'm-1' })
    expect(writeSnapshot({ snapshotFile: p.snapshot, payload, plugin }).written).toBe(true)
    const first = readFileSync(p.snapshot, 'utf8')
    const again = buildSnapshot({ ...registry, defaultModelId: 'm-1' })
    expect(writeSnapshot({ snapshotFile: p.snapshot, payload: again, plugin }).written).toBe(false)
    expect(readFileSync(p.snapshot, 'utf8')).toBe(first)

    const changed = buildSnapshot({ ...registry, defaultModelId: 'm-2' })
    expect(writeSnapshot({ snapshotFile: p.snapshot, payload: changed, plugin }).written).toBe(true)
    expect(plugin.parseSnapshot(readFileSync(p.snapshot, 'utf8'), 'test').defaultModelId).toBe('Small Model')
  })

  it('drops a model whose server vanished rather than handing the harness a dead id', () => {
    const warnings = []
    const payload = buildSnapshot({
      servers: registry.servers,
      models: [...registry.models, { id: 'ghost', vllmModelId: 'wire-ghost', server: 'srv-gone' }],
      defaultModelId: 'ghost',
      onWarning: (m) => warnings.push(m),
    })
    expect(payload.config.models.map((m) => m.id)).toEqual(['Big Model', 'Small Model'])
    // The dead default must not survive either, or the harness selects a model 404s.
    expect(payload.defaultModelId).toBe('Big Model')
    expect(warnings.join(' ')).toMatch(/ghost/)
  })

  it('hides models the core verdict found absent, reason and all', () => {
    // Real breakage 2026-10-06: a retired model stayed in the registry, so
    // dsh's picker offered it, and selecting it produced only an error toast.
    // Copilot's own picker had already hidden it; the harness must agree.
    // The verdict itself comes from the core's resolveServedModels — that
    // logic and its {id}-entry normalization canary (the 0.0.12 catalog
    // wipe) are tripwired in the core repo now (companionApi.test.ts).
    const warnings = []
    const payload = buildSnapshot({
      ...registry,
      defaultModelId: 'm-2',
      served: { 'm-2': { state: 'absent', reason: '"wire-two" is not in the list srv-a reports' } },
      onWarning: (m) => warnings.push(m),
    })
    expect(payload.config.models.map((m) => m.id)).toEqual(['Big Model'])
    // The pruned model was the default: it must fall back, not error at boot.
    expect(payload.defaultModelId).toBe('Big Model')
    expect(warnings.join(' ')).toMatch(/Small Model.*not currently served.*wire-two/)
  })

  it('scrubs server URLs out of verdict reasons before they reach log or disk', () => {
    // Real leak: the core reports a failed fetch with the full server URL in
    // the reason, and warnings are written verbatim into the bridge log and
    // snapshot.json. This is a public repo: private hosts never ride along.
    const warnings = []
    buildSnapshot({
      ...registry,
      defaultModelId: 'm-2',
      served: { 'm-2': { state: 'absent', reason: 'fetch http://invisible-host.example:8001/v1/models failed' } },
      onWarning: (m) => warnings.push(m),
    })
    const text = warnings.join(' ')
    expect(text).toMatch(/not currently served/)
    expect(text).not.toMatch(/invisible-host|http/)
  })

  it('never prunes on an unknown answer: only demonstrated absence hides a model', () => {
    // A server that is down, slow, or answered empty must NOT empty the
    // catalog: `unknown` and missing verdicts keep every model offered,
    // exactly the pre-verdict behavior.
    const noVerdict = buildSnapshot({ ...registry })
    expect(noVerdict.config.models).toHaveLength(2)
    const unknown = buildSnapshot({
      ...registry,
      served: { 'm-1': { state: 'unknown', reason: 'could not ask' }, 'm-2': { state: 'unknown' } },
    })
    expect(unknown.config.models).toHaveLength(2)
    // Only when EVERY model is demonstrably absent does the writer refuse.
    expect(() =>
      buildSnapshot({
        ...registry,
        served: { 'm-1': { state: 'absent' }, 'm-2': { state: 'absent' } },
      }),
    ).toThrow(/nothing honest/)
  })

  it('re-keys ids to display names and carries default, aux, and personality across', () => {
    const payload = buildSnapshot({
      ...registry,
      defaultModelId: 'm-1',
      title: { modelId: 'm-2', maxTokens: 256 },
      personalityFiles: { 'm-1': 'C:\\p.txt' },
    })
    expect(payload.config.models.map((m) => m.id)).toEqual(['Big Model', 'Small Model'])
    expect(payload.defaultModelId).toBe('Big Model')
    // Aux choices are written with the NEW key so the plugin can resolve them.
    expect(payload.aux['session-title'].modelId).toBe('Small Model')
    // Personality files arrive keyed by registry id and must still attach.
    expect(payload.personalityFile).toBe('C:\\p.txt')
    // Requests still carry the wire id untouched (adapter reads vllmModelId).
    expect(payload.config.models[0].vllmModelId).toBe('wire-one')
  })

  it('uniquifies colliding display names and falls back to the wire id', () => {
    const payload = buildSnapshot({
      servers: registry.servers,
      models: [
        { id: 'a', vllmModelId: 'wire-a', server: 'srv-a', displayName: 'Same' },
        { id: 'b', vllmModelId: 'wire-b', server: 'srv-a', displayName: 'Same' },
        { id: 'c', vllmModelId: 'wire-c', server: 'srv-a' },
      ],
    })
    expect(payload.config.models.map((m) => m.id)).toEqual(['Same', 'Same (2)', 'wire-c'])
  })

  it('honors core-built display keys, guarding collisions anyway', () => {
    // With the core's buildDisplayKeys passed in, ITS names are the ids —
    // identity is one rule shared with the Copilot picker. The local suffix
    // guard stays armed no matter who supplied the names.
    const payload = buildSnapshot({
      ...registry,
      displayKeys: { 'm-1': 'Chosen Name', 'm-2': 'Chosen Name' },
    })
    expect(payload.config.models.map((m) => m.id)).toEqual(['Chosen Name', 'Chosen Name (2)'])
  })

  it('refuses to write an empty registry instead of a harness with no models', () => {
    expect(() => buildSnapshot({ servers: [], models: [] })).toThrow()
  })
})

describe('pid file: one shared harness, no murdered strangers', () => {
  it('leaves a live harness alone and clears one that died', async () => {
    const p = paths()
    // A real child process, not a made-up pid: pids get recycled, and a bridge
    // that kills whatever number it finds would shoot an unrelated program.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    child.unref()
    try {
      writePidRecord(p.pid, { pid: child.pid, url: 'http://127.0.0.1:1/', startedAt: new Date().toISOString(), profile: 'vllmc', dshVersion: 'x' })
      expect(isProcessAlive(child.pid)).toBe(true)
      // The URL has to survive the round trip or no second window can adopt.
      expect(readPidRecord(p.pid)?.url).toBe('http://127.0.0.1:1/')

      const live = classifyPidRecord(p.pid)
      expect(live.kind).toBe('live')
      // The point of the whole test: classifying must not kill.
      expect(isProcessAlive(child.pid)).toBe(true)
      expect(existsSync(p.pid)).toBe(true)

      child.kill()
      // POSIX keeps a killed child as a zombie until this process reaps it,
      // and the reap runs on the event loop: await 'exit' instead of burning
      // the budget in a synchronous spin, or signal-0 keeps answering "alive"
      // for a corpse only the kernel's bookkeeping has not buried.
      await new Promise((resolve) => child.once('exit', resolve))

      expect(classifyPidRecord(p.pid)).toMatchObject({ kind: 'stale', pid: child.pid })
      expect(existsSync(p.pid)).toBe(false)
    } finally {
      child.kill()
    }
  })

  it('discards a corrupt pid file instead of wedging every later start', () => {
    const p = paths()
    writeFileSync(p.pid, '{"pid":"not a number"}')
    expect(classifyPidRecord(p.pid)).toEqual({ kind: 'none' })
    expect(existsSync(p.pid)).toBe(false)
  })

  it('adopts a harness another window announced, and forgets one that vanished', () => {
    const p = paths()
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    child.unref()
    try {
      const supervisor = new Supervisor({
        binPath: 'unused',
        dshHome: dir,
        profile: 'vllmc',
        pidFile: p.pid,
        activeDir: p.active,
        dshVersion: 'x',
        log: { info() {}, warn() {} },
      })
      supervisor.adopt({ pid: child.pid, url: 'http://127.0.0.1:9/?token=abc', startedAt: '', profile: 'vllmc', dshVersion: 'x' })
      // Without this the status bar would read "stopped" while turns worked.
      expect(supervisor.running).toBe(true)
      expect(supervisor.adopted).toBe(true)
      expect(supervisor.url).toContain('127.0.0.1:9')

      supervisor.dropAdoption()
      expect(supervisor.running).toBe(false)
      expect(existsSync(p.pid)).toBe(false)
    } finally {
      child.kill()
    }
  })

  it('only believes a pid whose port actually answers', async () => {
    const server = createServer((_req, res) => res.writeHead(503).end('nope'))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    try {
      // A refused status is still an answer: the harness is there, the token may not be.
      await expect(probeHarness(`http://127.0.0.1:${port}/?token=x`)).resolves.toBe(true)
      server.close()
      await new Promise((resolve) => server.on('close', resolve))
      await expect(probeHarness(`http://127.0.0.1:${port}/?token=x`)).resolves.toBe(false)
      await expect(probeHarness('')).resolves.toBe(false)
    } finally {
      server.close()
    }
  })

  it('strips the UI auth token from any URL that reaches a log', () => {
    const red = redactUrl('http://127.0.0.1:54321/?token=supersecretvalue')
    expect(red).not.toContain('supersecretvalue')
    expect(red).toContain('127.0.0.1')
  })
})

describe('usage outbox: exactly-once handoff to the ledger owner', () => {
  function record(id, prompt = 10, completion = 2) {
    return {
      recordId: id,
      recordedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + prompt * 1000).toISOString(),
      lastRequest: {
        serverUrl: 'http://127.0.0.1:8123/v1',
        modelId: 'wire-one',
        timestamp: Date.parse('2026-01-01T00:00:00Z'),
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
        cachedTokens: 0,
        reasoningTokens: 1,
      },
    }
  }
  function drop(outboxDir, id, payload = record(id)) {
    writeFileSync(join(outboxDir, `${id}.json`), JSON.stringify(payload))
  }
  /** A ledger stand-in with the same dedup and reset-barrier contract the real owner implements. */
  function ledger({ reset = false, throws = false } = {}) {
    const seen = new Set()
    const calls = []
    return {
      apiVersion: 1,
      calls,
      acceptedIds: [],
      async recordExternalRequests(records) {
        if (throws) throw new Error('ledger busy')
        calls.push(records.map((r) => r.recordId))
        const out = { accepted: [], duplicate: [], preReset: [] }
        for (const r of records) {
          if (reset) out.preReset.push(r.recordId)
          else if (seen.has(r.recordId)) out.duplicate.push(r.recordId)
          else {
            seen.add(r.recordId)
            out.accepted.push(r.recordId)
          }
        }
        this.acceptedIds = [...this.acceptedIds, ...out.accepted]
        return out
      },
    }
  }

  it('deletes a record only after the owner acknowledges it, exactly once', async () => {
    const p = paths()
    drop(p.outbox, 'r-1')
    drop(p.outbox, 'r-2')
    const port = ledger()
    const first = await ingestOutbox({ outboxDir: p.outbox, quarantineDir: p.quarantine, port })
    expect(first).toMatchObject({ accepted: 2, duplicate: 0, deferred: 0, malformed: 0 })
    expect(readdirSync(p.outbox)).toEqual([])
    expect(port.acceptedIds.sort()).toEqual(['r-1', 'r-2'])

    // Replayed records (crash between ack and delete, or a duplicated write)
    // must be counted once. Double counting would corrupt the user's dashboard.
    drop(p.outbox, 'r-1')
    const replay = await ingestOutbox({ outboxDir: p.outbox, quarantineDir: p.quarantine, port })
    expect(replay).toMatchObject({ accepted: 0, duplicate: 1 })
    expect(port.acceptedIds).toEqual(['r-1', 'r-2'])
    expect(readdirSync(p.outbox)).toEqual([])
  })

  it('keeps records when the ledger rejects the batch instead of eating them', async () => {
    const p = paths()
    drop(p.outbox, 'r-9')
    const busy = await ingestOutbox({
      outboxDir: p.outbox,
      quarantineDir: p.quarantine,
      port: ledger({ throws: true }),
    })
    expect(busy).toMatchObject({ deferred: 1, accepted: 0 })
    expect(readdirSync(p.outbox)).toEqual(['r-9.json'])

    // No ledger at all (main extension absent or too old): wait, never discard.
    const none = await ingestOutbox({ outboxDir: p.outbox, quarantineDir: p.quarantine, port: undefined })
    expect(none).toMatchObject({ deferred: 1 })
    expect(readdirSync(p.outbox)).toEqual(['r-9.json'])
  })

  it('deletes what the owner refuses as pre-reset, so a cleared dashboard stays cleared', async () => {
    const p = paths()
    drop(p.outbox, 'old-1')
    const outcome = await ingestOutbox({
      outboxDir: p.outbox,
      quarantineDir: p.quarantine,
      port: ledger({ reset: true }),
    })
    expect(outcome).toMatchObject({ preReset: 1, accepted: 0 })
    expect(readdirSync(p.outbox)).toEqual([])
  })

  it('parks a corrupt record in quarantine instead of deleting the user data', async () => {
    const p = paths()
    writeFileSync(join(p.outbox, 'broken.json'), '{not json')
    drop(p.outbox, 'half', { recordId: 'half' })
    // A negative counter is poison the core's own floor refuses; the bridge
    // must catch it HERE, because the ledger counts rejected ids as settled
    // and a mailed poison record is a deleted poison record.
    drop(p.outbox, 'negative', record('negative', -1))
    const port = ledger()
    const outcome = await ingestOutbox({ outboxDir: p.outbox, quarantineDir: p.quarantine, port })
    expect(outcome.malformed).toBe(3)
    expect(port.calls).toEqual([]) // nothing half-read reaches the ledger
    expect(readdirSync(p.outbox)).toEqual([])
    expect(readdirSync(p.quarantine).sort()).toEqual(['broken.json', 'half.json', 'negative.json'])
    // Still readable for a human to inspect after the fact.
    expect(readFileSync(join(p.quarantine, 'broken.json'), 'utf8')).toBe('{not json')
  })

  it('deletes what the owner refuses outright, once, instead of retrying forever', async () => {
    const p = paths()
    drop(p.outbox, 'poison')
    const warnings = []
    const refusing = {
      apiVersion: 1,
      async recordExternalRequests(records) {
        return { accepted: [], duplicate: [], preReset: [], rejected: records.map((r) => r.recordId) }
      },
    }
    const outcome = await ingestOutbox({
      outboxDir: p.outbox,
      quarantineDir: p.quarantine,
      port: refusing,
      log: { info() {}, warn: (m) => warnings.push(m) },
    })
    expect(outcome).toMatchObject({ accepted: 0, rejected: 1, deferred: 0 })
    // "Not mentioned" has to mean "not settled", so a refusal must be explicit
    // and final, or one broken record hammers the ledger every pass.
    expect(readdirSync(p.outbox)).toEqual([])
    expect(warnings.join(' ')).toMatch(/poison/)
  })

  it('is silent and harmless when there is no outbox yet', async () => {
    const p = paths()
    rmSync(p.outbox, { recursive: true, force: true })
    expect(await ingestOutbox({ outboxDir: p.outbox, quarantineDir: p.quarantine, port: ledger() })).toEqual(emptyOutcome())
  })
})

describe('drain: a restart never truncates a live turn in silence', () => {
  it('waits for an in-flight marker to clear', async () => {
    const p = paths()
    const marker = join(p.active, '1-live.json')
    writeFileSync(marker, '{}')
    const releasing = setTimeout(() => rmSync(marker, { force: true }), 150)
    const result = await drainActiveRequests(p.active, 4000, { intervalMs: 25 })
    clearTimeout(releasing)
    expect(result).toEqual({ drained: true, remaining: 0 })
  })

  it('reports what it had to cut when the grace runs out', async () => {
    const p = paths()
    writeFileSync(join(p.active, '1-stuck.json'), '{}')
    const result = await drainActiveRequests(p.active, 50, { intervalMs: 10 })
    expect(result).toEqual({ drained: false, remaining: 1 })
  })

  it('counts an unreadable marker as active, because guessing is how turns die', async () => {
    const p = paths()
    writeFileSync(join(p.active, 'junk.json'), '')
    mkdirSync(join(p.active, 'weird.json'))
    expect(readdirSync(p.active)).toHaveLength(2)
    const result = await drainActiveRequests(p.active, 0)
    expect(result.remaining).toBe(2)
  })
})

describe('npm command line: a setting must never become shell syntax', () => {
  // npm on Windows only runs through a shell, and a shell reads `|`, `;` and
  // quotes as instructions. The version comes from a user setting, so this is
  // the one place where input crosses into an executed command line.
  it.each(['1.0.0 | calc', '1.0.0; calc', '1.0.0" & calc &', '$(calc)', '`calc`', ''])(
    'refuses %j before anything is spawned',
    (version) => expect(ensureDshRuntime({ runtimeDir: join(dir, 'runtime'), version })).rejects.toThrow(/refusing|not a safe/),
  )

  it('accepts the shapes it is supposed to accept', () => {
    expect(isSafeVersionSpec('latest')).toBe(true)
    expect(isSafeVersionSpec('0.2.0-rc.2')).toBe(true)
    expect(isSafeVersionSpec('1.2.3')).toBe(true)
    expect(isSafeVersionSpec('^1.0.0')).toBe(false)
    expect(isSafeVersionSpec('1.0.0 | calc')).toBe(false)
  })
})

describe('harness node resolution', () => {
  // Named breakage: inside the extension host process.execPath is Electron,
  // dsh's loader fingerprints V8, sees "-electron.0" and dies before its URL
  // line. Every editor start would fail while every node-run rail stays green.
  it('finds node.exe on PATH on Windows and node elsewhere', () => {
    const win = join(dir, 'win')
    const posix = join(dir, 'posix')
    mkdirSync(win, { recursive: true })
    mkdirSync(posix, { recursive: true })
    writeFileSync(join(win, 'node.exe'), '')
    writeFileSync(join(posix, 'node'), '')
    expect(findNodeOnPath(`${join(dir, 'nope')}${delimiter}${win}${delimiter}${posix}`, 'win32')).toBe(join(win, 'node.exe'))
    // A posix-named file must not satisfy a win32 search, or the spawn dies ENOENT-style.
    expect(findNodeOnPath(`${join(dir, 'nope')}${delimiter}${posix}`, 'win32')).toBeUndefined()
    expect(findNodeOnPath(`${join(dir, 'nope')}${delimiter}${posix}`, 'linux')).toBe(join(posix, 'node'))
    expect(findNodeOnPath(undefined, 'linux')).toBeUndefined()
  })

  it('keeps the real node binary when the caller is not Electron', () => {
    // Vitest runs under plain node: versions.electron is absent, so execPath
    // is honest and PATH must not be consulted at all.
    expect(process.versions.electron).toBeUndefined()
    expect(resolveHarnessNode()).toBe(process.execPath)
  })
})

describe('workspace handoff to dsh', () => {
  // Named breakage: this file is live user data (workspace paths plus session
  // ids). A duplicate-per-restart pileup or a clobbered registry loses the
  // user's sessions from the picker, and writing into a future schema version
  // we never verified could corrupt the whole store.
  const quiet = { info() {}, warn: (m) => warnings.push(m) }
  let warnings = []
  beforeEach(() => {
    warnings = []
  })

  function storeFile() {
    return join(dir, 'storages', 'workspace.json')
  }
  function readStore() {
    return JSON.parse(readFileSync(storeFile(), 'utf8'))
  }

  it('creates a v2 registry and makes the folder the default', () => {
    mkdirSync(dir, { recursive: true })
    expect(registerDefaultWorkspace(dir, 'C:\\proj\\alpha', quiet)).toBe(true)
    const db = readStore()
    expect(db.unit).toEqual({ name: 'workspace', version: 2 })
    expect(db.global.initialized).toBe(true)
    const ids = Object.keys(db.tables.workspaces)
    expect(ids).toHaveLength(1)
    expect(db.global.defaultWorkspaceId).toBe(ids[0])
    expect(db.tables.workspaces[ids[0]].path).toBe('C:\\proj\\alpha')
    expect(db.global.workspaceIds).toEqual([ids[0]])
  })

  it('reuses the row on restart instead of duplicating, and keeps sessions', () => {
    mkdirSync(join(dir, 'storages'), { recursive: true })
    writeFileSync(
      storeFile(),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: ['old'], defaultWorkspaceId: 'old' },
        tables: { workspaces: { old: { path: 'C:\\proj\\alpha', title: 'alpha', sessionIds: ['s1'] } } },
      }),
    )
    expect(registerDefaultWorkspace(dir, 'C:\\proj\\alpha', quiet)).toBe(true)
    const db = readStore()
    expect(Object.keys(db.tables.workspaces)).toEqual(['old'])
    expect(db.global.defaultWorkspaceId).toBe('old')
    expect(db.tables.workspaces.old.sessionIds).toEqual(['s1'])
    expect(warnings).toHaveLength(0)
  })

  const itWindows = process.platform === 'win32' ? it : it.skip
  itWindows('heals a lowercase-drive row instead of orphaning every session', () => {
    // Real breakage 2026-10-05: VS Code reported the folder as `g:\...` with
    // the drive letter exactly as the window was opened, while dsh resolves
    // session cwds to `G:\...`. The old exact-string upsert wrote a second
    // row, made it the default, and EVERY session then died at create with
    // `could not attach to workspace ...: its cwd resolves to 'G:\...'`.
    mkdirSync(join(dir, 'storages'), { recursive: true })
    writeFileSync(
      storeFile(),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: ['low'], defaultWorkspaceId: 'low' },
        tables: { workspaces: { low: { path: 'c:\\proj\\alpha', title: 'alpha', sessionIds: ['s1'] } } },
      }),
    )
    expect(registerDefaultWorkspace(dir, 'c:\\proj\\alpha', quiet)).toBe(true)
    const db = readStore()
    // One row, same id (sessions survive), path canonicalized to what dsh resolves to.
    expect(Object.keys(db.tables.workspaces)).toEqual(['low'])
    expect(db.tables.workspaces.low.path).toBe('C:\\proj\\alpha')
    expect(db.global.defaultWorkspaceId).toBe('low')
  })

  itWindows('prunes the sessionless case-duplicate twin out of the picker', () => {
    // The stale 0.0.7 window wrote its lowercase twin next to the healed row
    // and dsh listed BOTH as "dsh-vllm-bridge", one of them a dead end that
    // kills every session attached to it. Registration must sweep the trap.
    mkdirSync(join(dir, 'storages'), { recursive: true })
    writeFileSync(
      storeFile(),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: ['canon', 'ghost'], defaultWorkspaceId: 'ghost' },
        tables: {
          workspaces: {
            canon: { path: 'C:\\proj\\alpha', title: 'alpha', sessionIds: ['s1'] },
            ghost: { path: 'c:\\proj\\alpha', title: 'alpha', sessionIds: [] },
          },
        },
      }),
    )
    expect(registerDefaultWorkspace(dir, 'c:\\proj\\alpha', quiet)).toBe(true)
    const db = readStore()
    expect(Object.keys(db.tables.workspaces)).toEqual(['canon'])
    expect(db.tables.workspaces.canon.path).toBe('C:\\proj\\alpha')
    expect(db.global.workspaceIds).toEqual(['canon'])
    expect(db.global.defaultWorkspaceId).toBe('canon')
  })

  itWindows('never prunes a twin that owns sessions, that is live user data', () => {
    mkdirSync(join(dir, 'storages'), { recursive: true })
    writeFileSync(
      storeFile(),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: ['canon', 'twin'], defaultWorkspaceId: 'canon' },
        tables: {
          workspaces: {
            canon: { path: 'C:\\proj\\alpha', title: 'alpha', sessionIds: ['s1'] },
            twin: { path: 'c:\\proj\\alpha', title: 'alpha', sessionIds: ['s2'] },
          },
        },
      }),
    )
    expect(registerDefaultWorkspace(dir, 'C:\\proj\\alpha', quiet)).toBe(true)
    const db = readStore()
    expect(Object.keys(db.tables.workspaces).sort()).toEqual(['canon', 'twin'])
    expect(db.tables.workspaces.twin.sessionIds).toEqual(['s2'])
  })

  it('keeps foreign rows and refuses to touch a corrupt or future-version registry', () => {
    mkdirSync(join(dir, 'storages'), { recursive: true })
    writeFileSync(
      storeFile(),
      JSON.stringify({
        unit: { name: 'workspace', version: 3 },
        global: { initialized: true, workspaceIds: ['x'], defaultWorkspaceId: 'x' },
        tables: { workspaces: { x: { path: 'C:\\other', title: 'other', sessionIds: [] } } },
      }),
    )
    const before = readFileSync(storeFile(), 'utf8')
    expect(registerDefaultWorkspace(dir, 'C:\\proj\\beta', quiet)).toBe(false)
    expect(readFileSync(storeFile(), 'utf8')).toBe(before)
    expect(warnings.join(' ')).toMatch(/version 3/)

    writeFileSync(storeFile(), '{not json')
    expect(registerDefaultWorkspace(dir, 'C:\\proj\\beta', quiet)).toBe(false)
    expect(readFileSync(storeFile(), 'utf8')).toBe('{not json')
  })
})

describe('overlay: editor tools mount as an MCP preset child', () => {
  // Named breakages: a mis-indented preset child kills the whole composition
  // at boot (agent-preset/invalid) and the harness comes up as nothing; a
  // dropped carried key silently resets upstream settings; emitting the row
  // without an endpoint leaves dsh dialing a dead port forever.
  const dump = [
    '- id: deepseek-account',
    '  name: dsh-deepseek-account',
    '- id: ui-settings-general',
    '  config:',
    '    theme: dark',
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek',
    '    model: v4',
    '    thinkingLevel: high',
    '- id: preset-standard',
    '  config:',
    '    plugins:',
    '      - id: core-tools',
    "        name: '@deepseek-ai/dsh-tool-fs'",
    '        config:',
    '          readOnly: false',
    // The web GUI defaults sessions to `ptc` and offers `cordis` for preset
    // authoring; a mount that only lands on `standard` is invisible to both.
    '- id: preset-ptc',
    '  config:',
    '    plugins:',
    "      - id: persona",
    "        name: '@deepseek-ai/dsh-persona'",
    '- id: preset-cordis',
    '  config:',
    '    plugins:',
    "      - id: persona",
    "        name: '@deepseek-ai/dsh-persona'",
  ].join('\n')
  const endpoint = { url: 'http://127.0.0.1:5599', token: 'tok-123' }

  it('mounts the upstream MCP client as a preset child dialing /mcp when an endpoint exists', () => {
    const { yml } = buildOverlay(dump, { model: 'm-1', mcpEndpoint: endpoint })
    expect(yml).toContain('- id: vllmc-editor-mcp')
    // Every tool-bearing preset gets its own child: the GUI's default `ptc`
    // session must see the editor tools exactly like `standard` does.
    expect(yml).toContain('- id: preset-ptc')
    expect(yml).toContain('- id: preset-cordis')
    expect((yml.match(/- id: vllmc-editor-mcp/g) || []).length).toBe(3)
    expect(yml).toContain("name: '@deepseek-ai/dsh-mcp-client'")
    expect(yml).toContain('serverName: vllmc_editor')
    expect(yml).toContain('url: http://127.0.0.1:5599/mcp')
    expect(yml).toContain('authorization: Bearer tok-123')
    // Carried config must survive the splice: the sibling child's nested map
    // and the default-model row's untouched key both stay verbatim.
    expect(yml).toContain('readOnly: false')
    expect(yml).toContain('thinkingLevel: high')
    expect(yml).toContain('provider: "vllmc"')
  })

  it('seeds the Preview Notice acknowledgement and carries the row\'s other keys', () => {
    // Without the seed every boot shows a modal whose Continue button can
    // never succeed in a no-account profile (upstream couples the ack to
    // account/settings state this bridge deliberately disables).
    const { yml } = buildOverlay(dump, { model: 'm-1' })
    expect(yml).toContain('- id: ui-settings-general')
    expect(yml).toContain('welcomeNoticeVersion: 2026-09-28.1')
    expect(yml).toContain('theme: dark')
  })

  it('quotes the default model so a display name cannot break or hijack the row', () => {
    // Real breakage: the model is whatever the user typed as displayName.
    // Unquoted, "gpt: fast" turns the line into a nested mapping (dsh
    // rejects the row and the composition dies at boot) and "gpt #1"
    // truncates at the comment marker, aiming a model that does not exist.
    const { yml } = buildOverlay(dump, { model: 'gpt: fast #4' })
    expect(yml).toContain('model: "gpt: fast #4"')
  })

  it('emits no mount without an endpoint, so a headless prepare still boots', () => {
    const { yml } = buildOverlay(dump, { model: 'm-1' })
    expect(yml).not.toContain('vllmc-editor-mcp')
    expect(yml).not.toContain('dsh-mcp-client')
  })

  it('restates and refreshes the mount on a patch-layer round trip', () => {
    // The generated rows live in the profile now, so every later dump
    // already carries the previous mount. Restating-and-skipping (the old
    // behavior) would delete the mount from the regenerated layer: the
    // editor tools would silently vanish on prepare number two. The row is
    // restated instead, and a rotated endpoint REPLACES the stale child
    // instead of double-mounting next to it.
    const once = buildOverlay(dump, { model: 'm-1', mcpEndpoint: endpoint }).yml
    const twice = buildOverlay(once, { model: 'm-1', mcpEndpoint: { url: 'http://127.0.0.1:7777', token: 'tok-rotated' } }).yml
    expect((twice.match(/- id: vllmc-editor-mcp/g) || []).length).toBe(3)
    expect(twice).toContain('url: http://127.0.0.1:7777/mcp')
    expect(twice).toContain('Bearer tok-rotated')
    expect(twice).not.toContain('5599')
    expect(twice).not.toContain('tok-123')
    // siblings survive the strip: their config travels with them
    expect(twice).toContain('readOnly: false')
    expect(twice).toContain("name: '@deepseek-ai/dsh-persona'")
    expect(twice).toContain('thinkingLevel: high')
    // three prepares in a row stay a fixed point for the mount's siblings
    const thrice = buildOverlay(twice, { model: 'm-1', mcpEndpoint: { url: 'http://127.0.0.1:7777', token: 'tok-rotated' } }).yml
    expect((thrice.match(/- id: vllmc-editor-mcp/g) || []).length).toBe(3)
    expect(thrice).toContain('readOnly: false')
  })

  it('skips absent preset rows with a warning instead of failing the boot', () => {
    // A profile without the web-app presets must still compose: only the
    // present row mounts; the missing rows surface in `skipped`.
    const stdOnly = dump.slice(0, dump.indexOf('- id: preset-ptc'))
    const once = buildOverlay(stdOnly, { model: 'm-1', mcpEndpoint: endpoint })
    expect(once.presetMounts).toEqual(['preset-standard'])
    expect(once.skipped.some((s) => s.startsWith('preset-ptc'))).toBe(true)
    expect(once.skipped.some((s) => s.startsWith('preset-cordis'))).toBe(true)
  })
})

describe('editor control channel (MCP)', () => {
  // Named breakages: an unauthenticated loopback server lets any local
  // process drive the user's editor; a lost drain marker lets a registry edit
  // behead a running build; a wrong initialize answer makes the pinned
  // dsh-mcp-client abort before tool discovery, silently killing every
  // editor tool while the harness looks healthy.
  const token = 'test-token-0123456789'
  const quiet = { info() {}, warn() {} }
  const tools = [
    {
      name: 'slow_tool',
      description: 'takes a moment',
      inputSchema: { type: 'object', properties: {} },
      run: async (args) => ({ text: `ran ${args.label ?? 'x'}` }),
    },
  ]
  let server

  afterEach(() => {
    server?.close()
    server = undefined
  })

  function mcpFetch(url, body) {
    return fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async function boot(toolList = tools) {
    server = new ControlServer({
      token,
      activeDir: join(dir, 'active'),
      mcp: { tools: () => toolList, serverInfo: { name: 'test-editor', version: '9.9.9' } },
      log: quiet,
    })
    return server.listen()
  }

  it('refuses strangers: no token or wrong token gets 401, no tool ever runs', async () => {
    let ran = 0
    const url = await boot([
      {
        name: 'spy',
        description: 'd',
        inputSchema: {},
        run: async () => {
          ran++
          return { text: 'nope' }
        },
      },
    ])
    const anonymous = await fetch(`${url}/mcp`, { method: 'POST', body: '{}' })
    expect(anonymous.status).toBe(401)
    const wrong = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope-not-the-token-0' },
      body: '{}',
    })
    expect(wrong.status).toBe(401)
    expect(ran).toBe(0)
  })

  it('debug-logs every JSON-RPC method and names every tool call (the verbosity ladder)', async () => {
    // Named breakage the ladder prevents: an editor tool "never arriving" is
    // usually the client never calling (mount/token drift after a reload);
    // without per-request debug lines the bridge cannot say who stayed silent.
    const debugs = []
    server = new ControlServer({
      token,
      activeDir: join(dir, 'active'),
      mcp: { tools: () => tools, serverInfo: { name: 'test-editor', version: '9.9.9' } },
      log: { info() {}, warn() {}, debug: (m) => debugs.push(m) },
    })
    const url = await server.listen()
    await mcpFetch(url, { jsonrpc: '2.0', method: 'notifications/initialized' })
    await mcpFetch(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    await mcpFetch(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'editor_state' } })
    expect(debugs.some((m) => m.includes('notifications/initialized'))).toBe(true)
    expect(debugs.some((m) => m.includes('tools/list'))).toBe(true)
    expect(debugs.some((m) => m.includes('tools/call') && m.includes('editor_state'))).toBe(true)
  })

  it('answers the handshake the pinned client demands: version echo, tool list, 202 notifications, 405 stream probe', async () => {
    const url = await boot()
    const init = await mcpFetch(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
    })
    expect(init.status).toBe(200)
    const hello = (await init.json()).result
    // The client aborts on any protocol version it did not itself offer.
    expect(hello.protocolVersion).toBe('2025-11-25')
    expect(hello.capabilities.tools).toBeDefined()
    expect(hello.serverInfo.name).toBe('test-editor')

    const listed = await mcpFetch(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    expect((await listed.json()).result.tools[0].name).toBe('slow_tool')

    const noted = await mcpFetch(url, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    expect(noted.status).toBe(202)
    expect(await noted.text()).toBe('')

    // The pinned client reads 405 on its SSE probe as "no server-to-client
    // channel" and proceeds without one; DELETE closes a session we never open.
    const stream = await fetch(`${url}/mcp`, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } })
    expect(stream.status).toBe(405)
    const close = await fetch(`${url}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
    expect(close.status).toBe(404)
  })

  it('runs tools, publishes a drain marker while a tool call executes, and removes it after', async () => {
    const activeDir = join(dir, 'active')
    let markerState
    const url = await boot([
      {
        name: 'slow_tool',
        description: 'd',
        inputSchema: {},
        run: async () => {
          markerState = readdirSync(activeDir).filter((n) => n.endsWith('.json'))
          return { text: 'done' }
        },
      },
    ])
    const res = await mcpFetch(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slow_tool', arguments: {} } })
    const out = (await res.json()).result
    expect(out.content[0]).toMatchObject({ type: 'text', text: 'done' })
    expect(out.isError).toBeUndefined()
    expect(markerState).toHaveLength(1)
    expect(readdirSync(activeDir)).toHaveLength(0)
  })

  it('turns tool failures AND unknown tools into readable content, never transport deaths', async () => {
    const url = await boot([
      ...tools,
      {
        name: 'boom',
        description: 'd',
        inputSchema: {},
        run: async () => {
          throw new Error('editor exploded')
        },
      },
    ])
    const failed = (await (await mcpFetch(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } })).json()).result
    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toMatch(/editor exploded/)
    // An unknown tool must land in the transcript as content the model can
    // correct against, not as an RPC error whose rendering the client decides.
    const ghost = (await (await mcpFetch(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } })).json()).result
    expect(ghost.isError).toBe(true)
    expect(ghost.content[0].text).toMatch(/no such tool/)
  })

  it('answers garbage with an RPC parse error and unknown paths with 404, keeping ping alive', async () => {
    const url = await boot()
    const headers = { authorization: `Bearer ${token}` }
    const junk = await (await fetch(`${url}/mcp`, { method: 'POST', headers, body: '{oops' })).json()
    expect(junk.error.code).toBe(-32700)
    expect((await fetch(`${url}/v1/secrets`, { headers })).status).toBe(404)
    expect((await fetch(`${url}/v1/ping`, { headers })).status).toBe(200)
  })
})

describe('ensureAdapterInstalled', () => {
  // The real breakage this catches (observed 2026-10-05, user install): pnpm
  // does not re-copy a file: dependency whose version did not change, so the
  // profile kept the previous plugin build forever. The preset child died
  // with "never started", session creation failed, and the Preview Notice
  // acknowledgement stopped persisting.
  function scaffold(opts) {
    const vendor = join(dir, 'vendor', 'dsh-adapter-vllmc')
    const vendorCore = join(dir, 'vendor', 'vllm-copilot-core')
    const modules = join(dir, 'profiles', 'vllmc', 'node_modules')
    const copy = join(modules, '@fuzzifikation', 'dsh-adapter-vllmc')
    const copyCore = join(modules, 'vllm-copilot-core')
    mkdirSync(vendor, { recursive: true })
    mkdirSync(vendorCore, { recursive: true })
    mkdirSync(copy, { recursive: true })
    mkdirSync(copyCore, { recursive: true })
    const manifest = JSON.stringify({ name: '@fuzzifikation/dsh-adapter-vllmc', version: '0.0.1' })
    writeFileSync(join(vendor, 'package.json'), manifest)
    writeFileSync(join(vendor, 'index.js'), 'export const apply = 1')
    writeFileSync(join(vendor, 'extra.js'), 'export const apply = 2')
    writeFileSync(join(vendorCore, 'package.json'), JSON.stringify({ name: 'vllm-copilot-core', version: '1.0.0' }))
    // The stale profile copy: same version stamp, missing the new file.
    writeFileSync(join(copy, 'package.json'), manifest)
    writeFileSync(join(copy, 'index.js'), 'export const apply = 1')
    if (opts.copyHasExtra) writeFileSync(join(copy, 'extra.js'), 'export const apply = 2')
    writeFileSync(join(copyCore, 'package.json'), JSON.stringify({ name: 'vllm-copilot-core', version: '1.0.0' }))
    return { vendor, vendorCore, modules, copy, copyCore }
  }

  function opts(s, run) {
    return {
      binPath: join(dir, 'bin.js'),
      dshHome: dir,
      profile: 'vllmc',
      adapterDir: s.vendor,
      coreDir: s.vendorCore,
      profileModules: s.modules,
      stampFile: join(dir, 'adapter-installed.txt'),
      run,
    }
  }

  it('reinstalls when the stamp matches but the profile copy is an older build', async () => {
    const s = scaffold({ copyHasExtra: false })
    writeFileSync(join(dir, 'adapter-installed.txt'), '0.0.1\n')
    let ran = 0
    // A pnpm-shaped fake: add is a NO-OP while the stale directory exists,
    // exactly the trap that broke real installs.
    await ensureAdapterInstalled(
      opts(s, (o) => {
        ran++
        if (!existsSync(join(s.copy, 'extra.js'))) {
          if (existsSync(s.copy)) return { code: 0, stdout: '', stderr: '' }
          mkdirSync(join(s.copy, '..'), { recursive: true })
          const cp = (from, to) => {
            mkdirSync(to, { recursive: true })
            for (const e of readdirSync(from, { withFileTypes: true })) {
              if (e.isDirectory()) cp(join(from, e.name), join(to, e.name))
              else writeFileSync(join(to, e.name), readFileSync(join(from, e.name)))
            }
          }
          cp(s.vendor, s.copy)
          cp(s.vendorCore, s.copyCore)
        }
        void o
        return { code: 0, stdout: '', stderr: '' }
      }),
    )
    expect(ran).toBe(1)
    expect(existsSync(join(s.copy, 'extra.js'))).toBe(true)
  })

  it('stops the boot instead of running a harness whose plugin tree stayed stale', async () => {
    const s = scaffold({ copyHasExtra: false })
    // A fake reinstall that changes nothing (stubborn stale tree).
    await expect(ensureAdapterInstalled(opts(s, () => ({ code: 0, stdout: '', stderr: '' })))).rejects.toThrow(/stale/)
  })

  it('does nothing when stamp and copy already match the vendor tree', async () => {
    const s = scaffold({ copyHasExtra: true })
    writeFileSync(join(dir, 'adapter-installed.txt'), '0.0.1\n')
    await expect(ensureAdapterInstalled(opts(s, () => ({ code: 1, stdout: '', stderr: 'must not run' })))).resolves.toBeUndefined()
  })
})

describe('startup lock', () => {
  // Real breakage: on editor start every restored window starts at once;
  // without the lock they run concurrent npm installs into one runtime tree
  // and spawn twice, leaving orphans that then kill each other via the sweep.
  it('gives exactly one window the right to start and releases it afterward', async () => {
    const lockFile = join(dir, 'start.lock')
    const pidFile = join(dir, 'dsh.pid')
    const a = await acquireStartLock({ lockFile, pidFile })
    expect(a.kind).toBe('acquired')
    const b = await acquireStartLock({ lockFile, pidFile, waitMs: 300, pollMs: 50 })
    expect(b.kind).toBe('busy')
    a.lock.release()
    const c = await acquireStartLock({ lockFile, pidFile, waitMs: 300, pollMs: 50 })
    expect(c.kind).toBe('acquired')
    c.lock.release()
  })

  it('steals the lock of a dead window instead of waiting out the budget', async () => {
    const lockFile = join(dir, 'start.lock')
    writeFileSync(lockFile, '2147483646\n')
    const won = await acquireStartLock({ lockFile, pidFile: join(dir, 'dsh.pid'), waitMs: 1000, pollMs: 50 })
    expect(won.kind).toBe('acquired')
    won.lock.release()
  })

  it('adopts the finished harness while a live holder still holds the lock', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
    const lockFile = join(dir, 'start.lock')
    writeFileSync(lockFile, `${holder.pid}\n`)
    const pidFile = join(dir, 'dsh.pid')
    writePidRecord(pidFile, {
      pid: holder.pid,
      startedAt: '',
      profile: 'vllmc',
      dshVersion: 'x',
      url: `http://127.0.0.1:${server.address().port}/`,
    })
    try {
      const won = await acquireStartLock({ lockFile, pidFile, waitMs: 5000, pollMs: 50 })
      expect(won.kind).toBe('adopt')
    } finally {
      holder.kill()
      server.close()
    }
  })

  it('catches the blind release: a stolen lock keeps protecting its new holder', async () => {
    // Real breakage: a prepare slower than staleMs loses the lock to a
    // stealer; the original holder's release used to unlink whatever was
    // there, releasing the stealer's live lock to a third window that then
    // runs npm install over the same runtime tree concurrently.
    const lockFile = join(dir, 'start.lock')
    const pidFile = join(dir, 'dsh.pid')
    const first = await acquireStartLock({ lockFile, pidFile, holderPid: 2147483646 })
    expect(first.kind).toBe('acquired')
    const second = await acquireStartLock({ lockFile, pidFile, holderPid: 2147483645, waitMs: 1000, pollMs: 50 })
    expect(second.kind).toBe('acquired')
    first.lock.release()
    expect(existsSync(lockFile)).toBe(true)
    expect(readFileSync(lockFile, 'utf8').trim()).toBe('2147483645')
    second.lock.release()
    expect(existsSync(lockFile)).toBe(false)
  })

  it('does not adopt a harness the caller refuses for composition staleness', async () => {
    // Real breakage: a window that queued behind a restart used to adopt the
    // pre-restart record through the waiting path, borrowing an older build's
    // plugin and skipping the replacement it waited for. The waiting path must
    // obey the same law as the direct one: refuse means keep waiting, busy
    // beats stale.
    const server = createServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
    const lockFile = join(dir, 'start.lock')
    writeFileSync(lockFile, `${holder.pid}\n`)
    const pidFile = join(dir, 'dsh.pid')
    writePidRecord(pidFile, {
      pid: holder.pid,
      startedAt: '',
      profile: 'vllmc',
      dshVersion: 'x',
      url: `http://127.0.0.1:${server.address().port}/`,
    })
    try {
      const refused = await acquireStartLock({ lockFile, pidFile, waitMs: 300, pollMs: 50, isAdoptable: () => false })
      expect(refused.kind).toBe('busy')
      const accepted = await acquireStartLock({ lockFile, pidFile, waitMs: 5000, pollMs: 50, isAdoptable: () => true })
      expect(accepted.kind).toBe('adopt')
    } finally {
      holder.kill()
      server.close()
    }
  })
})

describe('supervisor lifecycle around window close', () => {
  function fakeSupervisor(overrides) {
    return new Supervisor({
      binPath: join(dir, 'fake-launcher.js'),
      dshHome: dir,
      profile: 'vllmc',
      pidFile: join(dir, 'dsh.pid'),
      activeDir: join(dir, 'active'),
      dshVersion: 'test',
      log: { info() {}, warn() {} },
      nodePath: process.execPath,
      urlTimeoutMs: 20_000,
      ...overrides,
    })
  }

  it('reaps detached survivors before every spawn, the ones the editor killed the launcher of', async () => {
    writeFileSync(join(dir, 'fake-launcher.js'), "console.log('dsh web: http://127.0.0.1:59999/?token=fake')\nsetInterval(() => {}, 1000)\n")
    const swept = []
    const supervisor = fakeSupervisor({ sweep: (home) => swept.push(home) })
    const url = await supervisor.start()
    expect(url).toContain('59999')
    expect(swept).toEqual([dir])
    await supervisor.stop()
    expect(swept.length).toBe(2)
  })

  it('boots without --patch: the patched root include would poison every plugin toggle', async () => {
    // Upstream dsh-app-boot: an include created with a patches config is
    // never recorded as the root Include entry, so every live profile reload
    // (every plugin toggle) afterwards fails with "profile reload requires
    // the root Include entry". The generated rows reach the harness through
    // the profile's own patch layer instead, so the boot flag is gone.
    const argvFile = join(dir, 'argv.txt')
    writeFileSync(
      join(dir, 'argv-launcher.js'),
      "require('node:fs').writeFileSync(process.env.DSH_BRIDGE_ARGV_OUT, process.argv.slice(2).join('\\n'))\n" +
        "console.log('dsh web: http://127.0.0.1:59998/?token=fake')\nsetInterval(() => {}, 1000)\n",
    )
    const supervisor = fakeSupervisor({
      binPath: join(dir, 'argv-launcher.js'),
      sweep: () => {},
      env: { DSH_BRIDGE_ARGV_OUT: argvFile },
    })
    await supervisor.start()
    const args = readFileSync(argvFile, 'utf8').split('\n')
    expect(args).toEqual(['--profile', 'vllmc', '--no-open', '--port', '0'])
    expect(args).not.toContain('--patch')
    await supervisor.stop()
  })

  it('announces a plugin-toggle write to the profile but never its own regeneration', async () => {
    // The plugin manager persists a toggle but cannot hot-apply it
    // (docs/upstream-issues.md); the spawning window watches for that write
    // and offers the restart that converges, while the bridge's own
    // patch-layer regeneration stays silent.
    writeFileSync(
      join(dir, 'watch-launcher.js'),
      "console.log('dsh web: http://127.0.0.1:59997/?token=fake')\nsetInterval(() => {}, 1000)\n",
    )
    const profileDir = join(dir, 'profile')
    mkdirSync(profileDir, { recursive: true })
    const patchPath = join(profileDir, 'cordis.patch.yml')
    writeFileSync(patchPath, '[]\n')
    const edits = []
    const supervisor = fakeSupervisor({
      binPath: join(dir, 'watch-launcher.js'),
      sweep: () => {},
      profileDir,
      onProfileEdit: (file) => edits.push(file),
    })
    await supervisor.start()
    // A write we claimed as our own: not an event.
    supervisor.recordOwnProfileWrite(patchPath, '# ours\n')
    writeFileSync(patchPath, '# ours\n')
    // A write from anywhere else: one event, named by the file.
    writeFileSync(patchPath, "[]\n- id: '@some/bundle'\n  disabled: true\n")
    const deadline = Date.now() + 8000
    while (edits.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    await supervisor.stop()
    expect(edits).toEqual(['cordis.patch.yml'])
  })

  it('a fresh spawn clears the active-request ghosts the dead harness left behind', async () => {
    // Records carry the writer's pid in the file name; the writer is gone,
    // so the "N requests running" pill and the next drain are haunting a
    // corpse (observed after two mid-turn reloads: ghosts from 20:25 and
    // 14:43 counted against a harness that had just started).
    writeFileSync(
      join(dir, 'ghost-launcher.js'),
      "console.log('dsh web: http://127.0.0.1:59995/?token=fake')\nsetInterval(() => {}, 1000)\n",
    )
    const activeDir = join(dir, 'ghost-active')
    mkdirSync(activeDir, { recursive: true })
    writeFileSync(join(activeDir, '1794062613853-36696-eeade0fc.json'), '{}')
    writeFileSync(join(activeDir, '1794079552160-32632-11a7dfc8.json'), '{}')
    const supervisor = fakeSupervisor({
      binPath: join(dir, 'ghost-launcher.js'),
      sweep: () => {},
      activeDir,
    })
    await supervisor.start()
    expect(readdirSync(activeDir)).toEqual([])
    await supervisor.stop()
  })

  it('closing a borrowing window leaves the borrowed harness, its pid file, and its servers alone', () => {
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
    const pidFile = join(dir, 'dsh.pid')
    writePidRecord(pidFile, { pid: holder.pid, startedAt: '', profile: 'vllmc', dshVersion: 'x', url: 'http://127.0.0.1:9/' })
    const supervisor = fakeSupervisor({ pidFile, sweep: () => { throw new Error('a borrowing window must not sweep') } })
    supervisor.adopt(readPidRecord(pidFile))
    supervisor.release()
    expect(supervisor.running).toBe(false)
    expect(supervisor.adopted).toBe(false)
    expect(readPidRecord(pidFile)?.pid).toBe(holder.pid)
    expect(isProcessAlive(holder.pid)).toBe(true)
    holder.kill()
  })
})

describe('profile patch layer merge', () => {
  // The overlay rows and the plugin manager write the SAME file now. The
  // merge is the peace treaty: regeneration must be a fixed point over its
  // own output and must never eat the user's toggles.
  const scaffold = [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists; `!!js` expressions allowed).',
    '[]',
    '',
  ].join('\n')
  const rows = '# GENERATED by the dsh bridge\n- id: agent-default-model\n  config:\n    provider: "vllmc"\n    model: "m-1"\n'

  it('appends the block, keeps the scaffold comments, drops the bare []', () => {
    const merged = mergePatchLayer(scaffold, rows)
    expect(merged).toContain(PATCH_LAYER_START)
    expect(merged).toContain(PATCH_LAYER_END)
    expect(merged).toContain('!!js')
    expect(merged).not.toMatch(/^\[\]/m)
    expect(merged.indexOf('agent-default-model')).toBeGreaterThan(merged.indexOf(PATCH_LAYER_START))
  })

  it('is a fixed point: regenerating over its own output changes nothing', () => {
    const once = mergePatchLayer(scaffold, rows)
    expect(mergePatchLayer(once, rows)).toBe(once)
  })

  it('keeps plugin-manager rows and keeps them outside the block', () => {
    const toggled = mergePatchLayer(scaffold, rows)
    const withUser = `${toggled}\n- id: '@some/bundle'\n  disabled: true\n`
    const again = mergePatchLayer(withUser, rows)
    expect(again).toContain("@some/bundle")
    expect((again.match(/>>> dsh-bridge generated layer/g) || []).length).toBe(1)
    expect(again.indexOf("@some/bundle")).toBeLessThan(again.indexOf(PATCH_LAYER_START))
  })

  it('swallows a dangling block whose end marker was edited away', () => {
    const broken = mergePatchLayer(scaffold, rows).replace(PATCH_LAYER_END, '# oops, gone')
    const fixed = mergePatchLayer(broken, '# GENERATED\n- id: agent-default-model\n  config:\n    provider: "vllmc"\n    model: "m-2"\n')
    expect(fixed).toContain('model: "m-2"')
    expect(fixed).not.toContain('m-1')
    expect(fixed).not.toContain('oops, gone')
    expect((fixed.match(/>>> dsh-bridge generated layer/g) || []).length).toBe(1)
  })

  it('restores [] when the generated rows are empty', () => {
    expect(mergePatchLayer('', '').trim()).toBe('[]')
    expect(mergePatchLayer(scaffold, '')).toContain('[]')
  })
})

describe('composition and legacy home bookkeeping', () => {
  const current = { extensionVersion: '1.2.3', pluginFingerprint: 'abc', vendorCoreExists: true }

  it('refuses adoption when the running composition predates this build', () => {
    expect(compositionIsCurrent({ extensionVersion: '1.2.3', pluginFingerprint: 'abc' }, current)).toBe(true)
    expect(compositionIsCurrent({ extensionVersion: '1.2.2', pluginFingerprint: 'abc' }, current)).toBe(false)
    expect(compositionIsCurrent({ extensionVersion: '1.2.3', pluginFingerprint: 'old' }, current)).toBe(false)
    expect(compositionIsCurrent(undefined, current)).toBe(false)
    expect(compositionIsCurrent({ extensionVersion: '1.2.3', pluginFingerprint: 'abc' }, { ...current, vendorCoreExists: false })).toBe(false)
  })

  it('lists versioned homes from the old layout and never the stable root', () => {
    mkdirSync(join(dir, 'dsh-home-0.0.1'), { recursive: true })
    mkdirSync(join(dir, 'dsh-home-0.0.2'), { recursive: true })
    mkdirSync(join(dir, 'dsh-home', 'runtime'), { recursive: true })
    mkdirSync(join(dir, 'unrelated'), { recursive: true })
    expect(legacyHomeDirs(dir, join(dir, 'dsh-home'))).toEqual([join(dir, 'dsh-home-0.0.1'), join(dir, 'dsh-home-0.0.2')])
    // Rails still run versioned roots: self-exclusion must be by resolve, not name.
    expect(legacyHomeDirs(dir, join(dir, 'dsh-home-0.0.1'))).toEqual([join(dir, 'dsh-home-0.0.2')])
  })
})

describe('embed proxy (the chromeless-panel door)', () => {
  const quiet = { info() {}, warn() {} }
  // Named breakage this prevents: 0.0.10's webview showed a permanent 401
  // because Chromium refuses to carry the harness's SameSite=Strict session
  // across the webview origin. The proxy carries it server-side instead; if
  // that ever regresses, these tests see a 401 (or a 502 loop) immediately.
  let harness
  let proxy

  afterEach(async () => {
    proxy?.close()
    proxy = undefined
    if (harness) await new Promise((r) => harness.close(r))
    harness = undefined
  })

  function startHarness(sessionId) {
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        const cookie = req.headers.cookie || ''
        if (req.url.startsWith('/enter')) {
          // The real login: token in, Strict HttpOnly cookie on a 303 — the
          // exact shape dsh-client-connection stamps.
          res.writeHead(303, {
            location: `http://127.0.0.1:${s.address().port}/app`,
            'set-cookie': `sid=${sessionId}; Path=/; HttpOnly; SameSite=Strict`,
          })
          res.end()
          return
        }
        if (req.url === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<html><body><h1>APP PAGE</h1></body></html>')
          return
        }
        if (req.url === '/app') {
          if (cookie.includes(`sid=${sessionId}`)) {
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end(`APP:${sessionId}`)
          } else {
            res.writeHead(401)
            res.end('nope')
          }
          return
        }
        if (req.url === '/go') {
          res.writeHead(303, { location: `http://127.0.0.1:${s.address().port}/app` })
          res.end()
          return
        }
        if (req.url === '/echo' && req.method === 'POST') {
          let body = ''
          req.on('data', (c) => (body += c))
          req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end(`cookie=${cookie}|body=${body}`)
          })
          return
        }
        res.writeHead(404)
        res.end('404')
      })
      s.on('upgrade', (req, socket) => {
        const cookie = req.headers.cookie || ''
        if (!cookie.includes(`sid=${sessionId}`)) {
          socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          return
        }
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake\r\n\r\n')
        socket.write('WSOK')
        // Like any real ws stack: when the peer ends, the accepted leg ends too,
        // or the server's own close would wait on a write-only ghost.
        socket.on('end', () => socket.destroy())
      })
      s.listen(0, '127.0.0.1', () => resolve(s))
    })
  }

  const enterUrl = (s) => `http://127.0.0.1:${s.address().port}/enter?token=tok1`

  it('rides the Strict session a webview browser could never carry', async () => {
    harness = await startHarness('A1')
    proxy = new EmbedProxy({ port: 0, log: quiet })
    const root = await proxy.listen()
    proxy.setTarget(enterUrl(harness))
    const res = await fetch(`${root}/app`)
    expect(await res.text()).toBe('APP:A1')
    // The jar stays server-side: a Set-Cookie here would hand the webview a
    // cookie it could not send back, hiding future breakage behind a half-state.
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('replaces any arriving cookie header with the jar and passes POST bodies through', async () => {
    harness = await startHarness('A1')
    proxy = new EmbedProxy({ port: 0, log: quiet })
    const root = await proxy.listen()
    proxy.setTarget(enterUrl(harness))
    const res = await fetch(`${root}/echo`, {
      method: 'POST',
      headers: { cookie: 'junk=1', 'content-type': 'text/plain' },
      body: 'hi',
    })
    expect(await res.text()).toBe('cookie=sid=A1|body=hi')
  })

  it('keeps the browser on the proxy across absolute redirects', async () => {
    harness = await startHarness('A1')
    proxy = new EmbedProxy({ port: 0, log: quiet })
    const root = await proxy.listen()
    proxy.setTarget(enterUrl(harness))
    const res = await fetch(`${root}/go`, { redirect: 'manual' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${root}/app`)
  })

  it('relays the WebSocket handshake with the session attached', async () => {
    harness = await startHarness('A1')
    proxy = new EmbedProxy({ port: 0, log: quiet })
    const root = await proxy.listen()
    proxy.setTarget(enterUrl(harness))
    // Warm the jar over plain HTTP first, exactly as the page's boot would.
    expect(await (await fetch(`${root}/app`)).text()).toBe('APP:A1')
    const u = new URL(root)
    const sock = netConnect(Number(u.port), '127.0.0.1')
    const chunks = []
    sock.on('data', (c) => chunks.push(c))
    await new Promise((r) => sock.once('connect', r))
    sock.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !Buffer.concat(chunks).includes('WSOK')) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const got = Buffer.concat(chunks).toString()
    sock.destroy()
    expect(got).toContain('101 Switching Protocols')
    expect(got).toContain('WSOK')
  })

  it('stamps the title beacon into the index page and nowhere else', async () => {
    harness = await startHarness('A1')
    proxy = new EmbedProxy({ port: 0, log: quiet })
    const root = await proxy.listen()
    proxy.setTarget(enterUrl(harness))
    const page = await (await fetch(`${root}/`)).text()
    expect(page).toContain('APP PAGE')
    expect(page).toContain('dshEmbedTitle')
    expect(page).toContain('dshKey')
    expect(page).toContain('__dsh-key')
    expect(page.indexOf('dshEmbedTitle')).toBeLessThan(page.indexOf('</html>'))
    // Plain passthrough stays byte-identical: no beacon in non-HTML, and
    // not even in HTML that is not the index page.
    const other = await (await fetch(`${root}/app`)).text()
    expect(other).toBe('APP:A1')
  })

  it('takes the title beacon over the same-origin channel without auth', async () => {
    harness = await startHarness('A1')
    const titles = []
    proxy = new EmbedProxy({ port: 0, log: quiet, onTitle: (v, t) => titles.push([v, t]) })
    const root = await proxy.listen()
    // No setTarget, no login: the endpoint writes one string and reads nothing.
    const res = await fetch(`${root}/__dsh-title?v=abc&t=${encodeURIComponent('Dsf Query \u2014 DeepSeek Harness')}`)
    expect(res.status).toBe(204)
    expect(titles).toEqual([['abc', 'Dsf Query \u2014 DeepSeek Harness']])
  })

  it('takes a keyboard chord over the same-origin channel and pre-auth', async () => {
    harness = await startHarness('A1')
    const keys = []
    proxy = new EmbedProxy({ port: 0, log: quiet, onKey: (c) => keys.push(c) })
    const root = await proxy.listen()
    const res = await fetch(`${root}/__dsh-key?c=${encodeURIComponent('Ctrl+Shift+P')}`)
    expect(res.status).toBe(204)
    expect(keys).toEqual(['Ctrl+Shift+P'])
  })

  it('serves 502 while the harness is gone and rides the new one after retarget', async () => {
    harness = await startHarness('A1')
    proxy = new EmbedProxy({ port: 0, log: quiet })
    const root = await proxy.listen()
    proxy.setTarget(enterUrl(harness))
    expect(await (await fetch(`${root}/app`)).text()).toBe('APP:A1')
    await new Promise((r) => harness.close(r))
    harness = undefined
    expect((await fetch(`${root}/app`)).status).toBe(502)
    harness = await startHarness('B2')
    proxy.setTarget(enterUrl(harness))
    expect(await (await fetch(`${root}/app`)).text()).toBe('APP:B2')
  })
})
