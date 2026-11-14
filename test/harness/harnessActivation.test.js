/**
 * Tripwires for the installed-state half of the harness lifecycle, driven
 * through the exported activation entry so nothing internal is exported for the
 * test's benefit.
 *
 * Installed state is a file: the runtime stamp inside this extension's global
 * storage, which every window of this extension shares. Another window installs
 * or uninstalls while this one sits idle, and no command of this window runs.
 * The pill, the ingest timer and the sidebar rows only move when
 * `syncInstalledState()` runs, and the event that re-reads the stamp for an
 * already-active window is this window regaining focus. Delete that focus
 * listener in `activateHarness` and the focus cases go red.
 *
 * The same fixture carries the retired bridge gate: while that extension is
 * installed, every window answers the migration with a modal notice, and Start
 * and Install/Update must refuse before any prerequisite probe, progress card,
 * version picker or download. The configured-model gate is
 * verified the same way: Install, Start and Restart answer with one setup offer
 * before any probe, picker, progress card or download, and a configuration read
 * that fails mid-action is explained rather than swallowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const mock = vi.hoisted(() => {
  /** The retired standalone bridge, looked up the way `harness.ts` looks it up. */
  const OLD_BRIDGE_ID = 'System-Sciences.dsh-bridge'
  const rec = {
    pill: { shown: false, text: '' },
    refreshes: 0,
    treeProvider: undefined,
    listeners: {},
    commands: new Map(),
    /** Warnings the lifecycle showed, each with the buttons it offered. */
    warnings: [],
    /** Errors the lifecycle showed: a prerequisite complaint lands here, not in warnings. */
    errors: [],
    /** The next warning's answer, standing in for the user's click. */
    warningReply: undefined,
    quickPicks: 0,
    progress: 0,
    executed: [],
    /** Non-undefined while the retired bridge extension counts as installed. */
    oldBridge: undefined,
    /** The vLLM-Copilot registry the harness reads: what `getConfig` answers. */
    registry: { servers: [], models: [] },
    /** Stands in for the Add or Reconfigure Server/Model wizard's outcome. */
    wizard: undefined,
    /** Messages the lifecycle reported rather than complained about. */
    infos: [],
    /** When set, the settings store refuses to answer: a read that fails mid-action. */
    registryThrows: undefined,
  }
  const listen = (name) => (fn) => {
    const list = (rec.listeners[name] = rec.listeners[name] ?? [])
    list.push(fn)
    return {
      dispose: () => {
        rec.listeners[name] = list.filter((f) => f !== fn)
      },
    }
  }
  const fire = (name, event) => {
    for (const fn of [...(rec.listeners[name] ?? [])]) fn(event)
  }
  const disposable = () => ({ dispose: () => {} })

  class EventEmitter {
    constructor() {
      this.handlers = []
      this.event = (listener) => {
        this.handlers.push(listener)
        return { dispose: () => { this.handlers = this.handlers.filter((h) => h !== listener) } }
      }
    }
    fire(...args) {
      for (const handler of [...this.handlers]) handler(...args)
    }
    dispose() {
      this.handlers = []
    }
  }
  class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label
      this.collapsibleState = collapsibleState
    }
  }
  class MarkdownString {
    constructor(value) {
      this.value = value ?? ''
    }
    appendText(text) {
      this.value += text
      return this
    }
    appendMarkdown(text) {
      this.value += text
      return this
    }
  }
  class Position {
    constructor(line, character) {
      this.line = line
      this.character = character
    }
  }
  class Range {
    constructor(start, end) {
      this.start = start
      this.end = end
    }
  }
  class Selection extends Range {}
  class Diagnostic {
    constructor(range, message) {
      this.range = range
      this.message = message
    }
  }

  const createOutputChannel = (name) => ({
    name,
    logLevel: 2,
    appendLine: () => {},
    append: () => {},
    replace: () => {},
    clear: () => {},
    show: () => {},
    hide: () => {},
    dispose: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
  })

  const window = {
    activeTextEditor: undefined,
    terminals: [],
    tabGroups: { all: [], activeTabGroup: undefined },
    createOutputChannel,
    createStatusBarItem: () => ({
      name: '',
      tooltip: '',
      command: '',
      backgroundColor: undefined,
      get text() {
        return rec.pill.text
      },
      set text(value) {
        rec.pill.text = value
      },
      show: () => {
        rec.pill.shown = true
      },
      hide: () => {
        rec.pill.shown = false
      },
      dispose: () => {},
    }),
    createTreeView: (_id, options) => {
      rec.treeProvider = options.treeDataProvider
      options.treeDataProvider.onDidChangeTreeData(() => {
        rec.refreshes++
      })
      return { dispose: () => {}, reveal: async () => {} }
    },
    createTerminal: () => ({ show: () => {}, sendText: () => {}, dispose: () => {}, shellIntegration: undefined }),
    showInformationMessage: async (message) => {
      rec.infos.push(message)
      return undefined
    },
    // The real API takes `(message, ...items)` or `(message, options, ...items)`.
    // A modal notice arrives through `options`, so record it apart from the
    // buttons instead of reading the options object as one.
    showWarningMessage: async (message, ...args) => {
      const options = typeof args[0] === 'string' || args.length === 0 ? undefined : args[0]
      rec.warnings.push({ message, options, items: options ? args.slice(1) : args })
      return rec.warningReply
    },
    showErrorMessage: async (message, ...items) => {
      rec.errors.push({ message, items })
      return undefined
    },
    showQuickPick: async () => {
      rec.quickPicks++
      return undefined
    },
    showInputBox: async () => undefined,
    withProgress: (_options, task) => {
      rec.progress++
      return Promise.resolve(
        task(
          { report: () => {} },
          { isCancellationRequested: false, onDidRequestCancel: listen('withProgressCancel') },
        ),
      )
    },
    registerWebviewPanelSerializer: () => disposable(),
    onDidCloseTerminal: listen('onDidCloseTerminal'),
    onDidEndTerminalShellExecution: listen('onDidEndTerminalShellExecution'),
    onDidChangeWindowState: listen('onDidChangeWindowState'),
    onDidChangeActiveTerminal: listen('onDidChangeActiveTerminal'),
    onDidChangeActiveTextEditor: listen('onDidChangeActiveTextEditor'),
    createWebviewPanel: () => {
      throw new Error('activation must not open a webview panel')
    },
  }

  const workspace = {
    workspaceFolders: undefined,
    textDocuments: [],
    getConfiguration: () => ({
      // `vllm-copilot.models` and `.servers` are the registry; every harness
      // setting falls through to its default, as it does on a fresh install.
      get: (key, fallback) => {
        if (rec.registryThrows) throw rec.registryThrows
        return key in rec.registry ? rec.registry[key] : fallback
      },
      update: async () => {},
      has: () => false,
      inspect: () => undefined,
    }),
    onDidChangeConfiguration: listen('onDidChangeConfiguration'),
    onDidChangeTextDocument: listen('onDidChangeTextDocument'),
    onDidOpenTextDocument: listen('onDidOpenTextDocument'),
    onDidCloseTextDocument: listen('onDidCloseTextDocument'),
    openTextDocument: async () => {
      throw new Error('activation must not open a document')
    },
  }

  const vscode = {
    window,
    workspace,
    commands: {
      registerCommand: (name, fn) => {
        rec.commands.set(name, fn)
        return disposable()
      },
      executeCommand: async (name, ...args) => {
        rec.executed.push([name, ...args])
        // The setup guard launches the shipped wizard command by id; a case says
        // what the user leaves behind when it closes.
        if (name === 'vllm-copilot.addServerModel' && rec.wizard) await rec.wizard()
        return undefined
      },
      getCommands: async () => [],
    },
    extensions: {
      getExtension: (id) => (id === OLD_BRIDGE_ID ? rec.oldBridge : undefined),
      all: [],
    },
    languages: {
      getDiagnostics: () => [],
      createDiagnosticCollection: () => ({ set: () => {}, delete: () => {}, clear: () => {}, dispose: () => {} }),
    },
    env: {
      clipboard: { writeText: async () => {} },
      openExternal: async () => true,
      asExternalUri: async (uri) => uri,
      appName: 'Test',
      language: 'en',
    },
    EventEmitter,
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class ThemeIcon {
      constructor(id) {
        this.id = id
      }
    },
    MarkdownString,
    Uri: {
      file: (fsPath) => ({ fsPath, scheme: 'file', path: fsPath, with: (c) => ({ ...c }), toString: () => fsPath }),
      parse: (value) => ({ fsPath: value, scheme: 'file', path: value, toString: () => value }),
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts), scheme: 'file' }),
    },
    Position,
    Range,
    Selection,
    Diagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    Disposable: { from: (...items) => ({ dispose: () => items.forEach((item) => item?.dispose?.()) }) },
    StatusBarAlignment: { Left: 1, Right: 2 },
    LogLevel: { Trace: 0, Debug: 1, Info: 2, Warning: 3, Error: 4 },
    ProgressLocation: { Notification: 15, SourceControl: 1, Window: 10 },
    ViewColumn: { One: 1, Two: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    UIKind: { Desktop: 1, Web: 2 },
    __recorder: rec,
    __fire: fire,
    __oldBridgeId: OLD_BRIDGE_ID,
  }
  return vscode
})

