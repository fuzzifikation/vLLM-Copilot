/**
 * Editor glue. Everything with an `import * as vscode` lives here, in
 * `settings.ts`, or in `editor-tools.ts` (the MCP tool implementations),
 * which is what keeps the bridge's logic testable in plain node.
 */
import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { Bridge } from './bridge.js'
import { bridgePaths, ensureBridgeDirs } from './paths.js'
import { acquireStartLock } from './start-lock.js'
import { INSTALL_STAMP_FILE, isSafeVersionSpec } from './runtime.js'
import { readPidRecord, probeHarness } from './supervisor.js'
import { deletableWithin, directorySize, formatBytes } from './disk.js'
import { spawn } from 'node:child_process'
import { ControlServer } from './control-server.js'
import { EmbedProxy } from './embed-proxy.js'
import { createEditorTools } from './editor-tools.js'
import { readBridgeSettings } from './settings.js'
import { drainActiveRequests } from './ingest.js'
import { originAnswers, readServedHostPorts, servedUrlsFile } from './served-urls.js'
import { runPreflight, type PrereqCheck } from './preflight.js'
import { getConfig } from '../state/config.js'
import { resolveModelReplacements } from '../state/personalityStore.js'
import { recordExternalRequests } from '../state/externalUsage.js'

const RESTART_DEBOUNCE_MS = 1500
/** Deactivate must not hold the extension host hostage, unlike a deliberate restart. */
const SHUTDOWN_DRAIN_BUDGET_MS = 5000
/**
 * One setup offer per install, surviving window reloads and extension updates
 * (globalState outlives both). The offer is the only automatic word a fresh
 * install gets; every later start is the user's own.
 */
const ONBOARDED_KEY = 'vllm-copilot.harness.setupOffered'
/**
 * Bridge settings the harness reads at boot, so changing one means a restart.
 * Everything else (`drainTimeoutSeconds` is read per stop, `ingestIntervalSeconds`
 * just re-arms a timer) must never cut a live turn.
 */
const BRIDGE_RESTART_KEYS = ['defaultModelId', 'titleModel', 'titleMaxTokens', 'compactionModel', 'compactionMaxTokens', 'dshVersion'] as const

let output: vscode.LogOutputChannel | undefined

function log(): vscode.LogOutputChannel {
  if (!output) {
    output = vscode.window.createOutputChannel('DeepSeek Harness', { log: true })
    applyLogLevel()
  }
  return output
}

/**
 * The developer’s lens, one built-in switch from complete. The Debug-tier
 * emissions (harness stdout/stderr mirrors in the supervisor, MCP method and
 * tool-call names in the control server) are ALWAYS emitted and the channel’s
 * own level gates them — VS Code exposes no programmatic setter (
 * `LogOutputChannel.logLevel` is read-only as of 1.140) and the per-channel
 * picker persists the choice. This setting records the intent, reveals the
 * channel, and names the picker once, so the only unobvious step in turning
 * the verbosity up disappears.
 */
function applyLogLevel(): void {
  if (!output) return
  const setting = vscode.workspace.getConfiguration('vllm-copilot.harness').get<string>('logLevel', 'info')
  if ((setting === 'debug' || setting === 'trace') && output.logLevel > vscode.LogLevel.Debug) {
    output.show(false)
    output.info(
      `vllm-copilot.harness.logLevel is "${setting}", but this channel currently hides Debug lines. ` +
        'Use the gear control ("Set Log Level…") at the top of this Output channel and pick Debug ' +
        '(the choice persists); harness stdout/stderr mirrors and MCP tool-call lines appear immediately.',
    )
  }
}
let embed: EmbedProxy | undefined
let embedStart: Promise<string> | undefined
const harnessPanels = new Set<vscode.WebviewPanel>()
let panelProxyUrl: string | undefined
let panelHarnessUrl: string | undefined
/** The live harness URL as last seen, so a revived tab reconnects even when the serializer races the first render. */
let knownHarnessUrl: string | undefined

/** The embed proxy is lazy: only a panel or app-window open needs its door. */
function ensureEmbed(): Promise<string> {
  embed ??= new EmbedProxy({
    port: vscode.workspace.getConfiguration('vllm-copilot.harness').get<number>('embedPort', 43171),
    log: log(),
    onTitle: (view, title) => {
      for (const panel of harnessPanels) {
        if (panelViewIds.get(panel) === view) {
          setPanelTitle(panel, title, view)
          return
        }
      }
      log().debug?.(`embed title beacon for an unknown view (${view})`) 
    },
    onKey: (chord) => {
      void runBridgeKey(chord)
    },
  })
  embedStart ??= embed.listen().catch((err: Error) => {
    embedStart = undefined
    throw err
  })
  return embedStart
}

/**
 * The address a CLIENT-side surface (webview Chromium, external browser,
 * built-in browser view) can actually reach for a server-side loopback URL.
 * In a local window asExternalUri echoes it back; in remote SSH/WSL windows
 * it is the port-forwarded address, and calling it is what asks the workbench
 * to hold that tunnel open. The remote black-panel bug of 2026-11-12 was
 * exactly a panel aimed at the SERVER's 127.0.0.1 from the CLIENT's Chromium.
 */
async function toExternal(url: string): Promise<string> {
  try {
    const ext = await vscode.env.asExternalUri(vscode.Uri.parse(url))
    return ext.toString().replace(/\/+$/, '')
  } catch (err) {
    // Origin only: the harness URL carries its token, and logs are for strangers.
    const safe = (() => {
      try {
        return vscode.Uri.parse(url).authority
      } catch {
        return 'an unparseable URL'
      }
    })()
    log().warn(`could not resolve an external address for ${safe}: ${(err as Error).message}`)
    return url.replace(/\/+$/, '')
  }
}

/** Aim the proxy at a harness URL and hand back its stable root (undefined on failure). */
async function embedRootFor(url: string): Promise<string | undefined> {
  try {
    const root = await ensureEmbed()
    embed?.setTarget(url)
    const shown = await toExternal(root)
    embed?.allowOrigin(shown)
    return shown
  } catch (err) {
    log().warn(`embed proxy did not start: ${(err as Error).message}`)
    return undefined
  }
}

/**
 * The panel shell. The CSP admits exactly one frame source — the proxy —
 * and the src carries no secret: the proxy holds the harness session, so
 * nothing token-bearing ever enters the browser or its history.
 */
/**
 * Chords the frame may hand to the workbench, and only these. The frame
 * forwards a modifier chord only when its own handlers did not call
 * preventDefault, so DSH keeps every shortcut it actually implements —
 * this list is only what the harness leaves on the table. VS Code 1.145
 * dropped the webview keyboard protocol, so the extension executing the
 * command directly is the road that exists.
 */
