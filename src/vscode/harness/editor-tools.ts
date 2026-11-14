/**
 * The editor tools the harness sees through MCP: state, diagnostics,
 * open/diff, notify/ask, and a visible terminal runner. This is tool
 * implementation; `activate()` only wires the result into the control
 * server, which is why the module takes its disposables instead of a
 * context. Like `settings.ts`, this file touches the vscode API and is
 * therefore exercised on the extension-host rail, not in plain node.
 */
import * as vscode from 'vscode'
import * as path from 'node:path'
import type { McpTool } from './mcp.js'

export interface EditorTools {
  /** Built lazily per tools/list and per call, so bodies always close over live editor state. */
  tools(): McpTool[]
}

/** Trims tool output to a size a model context can swallow without revolt. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[... clipped, ${text.length - max} more characters]` : text
}

/** Resolves a model-supplied path against the first workspace folder. */
function resolveEditorPath(p: string): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  return path.isAbsolute(p) || !root ? p : path.resolve(root, p)
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
  json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go', css: 'css',
  html: 'html', yml: 'yaml', yaml: 'yaml', toml: 'toml', c: 'c', h: 'cpp',
  cc: 'cpp', hpp: 'cpp', java: 'java', cs: 'csharp', sh: 'shellscript', ps1: 'powershell',
}

interface TerminalResult {
  output: string
  exitCode: number | null
  timedOut: boolean
}