vi.mock('vscode', () => mock)

/**
 * The expensive edges, disarmed. The retired-bridge cases below prove the gate
 * answers before it probes or prepares anything. Should that gate ever be
 * deleted, the fall-through has to fail an assertion in milliseconds, not spend
 * minutes installing an npm runtime and launching a process under fake timers.
 * `importOriginal` keeps every other export, paths and stamp name included, the
 * real thing: the gate itself and its decision stay unmocked.
 */
const edges = vi.hoisted(() => ({
  preflight: vi.fn(async () => []),
  runtime: vi.fn(async () => {
    throw new Error('test tripwire: no harness runtime may be prepared while these cases run')
  }),
  started: vi.fn(async () => {
    throw new Error('test tripwire: no harness process may be launched while these cases run')
  }),
  /** Deactivating a window always asks the supervisor to stop, started or not. */
  stopped: vi.fn(async () => ({ drained: true, remaining: 0 })),
}))

vi.mock('../../src/vscode/harness/preflight.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runPreflight: (metadataDir) => edges.preflight(metadataDir),
}))

vi.mock('../../src/vscode/harness/runtime.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureDshRuntime: (options) => edges.runtime(options),
}))

vi.mock('../../src/vscode/harness/supervisor.js', async (importOriginal) => {
  const real = await importOriginal()
  /**
   * Reads like a supervisor that has never launched anything. `start` is the
   * tripwire; `stop` is a harmless drained answer, because the activation
   * disposer calls it for a harness that never ran and a rejection there would be
   * an unhandled one, not a finding. Nothing here pretends to work; it exists so
   * a deleted gate is loud and instant instead of slow and real.
   */
  class DisarmedSupervisor {
    url = undefined
    adopted = undefined
    setBinPath() {}
    adopt() {}
    dropAdoption() {}
    recordOwnProfileWrite() {}
    start() {
      return edges.started()
    }
    stop() {
      return edges.stopped()
    }
  }
  return { ...real, Supervisor: DisarmedSupervisor }
})

