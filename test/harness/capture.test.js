/**
 * Prompt-recording boundaries: consent semantics (fail closed, exact "on"),
 * the CaptureQueue consent gate (task start AND pre-rename), the plugin's
 * recorder module resolving its workspace target from the snapshot, and the
 * independent-writer safety (an exclusive lock file, atomic `wx` create) that
 * lets several dsh processes share one fixed recording file without losing
 * records - and refuses to write at all rather than force or steal a lock. Synthetic strings only - this is the
 * file that exists so no one ever tests with real prompts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from 'vllm-copilot-core'
import { flagFileFrom, lockFileFor, readCaptureTarget, createRecorder, CAPTURE_FLAG_FILENAME } from '../../dsh/plugin/capture.js'

const quietLog = { appendLine: () => {} }
const entry = (text) => ({ receivedContent: text, deliveredContent: text, rulesApplied: [] })

let dir
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vllmc-capture-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('consent marker (core, shared by editor and harness)', () => {
  it('reads ONLY the exact content "on" as consent; everything else fails closed', () => {
    const flag = path.join(dir, CAPTURE_FLAG_FILENAME)
    expect(core.readCaptureConsent(flag)).toEqual({ enabled: false, reason: 'absent' })
    core.writeCaptureConsent(flag, true)
    expect(readFileSync(flag, 'utf8')).toBe('on')
    expect(core.readCaptureConsent(flag).enabled).toBe(true)
    core.writeCaptureConsent(flag, false)
    expect(readFileSync(flag, 'utf8')).toBe('off')
    expect(core.readCaptureConsent(flag)).toEqual({ enabled: false, reason: 'off' })
    // Byte-exact: the writers emit bare `on`/`off`. Whitespace and casing are
    // not politeness - they are someone else's hands on the file, so they are
    // malformed, and malformed fails closed.
    writeFileSync(flag, 'on\n', 'utf8')
    expect(core.readCaptureConsent(flag)).toEqual({ enabled: false, reason: 'malformed' })
    writeFileSync(flag, '  on \n', 'utf8')
    expect(core.readCaptureConsent(flag).reason).toBe('malformed')
    writeFileSync(flag, 'ON', 'utf8')
    expect(core.readCaptureConsent(flag)).toEqual({ enabled: false, reason: 'malformed' })
    writeFileSync(flag, '{"enabled":true}', 'utf8')
    expect(core.readCaptureConsent(flag).enabled).toBe(false)
    unlinkSync(flag)
    expect(core.readCaptureConsent(flag).reason).toBe('absent')
  })
  it('uses a per-writer temp: a stray shared-name .tmp is none of its business', () => {
    // Two windows toggling at once must never rename over each other, so the
    // writer never touches `<flag>.tmp` - a foreign file under that exact name
    // survives the write untouched.
    const flag = path.join(dir, CAPTURE_FLAG_FILENAME)
    writeFileSync(flag + '.tmp', 'someone-elses-pen', 'utf8')
    core.writeCaptureConsent(flag, true)
    expect(readFileSync(flag, 'utf8')).toBe('on')
    expect(readFileSync(flag + '.tmp', 'utf8')).toBe('someone-elses-pen')
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([CAPTURE_FLAG_FILENAME + '.tmp'])
  })
})


describe('CaptureQueue consent gate', () => {
  const target = () => path.join(dir, 'system-messages-999.json')

  it('catches the disabled-but-queued capture: gate false at task start touches no disk', async () => {
    await new core.CaptureQueue().enqueueWrite(target(), [entry('SECRET')], quietLog, { gate: () => false })
    expect(existsSync(target())).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('catches the flip mid-RMW: gate checked again before the rename, temp cleaned', async () => {
    let calls = 0
    // First check (task start) passes; the consent dies during the read+merge.
    await new core.CaptureQueue().enqueueWrite(target(), [entry('SECRET')], quietLog, { gate: () => ++calls === 1 })
    expect(calls).toBe(2)
    expect(existsSync(target())).toBe(false)
    // The temp written before the flip must not linger as recording debris.
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('records normally while consent holds, and Copilot callers (no options) keep the old behavior', async () => {
    const t = target()
    await new core.CaptureQueue().enqueueWrite(t, [entry('a')], quietLog, { gate: () => true, mode: 0o600 })
    expect(JSON.parse(readFileSync(t, 'utf8'))).toEqual([entry('a')])
    const t2 = path.join(dir, 'plain.json')
    await new core.CaptureQueue().enqueueWrite(t2, [entry('b')], quietLog)
    expect(JSON.parse(readFileSync(t2, 'utf8'))).toEqual([entry('b')])
  })
})

describe('CaptureQueue corrupt-file recovery', () => {
  it('a damaged capture is replaced - and its bytes never reach the log', async () => {
    const RED = 'ZZRED-9142' // short enough for V8's quoted excerpt to leak it whole
    const t = path.join(dir, 'system-messages-999.json')
    // Bare-token array: V8's error quotes the source excerpt, so the old
    // err.message logging genuinely leaked captured text into the log.
    writeFileSync(t, `[${RED} captured prompt tail]`, 'utf8')
    const lines = []
    await new core.CaptureQueue().enqueueWrite(t, [entry('after')], { appendLine: (l) => lines.push(l) })
    const joined = lines.join('\n')
    expect(joined).toContain('Failed to read')
    expect(joined).toContain('corrupt JSON')
    expect(joined).not.toContain(RED)
    expect(JSON.parse(readFileSync(t, 'utf8')).map((e) => e.receivedContent)).toEqual(['after'])
  })
})

describe('plugin recorder (capture.js)', () => {
  const workspaceTarget = () => path.join(dir, 'ws', '.vllm', 'dsh-system-messages.json')
  function writeSnapshotWith(captureFile) {
    const snapshotFile = path.join(dir, 'vllmc', 'snapshot.json')
    mkdirSync(path.dirname(snapshotFile), { recursive: true })
    writeFileSync(snapshotFile, JSON.stringify({ version: 1, captureFile }), 'utf8')
    return snapshotFile
  }

  it('flag sits beside the snapshot; target is the snapshot-named workspace file - never Copilot\'s file name', () => {
    const snapshotFile = writeSnapshotWith(workspaceTarget())
    expect(path.basename(flagFileFrom(snapshotFile))).toBe(CAPTURE_FLAG_FILENAME)
    expect(flagFileFrom(snapshotFile)).toBe(path.join(dir, 'vllmc', 'capture.flag'))
    expect(readCaptureTarget(snapshotFile)).toBe(workspaceTarget())
    // Source isolation pinned: the harness file name is NOT Copilot's.
    expect(path.basename(readCaptureTarget(snapshotFile))).toBe('dsh-system-messages.json')
    expect(readCaptureTarget(snapshotFile)).not.toBe(path.join(dir, 'ws', '.vllm', 'system-messages.json'))
  })

  it('readCaptureTarget fails closed: unreadable snapshot, absent/blank/relative/garbage targets all mean NO destination', () => {
    expect(readCaptureTarget(path.join(dir, 'nope.json'))).toBeUndefined()
    expect(readCaptureTarget(writeSnapshotWith(undefined))).toBeUndefined()
    expect(readCaptureTarget(writeSnapshotWith(''))).toBeUndefined()
    expect(readCaptureTarget(writeSnapshotWith('   '))).toBeUndefined()
    expect(readCaptureTarget(writeSnapshotWith(path.join('.vllm', 'dsh-system-messages.json')))).toBeUndefined() // relative = a guess, refused
    expect(readCaptureTarget(writeSnapshotWith(42))).toBeUndefined()
    const corrupt = path.join(dir, 'vllmc', 'snapshot.json')
    mkdirSync(path.dirname(corrupt), { recursive: true })
    writeFileSync(corrupt, '{ not json', 'utf8')
    expect(readCaptureTarget(corrupt)).toBeUndefined()
  })

  it('records ONLY to the snapshot-named workspace file, and stops the moment consent flips', async () => {
    const target = workspaceTarget()
    const snapshotFile = writeSnapshotWith(target)
    const flagFile = flagFileFrom(snapshotFile)
    const record = createRecorder({ core, flagFile, snapshotFile, log: quietLog })

    await record([entry('prompt bytes')]) // consent absent: ordinary silence...
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(dir).filter((n) => n.includes('system-messages'))).toEqual([]) // ...and nowhere else

    core.writeCaptureConsent(flagFile, true)
    await record([entry('one')])
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual([entry('one')])

    core.writeCaptureConsent(flagFile, false)
    await record([entry('two')])
    expect(JSON.parse(readFileSync(target, 'utf8')).map((e) => e.receivedContent)).toEqual(['one'])

    core.writeCaptureConsent(flagFile, true)
    await record([entry('three')])
    expect(JSON.parse(readFileSync(target, 'utf8')).map((e) => e.receivedContent)).toEqual(['one', 'three'])
  })

  it('follows a snapshot rebind at the next capture - no restart, no env, no fallback', async () => {
    const first = workspaceTarget()
    const snapshotFile = writeSnapshotWith(first)
    const flagFile = flagFileFrom(snapshotFile)
    const record = createRecorder({ core, flagFile, snapshotFile, log: quietLog })
    core.writeCaptureConsent(flagFile, true)
    await record([entry('to-first')])
    const second = path.join(dir, 'other-ws', '.vllm', 'dsh-system-messages.json')
    writeFileSync(snapshotFile, JSON.stringify({ version: 1, captureFile: second }), 'utf8')
    await record([entry('to-second')])
    expect(JSON.parse(readFileSync(first, 'utf8')).map((e) => e.receivedContent)).toEqual(['to-first'])
    expect(JSON.parse(readFileSync(second, 'utf8')).map((e) => e.receivedContent)).toEqual(['to-second'])
  })

  it('consent ON with NO workspace target: one honest warning, zero bytes anywhere, recovery without rebuild', async () => {
    const snapshotFile = writeSnapshotWith(undefined)
    const flagFile = flagFileFrom(snapshotFile)
    const lines = []
    const record = createRecorder({ core, flagFile, snapshotFile, log: { appendLine: (l) => lines.push(l) } })
    core.writeCaptureConsent(flagFile, true)
    await record([entry('prompt bytes')])
    const joined = lines.join('\n')
    expect(joined).toContain('no workspace recording file')
    expect(joined).not.toContain('prompt bytes') // the warning carries no prompt text
    expect(readdirSync(dir).filter((n) => n.includes('system-messages'))).toEqual([]) // no home fallback, ever
    await record([entry('again')])
    expect(lines.filter((l) => l.includes('no workspace recording file'))).toHaveLength(1) // once, not per request
    // Give it a destination: recording resumes with the next capture.
    writeFileSync(snapshotFile, JSON.stringify({ version: 1, captureFile: workspaceTarget() }), 'utf8')
    await record([entry('now')])
    expect(JSON.parse(readFileSync(workspaceTarget(), 'utf8')).map((e) => e.receivedContent)).toEqual(['now'])
  })

  it('stays silent while absent, and warns once on a garbage marker', async () => {
    const snapshotFile = writeSnapshotWith(workspaceTarget())
    const flagFile = flagFileFrom(snapshotFile)
    const lines = []
    const record = createRecorder({ core, flagFile, snapshotFile, log: { appendLine: (l) => lines.push(l) } })
    await record([entry('alpha')])
    expect(lines).toEqual([])
    core.writeCaptureConsent(flagFile, true)
    await record([entry('bravo')])
    writeFileSync(flagFile, 'yes please', 'utf8')
    await record([entry('charlie')])
    await record([entry('delta')])
    const warns = lines.filter((l) => l.includes('consent marker malformed'))
    expect(warns).toHaveLength(1) // once, not per request
    expect(warns[0]).not.toMatch(/alpha|bravo|charlie|delta/) // the warning carries no prompt text
    expect(JSON.parse(readFileSync(workspaceTarget(), 'utf8'))).toHaveLength(1) // nothing added while malformed
  })
})

describe('lockFileFor (the per-target gate in the user\'s .vllm folder)', () => {
  it('is a dotted sibling named after the exact target, so every writer agrees on one gate', () => {
    const target = path.join('V:\\ws', '.vllm', 'dsh-system-messages.json')
    expect(lockFileFor(target)).toBe(path.join('V:\\ws', '.vllm', '.dsh-system-messages.json.lock'))
  })
})

describe('CaptureQueue independent-writer safety (shared fixed workspace file, lockFile)', () => {
  it('two independent queues onto one target serialize and keep BOTH writers\' entries', async () => {
    const target = path.join(dir, 'ws', '.vllm', 'dsh-system-messages.json')
    const lock = lockFileFor(target)
    const q1 = new core.CaptureQueue()
    const q2 = new core.CaptureQueue()
    const opts = { mode: 0o600, lockFile: lock }
    await Promise.all([
      q1.enqueueWrite(target, [entry('from-A-1')], quietLog, opts),
      q2.enqueueWrite(target, [entry('from-B-1')], quietLog, opts),
      q1.enqueueWrite(target, [entry('from-A-2')], quietLog, opts),
      q2.enqueueWrite(target, [entry('from-B-2')], quietLog, opts),
    ])
    const kept = JSON.parse(readFileSync(target, 'utf8')).map((e) => e.receivedContent)
    expect(kept.sort()).toEqual(['from-A-1', 'from-A-2', 'from-B-1', 'from-B-2'])
    // The lock is a gate, not furniture: released after every commit.
    expect(existsSync(lock)).toBe(false)
  })

  it('a held lock SKIPS the capture with a named warning - the target is untouched, the lock is never stolen', async () => {
    const target = path.join(dir, 'ws', '.vllm', 'dsh-system-messages.json')
    const lock = lockFileFor(target)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify([entry('kept')]), 'utf8')
    // "Another process holds it" - and we cannot prove otherwise from here,
    // so the ONLY correct action is: wait, give up, SAY SO, change nothing.
    writeFileSync(lock, JSON.stringify({ pid: 999999, at: new Date().toISOString() }), 'utf8')
    const lines = []
    await new core.CaptureQueue().enqueueWrite(target, [entry('SECRET')], { appendLine: (l) => lines.push(l) }, {
      lockFile: lock,
      lockWaitMs: 40,
    })
    const joined = lines.join('\n')
    expect(joined).toContain('Capture skipped')
    expect(joined).toContain('another recorder holds the capture lock')
    expect(joined).not.toContain('SECRET') // warnings carry no prompt text
    expect(JSON.parse(readFileSync(target, 'utf8')).map((e) => e.receivedContent)).toEqual(['kept'])
    expect(existsSync(lock)).toBe(true) // NEVER deleted by a non-owner
    expect(readdirSync(path.dirname(target)).filter((n) => n.endsWith('.tmp'))).toEqual([])
    // Remove the stale lock (the warning tells the user exactly this) and the
    // next capture proceeds normally.
    unlinkSync(lock)
    await new core.CaptureQueue().enqueueWrite(target, [entry('resumed')], quietLog, { lockFile: lock })
    expect(JSON.parse(readFileSync(target, 'utf8')).map((e) => e.receivedContent)).toEqual(['kept', 'resumed'])
    expect(existsSync(lock)).toBe(false)
  })

  it('consent OFF while waiting on the lock drops the write (the gate rides every contention poll)', async () => {
    const target = path.join(dir, 'ws', '.vllm', 'dsh-system-messages.json')
    const lock = lockFileFor(target)
    mkdirSync(path.dirname(lock), { recursive: true })
    writeFileSync(lock, JSON.stringify({ pid: 999999 }), 'utf8')
    let gateCalls = 0
    const lines = []
    await new core.CaptureQueue().enqueueWrite(target, [entry('SECRET')], { appendLine: (l) => lines.push(l) }, {
      lockFile: lock,
      lockWaitMs: 4000, // would keep waiting if consent held - consent must cut it short
      gate: () => ++gateCalls < 3, // start + first poll pass, second poll is OFF
    })
    expect(lines.join('\n')).toContain('consent off while waiting for the capture lock')
    expect(existsSync(target)).toBe(false)
    expect(existsSync(lock)).toBe(true) // waited, gate died, nothing stolen
  })

  it('temps are uniquely named: a foreign file at the old shared `.tmp` name is none of its business', async () => {
    const target = path.join(dir, 'dsh-system-messages.json')
    writeFileSync(`${target}.tmp`, 'someone-elses-pen', 'utf8')
    await new core.CaptureQueue().enqueueWrite(target, [entry('mine')], quietLog, { lockFile: lockFileFor(target) })
    expect(readFileSync(`${target}.tmp`, 'utf8')).toBe('someone-elses-pen') // never touched
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([`${path.basename(target)}.tmp`]) // no temp debris
  })

  it('a consent flip between the temp write and the rename still drops the write and releases the lock', async () => {
    const target = path.join(dir, 'dsh-system-messages.json')
    writeFileSync(target, JSON.stringify([entry('kept')]), 'utf8')
    const lock = lockFileFor(target)
    let gateCalls = 0
    await new core.CaptureQueue().enqueueWrite(target, [entry('SECRET')], quietLog, {
      lockFile: lock,
      gate: () => ++gateCalls === 1, // passes at task start, dies at the pre-rename check
    })
    expect(JSON.parse(readFileSync(target, 'utf8')).map((e) => e.receivedContent)).toEqual(['kept'])
    expect(existsSync(lock)).toBe(false) // finally released even on the abandoned path
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp') && n !== `${path.basename(target)}.tmp`)).toEqual([])
  })
})

// Module-level fixtures for the queue-lifetime test below (the plugin
// describe keeps its own).
function writeSnapshotProbe() {
  const snapshotFile = path.join(dir, 'vllmc', 'snapshot.json')
  mkdirSync(path.dirname(snapshotFile), { recursive: true })
  writeFileSync(snapshotFile, JSON.stringify({ version: 1, captureFile: workspaceProbeTarget() }), 'utf8')
  return snapshotFile
}
function workspaceProbeTarget() {
  return path.join(dir, 'ws', '.vllm', 'dsh-system-messages.json')
}

describe('plugin recorder queue lifetime', () => {
  it('recorders built by one loaded module share ONE queue (reload-safe serialization)', async () => {
    const snapshotFile = writeSnapshotProbe()
    const flagFile = flagFileFrom(snapshotFile)
    core.writeCaptureConsent(flagFile, true)
    const q = createRecorder({ core, flagFile, snapshotFile, log: quietLog })
    const alsoQ = createRecorder({ core, flagFile, snapshotFile, log: quietLog })
    await Promise.all([q([entry('x')]), alsoQ([entry('y')])])
    expect(JSON.parse(readFileSync(workspaceProbeTarget(), 'utf8')).map((e) => e.receivedContent).sort()).toEqual(['x', 'y'])
  })
})