const KEYBOARD_BRIDGE: Record<string, string> = {
  F1: 'workbench.action.showCommands',
  'Ctrl+Shift+P': 'workbench.action.showCommands',
  'Cmd+Shift+P': 'workbench.action.showCommands',
  'Ctrl+P': 'workbench.action.quickOpen',
  'Cmd+P': 'workbench.action.quickOpen',
  'Ctrl+B': 'workbench.action.toggleSidebarVisibility',
  'Cmd+B': 'workbench.action.toggleSidebarVisibility',
  'Ctrl+Shift+E': 'workbench.view.explorer',
  'Cmd+Shift+E': 'workbench.view.explorer',
  'Ctrl+Shift+F': 'workbench.view.search',
  'Cmd+Shift+F': 'workbench.view.search',
  'Ctrl+Comma': 'workbench.action.openSettings',
  'Cmd+Comma': 'workbench.action.openSettings',
  'Ctrl+W': 'workbench.action.closeActiveEditor',
  'Cmd+W': 'workbench.action.closeActiveEditor',
}

/** Two roads report one press (postMessage and the proxy fetch); the
 * whitelist executes it once. */
const lastChordExecuted = new Map<string, number>()

async function runBridgeKey(chord: string): Promise<void> {
  if (!vscode.workspace.getConfiguration('vllm-copilot.harness').get<boolean>('keyboardBridge', true)) return
  const cmd = KEYBOARD_BRIDGE[chord]
  if (!cmd) return
  const now = Date.now()
  if (now - (lastChordExecuted.get(chord) ?? 0) < 800) return
  lastChordExecuted.set(chord, now)
  // Info, not debug: a shortcut press is a user event, and doctrine says a
  // fragile hop earns a log at its receiving end that survives the default
  // log level. "Nothing in the log" must mean "nothing arrived", never
  // "the log was filtered".
  log().info(`keyboard bridge: ${chord} -> ${cmd}`)
  try {
    await vscode.commands.executeCommand(cmd)
  } catch (err) {
    log().warn(`keyboard bridge: ${cmd} failed: ${(err as Error).message}`)
  }
}

