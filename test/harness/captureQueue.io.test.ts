/**
 * The consent gate and the capture lock against REAL awaited I/O seams, with
 * fs/promises stubbed by a tiny deterministic store so the consent flip and
 * the two-writer contention can land exactly INSIDE an in-flight write -
 * no sleeps, no racing, no call-count guessing. Pins: unique per-operation
 * temps, abandoned temps removed and their failure said out loud, the plain
 * Copilot path doing ZERO extra I/O, and the interleaving that broke the old
 * optimistic "CAS" (both writers merge the same stale bytes) being
 * structurally impossible when both take the lockFile - both report
 * completed, NO entries lost. Synthetic strings only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureQueue } from '../../src/core/personality/capture.js'

type WriteOpts = { encoding?: string; mode?: number; flag?: string }

const fsMock = vi.hoisted(() => {
  const store = new Map<string, string>()
  const hooks: { stallTemp: Promise<void> | null } = { stallTemp: null }
  const enoent = (what: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`ENOENT: no such file or directory, ${what}`), { code: 'ENOENT' })
  return {
    store,
    hooks,
    mkdir: vi.fn(async (_p: string, _o?: unknown) => undefined),
    readFile: vi.fn(async (p: string): Promise<string> => {
      if (!store.has(p)) throw enoent(`read ${p}`)
      return store.get(p)!
    }),
    writeFile: vi.fn(async (p: string, data: string, opts?: WriteOpts) => {
      if (opts?.flag === 'wx' && store.has(p)) {
        throw Object.assign(new Error(`EEXIST: file exists, ${p}`), { code: 'EEXIST' })
      }
      if (p.endsWith('.tmp') && hooks.stallTemp) await hooks.stallTemp
      store.set(p, data)
    }),
    rename: vi.fn(async (from: string, to: string) => {
      if (!store.has(from)) throw enoent(`rename ${from}`)
      store.set(to, store.get(from)!)
      store.delete(from)
    }),
    unlink: vi.fn(async (p: string) => {
      if (!store.has(p)) throw enoent(`unlink ${p}`)
      store.delete(p)
    }),
  }
})
vi.mock('fs/promises', () => fsMock)

const TARGET = 'V:\\vllmc\\system-messages-4242.json'
const LOCK = 'V:\\vllmc\\.rec.lock'
// Temps are per-operation (pid + random): two writers can never stage onto
// one shared name. Match the shape; never the literal.
const TMP_RE = /^V:\\vllmc\\system-messages-4242\.json\.\d+\.[0-9a-f]{8}\.tmp$/
const entry = { receivedContent: 'SYNTH-A', deliveredContent: 'SYNTH-B', rulesApplied: ['r'] }
const entryB = { receivedContent: 'SYNTH-C', deliveredContent: 'SYNTH-D', rulesApplied: [] }

function mkLog() {
  const lines: string[] = []
  return { lines, log: { appendLine: (l: string) => lines.push(l) } as any }
}

beforeEach(() => {
  fsMock.mkdir.mockClear()
  fsMock.readFile.mockClear()
  fsMock.writeFile.mockClear()
  fsMock.rename.mockClear()
  fsMock.unlink.mockClear()
  fsMock.store.clear()
  fsMock.hooks.stallTemp = null
})

describe('CaptureQueue against awaited I/O', () => {
  it('drops a write whose consent died WHILE the temp write was still in flight', async () => {
    let release!: () => void
    fsMock.writeFile.mockImplementationOnce(() => new Promise<undefined>((res) => { release = () => res(undefined) }))
    let consent = true
    const { lines, log } = mkLog()
    const pending = new CaptureQueue().enqueueWrite(TARGET, [entry], log, { gate: () => consent, mode: 0o600 })
    await vi.waitFor(() => expect(fsMock.writeFile).toHaveBeenCalled())
    consent = false
    release()
    await pending
    expect(fsMock.rename).not.toHaveBeenCalled()
    expect(fsMock.unlink).toHaveBeenCalledWith(expect.stringMatching(TMP_RE))
    expect(lines.some((l) => /abandoned before commit/.test(l))).toBe(true)
  })

  it('a failed write removes this operation temp - and says so when removal ALSO fails', async () => {
    fsMock.writeFile.mockRejectedValueOnce(new Error('disk on fire'))
    const eacces: NodeJS.ErrnoException = new Error('EACCES: denied')
    eacces.code = 'EACCES'
    fsMock.unlink.mockRejectedValueOnce(eacces)
    const { lines, log } = mkLog()
    await new CaptureQueue().enqueueWrite(TARGET, [entry], log, { mode: 0o600 })
    expect(fsMock.rename).not.toHaveBeenCalled()
    expect(fsMock.unlink).toHaveBeenCalledWith(expect.stringMatching(TMP_RE))
    expect(lines.some((l) => /Failed to write capture file/.test(l))).toBe(true)
    // Abandoned raw prompt bytes must never be a silent footnote.
    expect(lines.some((l) => /Could not remove temporary capture file/.test(l))).toBe(true)
  })

  it('a failed rename also cleans the temp', async () => {
    fsMock.rename.mockRejectedValueOnce(new Error('rename denied'))
    const { lines, log } = mkLog()
    await new CaptureQueue().enqueueWrite(TARGET, [entry], log, { mode: 0o600 })
    expect(fsMock.unlink).toHaveBeenCalledWith(expect.stringMatching(TMP_RE))
    expect(lines.some((l) => /Failed to write capture file/.test(l))).toBe(true)
  })

  it('a reader holding the target open costs a retry, not the record', async () => {
    // The Windows shape of a shared file: replacing the target is refused
    // OUTRIGHT while any handle has it open - an antivirus scan, a sync client,
    // an editor showing the recording (which is the whole point of the file),
    // or a test polling it. That handle closes in microseconds, so treating the
    // refusal as fatal deletes a user's captured prompt over a 50µs read. The
    // commit is all-or-nothing, so retrying the SAME rename can only land the
    // new bytes or leave the old ones: no partial state to reason about.
    const eperm = (): NodeJS.ErrnoException =>
      Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    fsMock.rename.mockRejectedValueOnce(eperm())
    const { lines, log } = mkLog()
    await new CaptureQueue().enqueueWrite(TARGET, [entry], log, { mode: 0o600 })
    expect(fsMock.rename.mock.calls.length).toBeGreaterThan(1)
    expect(JSON.parse(fsMock.store.get(TARGET)!)).toEqual([entry]) // the record SURVIVED
    // Said once, not per attempt - and never as a write failure.
    expect(lines.filter((l) => /Capture commit waiting for a reader/.test(l))).toHaveLength(1)
    expect(lines.some((l) => /Failed to write capture file/.test(l))).toBe(false)
    expect(fsMock.unlink).not.toHaveBeenCalled() // the temp was committed, not abandoned
  })

  it('a persistent refusal gives up on schedule: bounded retries, temp cleaned, failure said', async () => {
    // A wedged reader must not pin the queue - and the capture lock behind it -
    // forever, so the patience is capped and the old fatal path still runs.
    const eperm = (): NodeJS.ErrnoException =>
      Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    for (let attempt = 0; attempt < 8; attempt++) fsMock.rename.mockRejectedValueOnce(eperm())
    const { lines, log } = mkLog()
    await new CaptureQueue().enqueueWrite(TARGET, [entry], log, { mode: 0o600 })
    expect(fsMock.rename.mock.calls.length).toBe(8)
    expect(lines.some((l) => /Failed to write capture file/.test(l))).toBe(true)
    expect(fsMock.unlink).toHaveBeenCalledWith(expect.stringMatching(TMP_RE))
  })

  it('consent dying during a commit retry abandons the write like one before the first attempt', async () => {
    // The flip lands INSIDE the refused commit (the seam decides, no sleeps
    // guessed), so the retry must notice consent is gone and stop.
    let consent = true
    fsMock.rename.mockImplementationOnce(async () => {
      consent = false
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    })
    const { lines, log } = mkLog()
    await new CaptureQueue().enqueueWrite(TARGET, [entry], log, { gate: () => consent, mode: 0o600 })
    expect(fsMock.rename).toHaveBeenCalledTimes(1) // never tried again with consent dead
    expect(fsMock.store.has(TARGET)).toBe(false) // nothing persisted after the flip
    expect(fsMock.unlink).toHaveBeenCalledWith(expect.stringMatching(TMP_RE))
    expect(lines.some((l) => /abandoned before commit/.test(l))).toBe(true)
  })

  it('gate false at task start touches no I/O at all', async () => {
    const { log } = mkLog()
    await new CaptureQueue().enqueueWrite(TARGET, [entry], log, { gate: () => false })
    expect(fsMock.writeFile).not.toHaveBeenCalled()
    expect(fsMock.unlink).not.toHaveBeenCalled()
    expect(fsMock.rename).not.toHaveBeenCalled()
  })

  it('the Copilot path (no options) is untouched: no gate reads, no lock, straight atomic write', async () => {
    const { log } = mkLog()
    await new CaptureQueue().enqueueWrite(TARGET, [entry], log)
    expect(fsMock.rename).toHaveBeenCalledWith(expect.stringMatching(TMP_RE), TARGET)
    expect(fsMock.unlink).not.toHaveBeenCalled()
    // Zero extra I/O on the historical path: the Copilot merge still reads
    // exactly once and never creates a lock.
    expect(fsMock.readFile).toHaveBeenCalledTimes(1)
    expect(fsMock.writeFile.mock.calls.every((c) => String(c[2]?.flag ?? '') !== 'wx')).toBe(true)
  })

  it('lockFile: exclusive wx-create before any read, release in finally after the rename', async () => {
    const { log } = mkLog()
    await new CaptureQueue().enqueueWrite(TARGET, [entry], log, { lockFile: LOCK, mode: 0o600 })
    // The lock is TAKEN (flag wx, mode 0600) and it is the FIRST write...
    expect(fsMock.writeFile.mock.calls[0][0]).toBe(LOCK)
    expect(fsMock.writeFile.mock.calls[0][2]).toMatchObject({ flag: 'wx', mode: 0o600 })
    // ...the merge read happens strictly AFTER acquisition, and the lock is
    // gone once the commit is done.
    const readOrder = fsMock.readFile.mock.calls.length
    expect(readOrder).toBe(1)
    expect(fsMock.rename).toHaveBeenCalledWith(expect.stringMatching(TMP_RE), TARGET)
    expect(fsMock.unlink).toHaveBeenCalledWith(LOCK)
    expect(fsMock.store.has(LOCK)).toBe(false)
  })

  it('a persistently held lock SKIPS: no temp, no rename, no lock removal, named warning', async () => {
    fsMock.store.set(LOCK, '{"pid":999999}') // a stranger holds the gate
    const { lines, log } = mkLog()
    await new CaptureQueue().enqueueWrite(TARGET, [entry], log, { lockFile: LOCK, lockWaitMs: 30 })
    // Every write attempt hit the LOCK and only the lock.
    expect(fsMock.writeFile.mock.calls.length).toBeGreaterThan(1)
    expect(fsMock.writeFile.mock.calls.every((c) => c[0] === LOCK)).toBe(true)
    expect(fsMock.rename).not.toHaveBeenCalled()
    expect(fsMock.readFile).not.toHaveBeenCalled() // never merged - never got in
    expect(fsMock.unlink).not.toHaveBeenCalled() // a foreign lock is NEVER touched
    expect(lines.some((l) => /Capture skipped: another recorder holds the capture lock/.test(l))).toBe(true)
    expect(lines.join('\n')).toContain('delete that file') // manual cleanup is spelled out
  })

  it('consent dying while waiting on the lock drops the write instead of queueing behind a stranger', async () => {
    fsMock.store.set(LOCK, '{"pid":999999}')
    let gateCalls = 0
    const { lines, log } = mkLog()
    await new CaptureQueue().enqueueWrite(TARGET, [entry], log, {
      lockFile: LOCK,
      lockWaitMs: 60_000, // consent alone must end this
      gate: () => ++gateCalls < 3,
    })
    expect(lines.some((l) => /consent off while waiting for the capture lock/.test(l))).toBe(true)
    expect(fsMock.rename).not.toHaveBeenCalled()
    expect(fsMock.unlink).not.toHaveBeenCalled()
  })

  it('a lock that cannot be created for non-contention reasons fails closed - nothing is written elsewhere', async () => {
    const eperm: NodeJS.ErrnoException = new Error('EPERM: locked out')
    eperm.code = 'EPERM'
    fsMock.writeFile.mockImplementationOnce(async () => { throw eperm })
    const { lines, log } = mkLog()
    await new CaptureQueue().enqueueWrite(TARGET, [entry], log, { lockFile: LOCK })
    expect(lines.some((l) => /could not be created/.test(l))).toBe(true)
    expect(fsMock.rename).not.toHaveBeenCalled()
    expect(fsMock.store.has(TARGET)).toBe(false)
  })

  it('consent flip during a STALLED temp write still drops the write and releases the lock', async () => {
    let release!: () => void
    fsMock.hooks.stallTemp = new Promise<void>((res) => { release = () => res() })
    let consent = true
    const { lines, log } = mkLog()
    const pending = new CaptureQueue().enqueueWrite(TARGET, [entry], log, { gate: () => consent, lockFile: LOCK })
    await vi.waitFor(() => expect(fsMock.writeFile.mock.calls.some((c) => String(c[0]).endsWith('.tmp'))).toBe(true))
    consent = false
    release()
    await pending
    expect(fsMock.rename).not.toHaveBeenCalled()
    expect(fsMock.unlink).toHaveBeenCalledWith(expect.stringMatching(TMP_RE))
    expect(fsMock.unlink).toHaveBeenCalledWith(LOCK) // finally runs on the abandoned path too
    expect(lines.some((l) => /abandoned before commit/.test(l))).toBe(true)
  })

  it('two INDEPENDENT queues, one target: the stale-merge interleaving that ate records is structurally gone', async () => {
    // The OLD pseudo-CAS failure, scheduled ON PURPOSE: writer A reads the
    // target and stalls BEFORE its rename; writer B then attempts its whole
    // read-merge. Under optimistic replay B merged STALE bytes and its later
    // rename silently erased A. With the lock, B cannot even READ the target
    // until A committed and released - the assertion below proves the merge
    // read happens strictly after A's rename, every single run.
    fsMock.store.set(TARGET, '[]')
    let releaseA!: () => void
    fsMock.hooks.stallTemp = new Promise<void>((res) => { releaseA = () => res() })
    const qA = new CaptureQueue()
    const qB = new CaptureQueue()
    const logA = mkLog()
    const logB = mkLog()

    // A: lock (passes the wx gate), merge read, then STALLS on its temp write.
    const pA = qA.enqueueWrite(TARGET, [entry], logA.log, { lockFile: LOCK })
    await vi.waitFor(() => expect(fsMock.writeFile.mock.calls.some((c) => String(c[0]).endsWith('.tmp'))).toBe(true))
    expect(fsMock.store.has(LOCK)).toBe(true)
    expect(fsMock.readFile).toHaveBeenCalledTimes(1) // A's merge read only

    // B: an INDEPENDENT queue (a second dsh process, module state unshared).
    const pB = qB.enqueueWrite(TARGET, [entryB], logB.log, { lockFile: LOCK })
    await vi.waitFor(() => expect(fsMock.writeFile.mock.calls.filter((c) => c[0] === LOCK).length).toBeGreaterThanOrEqual(2))
    // The decisive fact: while A holds the lock mid-flight, B HAS NOT READ
    // the target at all. The old code read here - and that read is what lost
    // records. It cannot happen any more.
    expect(fsMock.readFile).toHaveBeenCalledTimes(1)

    // A finishes and hands the gate over.
    fsMock.hooks.stallTemp = null
    releaseA()
    await Promise.all([pA, pB])

    const kept = JSON.parse(fsMock.store.get(TARGET)!).map((e: { receivedContent: string }) => e.receivedContent)
    expect(kept.sort()).toEqual(['SYNTH-A', 'SYNTH-C']) // both completed, NOTHING lost
    expect(fsMock.readFile).toHaveBeenCalledTimes(2) // B read only AFTER A committed
    expect(fsMock.unlink).toHaveBeenCalledWith(LOCK) // both released (25ms polls, real release)
    expect((logA.lines.join('\n') + '\n' + logB.lines.join('\n')).match(/Captured/g)).toHaveLength(2)
    expect(fsMock.store.has(LOCK)).toBe(false)
  })
})