const { INSTALL_STAMP_FILE } = await import('../../src/vscode/harness/runtime.js')
const { activateHarness } = await import('../../src/vscode/harness/harness.js')

const repo = path.resolve(import.meta.dirname, '..', '..')
const recorder = mock.__recorder
const fire = mock.__fire
/** Harness commands a row is built for, read from the manifest the lifecycle reads. */
const harnessCommands = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).contributes.commands.filter(
  (entry) => entry.command.startsWith('vllm-copilot.harness.'),
).length

const OLD_BRIDGE_ID = mock.__oldBridgeId
/** What a completed install records in its stamp, read from the certified pin. */
const pinned = JSON.parse(readFileSync(path.join(repo, 'dsh', 'dsh.json'), 'utf8')).pinned

let storage
let context

/**
 * Writes or deletes the runtime stamp the way another window's install or
 * uninstall does: the installed version and a newline, tmp file then rename.
 */
function setInstalled(on) {
  const runtime = path.join(storage, 'dsh-home', 'runtime')
  rmSync(path.join(storage, 'dsh-home'), { recursive: true, force: true })
  if (!on) return
  mkdirSync(runtime, { recursive: true })
  const stamp = path.join(runtime, INSTALL_STAMP_FILE)
  writeFileSync(`${stamp}.tmp`, `${pinned}\n`, 'utf8')
  renameSync(`${stamp}.tmp`, stamp)
}