export function createEditorTools(deps: { disposables: vscode.Disposable[] }): EditorTools {
  let harnessTerminal: vscode.Terminal | undefined
  deps.disposables.push(
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === harnessTerminal) harnessTerminal = undefined
    }),
  )

  async function runInEditorTerminal(command: string, requestedTimeout: number | undefined, signal: AbortSignal): Promise<TerminalResult> {
    if (!harnessTerminal || !vscode.window.terminals.includes(harnessTerminal)) {
      harnessTerminal = vscode.window.createTerminal({ name: 'DSH Harness' })
    }
    const shell = harnessTerminal.shellIntegration
    if (!shell) throw new Error('the editor terminal has no shell integration yet; retry in a moment')
    const execution = shell.executeCommand(command)
    // show(false): the command and its live output become visible without
    // stealing focus from whatever the user is reading.
    harnessTerminal.show(false)
    const timeoutMs = requestedTimeout ?? 120_000
    const deadline = Date.now() + timeoutMs
    // The exit code only exists on the end event (documented contract); the
    // read stream says nothing about it.
    let endSubscription: vscode.Disposable | undefined
    const ended = new Promise<number | undefined>((resolve) => {
      const sub = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) {
          resolve(event.exitCode)
          sub.dispose()
        }
      })
      endSubscription = sub
    })
    const iterator = execution.read()[Symbol.asyncIterator]()
    let output = ''
    let timedOut = false
    // The abort promise is built once for the whole command: registering a
    // listener per read iteration would pile up one permanent listener per
    // output chunk on a signal that outlives them all.
    let settleAborted: (value: 'aborted') => void = () => {}
    const aborted = new Promise<'aborted'>((resolve) => {
      settleAborted = resolve
    })
    signal.addEventListener('abort', () => settleAborted('aborted'), { once: true })
    if (signal.aborted) settleAborted('aborted')
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        timedOut = true
        break
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const next: IteratorResult<string> | 'timeout' | 'aborted' = await Promise.race([
        iterator.next(),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), remaining)
        }),
        aborted,
      ]).finally(() => {
        // One live timer per command, not one orphan per chunk.
        if (timer) clearTimeout(timer)
      })
      if (next === 'timeout') {
        timedOut = true
        // No orphan listener, no dangling stream: an abandoned build command
        // must not leave this machinery attached to the terminal forever.
        endSubscription?.dispose()
        void iterator.return?.()
        break
      }
      if (next === 'aborted') {
        endSubscription?.dispose()
        void iterator.return?.()
        throw new Error('the harness closed the control channel while the command was still running')
      }
      if (next.done) break
      output += next.value
    }
    let exitCode: number | null = null
    if (!timedOut) {
      // The end event trails the stream by a moment; a lost race means "no
      // exit code", which the tool reports honestly rather than guessing 0.
      const grace = await Promise.race([
        ended,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
      ])
      exitCode = grace ?? null
    }
    // The resolve path disposes its own listener; this covers the lost race.
    endSubscription?.dispose()
    return { output, exitCode, timedOut }
  }

  return {
    tools: () => [
      {
        name: 'editor_state',
        description:
          'Report what the user has open in the editor right now: workspace folders, every visible tab, and the active file with its selection text. Call this before editing so work lands where the user is looking.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => {
          const lines: string[] = []
          const folders = vscode.workspace.workspaceFolders ?? []
          lines.push(`workspace folders: ${folders.length ? folders.map((f) => f.uri.fsPath).join(' | ') : '(none: this window has no open folder)'}`)
          const tabs: string[] = []
          for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
              const input = tab.input as { uri?: { fsPath?: string }; terminal?: { name?: string } } | undefined
              const where = input?.uri?.fsPath ?? (input?.terminal ? `terminal: ${input.terminal.name ?? 'unnamed'}` : tab.label ?? 'unknown tab')
              tabs.push(`${group.isActive && tab.isActive ? '* ' : '  '}${where}`)
            }
          }
          lines.push(tabs.length ? `open tabs (* = active):\n${tabs.join('\n')}` : 'open tabs: (none)')
          const editor = vscode.window.activeTextEditor
          if (editor) {
            const sel = editor.selection
            lines.push(`active: ${editor.document.uri.fsPath} (${editor.document.lineCount} lines, ${editor.document.languageId}, ${editor.document.isDirty ? 'unsaved changes' : 'saved'})`)
            if (!sel.isEmpty) lines.push(`selection L${sel.start.line + 1}-L${sel.end.line + 1}:\n${clip(editor.document.getText(sel), 4000)}`)
            else lines.push(`cursor at L${sel.active.line + 1}`)
          } else {
            lines.push('active: no text editor is focused')
          }
          return { text: lines.join('\n') }
        },
      },
      {
        name: 'editor_diagnostics',
        description:
          'Read the editor problem panel: the errors and warnings VS Code reports for one file or for the whole window. Call this after editing code; it is the same feedback the user sees in real time.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File to report on (absolute, or relative to the first workspace folder). Omit to summarize every file with recorded problems.' },
          },
          additionalProperties: false,
        },
        run: async (args) => {
          const severity = ['error', 'warning', 'info', 'hint']
          const format = (d: vscode.Diagnostic) =>
            `  L${d.range.start.line + 1} [${severity[d.severity] ?? 'unknown'}] ${d.message.split('\n')[0]}${d.source ? ` (${d.source})` : ''}`
          const file = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined
          if (file) {
            const target = vscode.Uri.file(resolveEditorPath(file))
            const found = vscode.languages.getDiagnostics(target)
            return { text: found.length ? `${target.fsPath}:\n${found.map(format).join('\n')}` : `${target.fsPath}: no problems recorded.` }
          }
          const entries = vscode.languages.getDiagnostics().filter(([, list]) => list.length > 0)
          if (entries.length === 0) return { text: 'the problem panel is empty: no diagnostics recorded in this window.' }
          const errorsOf = (list: vscode.Diagnostic[]) => list.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length
          const files = entries
            .sort((a, b) => errorsOf(b[1]) - errorsOf(a[1]))
            .slice(0, 40)
            .map(([uri, list]) => `${uri.fsPath}: ${errorsOf(list)} error(s), ${list.length - errorsOf(list)} other\n${list.slice(0, 5).map(format).join('\n')}`)
          return { text: `${entries.length} file(s) carry diagnostics (first 40, error-heavy first):\n${files.join('\n')}` }
        },
      },
      {
        name: 'editor_open_file',
        description: 'Open a file in the editor and focus it, optionally jumping to a 1-based line. Use it after edits so the user sees what changed.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File to open (absolute, or relative to the first workspace folder).' },
            line: { type: 'number', description: '1-based line to reveal and place the cursor on.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        run: async (args) => {
          const file = typeof args.path === 'string' ? resolveEditorPath(args.path.trim()) : ''
          if (!file) throw new Error('path is required')
          const doc = await vscode.workspace.openTextDocument(file)
          const shown = await vscode.window.showTextDocument(doc)
          if (typeof args.line === 'number' && Number.isFinite(args.line) && args.line >= 1) {
            const row = Math.min(Math.trunc(args.line) - 1, Math.max(doc.lineCount - 1, 0))
            const target = new vscode.Range(row, 0, row, 0)
            shown.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
            shown.selection = new vscode.Selection(target.start, target.start)
          }
          return { text: `opened ${doc.uri.fsPath} for the user.` }
        },
      },
      {
        name: 'editor_open_diff',
        description:
          'Show a diff editor: the content you provide on the left, the file as it is on disk on the right. Use it before overwriting a file you did not read in full, so the human sees the change instead of discovering it.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File on disk (right side of the diff).' },
            before: { type: 'string', description: 'The content to show on the left, typically the previous version you are replacing.' },
          },
          required: ['path', 'before'],
          additionalProperties: false,
        },
        run: async (args) => {
          if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('path is required')
          if (typeof args.before !== 'string') throw new Error('before (string) is required')
          const file = resolveEditorPath(args.path.trim())
          const language = LANGUAGE_BY_EXTENSION[path.extname(file).replace('.', '')] ?? 'plaintext'
          const left = await vscode.workspace.openTextDocument({ content: args.before, language })
          const right = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
          await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, `${path.basename(file)}: provided vs on disk`)
          return { text: `diff of ${file} is open for the user to review.` }
        },
      },
      {
        name: 'editor_notify',
        description: 'Put a notification in the editor with optional buttons, and report which button the user clicked (or that it was dismissed). For milestones worth a glance, not for chatter.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The notification text.' },
            buttons: { type: 'array', items: { type: 'string' }, description: 'Up to 3 button labels.' },
          },
          required: ['message'],
          additionalProperties: false,
        },
        run: async (args) => {
          const message = typeof args.message === 'string' ? args.message.trim() : ''
          if (!message) throw new Error('message is required')
          const buttons = Array.isArray(args.buttons) ? args.buttons.filter((b): b is string => typeof b === 'string').slice(0, 3) : []
          const picked = await vscode.window.showInformationMessage(message, ...buttons)
          return { text: picked ? `the user clicked: ${picked}` : 'the notification expired or was dismissed without a choice.' }
        },
      },
      {
        name: 'editor_ask',
        description:
          'Ask the user a question IN THE EDITOR and wait for the answer: a pick list when options are given, otherwise a text box. The user may dismiss it; if so, state your best assumption instead of asking again. With secret the typed value is deliberately NOT returned: a secret must never enter a model context, so use secret only for confirmations, never to collect a credential.',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'One clear question.' },
            options: { type: 'array', items: { type: 'string' }, description: 'Choices to offer as a pick list (omit for a free-form answer).' },
            secret: { type: 'boolean', description: 'Obscure the typed answer and withhold it from the reply. For confirmations only: never use this to collect a credential for the harness.' },
          },
          required: ['question'],
          additionalProperties: false,
        },
        run: async (args) => {
          const question = typeof args.question === 'string' ? args.question.trim() : ''
          if (!question) throw new Error('question is required')
          const options = Array.isArray(args.options) ? args.options.filter((o): o is string => typeof o === 'string').slice(0, 10) : []
          const answer = options.length
            ? await vscode.window.showQuickPick(options, { title: 'The harness asks', placeHolder: question, ignoreFocusOut: true })
            : await vscode.window.showInputBox({ title: 'The harness asks', prompt: question, password: args.secret === true, ignoreFocusOut: true })
          if (answer === undefined) {
            return { text: 'the user dismissed the question without answering. State your assumption and proceed; do not fire the same question again.', isError: true }
          }
          // A password box that pipes its plaintext back into the transcript is
          // a lie of omission: the answer would ride into every later model
          // context and into the harness history on disk. Secret answers are
          // acknowledged, never transported.
          if (args.secret === true) {
            return { text: 'the user provided the requested secret; its value was deliberately not returned. Treat the matter as confirmed and never ask the harness to carry secret values.' }
          }
          return { text: `the user answered: ${answer}` }
        },
      },
      {
        name: 'run_terminal',
        description:
          'Run a shell command in the user VS Code editor terminal and return its combined output and exit code. Prefer this for anything the user should watch or interrupt (builds, tests, git): it runs visibly in the editor. The command runs in the terminal current directory, so cd within the command when it must run elsewhere. Keep timeoutMs generous for builds.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command line to run in the editor terminal.' },
            timeoutMs: { type: 'number', description: 'Give up waiting after this many milliseconds (default 120000).' },
          },
          required: ['command'],
          additionalProperties: false,
        },
        run: async (args, signal) => {
          const command = typeof args.command === 'string' ? args.command.trim() : ''
          if (!command) throw new Error('command must be a non-empty string')
          const timeoutMs = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : undefined
          const result = await runInEditorTerminal(command, timeoutMs, signal)
          const note = result.timedOut ? '\n[timed out; the command may still be running in the editor terminal]' : ''
          return { text: `\`\`\`console\n${clip(result.output.replace(/\n+$/, ''), 60_000)}\n\`\`\`\n[exit code: ${result.exitCode ?? 'unknown'}]${note}` }
        },
      },
    ],
  }
}
