/**
 * The harness prompt commands at their REAL seams: the registered command
 * handlers (not just their helpers), the consent marker on disk, the
 * settings writes, and the "which recording file do I open" resolver. The
 * isolation clause that matters most: these handlers may only ever touch
 * vllm-copilot.harness.* settings - never a Copilot model field. Synthetic
 * strings only.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import {
  equivalentHarnessPath,
  harnessPersonalitiesDir,
  harnessPersonalityTemplate,
  registerHarnessPromptCommands,
  scanHarnessPersonalities,
  snapshotRecordingFile,
  workspaceRecordingFile,
  syncCaptureMarker,
} from '../../src/vscode/harness/promptCommands.js'
import { bridgePaths, type BridgePaths } from '../../src/vscode/harness/paths.js'

const quietLog = { info: () => {}, warn: () => {}, error: () => {} }

const w = vscode.window as any
const c = vscode.commands as any
const ws = vscode.workspace as any

const originals = {
  showQuickPick: w.showQuickPick,
  showOpenDialog: w.showOpenDialog,
  showInformationMessage: w.showInformationMessage,
  showWarningMessage: w.showWarningMessage,
  showErrorMessage: w.showErrorMessage,
  openTextDocument: ws.openTextDocument,
  showTextDocument: w.showTextDocument,
  executeCommand: c.executeCommand,
  getConfiguration: ws.getConfiguration,
  workspaceFolders: ws.workspaceFolders,
  mockConfig: ws._mockConfig,
}

let root: string
let paths: BridgePaths
let context: { globalStorageUri: { fsPath: string } }
let updates: { section: string; key: string; value: unknown; target: unknown }[]
let infos: string[]
let warnings: string[]
let errors: string[]
let errorItems: string[]
let logErrors: string[]
let opened: { command: string; args: unknown[] }[]
let installed = false
let quickPickResult: ((items: any[]) => any) | undefined

/** Settings fake: records EVERY config write the handlers make, so "only
 *  harness keys" is an assertion over the recorded list, not a hope. */
/** Settings fake recording EVERY write WITH ITS SECTION: the isolation law
 *  is "harness commands touch only vllm-copilot.harness.*", and a key-name
 *  list alone could not tell a harness write from a Copilot one. */
function mockSettings(settings: { personality?: string; personalityFile?: string; captureSystemMessages?: boolean }) {
  ws.getConfiguration = (section?: string) => ({
    get: (key: string, def?: unknown) => ((settings as any)[key] !== undefined ? (settings as any)[key] : def),
    update: async (key: string, value: unknown, target?: unknown) => {
      updates.push({ section: section ?? '', key, value, target })
    },
    inspect: () => undefined,
    has: () => false,
  })
}

/** Make the harness READ as running: the pid record the commands consult
 *  (readPidRecord is pure file parsing - no liveness probe to fake). */
function makeRunning() {
  installed = true
  mkdirSync(path.dirname(paths.pid), { recursive: true })
  writeFileSync(paths.pid, JSON.stringify({ pid: 4242, startedAt: 'now', profile: 'p', dshVersion: 'v', url: 'http://127.0.0.1:1' }), 'utf8')
}

function register() {
  c._registrations.length = 0
  registerHarnessPromptCommands({
    context: context as any,
    paths,
    log: { info: () => {}, warn: () => {}, error: (m: string) => logErrors.push(m) },
    isInstalled: () => installed,
  })
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'vllmc-pcmd-'))
  paths = bridgePaths(root)
  context = { globalStorageUri: { fsPath: path.join(root, 'globalStorage') } }
  updates = []
  infos = []
  warnings = []
  errors = []
  errorItems = []
  logErrors = []
  opened = []
  quickPickResult = undefined
  installed = false
  ws.workspaceFolders = [{ uri: { fsPath: path.join(root, 'workspace') } }]
  mockSettings({})
  w.showQuickPick = async (items: any[]) => (quickPickResult ? quickPickResult(items) : undefined)
  w.showOpenDialog = async () => undefined
  w.showInformationMessage = async (m: string) => { infos.push(m); return undefined }
  w.showWarningMessage = async (m: string) => { warnings.push(m); return undefined }
  w.showErrorMessage = async (m: string, ...items: string[]) => { errors.push(m); errorItems.push(...items); return undefined }
  ws.openTextDocument = async (arg: any) => ({ untitled: true, arg })
  w.showTextDocument = async () => undefined
  c.executeCommand = async (command: string, ...args: unknown[]) => { opened.push({ command, args }); return undefined }
})