/** The notices of one command only, since activation may have spoken earlier. */
function clearNotices() {
  recorder.infos = []
  recorder.registry = { servers: [], models: [] }
  recorder.wizard = undefined
  recorder.registryThrows = undefined
  recorder.warnings = []
  recorder.errors = []
  recorder.quickPicks = 0
  recorder.progress = 0
  recorder.executed = []
  recorder.warningReply = undefined
  edges.preflight.mockClear()
  edges.runtime.mockClear()
  edges.started.mockClear()
  edges.stopped.mockClear()
}

/**
 * Runs a lifecycle command and swallows a rejection, so a broken gate still
 * reaches the assertions that explain the failure instead of the tripwire
 * throwing past them.
 */
async function runCommand(id) {
  await recorder.commands.get(id)().catch(() => undefined)
}

/** Lets an unawaited `showWarningMessage().then(...)` chain settle. */
async function settle() {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

function focus() {
  recorder.refreshes = 0
  fire('onDidChangeWindowState', { focused: true })
}

/** The copy the pitch state shows, straight out of `harnessView.ts`: pitch, install, and the three session prompt controls, which are discoverable before install because they create nothing on their own. */
const PITCH_ROWS = [
  'Run an agent on your own models',
  'Install DeepSeek Harness\u2026',
  'Set Harness Personality\u2026',
  'Toggle Harness Prompt Recording',
  'Open Harness Recording',
]

function rows() {
  return recorder.treeProvider.getChildren().map((item) => String(item.label))
}
/** The migration notice `harness.ts` shows while the retired bridge is installed. */
const MIGRATION_TITLE = 'The DeepSeek Harness Bridge has been replaced'
const MIGRATION_DETAIL =
  'DeepSeek Harness is built into vLLM-Copilot. Uninstall the separate DeepSeek Harness Bridge extension, then reload this window. Until then, the built-in harness cannot be installed or started. Existing bridge sessions and settings are not imported or deleted by this migration.'
/** The one button, named for what it does: open the bridge's page, not uninstall it. */
const OPEN_BRIDGE = 'Open Bridge Extension Page'
/** Title, modality, detail and button as one object, so none of them can drift. */
const MIGRATION = { message: MIGRATION_TITLE, options: { modal: true, detail: MIGRATION_DETAIL }, items: [OPEN_BRIDGE] }

beforeEach(() => {
  vi.useFakeTimers()
  // Every case asks what one window said, so a window starts with an empty notice
  // log instead of inheriting an earlier window's.
  recorder.warnings = []
  storage = mkdtempSync(path.join(tmpdir(), 'dsh-activation-'))
  context = {
    subscriptions: [],
    extensionPath: repo,
    extensionUri: { fsPath: repo },
    globalStorageUri: { fsPath: storage, scheme: 'file', path: storage },
    extension: {
      id: 'system-sciences.vllm-copilot',
      extensionUri: { fsPath: repo },
      packageJSON: JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')),
    },
    globalState: { get: () => undefined, update: async () => {} },
    workspaceState: { get: () => undefined, update: async () => {} },
  }
})

afterEach(() => {
  for (const item of context.subscriptions) item?.dispose?.()
  vi.useRealTimers()
  rmSync(storage, { recursive: true, force: true })
})

describe('a window that activated before the harness existed', () => {
  it('creates no harness folder, shows no pill, and arms no timer', async () => {
    await activateHarness(context)
    expect(existsSync(path.join(storage, 'dsh-home'))).toBe(false)
    expect(recorder.pill.shown).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(rows()).toEqual(PITCH_ROWS)
  })
  it('says nothing to a window whose retired bridge was never installed', async () => {
    await activateHarness(context)
    // The notice is driven by the bridge's presence alone. Absent, the window
    // stays silent, so no ordinary window ever meets a blocking dialog.
    expect(recorder.warnings).toEqual([])
  })

  it('shows another window install once this window regains focus', async () => {
    await activateHarness(context)
    setInstalled(true)
    focus()
    expect(recorder.refreshes).toBeGreaterThan(0)
    expect(recorder.pill.shown).toBe(true)
    expect(recorder.pill.text).toContain('DSH: stopped')
    const listed = rows()
    expect(listed[0]).toBe('Open Harness')
    expect(listed.at(-1)).toBe('Uninstall Harness')
    expect(listed.length).toBe(harnessCommands + 1)
    // Reading the stamp starts and installs nothing: no progress card, no
    // version picker, and the pill says stopped, not starting.
    expect(recorder.progress).toBe(0)
    expect(recorder.quickPicks).toBe(0)
    // A second focus must not stack a second ingest timer on one install.
    focus()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('loses the pill and the ingest timer when the other window uninstalls', async () => {
    await activateHarness(context)
    setInstalled(true)
    focus()
    expect(recorder.pill.shown).toBe(true)
    setInstalled(false)
    focus()
    expect(recorder.pill.shown).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(rows()).toEqual(PITCH_ROWS)
  })

  it('promises the Node version the certified metadata requires', async () => {
    await activateHarness(context)
    const [, install] = recorder.treeProvider.getChildren()
    const stated = String(JSON.parse(readFileSync(path.join(repo, 'dsh', 'dsh.json'), 'utf8')).requiresNode)
    expect(stated).toMatch(/^>=\d+\.\d+\.\d+$/)
    expect(String(install.tooltip.value)).toContain(`Node.js ${stated.slice(2)} or newer`)
  })

  it('ignores a window that merely lost focus', async () => {
    await activateHarness(context)
    setInstalled(true)
    recorder.refreshes = 0
    fire('onDidChangeWindowState', { focused: false })
    expect(recorder.refreshes).toBe(0)
    expect(recorder.pill.shown).toBe(false)
  })

  it('stops listening once the window is deactivated', async () => {
    await activateHarness(context)
    edges.stopped.mockClear()
    for (const item of context.subscriptions) item?.dispose?.()
    await settle()
    expect(recorder.listeners.onDidChangeWindowState ?? []).toEqual([])
    // The disarmed supervisor is the object the bridge really holds: the
    // disposer's stop landed on it, and a harness that never launched stops as
    // harmlessly as it started. A rejection here would be an unhandled one,
    // thrown by a teardown the product runs on every window close.
    expect(edges.stopped).toHaveBeenCalledTimes(1)
    setInstalled(true)
    focus()
    expect(recorder.pill.shown).toBe(false)
  })
})

describe('the retired bridge extension still installed', () => {
  beforeEach(async () => {
    recorder.oldBridge = { id: OLD_BRIDGE_ID, packageJSON: { version: '0.1.6' } }
    await activateHarness(context)
  })

  afterEach(() => {
    recorder.oldBridge = undefined
  })

  it('notices the migration as a modal the moment the window activates', () => {
    // `beforeEach` activated the window and nothing cleared its notices, so this
    // is what a bridge user meets on activation: a dialog, not a toast beside the
    // tray, which is the notice users reported never seeing.
    expect(recorder.warnings).toEqual([MIGRATION])
  })

  it('refuses Start before any prerequisite probe or progress card', async () => {
    clearNotices()
    await runCommand('vllm-copilot.harness.start')
    expect(recorder.warnings).toEqual([MIGRATION])
    expect(recorder.quickPicks).toBe(0)
    expect(recorder.progress).toBe(0)
    // Asked nothing, prepared nothing: no prerequisite probe (passing or not),
    // no npm runtime, no launched process.
    expect(edges.preflight).not.toHaveBeenCalled()
    expect(edges.runtime).not.toHaveBeenCalled()
    expect(edges.started).not.toHaveBeenCalled()
    expect(recorder.errors).toEqual([])
    expect(existsSync(path.join(storage, 'dsh-home'))).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(recorder.pill.shown).toBe(false)
  })

  it('refuses Install or Update before the version picker', async () => {
    clearNotices()
    await runCommand('vllm-copilot.harness.installOrUpdate')
    expect(recorder.warnings).toEqual([MIGRATION])
    expect(recorder.quickPicks).toBe(0)
    expect(recorder.progress).toBe(0)
    expect(edges.preflight).not.toHaveBeenCalled()
    expect(edges.runtime).not.toHaveBeenCalled()
    expect(edges.started).not.toHaveBeenCalled()
    expect(recorder.errors).toEqual([])
    expect(existsSync(path.join(storage, 'dsh-home'))).toBe(false)
  })

  it('opens the bridge extension page when its button is pressed, and nothing else', async () => {
    clearNotices()
    recorder.warningReply = OPEN_BRIDGE
    await runCommand('vllm-copilot.harness.start')
    expect(edges.preflight).not.toHaveBeenCalled()
    expect(recorder.warnings).toEqual([MIGRATION])
    await settle()
    // `setContext` is the palette state every render writes. Past it, one command
    // fires: the retired extension's own page, where the user presses Uninstall.
    // No uninstall and no reload runs here, and never this extension's page, which
    // the bridge declares a dependency on.
    expect(recorder.executed.filter(([name]) => name !== 'setContext')).toEqual([['extension.open', OLD_BRIDGE_ID]])
    expect(recorder.errors).toEqual([])
  })

  it('does nothing when the notice is dismissed', async () => {
    clearNotices()
    await runCommand('vllm-copilot.harness.start')
    expect(recorder.warnings).toEqual([MIGRATION])
    await settle()
    expect(recorder.executed.filter(([name]) => name !== 'setContext')).toEqual([])
    expect(edges.runtime).not.toHaveBeenCalled()
    expect(edges.started).not.toHaveBeenCalled()
  })
})

/** One configured server and one model on it: what the harness needs to exist. */
const SERVER = { id: 'local', serverUrl: 'http://127.0.0.1:8001/v1' }
const MODEL = { id: 'm1', server: 'local', displayName: 'Test Model' }
/** The one button the setup offer gets, straight out of `harness.ts`. */
const SETUP = 'Configure a server and model…'
/** The one sentence the setup offer shows, asserted exactly so it cannot drift. */
const SETUP_MESSAGE = 'The DeepSeek Harness needs a model with a configured server. Configure one to continue.'

describe('a harness with nothing to run on', () => {
  beforeEach(async () => {
    await activateHarness(context)
  })

  /** Nothing at all may happen beyond the offer: no probe, no picker, no bytes. */
  function assertNoHarnessWork(errorsExpected = false) {
    expect(edges.preflight).not.toHaveBeenCalled()
    expect(edges.runtime).not.toHaveBeenCalled()
    expect(edges.started).not.toHaveBeenCalled()
    expect(recorder.quickPicks).toBe(0)
    expect(recorder.progress).toBe(0)
    if (!errorsExpected) expect(recorder.errors).toEqual([])
    expect(existsSync(path.join(storage, 'dsh-home'))).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(recorder.pill.shown).toBe(false)
  }

  it('offers the existing setup wizard before it probes, asks or downloads', async () => {
    clearNotices()
    await runCommand('vllm-copilot.harness.installOrUpdate')
    expect(recorder.warnings).toEqual([{ message: SETUP_MESSAGE, items: [SETUP] }])
    assertNoHarnessWork()
  })

  it('does nothing when the offer is dismissed', async () => {
    clearNotices()
    await runCommand('vllm-copilot.harness.start')
    expect(recorder.warnings).toHaveLength(1)
    // No button clicked, so the shipped wizard was never launched.
    expect(recorder.executed.filter(([name]) => name === 'vllm-copilot.addServerModel')).toEqual([])
    assertNoHarnessWork()
  })

  it('resumes the install it was asked for once the wizard configures a model', async () => {
    clearNotices()
    recorder.warningReply = SETUP
    recorder.wizard = async () => {
      recorder.registry = { servers: [SERVER], models: [MODEL] }
    }
    await runCommand('vllm-copilot.harness.installOrUpdate')
    expect(recorder.executed.filter(([name]) => name === 'vllm-copilot.addServerModel')).toEqual([
      ['vllm-copilot.addServerModel'],
    ])
    expect(recorder.errors).toEqual([])
    expect(recorder.infos).toEqual([])
    // Past the guard, into the version choice the user actually asked for; the
    // picker is dismissed here, so nothing is downloaded and no progress card opens.
    expect(edges.preflight).toHaveBeenCalledTimes(1)
    expect(recorder.quickPicks).toBe(1)
    expect(recorder.progress).toBe(0)
    expect(edges.runtime).not.toHaveBeenCalled()
  })

  it('stops cleanly when the wizard ends without a usable model', async () => {
    clearNotices()
    recorder.warningReply = SETUP
    // A server and no model: exactly the half-configured registry that must not
    // be waved through, and exactly what the wizard leaves when it is cancelled.
    recorder.wizard = async () => {
      recorder.registry = { servers: [SERVER], models: [] }
    }
    await runCommand('vllm-copilot.harness.installOrUpdate')
    expect(recorder.warnings).toHaveLength(1)
    // One honest sentence, and not the success-shaped one the real install ends with.
    expect(recorder.infos).toEqual([
      'No usable model was configured, so the DeepSeek Harness will not be installed yet.',
    ])
    assertNoHarnessWork()
  })

  it('refuses a registry whose model points at a server that is gone', async () => {
    for (const unusable of [
      { servers: [], models: [MODEL] },
      { servers: [{ id: 'other', serverUrl: 'http://127.0.0.1:9/v1' }], models: [MODEL] },
      { servers: [SERVER], models: [{ id: 'm2', server: 'gone' }] },
      // The model names this very server, so only the missing URL can reject it.
      { servers: [{ id: 'local' }], models: [MODEL] },
    ]) {
      clearNotices()
      recorder.registry = unusable
      await runCommand('vllm-copilot.harness.start')
      expect(recorder.warnings, JSON.stringify(unusable)).toEqual([{ message: SETUP_MESSAGE, items: [SETUP] }])
      assertNoHarnessWork()
    }
  })

  it('refuses Restart with the same offer, not a stop and a raw snapshot error', async () => {
    clearNotices()
    await runCommand('vllm-copilot.harness.restart')
    expect(recorder.warnings).toEqual([{ message: SETUP_MESSAGE, items: [SETUP] }])
    // bridge.restart() stops before it starts, so a stop attempt here means the
    // guard was bypassed and the bridge is already tearing something down.
    expect(edges.stopped).not.toHaveBeenCalled()
    assertNoHarnessWork()
  })

  it('explains a configuration that cannot be re-read once the wizard is done', async () => {
    clearNotices()
    recorder.warningReply = SETUP
    recorder.wizard = async () => {
      recorder.registryThrows = new Error('the settings store refused to answer')
    }
    await runCommand('vllm-copilot.harness.start')
    expect(recorder.errors).toEqual([
      {
        message: expect.stringMatching(/could not re-read your vLLM-Copilot servers and models/),
        items: ['Show Log'],
      },
    ])
    // "the wizard finished and then nothing happened" is what this rules out.
    expect(recorder.infos).toEqual([])
    assertNoHarnessWork(true)
  })

  it('leaves a configured user exactly the flow they had', async () => {
    clearNotices()
    recorder.registry = { servers: [SERVER], models: [MODEL] }
    await runCommand('vllm-copilot.harness.installOrUpdate')
    expect(recorder.warnings).toEqual([])
    expect(recorder.infos).toEqual([])
    expect(edges.preflight).toHaveBeenCalledTimes(1)
    expect(recorder.quickPicks).toBe(1)
  })

  it('answers the retired bridge first, model or no model', async () => {
    clearNotices()
    recorder.oldBridge = { id: OLD_BRIDGE_ID, packageJSON: { version: '0.1.6' } }
    await runCommand('vllm-copilot.harness.installOrUpdate')
    recorder.oldBridge = undefined
    expect(recorder.warnings).toEqual([MIGRATION])
    assertNoHarnessWork()
  })
})


describe('activation consent reconciliation (survivor harness)', () => {
  it('re-asserts an OFF setting over a stale ON marker', async () => {
    // A harness survived from before this window; the user switched recording
    // off while the extension was closed. Activation must correct the marker
    // before anything can adopt that survivor.
    const vllmc = path.join(storage, 'dsh-home', 'vllmc')
    mkdirSync(vllmc, { recursive: true })
    writeFileSync(path.join(vllmc, 'capture.flag'), 'on', 'utf8')
    await activateHarness(context)
    expect(readFileSync(path.join(vllmc, 'capture.flag'), 'utf8')).toBe('off')
  })

  it('says so loudly when the stale marker refuses to flip off', async () => {
    const vllmc = path.join(storage, 'dsh-home', 'vllmc')
    mkdirSync(path.join(vllmc, 'capture.flag'), { recursive: true }) // a DIRECTORY refuses the write
    await activateHarness(context)
    expect(recorder.warnings.some((w) => w.message.includes('could not be set to "off"'))).toBe(true)
  })
})