function harnessPanelHtml(root: string, view = ''): string {
  const src = view ? `${root}/?dshView=${view}` : `${root}/`
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${root}; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`,
    '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style>',
    '</head><body><iframe src="' + src + '" allow="clipboard-read; clipboard-write"></iframe>',
    // The proxy stamps a title beacon into the harness page carrying this
    // view's id; the beacon reports two ways (parent.postMessage here AND a
    // same-origin POST to the proxy), because a webview is exactly where you
    // stop trusting any single messaging route. Either one renames the tab.
    '<script>',
    'const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null',
    'window.addEventListener("message", (e) => { const d = e.data; if (api && d && (typeof d.dshEmbedTitle === "string" || typeof d.dshKey === "string")) api.postMessage(d) })',
    '</script></body></html>',
  ].join('')
}

/** Which beacon belongs to which panel: a per-load id the shell carries in the iframe src. */
const panelViewIds = new WeakMap<vscode.WebviewPanel, string>()

function repaintHarnessPanels(root: string): void {
  for (const panel of harnessPanels) panel.webview.html = harnessPanelHtml(root, panelViewIds.get(panel) ?? '')
  panelProxyUrl = root
}

/**
 * 'Session — DeepSeek Harness' is what the GUI stamps into document.title
 * (dsh-client-ui-layout). Keep the session, drop the product, prefix ours.
 */
function setPanelTitle(panel: vscode.WebviewPanel, raw: string, view: string): void {
  const t = raw.trim()
  if (!t) return
  const session = (t.includes(' \u2014 ') ? t.split(' \u2014 ').slice(0, -1).join(' \u2014 ').trim() : t) || t
  const next = `DSH \u2014 ${session.slice(0, 80)}`
  if (panel.title !== next) {
    panel.title = next
    log().debug?.(`harness view (${view}) titled: ${next}`)
  }
}

function showHarnessPanel(root: string, fresh: boolean): void {
  if (!fresh) {
    const first = harnessPanels.values().next().value as vscode.WebviewPanel | undefined
    if (first) {
      if (panelProxyUrl !== root) repaintHarnessPanels(root)
      first.reveal()
      return
    }
  }
  // The harness session-multiplexes, so a second view is a full GUI on the
  // same bus: its own tab, its own session selection, splittable and movable
  // into a window of its own like any editor.
  const panel = vscode.window.createWebviewPanel(
    'vllm-copilot.harnessPanel',
    'DSH Harness',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  )
  adoptHarnessPanel(panel, root)
  panelProxyUrl = root
}

/**
 * One adoption path for both doors into the set: fresh creation and VS Code's
 * revival of a tab a previous window session left behind. Revived tabs arrive
 * empty; they get the proxy frame when the harness is reachable (or as soon as
 * render() reports its URL) and an honest waiting card until then.
 */
function adoptHarnessPanel(panel: vscode.WebviewPanel, root?: string): void {
  const view = randomUUID().slice(0, 8)
  panelViewIds.set(panel, view)
  panel.iconPath = new vscode.ThemeIcon('rocket')
  panel.webview.html =
    root
      ? harnessPanelHtml(root, view)
      : '<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:var(--vscode-font-family, sans-serif);color:var(--vscode-descriptionForeground, #888);padding:2.5rem">Waiting for the harness. Open it via the DSH status item or run \u201cDeepSeek Harness: Start Harness\u201d \u2014 this view reconnects by itself.</body></html>'
  panel.onDidDispose(() => {
    harnessPanels.delete(panel)
    if (harnessPanels.size === 0) panelProxyUrl = undefined
  })
  panel.webview.onDidReceiveMessage((message: { dshEmbedTitle?: unknown; dshKey?: unknown }) => {
    const chord = typeof message?.dshKey === 'string' ? message.dshKey : ''
    if (chord) {
      void runBridgeKey(chord)
      return
    }
    const raw = typeof message?.dshEmbedTitle === 'string' ? message.dshEmbedTitle : ''
    log().debug?.(`harness view (${view}) postMessage: ${raw}`)
    if (raw) setPanelTitle(panel, raw, view)
  })
  harnessPanels.add(panel)
  if (!root && knownHarnessUrl) {
    void embedRootFor(knownHarnessUrl).then((r) => {
      if (r && harnessPanels.has(panel)) panel.webview.html = harnessPanelHtml(r, view)
    })
  }
}
/**
 * Keep an open panel glued to the live harness. Every state transition
 * routes here; the URL guard makes it free when nothing changed. A harness
 * restart re-logs the proxy through the new token URL and reloads the frame
 * in place — the panel's own URL never moves.
 */
function syncHarnessPanel(url: string | undefined): void {
  knownHarnessUrl = url ?? knownHarnessUrl
  if (harnessPanels.size === 0 || !url || url === panelHarnessUrl) return
  panelHarnessUrl = url
  void embedRootFor(url).then((root) => {
    if (root) repaintHarnessPanels(root)
  })
}

/**
 * Chromium `--app` window: a bar-less standalone window sharing the browser
 * profile, aimed at the stable proxy root. Windows-only door; elsewhere it
 * reports the miss and the caller falls back.
 */
function openAppWindow(url: string): boolean {
  if (process.platform !== 'win32') return false
  const candidates = [
    process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['PROGRAMFILES'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
  ]
  const exe = candidates.find((c) => c && existsSync(c))
  if (!exe) return false
  try {
    const child = spawn(exe, [`--app=${url}`], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * Show the harness UI per `vllm-copilot.harness.openIn`.
 *
 * `panel` (the default) docks a chromeless webview fed by the embed proxy.
 * The naive iframe this replaces died of `SameSite=Strict` cookies in
 * 0.0.10/0.0.11 — Chromium will not carry the harness session across the
 * webview origin, and that remains true; the proxy simply moves the
 * session server-side (see `harness/embed-proxy.ts`). Never aim the panel
 * at the raw harness URL. `appWindow` opens the same stable proxy root in
 * a bar-less Chromium `--app` window. `embedded` keeps the built-in browser
 * view, toolbar and all (VS Code exposes no way to hide it; 1.140 removed
 * Simple Browser, so the probe also answers `simpleBrowser.show` for
 * older builds and VSCodium). `external`, or any door missing, ends in the
 * system browser, said out loud. The token-bearing URL only ever crosses
 * as a function argument; the panel and app window see the proxy root.
 */
async function openHarnessUrl(url: string, fresh = false): Promise<void> {
  const mode = vscode.workspace.getConfiguration('vllm-copilot.harness').get<string>('openIn', 'panel')
  if (mode === 'panel' || mode === 'appWindow') {
    const root = await embedRootFor(url)
    if (root) {
      panelHarnessUrl = url
      knownHarnessUrl = url
      if (mode === 'panel') {
        showHarnessPanel(root, fresh)
        return
      }
      if (openAppWindow(root)) return
      void vscode.window.showInformationMessage(
        'No Edge or Chrome install was found for the app-window door, so the harness opens in the built-in browser view.',
      )
    } else if (mode === 'panel') {
      void vscode.window.showInformationMessage(
        'The embed proxy could not start, so the harness opens in the built-in browser view.',
      )
    }
  }
  if (mode === 'external') {
    await vscode.env.openExternal(vscode.Uri.parse(await toExternal(url)))
    return
  }
  const commands = await vscode.commands.getCommands(true)
  const door = commands.includes('workbench.action.browser.open')
    ? 'workbench.action.browser.open'
    : commands.includes('simpleBrowser.show')
      ? 'simpleBrowser.show'
      : undefined
  if (door) {
    try {
      // The browser view lives client-side too: in a remote window it dials
      // the tunnel, never the server's loopback.
      await vscode.commands.executeCommand(door, await toExternal(url))
      return
    } catch {
      void vscode.window.showInformationMessage(
        'The embedded browser view refused to open, so the harness opens in the system browser instead.',
      )
    }
  } else {
    void vscode.window.showInformationMessage(
      'This editor build provides no embedded browser view, so the harness opens in the system browser instead.',
    )
  }
  await vscode.env.openExternal(vscode.Uri.parse(await toExternal(url)))
}

export async function activateHarness(context: vscode.ExtensionContext): Promise<void> {
  const logger = log()
  const version = String(context.extension.packageJSON.version ?? '0.0.0')
  const paths = bridgePaths(context.globalStorageUri.fsPath)
  ensureBridgeDirs(paths)

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90)
  status.command = 'vllm-copilot.harness.open'
  context.subscriptions.push(status)

  // The editor control channel: the harness's MCP client dials this loopback
  // server to reach the editor tools. Token per activation, handed to the
  // harness ONLY through the generated overlay row; never logged.
  const editorTools = createEditorTools({ disposables: context.subscriptions })
  const controlToken = randomUUID()
  let control: ControlServer | undefined
  let controlStart: Promise<string> | undefined
  function ensureControl(): Promise<string> {
    control ??= new ControlServer({
      token: controlToken,
      activeDir: paths.active,
      mcp: { tools: () => editorTools.tools(), serverInfo: { name: 'vllmc-editor', version } },
      log: logger,
    })
    controlStart ??= control.listen().catch((err: Error) => {
      controlStart = undefined
      throw err
    })
    return controlStart
  }

  // One plugin-toggle notice at a time; back-to-back toggles all land in
// the same restart, and a stack of identical cards is noise.
let profileEditNoticeOpen = false
const bridge = new Bridge({
    extensionRoot: context.extensionPath,
    extensionVersion: version,
    paths,
    log: logger,
    onProfileEdit: (file) => {
      // A plugin-page toggle: the manager persisted the change to the
      // profile, but this dsh build cannot hot-apply it, and the GUI
      // toast claims a failure that a restart will actually undo. Say so
      // plainly and offer the restart that converges.
      if (profileEditNoticeOpen) return
      profileEditNoticeOpen = true
      const adopted = bridge.supervisor.adopted
      void vscode.window
        .showInformationMessage(
          `DeepSeek Harness: ${file} changed on disk. Plugin changes are saved but cannot hot-apply; ` +
            (adopted
              ? 'the window that started this harness can restart it.'
              : 'restart now (in-flight turns are waited for).'),
          ...(adopted ? [] : ['Restart harness now']),
        )
        .then((choice) => {
          // vscode's Thenable has no finally; dismissal resolves with
          // undefined and arms the next notice just the same.
          profileEditNoticeOpen = false
          if (choice === 'Restart harness now') scheduleRestart('a plugin toggle changed the profile')
        })
    },
    dshVersion: () => readBridgeSettings().dshVersion || readBundledPin(),
    registry: async () => {
      const config = await getConfig()
      // A configured personality only reaches the harness through the
      // snapshot's `personalityFile`. `resolveModelReplacements` is the one
      // resolver the chat pipeline uses, so it answers BOTH references a model
      // can carry: a stored `systemMessageReplacementsFile` path and a
      // built-in personality stored by name in `model.personality`. The old
      // absolute-path-only lookup silently dropped every built-in.
      const personalityFiles: Record<string, string> = {}
      for (const model of config.models) {
        const resolved = await resolveModelReplacements(context, model, (message) => logger.info(message))
        if (resolved) personalityFiles[model.id] = resolved.sourcePath
      }
      return {
        servers: config.servers,
        models: config.models,
        personalityFiles,
        fixEmptyToolParameters: vscode.workspace.getConfiguration('vllm-copilot').get<boolean>('fixEmptyToolParameters'),
      }
    },
    choices: () => {
      const s = readBridgeSettings()
      return {
        defaultModelId: s.defaultModelId || undefined,
        title: s.title,
        compaction: s.compaction,
        drainTimeoutMs: s.drainTimeoutSeconds * 1000,
      }
    },
    recordUsage: recordExternalRequests,
    editorWorkspaceFolder: () => {
      const [first, second] = vscode.workspace.workspaceFolders ?? []
      if (!first) return undefined
      if (second) {
        logger.warn(`the window has multiple root folders; the harness workspace is the first one ("${first.name}")`)
      }
      return first.uri.fsPath
    },
    controlEndpoint: () => {
      const url = control?.url
      return url ? { url, token: controlToken } : undefined
    },
    progress: (message, increment) => {
      // Null unless a start is in flight: the same Bridge instance also
      // prepares behind restarts, and an unrequested notification card on a
      // config-triggered restart would be noise. The start owns the card.
      startProgress?.(message, increment)
    },
    onUnexpectedExit: (info) => {
      render()
      // The URL died with the server; a tab nobody can serve is tomorrow's
      // poisoned boot, so bury it now. The pill reopens the harness in a click.
      sweepNow()
      void vscode.window
        .showWarningMessage(
          `The DeepSeek Harness exited on its own (code ${info.code}, signal ${info.signal}). The vLLM-Copilot log has the last output.`,
          'Show Log',
          'Restart Harness',
        )
        .then((choice) => {
          if (choice === 'Show Log') void output?.show()
          if (choice === 'Restart Harness') void guardedStart()
        })
    },
  })

  function readBundledPin(): string {
    // The certified version lives in exactly one file, the same one the node
    // rails read. The setting overrides it; nothing else duplicates it. An
    // unreadable pin aborts the start: quietly booting whatever npm calls
    // "latest" would run an uncertified dsh against overlays certified
    // against a different composition, the exact drift the pin exists to stop.
    try {
      const raw = readFileSync(path.join(context.extensionPath, 'dsh', 'dsh.json'), 'utf8')
      const pinned = String((JSON.parse(raw) as { pinned?: string }).pinned ?? '')
      if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pinned)) {
        throw new Error(`dsh/dsh.json carries no exact pinned version (got ${JSON.stringify(pinned)})`)
      }
      return pinned
    } catch (err) {
      const message = (err as Error).message
      logger.error(`the bundled dsh pin is unreadable: ${message}`)
      throw new Error(`cannot start the harness: the certified dsh pin in dsh/dsh.json is unreadable (${message}); refusing to fall back to an uncertified "latest"`)
    }
  }

  // Declared before render(): the pill reads this promise to show the
  // starting state, and render() runs at activation, before any start.
  let starting: Promise<string | undefined> | undefined
  // The active start's progress card, if any: bridge phases land here while
  // guardedStart holds the notification open.
  let startProgress: ((message: string, increment?: number) => void) | undefined

  function render(): void {
    const active = bridge.activeRequests()
    // A panel (or app window) outliving a harness restart is the norm:
    // re-aim the proxy and reload it in place whenever the URL moved.
    syncHarnessPanel(bridge.supervisor.url)
    // The palette reflects reality. Start hides itself while the harness runs,
    // and nothing offers "Open" before there is a URL to open.
    void vscode.commands.executeCommand('setContext', 'vllm-copilot.harness.running', bridge.supervisor.running)
    // The stamp file is the whole truth about "installed": it is written by
    // tmp+rename only after npm reported the runtime tree complete, and the
    // uninstall deletes the directory holding it. The palette offers Uninstall
    // exactly when there is something to uninstall.
    void vscode.commands.executeCommand('setContext', 'vllm-copilot.harness.installed', existsSync(path.join(paths.runtime, INSTALL_STAMP_FILE)))
    if (bridge.supervisor.running) {
      status.text = `$(vllm-copilot-dsh) DSH${active ? ` $(zap)${active}` : ''}`
      status.tooltip = new vscode.MarkdownString(
        [
          `**DeepSeek Harness: running**`,
          '',
          `URL: \`${bridge.supervisor.url ? bridge.supervisor.url.replace(/\?.*$/, '?<token redacted>') : 'unknown'}\``,
          `In-flight requests: ${active}`,
          bridge.preparedInfo ? `dsh ${bridge.preparedInfo.dshVersion}, core ${bridge.preparedInfo.coreVersion}` : '',
          bridge.preparedInfo ? `privacy rows disabled: ${bridge.preparedInfo.rowsDisabled}` : '',
          '',
          'Click to open the harness.',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      status.backgroundColor = undefined
      // Re-arm the click on every transition INTO running. The command was
      // set to "start" while stopped (below), and a stale one made the
      // running pill execute a no-op Start: the tooltip said "click to
      // open" and the click opened nothing, silently, because starting an
      // already-running harness returns its URL. Every field render claims
      // must be written by every branch that displays it.
      status.command = 'vllm-copilot.harness.open'
      return
    }
    if (starting) {
      // A cold first run installs the dsh runtime and the profile with pnpm
      // before anything can listen; two-plus minutes of "stopped" reads as
      // death. Say what is happening instead of gaslighting the user.
      status.text = '$(sync~spin) DSH: starting'
      status.tooltip = new vscode.MarkdownString([
        '**DeepSeek Harness: starting**',
        '',
        'The first run after an install downloads and installs the harness once.',
        'That takes a few minutes; later starts take seconds.',
        'Progress: "DeepSeek Harness" output channel.',
      ].join('\n'))
      status.command = 'vllm-copilot.harness.start'
      status.backgroundColor = undefined
      return
    }
    status.text = '$(vllm-copilot-dsh-off) DSH: stopped'
    status.tooltip = 'The DeepSeek Harness is not running. Click to start it.'
    status.command = 'vllm-copilot.harness.start'
  }
  render()
  status.show()

  /**
   * Stale embedded tabs kill the window's menus, and the harness manufactures
   * them by design: port and token are reissued every boot, so a harness tab
   * restored after a restart can never connect. In VS Code 1.140 the browser
   * tab is a native Electron child view, and a restored fail-load one breaks
   * the window's menu layer (owner-reproduced 2026-10-11: tab open across a
   * restart equals dead menus; closing the tab afterwards does NOT heal the
   * menus, only a window reload does; upstream sibling
   * microsoft/vscode#317715). The bridge cannot prevent the restore and
   * cannot heal the latched damage, so this sweep is prevention for future
   * boots, executed the moment the bridge wakes: it closes exactly its own
   * zombies, and a closed tab is never restored. Nothing else is ever
   * touched: tabs match on loopback host:ports we ourselves served, and
   * never while the origin answers anything.
   */
  async function sweepStaleTabs(): Promise<number> {
    const hostPorts = readServedHostPorts(servedUrlsFile(paths.vllmc))
    let closed = 0
    for (const hostPort of hostPorts) {
      for (;;) {
        if (!tabGroupShowing(hostPort)) break
        if (await originAnswers(hostPort)) {
          logger.info(`keeping the browser tab on ${hostPort}: something answers there now`)
          break
        }
        if (!(await closeStaleTab(hostPort))) {
          logger.warn(`could not close the stale harness tab on ${hostPort}: close it by hand, then reload the window to bring its menus back`)
          break
        }
        closed += 1
        logger.info(`closed the stale harness tab on ${hostPort}: its URL died with the last session`)
      }
    }
    if (closed)
      logger.info(
        `stale-tab sweep: closed ${closed} dead harness tab(s); the next session starts clean, and if this window's menus are hidden, one "Developer: Reload Window" brings them back`,
      )
    return closed
  }

  /** Browser tabs carry the origin as label, so `127.0.0.1:port` IS the match. */
  function tabGroupShowing(label: string): vscode.TabGroup | undefined {
    for (const group of vscode.window.tabGroups.all) {
      if (group.tabs.some((tab) => tab.label === label)) return group
    }
    return undefined
  }

  /**
   * 1.140 ships no command that closes one NAMED tab (`workbench.action.closeTabs`
   * is absent from the build, verified against every bundle chunk), so the
   * close walks to the tab: cycle groups until the target's group is active,
   * cycle tabs inside it until the target is active, close the active editor.
   * Focus is a suggestion, not a promise, so reality is re-read after every
   * step and the walk is bounded. This dance is Microsoft's fault, not ours.
   */
  async function closeStaleTab(label: string): Promise<boolean> {
    const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    for (let step = 0; step < 24; step += 1) {
      const group = tabGroupShowing(label)
      if (!group) return true
      const active = vscode.window.tabGroups.activeTabGroup
      if (active.viewColumn === group.viewColumn && active.activeTab?.label === label) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
        await nap(400)
      } else {
        await vscode.commands.executeCommand(
          active.viewColumn === group.viewColumn ? 'workbench.action.nextEditorInGroup' : 'workbench.action.focusNextGroup',
        )
        await nap(60)
      }
    }
    return !tabGroupShowing(label)
  }

  /** Fire the sweep without ever blocking or rejecting a caller. */
  function sweepNow(): void {
    void sweepStaleTabs().catch((err: Error) => logger.warn(`stale-tab sweep failed: ${err.message}`))
  }

  // The sweep runs before anything else spends time: every second a fail-load
  // view sits in the window is a second the user cannot open a menu.
  sweepNow()

  /**
   * Shutdown variant: close this window's harness tabs whether or not the
   * origin still answers, because no server will own that URL in the NEXT
   * session, and only a tab that was never restored cannot poison a boot.
   * Best effort: the host may not wait for the focus walk, and whatever
   * survives is exactly what the next activation's sweep was built for.
   */
  async function closeOwnEmbeddedTabs(): Promise<void> {
    for (const hostPort of readServedHostPorts(servedUrlsFile(paths.vllmc))) {
      for (;;) {
        if (!tabGroupShowing(hostPort)) break
        if (!(await closeStaleTab(hostPort))) break
        logger.info(`closed the harness tab on ${hostPort} before shutdown: dead URLs must not survive into the next session`)
      }
    }
  }

  /**
   * Machine prerequisites, asked once per window. The extension host's PATH is
   * frozen when the editor launches, so a fix performed mid-session is
   * invisible until a restart anyway: caching the first answer cannot go
   * stale, and no start pays for the probes twice.
   */
  let preflightChecks: Promise<PrereqCheck[]> | undefined
  async function missingPrereqs(): Promise<PrereqCheck[]> {
    preflightChecks ??= runPreflight().then((checks) => {
      for (const check of checks) (check.ok ? logger.info : logger.warn)(`prerequisite ${check.name}: ${check.summary}`)
      return checks
    })
    return (await preflightChecks).filter((check) => !check.ok)
  }

  /**
   * The ask. Every missing prerequisite gets its own sentence and its own
   * fix (a fixes[0]-only message swallowed the pnpm line whenever node was
   * missing too), and a machine-installable command is offered for COPYING,
   * never executed: installing tools on the machine stays the human's call
   * (owner ruling 2026-11-12). After the fix, the editor restart is not
   * folklore; the host's PATH is frozen at launch.
   */
  function announceMissingPrereqs(missing: PrereqCheck[], verb: string): void {
    const sentences = missing.map((check) => `${check.summary}. ${check.fix ?? ''}`.trim()).join(' ')
    const copyables = missing.filter((check) => check.command)
    const copyLabel = (check: PrereqCheck): string => `Copy: ${check.command}`
    void vscode.window
      .showErrorMessage(`The DeepSeek Harness cannot ${verb} on this machine: ${sentences}`, ...copyables.map(copyLabel), 'Show Log')
      .then((choice) => {
        if (choice === 'Show Log') void output?.show()
        const picked = copyables.find((check) => copyLabel(check) === choice)
        if (picked?.command) void vscode.env.clipboard.writeText(picked.command)
      })
  }

  async function guardedStart(): Promise<string | undefined> {
    if (bridge.supervisor.running && bridge.supervisor.url) return bridge.supervisor.url
    // Prerequisites are named before any download starts. Without this gate a
    // missing npm surfaced as cmd.exe's "not recognized as an internal or
    // external command" inside a start failure, and a Node older than dsh's
    // engine floor installed the whole tree before dying downstream.
    const missing = await missingPrereqs()
    if (missing.length) {
      announceMissingPrereqs(missing, 'start')
      return undefined
    }
    // Best effort: a harness whose control channel failed to start still
    // runs; its agent simply never sees the editor tools (the MCP client
    // cannot dial a dead endpoint and mounts nothing).
    await ensureControl().catch((err: Error) => logger.warn(`editor control channel did not start: ${err.message}`))
    // A cold start installs an npm runtime and a pnpm profile: minutes. The
    // bridge narrates each phase into this standard progress card so waiting
    // looks like working. Not cancellable: a start aborted mid-install buys
    // nothing a crashed one does not already handle (stamps make every
    // interrupted step reinstall cleanly). withProgress hands back a Thenable
    // rather than a Promise, so it gets boxed before anything chains on it.
    starting ??= Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'DeepSeek Harness', cancellable: false },
        async (progress) => {
          startProgress = (message, increment) =>
            progress.report(increment === undefined ? { message } : { message, increment })
          try {
            const url = await bridge.start()
            // A start that completed IS the setup offer's acceptance, whether
            // it came from the button, the pill or the palette.
            void context.globalState.update(ONBOARDED_KEY, true)
            return url
          } finally {
            startProgress = undefined
          }
        },
      ),
    )
      .catch((err: Error) => {
        logger.error(`harness failed to start: ${err.message}`)
        void vscode.window.showErrorMessage(`DeepSeek Harness failed to start: ${err.message}`, 'Show Log').then((choice) => {
          if (choice === 'Show Log') void output?.show()
        })
        return undefined
      })
      .finally(() => {
        starting = undefined
        render()
      })
    // The pill only learns about the flight if we paint it now; the finally
    // above repaints when it lands.
    render()
    return starting
  }

  /**
   * Registry edits must reach the harness, and the harness reads its config at
   * boot, so an edit means a restart. The restart drains first: a user who
   * tweaks a model while a turn is in flight must not watch that turn die.
   *
   * Auto-restart is the spawning window's job alone. Every window hears the
   * same configuration event, and a borrowing window that restarted would
   * tree-kill the harness it does not own, while the concurrent stop and
   * DSH_HOME sweep of two windows can cut down a freshly respawned harness
   * mid-boot. The owner window hears the same event and performs the swap.
   */
  let pendingRestart: NodeJS.Timeout | undefined
  function scheduleRestart(reason: string): void {
    if (!bridge.supervisor.running) {
      // A boot in flight reads its settings at prepare time; a change landing
      // mid-start would otherwise be swallowed until the NEXT edit, leaving a
      // harness built from stale config proudly running. Re-check after the
      // debounce until the boot settles; a failed start ends the loop.
      if (starting) setTimeout(() => scheduleRestart(reason), RESTART_DEBOUNCE_MS).unref?.()
      return
    }
    if (pendingRestart) clearTimeout(pendingRestart)
    pendingRestart = setTimeout(() => {
      void (async () => {
        if (bridge.supervisor.adopted) {
          logger.info(`not restarting (${reason}): this window borrows the harness; the window that spawned it applies the change`)
          return
        }
        logger.info(`restarting the harness: ${reason}`)
        const settings = readBridgeSettings()
        const preview = await drainActiveRequests(paths.active, 0)
        if (preview.remaining > 0 && settings.drainTimeoutSeconds > 0) {
          void vscode.window.showInformationMessage(
            `Waiting for ${preview.remaining} harness request(s) to finish before applying this change.`,
          )
        }
        await bridge.restart().then((result) => {
          if (!result.drained) {
            void vscode.window.showWarningMessage(`${result.remaining} in-flight harness request(s) were cut while applying this change.`)
          }
        })
        render()
        // A restart reissues port and token, so the open tab just became a
        // corpse with a live-looking page. Sweep before the window can quit
        // with it and restore a dead URL into the next session.
        sweepNow()
      })()
    }, RESTART_DEBOUNCE_MS)
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('vllm-copilot.servers') ||
        event.affectsConfiguration('vllm-copilot.models') ||
        event.affectsConfiguration('vllm-copilot.fixEmptyToolParameters')
      ) {
        // No early return: one configuration event can carry a registry edit
        // AND a bridge edit (bulk settings change), and the bridge half below
        // re-arms the ingest timer. Skipping it would silently keep the old
        // cadence until the next restart.
        scheduleRestart('the vLLM-Copilot registry changed')
      }
      if (!event.affectsConfiguration('vllm-copilot.harness')) return
      // The verbosity knob is a channel property, not a boot input: flipping it
      // while a session runs is exactly the moment it earns its keep.
      if (event.affectsConfiguration('vllm-copilot.harness.logLevel')) applyLogLevel()
      // Only boot-time settings justify draining and restarting a live
      // session. The ingest cadence re-arms here so the setting takes effect
      // without a restart; none of these may cut an in-flight turn.
      if (event.affectsConfiguration('vllm-copilot.harness.ingestIntervalSeconds')) armIngestTimer()
      if (BRIDGE_RESTART_KEYS.some((key) => event.affectsConfiguration(`vllm-copilot.harness.${key}`))) {
        scheduleRestart('a DeepSeek Harness setting changed')
      }
    }),
  )

  /** The dsh version sitting in the runtime directory, read from its own manifest. */
  function installedDshVersion(): string | undefined {
    try {
      const marker = path.join(paths.runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      return String((JSON.parse(readFileSync(marker, 'utf8')) as { version?: string }).version ?? '') || undefined
    } catch {
      return undefined
    }
  }

  /**
   * Install, update, or repair the harness WITHOUT ever spawning it: Start
   * owns running, this owns having. The version choice is written to the one
   * setting every window's restart listener already obeys (dshVersion is a
   * BRIDGE_RESTART_KEYS member), so a running harness converges through the
   * same drained restart a settings edit triggers - this command never
   * invents a second restart path. A stopped harness is prepared right here:
   * bridge.prepare() is idempotent and installs everything a start would
   * (runtime, vendor staging, profile, adapter, snapshot) minus the spawn,
   * under the same start lock Start holds, because concurrent npm installs
   * into one runtime tree is the exact corruption start-lock.ts exists for.
   */
  async function installOrUpdateHarness(): Promise<void> {
    const missing = await missingPrereqs()
    if (missing.length) {
      announceMissingPrereqs(missing, 'be installed')
      return
    }
    let pin: string
    try {
      pin = readBundledPin()
    } catch (err) {
      void vscode.window.showErrorMessage(`DeepSeek Harness: ${(err as Error).message}`, 'Show Log')
      return
    }
    const cfg = vscode.workspace.getConfiguration('vllm-copilot.harness')
    const currentSpec = (cfg.get<string>('dshVersion') ?? '').trim()
    const installed = installedDshVersion()
    const targetName = (spec: string): string => (spec === '' ? `certified ${pin}` : spec)
    type Target = vscode.QuickPickItem & { spec?: string; repair?: boolean }
    const items: Target[] = [
      {
        label: `$(shield) Certified version ${pin}`,
        description: currentSpec === '' ? 'current choice' : undefined,
        detail: 'The exact version vLLM-Copilot was certified against. The safe answer.',
        spec: '',
      },
      {
        label: '$(rocket) Latest from npm (experimental)',
        description: currentSpec === 'latest' ? 'current choice' : undefined,
        detail: "dsh's semver is decorative: an uncertified release can change its config rows under vLLM-Copilot.",
        spec: 'latest',
      },
      {
        label: '$(tag) An exact version…',
        detail: 'Pin a specific release, e.g. to retest one vLLM-Copilot does not certify.',
      },
    ]
    if (installed) {
      items.push({
        label: `$(tools) Repair ${installed} from scratch`,
        detail: 'Re-download the current version and restage the harness files. Sessions, profile choices, and settings are kept.',
        repair: true,
      })
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: installed
        ? `DeepSeek Harness ${installed} is installed · running target: ${targetName(currentSpec)}`
        : 'Install the DeepSeek Harness (@deepseek-ai/dsh)',
      placeHolder: 'Which version should the harness run?',
      ignoreFocusOut: true,
    })
    if (!picked) return
    let spec = picked.spec
    if (spec === undefined && !picked.repair) {
      const typed = await vscode.window.showInputBox({
        title: `Exact @deepseek-ai/dsh version (the certified one is ${pin})`,
        value: pin,
        validateInput: (value) => (isSafeVersionSpec(value.trim()) ? undefined : 'Enter "latest" or an exact version like 0.2.0-rc.2'),
        ignoreFocusOut: true,
      })
      if (typed === undefined) return
      spec = typed.trim()
    }
    // A repair keeps whatever version is targeted now; it only clears stamps.
    if (spec === undefined) spec = currentSpec
    const changed = !picked.repair && spec !== currentSpec
    if (bridge.supervisor.running || starting) {
      if (!changed && !picked.repair) {
        void vscode.window.showInformationMessage(`The harness already targets ${targetName(spec)}; nothing to do.`)
        return
      }
      // The settings write below schedules the drained restart in every
      // window (the owner executes it, borrowers log it). A repair writes no
      // setting at all, so it schedules that restart itself.
      if (changed) await cfg.update('dshVersion', spec, vscode.ConfigurationTarget.Global)
      rmSync(path.join(paths.runtime, INSTALL_STAMP_FILE), { force: true })
      if (picked.repair) {
        // The same stamp logic one level up: deleting a completion promise is
        // the only vocabulary the installers speak.
        rmSync(paths.coreVersion, { force: true })
        rmSync(paths.adapterStamp, { force: true })
        scheduleRestart('a repair cleared the install stamps under a running harness')
      }
      void vscode.window.showInformationMessage(
        bridge.supervisor.adopted
          ? `Harness update to ${targetName(spec)} chosen; the window that started the harness will drain and restage it.`
          : `Harness update to ${targetName(spec)} chosen; the running harness will drain and restage once its in-flight work lands.`,
      )
      render()
      return
    }
    if (changed) await cfg.update('dshVersion', spec, vscode.ConfigurationTarget.Global)
    if (changed || picked.repair) {
      rmSync(path.join(paths.runtime, INSTALL_STAMP_FILE), { force: true })
      if (picked.repair) {
        rmSync(paths.coreVersion, { force: true })
        rmSync(paths.adapterStamp, { force: true })
      }
    }
    const held = await acquireStartLock({ lockFile: paths.startLock, pidFile: paths.pid, log: logger })
    if (held.kind === 'adopt') {
      void vscode.window.showInformationMessage('A harness started while you were choosing; its next restart picks up your choice.')
      render()
      return
    }
    if (held.kind === 'busy') {
      void vscode.window.showWarningMessage('Another editor window is still preparing the harness; start the install again once it reports.')
      return
    }
    try {
      const prepared = await Promise.resolve(
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'DeepSeek Harness', cancellable: false },
          async (progress) => {
            startProgress = (message, increment) =>
              progress.report(increment === undefined ? { message } : { message, increment })
            try {
              return await bridge.prepare()
            } finally {
              startProgress = undefined
            }
          },
        ),
      )
      // The download the first-run offer asks permission for has now been
      // given and spent: the offer has nothing left to ask.
      void context.globalState.update(ONBOARDED_KEY, true)
      void vscode.window
        .showInformationMessage(
          `DeepSeek Harness ${prepared.dshVersion} is installed and ready, not running. Start it from the pill whenever you like.`,
          'Start Harness',
        )
        .then((choice) => {
          if (choice === 'Start Harness') void guardedStart()
        })
    } catch (err) {
      logger.error(`harness install failed: ${(err as Error).message}`)
      void vscode.window
        .showErrorMessage(`DeepSeek Harness install failed: ${(err as Error).message}`, 'Show Log')
        .then((choice) => {
          if (choice === 'Show Log') void output?.show()
        })
    } finally {
      held.lock.release()
      render()
    }
  }

  /**
   * Take the harness off the machine, never the bridge: paths.ts promises one
   * directory holds everything the harness owns, so uninstall is stop,
   * confirm, and one recursive delete. What SURVIVES is the promise the
   * confirmation makes out loud - the vLLM-Copilot registry, its usage
   * totals, and this extension's settings all live elsewhere by design.
   */
  async function uninstallHarness(): Promise<void> {
    if (starting) {
      void vscode.window.showWarningMessage('A harness start is in flight; let it finish (or stop it) before uninstalling.')
      return
    }
    // A harness another window spawned answers through the pid record long
    // before this window would adopt it, and Windows denies deleting files a
    // live process has open: force-deleting under it yields a half-deleted
    // tree nobody can finish removing.
    if (!bridge.supervisor.running) {
      const record = readPidRecord(paths.pid)
      if (record && (await probeHarness(record.url))) {
        void vscode.window.showWarningMessage('The DeepSeek Harness is running (started from another window); stop it there first.')
        return
      }
    }
    if (bridge.supervisor.running) {
      if (bridge.supervisor.adopted) {
        void vscode.window.showWarningMessage('The DeepSeek Harness runs in a window that is not this one; stop it there first.')
        return
      }
      const active = bridge.activeRequests()
      const go = await vscode.window.showWarningMessage(
        `Uninstall the DeepSeek Harness? ${active ? `Its ${active} in-flight request(s) end with it.` : 'The running harness stops first.'}`,
        { modal: true },
        'Stop and continue',
      )
      if (go !== 'Stop and continue') return
      const result = await bridge.stop()
      if (!result.drained) {
        void vscode.window.showWarningMessage(`${result.remaining} in-flight harness request(s) were cut by the uninstall stop.`)
      }
      render()
      // Read the served-URL history and close the tabs while the record still
      // exists: a harness tab that outlives the delete is tomorrow's poisoned
      // restore, and the sweep is the only thing that knows these URLs.
      await sweepStaleTabs()
    }
    const pendingUsage = readdirSync(paths.outbox).filter((n) => n.endsWith('.json')).length
    const confirm = await vscode.window.showWarningMessage(
      'Uninstall the DeepSeek Harness?',
      {
        modal: true,
        detail:
          `This deletes the harness runtime, its profile, every saved session` +
          `${pendingUsage ? `, and ${pendingUsage} usage record(s) your dashboard has not received yet` : ''} from:\n${paths.root}\n\n` +
          'Your vLLM-Copilot servers, models, and usage totals are untouched - vLLM-Copilot itself stays installed. ' +
          '"Install or Update Harness…" brings the harness back with fresh sessions.',
      },
      'Uninstall',
    )
    if (confirm !== 'Uninstall') return
    // Recursive delete only where the bytes are truly ours: a junction
    // planted at the harness home would hand rmSync whatever it points at.
    if (!deletableWithin(paths.root, path.dirname(paths.root))) {
      void vscode.window.showErrorMessage('Refusing to delete the harness home: it does not resolve inside vLLM-Copilot\'s storage directory. Something replaced that folder - look into it before deleting anything by hand.')
      return
    }
    let freed = 0
    await Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Uninstalling the DeepSeek Harness', cancellable: false },
        async () => {
          freed = directorySize(paths.root)
          rmSync(paths.root, { recursive: true, force: true })
        },
      ),
    )
    // The offer is a first-run promise: a reinstall owes the user the ask.
    void context.globalState.update(ONBOARDED_KEY, undefined)
    render()
    void vscode.window.showInformationMessage(
      `DeepSeek Harness uninstalled (${formatBytes(freed)} freed). vLLM-Copilot stays installed; "Install or Update Harness…" brings the harness back.`,
    )
  }

  // Ingestion runs on a timer rather than on a file watch: the outbox is a
  // directory the harness writes into from another process, and polling a
  // directory is portable in a way that reliable inotify events are not.
  let ingestTimer: NodeJS.Timeout | undefined
  let ingesting = false
  async function ingestPass(): Promise<void> {
    if (ingesting) return
    ingesting = true
    try {
      const outcome = await bridge.ingest()
      if (outcome.accepted || outcome.duplicate || outcome.malformed) {
        logger.info(
          `usage ingest: ${outcome.accepted} new, ${outcome.duplicate} duplicate, ${outcome.preReset} before last reset` +
            `${outcome.malformed ? `, ${outcome.malformed} quarantined` : ''}` +
            `${outcome.rejected ? `, ${outcome.rejected} refused` : ''}` +
            `${outcome.deferred ? `, ${outcome.deferred} deferred` : ''}`,
        )
      }
    } catch (err) {
      logger.warn(`usage ingest pass failed: ${(err as Error).message}`)
    } finally {
      ingesting = false
      render()
    }
  }

  function armIngestTimer(): void {
    const seconds = Math.max(2, readBridgeSettings().ingestIntervalSeconds)
    if (ingestTimer) clearInterval(ingestTimer)
    ingestTimer = setInterval(() => void ingestPass(), seconds * 1000)
    ingestTimer.unref?.()
  }
  armIngestTimer()
  void ingestPass()

  // Registered before any early return below: activation can bail out early
  // (no vLLM-Copilot, empty registry) and a timer armed before that would
  // otherwise outlive the extension with nothing left to clear it.
  context.subscriptions.push({
    dispose: () => {
      if (ingestTimer) clearInterval(ingestTimer)
      if (pendingRestart) clearTimeout(pendingRestart)
      control?.close()
      embed?.close()
    },
  })

  /** What the status bar cannot hold: versions, handoff health, queue depth.
   *  Never a URL with its token and never a server id built from a hostname. */
  async function showReport(): Promise<void> {
    const info = bridge.preparedInfo
    const lines = [
      `Harness: ${bridge.supervisor.running ? 'running' : 'stopped'}`,
      `dsh version: ${info?.dshVersion ?? 'not prepared'}`,
      `vLLM-Copilot core: ${info?.coreVersion ?? 'not staged'}`,
      `snapshot version: ${info?.snapshotVersion ?? 'not written'}`,
      `privacy rows disabled: ${info?.rowsDisabled ?? 'unknown'}`,
      `in-flight requests: ${bridge.activeRequests()}`,
      `pending usage records: ${readdirSync(paths.outbox).filter((n) => n.endsWith('.json')).length}`,
      `editor control channel: ${control?.url ? `listening on ${control.url}` : 'not started'}`,
      '',
      'Harness URL tokens and server ids are never shown here.',
    ]
    const choice = await vscode.window.showInformationMessage(lines.join('  \n'), 'Show Log')
    if (choice === 'Show Log') output?.show()
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('vllm-copilot.harness.start', async () => {
      await guardedStart()
      render()
    }),
    vscode.commands.registerCommand('vllm-copilot.harness.stop', async () => {
      const result = await bridge.stop()
      if (!result.drained) {
        void vscode.window.showWarningMessage(`${result.remaining} in-flight harness request(s) were cut by this stop.`)
      }
      render()
      // The tab's server is gone by the user's own hand: close the tab too.
      sweepNow()
    }),
    vscode.commands.registerCommand('vllm-copilot.harness.restart', async () => {
      const result = await bridge.restart()
      if (!result.drained) {
        void vscode.window.showWarningMessage(`${result.remaining} in-flight harness request(s) were cut by this restart.`)
      }
      render()
      sweepNow()
    }),
    vscode.commands.registerCommand('vllm-copilot.harness.open', async () => {
      const url = bridge.supervisor.url ?? (await guardedStart())
      if (!url) return
      // The URL carries the UI's auth token, so it is opened programmatically
      // and never printed to a log or a notification a user might paste.
      await openHarnessUrl(url)
    }),
    vscode.commands.registerCommand('vllm-copilot.harness.openNewView', async () => {
      const url = bridge.supervisor.url ?? (await guardedStart())
      if (!url) return
      await openHarnessUrl(url, true)
    }),
    // Revive harness views the previous window session had open: tabs survive
    // reloads now; the session shown inside cannot, because no URL says which
    // one it was (upstream issues entry 3).
    vscode.window.registerWebviewPanelSerializer('vllm-copilot.harnessPanel', {
      deserializeWebviewPanel: async (panel) => adoptHarnessPanel(panel),
    }),
    vscode.commands.registerCommand('vllm-copilot.harness.showLogs', async () => {
      output?.show()
    }),
    vscode.commands.registerCommand('vllm-copilot.harness.report', () => showReport()),
    // Visible on purpose: if a stale harness tab ever eats the menus again
    // (ours or a restored one the sweep missed), this is the recovery button
    // a keyboard user can reach without a mouse menu, and the rail's handle
    // on the exact production path.
    vscode.commands.registerCommand('vllm-copilot.harness.sweepStaleTabs', async () => {
      await sweepStaleTabs()
    }),
    vscode.commands.registerCommand('vllm-copilot.harness.installOrUpdate', async () => {
      await installOrUpdateHarness()
    }),
    vscode.commands.registerCommand('vllm-copilot.harness.uninstall', async () => {
      await uninstallHarness()
    }),
    // The settings gear on the extension page does this; a keyboard user
    // reaches it through the palette instead of a mouse menu.
    vscode.commands.registerCommand('vllm-copilot.harness.openSettings', () =>
      void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:system-sciences.vllm-copilot vllm-copilot.harness'),
    ),
  )

  const registry = await getConfig()
  if (registry.models.length === 0) {
    logger.warn('the vLLM-Copilot registry has no models; the harness is not launched')
    void vscode.window
      .showInformationMessage('Add a server and a model in vLLM-Copilot settings, then start the DeepSeek Harness.', 'Open vLLM-Copilot Settings', 'Start Harness')
      .then((choice) => {
        if (choice === 'Open vLLM-Copilot Settings') void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:system-sciences.vllm-copilot vllm-copilot')
        if (choice === 'Start Harness') void guardedStart()
      })
    return
  }

  // Starting is manual by design: the pill, the command palette, or the
  // buttons in the notices above. A harness the user did not ask for never
  // installs a runtime, opens a port, or spends tokens on its own.
  render()

  // First run after an install, reached only when the registry offers models
  // (the early return above owns that gap). The offer asks for the one thing
  // the user has not been offered yet: the dsh
  // download. Pressing the button IS the manual ask the ruling above demands;
  // "Later" says nothing again, forever, and the pill stays. An install that
  // booted into a broken environment keeps the flag unset, so the offer lands
  // on the first window where the notice can actually be acted on.
  if (!context.globalState.get<boolean>(ONBOARDED_KEY)) {
    void vscode.window
      .showInformationMessage(
        'vLLM-Copilot is installed, and your registry has models to offer. '
          + 'The DeepSeek Harness itself (@deepseek-ai/dsh) downloads once into vLLM-Copilot\u2019s own directory: about 2-3 minutes, '
          + 'and it needs Node.js 22 or newer with npm on PATH. Set it up now?',
        'Check prerequisites and start',
        'Later',
      )
      .then(async (choice) => {
        await context.globalState.update(ONBOARDED_KEY, true)
        if (choice === 'Check prerequisites and start') {
          await guardedStart()
          render()
        }
      })
  }

  context.subscriptions.push({
    // Deactivate is best effort: it does not run at all when the host dies,
    // which is what the start-time reap of detached survivors is for.
    dispose: () => {
      // Tabs die with the session, unconditionally and first: a restored
      // fail-load browser view poisons the window's menus before any
      // extension can react (docs/upstream-issues.md section 3), and menu
      // damage latches until a reload, so prevention is the only cure.
      void closeOwnEmbeddedTabs().catch(() => {})
      // A borrowed harness belongs to a window that is still open: closing
      // this one must leave it, its pid record, and its detached servers
      // running. Only the window that spawned the harness may end it.
      if (bridge.supervisor.adopted) bridge.supervisor.release()
      else void bridge.supervisor.stop({ drainMs: SHUTDOWN_DRAIN_BUDGET_MS })
    },
  })
}