afterEach(() => {
  Object.assign(w, {
    showQuickPick: originals.showQuickPick,
    showOpenDialog: originals.showOpenDialog,
    showInformationMessage: originals.showInformationMessage,
    showWarningMessage: originals.showWarningMessage,
    showErrorMessage: originals.showErrorMessage,
    showTextDocument: originals.showTextDocument,
  })
  Object.assign(ws, {
    openTextDocument: originals.openTextDocument,
    getConfiguration: originals.getConfiguration,
    workspaceFolders: originals.workspaceFolders,
    _mockConfig: originals.mockConfig,
  })
  c.executeCommand = originals.executeCommand
  rmSync(root, { recursive: true, force: true })
})

describe('syncCaptureMarker', () => {
  it('never creates a dormant harness home - absent folder means nothing to write', () => {
    const sync = syncCaptureMarker(paths, true, quietLog)
    expect(sync).toEqual({ folderExists: false })
    expect(existsSync(paths.vllmc)).toBe(false)
    expect(existsSync(paths.captureFlag)).toBe(false)
  })

  it('writes the marker when the home exists, and follows every flip', () => {
    mkdirSync(paths.vllmc, { recursive: true })
    expect(syncCaptureMarker(paths, true, quietLog)).toEqual({ folderExists: true })
    expect(readFlag()).toBe('on')
    expect(syncCaptureMarker(paths, false, quietLog).error).toBeUndefined()
    expect(readFlag()).toBe('off')
  })
})

describe('workspace recording target resolution', () => {
  it('workspaceRecordingFile: first folder only, harness file name - never Copilot\'s', () => {
    ws.workspaceFolders = undefined
    expect(workspaceRecordingFile()).toBeUndefined()
    ws.workspaceFolders = [{ uri: { fsPath: path.join(root, 'ws1') } }, { uri: { fsPath: path.join(root, 'ws2') } }]
    const f = workspaceRecordingFile() as string
    expect(path.basename(f)).toBe('dsh-system-messages.json')
    expect(path.dirname(f)).toBe(path.join(path.join(root, 'ws1'), '.vllm'))
    // Source isolation: NOT the file Copilot's systemMessageCapture writes.
    expect(f).not.toBe(path.join(path.join(root, 'ws1'), '.vllm', 'system-messages.json'))
  })

  it('snapshotRecordingFile: reads the snapshot truth; absent/relative/garbage all fail closed', () => {
    expect(snapshotRecordingFile(paths.snapshot)).toBeUndefined() // no harness home yet
    mkdirSync(paths.vllmc, { recursive: true })
    writeFileSync(paths.snapshot, JSON.stringify({ captureFile: 'D:\\other\\.vllm\\dsh-system-messages.json' }), 'utf8')
    expect(snapshotRecordingFile(paths.snapshot)).toBe('D:\\other\\.vllm\\dsh-system-messages.json')
    writeFileSync(paths.snapshot, JSON.stringify({ captureFile: '.vllm/dsh-system-messages.json' }), 'utf8')
    expect(snapshotRecordingFile(paths.snapshot)).toBeUndefined() // relative = no destination
    writeFileSync(paths.snapshot, JSON.stringify({ captureFile: '   ' }), 'utf8')
    expect(snapshotRecordingFile(paths.snapshot)).toBeUndefined()
    writeFileSync(paths.snapshot, JSON.stringify({}), 'utf8')
    expect(snapshotRecordingFile(paths.snapshot)).toBeUndefined()
    writeFileSync(paths.snapshot, '{ broken', 'utf8')
    expect(snapshotRecordingFile(paths.snapshot)).toBeUndefined()
  })
})

describe('scanHarnessPersonalities', () => {
  it('an absent folder is ordinary (empty list)', async () => {
    expect(await scanHarnessPersonalities(path.join(root, 'nope'))).toEqual([])
  })

  it('directory refusal THROWS - a permission wall is not an empty shelf', async () => {
    mkdirSync(path.dirname(paths.vllmc), { recursive: true })
    writeFileSync(paths.vllmc, 'not a folder', 'utf8')
    await expect(scanHarnessPersonalities(paths.vllmc)).rejects.toThrow()
  })
})

describe('equivalentHarnessPath', () => {
  it('case-folds only where the OS is case-insensitive', () => {
    const a = path.join(root, 'Voice.JSON')
    const b = path.join(root, 'voice.json')
    if (process.platform === 'win32') expect(equivalentHarnessPath(a, b)).toBe(true)
    else expect(equivalentHarnessPath(a, b)).toBe(false)
    // Separator noise and trailing separators never split an identity.
    expect(equivalentHarnessPath(path.join(root, 'x') + path.sep, root + path.sep + 'x')).toBe(true)
    expect(equivalentHarnessPath(path.join(root, 'x'), path.join(root, 'y'))).toBe(false)
  })
})

describe('harnessPersonalityTemplate', () => {
  it('is valid JSON with EMPTY rules, harness-only instructions and the real folder', () => {
    const dir = harnessPersonalitiesDir(context as any)
    const parsed = JSON.parse(harnessPersonalityTemplate(dir))
    expect(parsed.rules).toEqual([])
    expect(parsed.meta.name).toBeTruthy()
    expect(parsed.meta.description).toContain('HARNESS prompt')
    expect(parsed.meta.description).not.toContain('Copilot preset')
    // The Create flow is a lie without a REAL path the user can paste.
    expect(parsed.meta.howTo).toContain(dir)
    expect(JSON.stringify(parsed)).not.toContain('prompt-replacements-common.json')
  })
})

describe('Set Harness Personality command', () => {
  it('Default clears BOTH harness prompt settings (name and file) and says what happens', async () => {
    mockSettings({ personality: 'Spartan', personalityFile: 'voice.json' })
    register()
    quickPickResult = (items: any[]) => items.find((i) => i.action === 'default')
    await c._run('vllm-copilot.harness.setPersonality')
    expect(updates).toEqual([
      { section: 'vllm-copilot.harness', key: 'personality', value: '', target: vscode.ConfigurationTarget.Global },
      { section: 'vllm-copilot.harness', key: 'personalityFile', value: '', target: vscode.ConfigurationTarget.Global },
    ])
    expect(infos.some((m) => m.includes('untouched'))).toBe(true)
  })

  it('bundled voices are offered in curated order and store ONLY the portable name - the file reference is cleared', async () => {
    mockSettings({ personalityFile: 'old.json' })
    register()
    let seen: any[] = []
    quickPickResult = (items: any[]) => {
      seen = items
      return items.find((i) => i.presetName === 'Spartan')
    }
    await c._run('vllm-copilot.harness.setPersonality')
    expect(updates).toEqual([
      { section: 'vllm-copilot.harness', key: 'personalityFile', value: '', target: vscode.ConfigurationTarget.Global },
      { section: 'vllm-copilot.harness', key: 'personality', value: 'Spartan', target: vscode.ConfigurationTarget.Global },
    ])
    expect(seen.filter((i) => i.presetName).map((i) => i.presetName)).toEqual(['Supportive Mentor', 'Critical Senior Dev', 'Sarcastic Robot', 'Spartan'])
    expect(infos.some((m) => m.includes('Spartan'))).toBe(true)
  })

  it('the current bundled voice wears the check mark, Default does not; refresh shows the name', async () => {
    mockSettings({ personality: 'Spartan' })
    register()
    let seen: any[] = []
    let placeholder = ''
    w.showQuickPick = async (items: any[], options: any) => { seen = items; placeholder = options.placeHolder; return undefined }
    await c._run('vllm-copilot.harness.setPersonality')
    expect(seen.some((i) => i.presetName === 'Spartan' && i.label === '$(check) Spartan')).toBe(true)
    expect(seen.some((i) => i.presetName === 'Spartan' && String(i.description).includes('current'))).toBe(true)
    expect(seen.find((i) => i.action === 'default').label).toBe('Default (upstream DeepSeek Harness prompt)')
    expect(placeholder).toContain('Spartan')
  })

  it('rejects garbage AND broken include trees; nothing gets attached', async () => {
    register()
    const garbage = path.join(root, 'garbage.json')
    writeFileSync(garbage, JSON.stringify({ rules: 'not-an-array' }), 'utf8')
    const brokenInclude = path.join(root, 'broken-include.json')
    writeFileSync(brokenInclude, JSON.stringify({ rules: [{ include: 'does-not-exist.json' }] }), 'utf8')

    w.showOpenDialog = async () => [{ fsPath: garbage }]
    quickPickResult = (items: any[]) => items.find((i) => i.action === 'load')
    await c._run('vllm-copilot.harness.setPersonality')
    expect(errors.some((m) => m.includes('Not a usable harness personality file'))).toBe(true)
    expect(updates).toEqual([])

    errors.length = 0
    w.showOpenDialog = async () => [{ fsPath: brokenInclude }]
    await c._run('vllm-copilot.harness.setPersonality')
    // Same doctrine as Copilot Load: an include-failed tree is NOT attached.
    expect(errors.some((m) => /Not a usable harness personality file: Include/.test(m))).toBe(true)
    expect(updates).toEqual([])

    // And a valid file IS attached, stored by path (no workspace folder here).
    errors.length = 0
    const good = path.join(root, 'good.json')
    writeFileSync(good, JSON.stringify({ meta: { name: 'G', description: 'd' }, rules: [{ ruleName: 'r', find: 'A', replace: 'B' }] }), 'utf8')
    w.showOpenDialog = async () => [{ fsPath: good }]
    await c._run('vllm-copilot.harness.setPersonality')
    // Attaching a custom file clears the bundled-voice name: the two are mutually exclusive.
    expect(updates).toEqual([
      { section: 'vllm-copilot.harness', key: 'personality', value: '', target: vscode.ConfigurationTarget.Global },
      { section: 'vllm-copilot.harness', key: 'personalityFile', value: good, target: vscode.ConfigurationTarget.Global },
    ])
    expect(errors).toEqual([])
  })

  it('Create opens a valid EMPTY template naming the real folder - writes and attaches nothing', async () => {
    register()
    let docArg: any
    ws.openTextDocument = async (arg: any) => { docArg = arg; return { untitled: true } }
    quickPickResult = (items: any[]) => items.find((i) => i.action === 'create')
    await c._run('vllm-copilot.harness.setPersonality')
    const dir = harnessPersonalitiesDir(context as any)
    expect(docArg.language).toBe('json')
    const parsed = JSON.parse(docArg.content)
    expect(parsed.rules).toEqual([])
    expect(parsed.meta.howTo).toContain(dir)
    expect(updates).toEqual([])
    expect(infos.some((m) => m.includes(dir))).toBe(true)
    expect(existsSync(dir)).toBe(false) // nothing auto-saved, folder untouched
  })
})

describe('Toggle Harness Prompt Recording command', () => {
  it('flips setting AND marker together, harness keys only, honest ON then OFF', async () => {
    mkdirSync(paths.vllmc, { recursive: true })
    const settings: any = { captureSystemMessages: false }
    mockSettings(settings)
    register()

    await c._run('vllm-copilot.harness.toggleRecording')
    // cfg.update is the settings write; the marker must agree on disk before
    // any success message is allowed off the handler.
    expect(updates).toEqual([{ section: 'vllm-copilot.harness', key: 'captureSystemMessages', value: true, target: vscode.ConfigurationTarget.Global }])
    expect(readFlag()).toBe('on')
    expect(infos.some((m) => m.includes('recording: ON'))).toBe(true)
    // The ON answer names the EXACT workspace file - the UX promise under test.
    expect(infos.some((m) => m.includes(path.join(root, 'workspace', '.vllm', 'dsh-system-messages.json')))).toBe(true)
    expect(infos.some((m) => m.includes('uninstalling the harness does not touch it'))).toBe(true)
    expect(infos.some((m) => m.includes('system-messages-'))).toBe(false) // no pid-file fiction left
    expect(errors).toEqual([])
    expect(warnings).toEqual([])

    // The mock does not re-serve mutated settings the way the real
    // Configuration does; point the reader at what the write just did.
    settings.captureSystemMessages = true
    infos.length = 0
    await c._run('vllm-copilot.harness.toggleRecording')
    expect(readFlag()).toBe('off')
    expect(infos.some((m) => m.includes('recording: OFF') && m.includes('dropped on the spot'))).toBe(true)
    // Every write this command ever made: the harness recording key IN THE
    // HARNESS SECTION. Not one byte aimed at a Copilot namespace.
    expect(updates).toEqual([
      { section: 'vllm-copilot.harness', key: 'captureSystemMessages', value: true, target: vscode.ConfigurationTarget.Global },
      { section: 'vllm-copilot.harness', key: 'captureSystemMessages', value: false, target: vscode.ConfigurationTarget.Global },
    ])
    expect(updates.every((u) => u.section === 'vllm-copilot.harness')).toBe(true)
  })

  it('NEVER claims success while the marker refuses - warns with the truth', async () => {
    mkdirSync(paths.vllmc, { recursive: true })
    // A DIRECTORY where the marker file belongs: every marker write fails.
    mkdirSync(paths.captureFlag)
    register()
    await c._run('vllm-copilot.harness.toggleRecording')
    expect(warnings.some((m) => m.includes('could not be updated'))).toBe(true)
    expect(infos).toEqual([]) // no success announcement, ever, on a failed marker
    expect(logErrors.some((m) => m.includes('capture consent marker write failed'))).toBe(true)
  })

  it('pre-install toggle flips the setting and creates NO folder', async () => {
    register()
    await c._run('vllm-copilot.harness.toggleRecording')
    expect(updates).toEqual([{ section: 'vllm-copilot.harness', key: 'captureSystemMessages', value: true, target: vscode.ConfigurationTarget.Global }])
    expect(existsSync(paths.vllmc)).toBe(false)
    expect(infos.some((m) => m.includes('Recording starts when the harness next starts') && m.includes('seeds at prepare'))).toBe(true)
  })

  it('refuses to enable with no workspace folder: no setting write, no marker, actionable warning', async () => {
    ws.workspaceFolders = undefined
    mkdirSync(paths.vllmc, { recursive: true })
    const settings: any = { captureSystemMessages: false }
    mockSettings(settings)
    register()
    await c._run('vllm-copilot.harness.toggleRecording')
    expect(warnings.some((m) => m.includes('was NOT turned on') && m.includes('dsh-system-messages.json'))).toBe(true)
    expect(updates).toEqual([])
    expect(existsSync(paths.captureFlag)).toBe(false)
    expect(infos).toEqual([])
  })

  it('ON with a RUNNING foreign-bound harness: names the owner, demands Restart, never claims the pen moved', async () => {
    mkdirSync(paths.vllmc, { recursive: true })
    const other = path.join(root, 'other-ws', '.vllm', 'dsh-system-messages.json')
    mkdirSync(path.dirname(other), { recursive: true })
    writeFileSync(other, '[]', 'utf8')
    writeFileSync(paths.snapshot, JSON.stringify({ captureFile: other }), 'utf8')
    const settings: any = { captureSystemMessages: false }
    mockSettings(settings)
    makeRunning()
    register()
    await c._run('vllm-copilot.harness.toggleRecording')
    expect(warnings.some((m) => m.includes(other) && m.includes('records to ANOTHER window') && m.includes('Restart'))).toBe(true)
    // Start adopting a survivor must never be dressed up as a rebind.
    expect(warnings.some((m) => m.includes('Start adopts the survivor and rebinds nothing'))).toBe(true)
    expect(infos).toEqual([]) // this is not a success story
  })

  it('ON with a RUNNING folder-less-bound harness: says it records NOTHING until Restart here', async () => {
    mkdirSync(paths.vllmc, { recursive: true })
    writeFileSync(paths.snapshot, JSON.stringify({ version: 1 }), 'utf8') // no captureFile - empty window prepared
    const settings: any = { captureSystemMessages: false }
    mockSettings(settings)
    makeRunning()
    register()
    await c._run('vllm-copilot.harness.toggleRecording')
    expect(warnings.some((m) => m.includes('names no recording file') && m.includes('records NOTHING') && m.includes('Restart'))).toBe(true)
    expect(infos).toEqual([])
  })

  it('a STALE foreign snapshot with the harness NOT running is no lie: next start rebinds here', async () => {
    mkdirSync(paths.vllmc, { recursive: true })
    const other = path.join(root, 'other-ws', '.vllm', 'dsh-system-messages.json')
    mkdirSync(path.dirname(other), { recursive: true })
    writeFileSync(other, '[]', 'utf8')
    writeFileSync(paths.snapshot, JSON.stringify({ captureFile: other }), 'utf8')
    const settings: any = { captureSystemMessages: false }
    mockSettings(settings)
    register()
    await c._run('vllm-copilot.harness.toggleRecording')
    // Not running: prepare happens at the next start HERE - an honest plain ON.
    expect(infos.some((m) => m.includes('recording: ON') && m.includes('next starts'))).toBe(true)
    expect(warnings).toEqual([])
  })
})

describe('Open Harness Recording command', () => {
  const ownFile = () => path.join(root, 'workspace', '.vllm', 'dsh-system-messages.json')

  it('opens THIS workspace\'s .vllm\\dsh-system-messages.json directly - no pid scan', async () => {
    const file = ownFile()
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '[]', 'utf8')
    // A stale home file must not win the open.
    mkdirSync(paths.vllmc, { recursive: true })
    writeFileSync(path.join(paths.vllmc, 'system-messages-999.json'), '[]', 'utf8')
    register()
    await c._run('vllm-copilot.harness.openRecording')
    // The vscode mock's Uri.file returns the path itself - assert the real target.
    expect(opened).toEqual([{ command: 'vscode.open', args: [file] }])
  })

  it('missing file: names the enable-and-send recipe, opens nothing', async () => {
    register()
    await c._run('vllm-copilot.harness.openRecording')
    expect(infos.some((m) => m.includes('No harness prompt recording exists yet') && m.includes(ownFile()))).toBe(true)
    expect(opened).toEqual([])
  })

  it('no workspace: actionable open-a-folder warning; nothing is invented elsewhere', async () => {
    ws.workspaceFolders = undefined
    register()
    await c._run('vllm-copilot.harness.openRecording')
    expect(warnings.some((m) => m.includes('no folder open') && m.includes('dsh-system-messages.json'))).toBe(true)
    expect(opened).toEqual([])
  })

  it('names the owning window when the RUNNING shared harness records into ANOTHER workspace', async () => {
    const other = path.join(root, 'other-ws', '.vllm', 'dsh-system-messages.json')
    mkdirSync(path.dirname(other), { recursive: true })
    writeFileSync(other, '[]', 'utf8')
    mkdirSync(paths.vllmc, { recursive: true })
    writeFileSync(paths.snapshot, JSON.stringify({ captureFile: other }), 'utf8')
    makeRunning()
    register()
    await c._run('vllm-copilot.harness.openRecording')
    expect(infos.some((m) => m.includes(other) && m.includes('bound to another window') && m.includes('Restart'))).toBe(true)
    expect(infos.some((m) => m.includes('Start adopts the survivor and rebinds nothing'))).toBe(true)
    expect(opened).toEqual([]) // this window's file still does not exist - no fake open, no foreign auto-open
  })

  it('own file opens even when the running pen is elsewhere - then says exactly where it is', async () => {
    const file = ownFile()
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '[]', 'utf8')
    const other = path.join(root, 'other-ws', '.vllm', 'dsh-system-messages.json')
    mkdirSync(path.dirname(other), { recursive: true })
    writeFileSync(other, '[1]', 'utf8')
    mkdirSync(paths.vllmc, { recursive: true })
    writeFileSync(paths.snapshot, JSON.stringify({ captureFile: other }), 'utf8')
    makeRunning()
    register()
    await c._run('vllm-copilot.harness.openRecording')
    // THIS window's file opens; the foreign file is named, never opened.
    expect(opened).toEqual([{ command: 'vscode.open', args: [file] }])
    expect(warnings.some((m) => m.includes(other) && m.includes('Restart'))).toBe(true)
  })

  it('running with NO bound target: says it records nothing anywhere and how to fix it', async () => {
    mkdirSync(paths.vllmc, { recursive: true })
    writeFileSync(paths.snapshot, JSON.stringify({ version: 1 }), 'utf8')
    makeRunning()
    register()
    await c._run('vllm-copilot.harness.openRecording')
    expect(warnings.some((m) => m.includes('names no recording file') && m.includes('records nothing anywhere') && m.includes(ownFile()))).toBe(true)
    expect(opened).toEqual([])
  })

  it('command failures go through the outer net: named error + Show Log, no soft silence', async () => {
    const file = ownFile()
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '[]', 'utf8')
    c.executeCommand = async () => {
      throw new Error('editor exploded')
    }
    register()
    await c._run('vllm-copilot.harness.openRecording')
    expect(errors.some((m) => m.includes('Open Harness Recording failed') && m.includes('editor exploded'))).toBe(true)
    expect(errorItems).toContain('Show Log')
    expect(logErrors.some((m) => m.includes('failed:'))).toBe(true)
    expect(infos).toEqual([])
  })
})

function readFlag(): string {
  return readFileSync(paths.captureFlag, 'utf8')
}