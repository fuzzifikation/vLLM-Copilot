# UI/UX: the harness as an editor surface

Status law: this file describes the harness surface **as it is and as it must stay** (certified live 2026-11-07, VS Code 1.145, Windows). Every paragraph is a spec: if code and this file disagree, one of them has a bug. The decision history behind these choices is the dated journal in [harness-journal.md](./harness-journal.md); the mechanism and its security laws are in [harness.md](./harness.md) ("Harness surface laws").

## The one idea

The harness is not a webpage you visit inside the editor; it is a **tab in the editor**. Everything below follows from that: no address bar, no browser chrome, no visible server, a tab that carries the name of the conversation it shows, and keyboard chords that answer from inside it like any other editor. The owner's test: a stranger should not be able to tell from the pane itself that a web server is involved.

## Surfaces

### Status pill
- One item in the status bar: stopped / starting (spinner, with an honest first-run tooltip) / running. The pill exists only once the harness runtime is installed; until then the **DeepSeek Harness** sidebar section is the whole surface, and it shows the install row.
- One command behind the click in every state — `harness.open` — because the pill is "give me my harness", and a stopped pill that only CONNECTED made the user click twice for the window they had already asked for (owner ruling, 2026-11-14). Running: **reveals** the existing view, never a second one (that ruling stands; new views are the `+` or the command). Stopped: starts, then opens. Starting: clicking joins that boot and opens when it lands.
- The click is therefore set ONCE at pill creation. Per-state command assignment is how this pill once fired a silent no-op Start behind a "click to open" tooltip (journal, 2026-10-05); the fix then was to re-arm per state, this fix removes the per-state half of the bug class instead.

### The harness view (panel, the default)
- A `WebviewPanel` whose entire pane is the harness GUI. No toolbar, no address bar, no reload button: the editor tab **is** the surface.
- Tab identity: rocket icon; title `DSH — <chat title>` once the view has reported which conversation it shows (falls back to `DSH Harness` for at most ~1.5 s and while the harness is down). Two views on the same chat carry the same title, which is the truth rather than a bug to re-number away.
- The tab behaves like any editor tab: split it, drag it into a group, "Move into New Window" for a dedicated harness window. With `workbench.editor.showTabs: "multiple"` a dedicated window with exactly one editor shows **no tab strip at all**, which is the zero-chrome window, and it needs no code of ours.
- Tabs survive window reloads (webview serializer revival): a revived tab reconnects to the harness by itself as soon as one is reachable, showing an honest waiting card until then.
- The panel's own address is `127.0.0.1:<vllm-copilot.harness.embedPort>` and **never moves** across harness restarts; a restart reloads the frame in place. Never reintroduce a panel URL that carries the harness port or token: restart-proofing, restored tabs, and the stale-tab bug class all rest on this.

### Creating views
- `+` in the panel title bar (navigation row): "Open Another Harness View".
- Same command in the palette; same behavior from the palette on any path: always opens a fresh full GUI, its own session selection, sharing the one harness.
- Multiple views are honest because the harness session-multiplexes: each view is a complete GUI on one bus.

### Keyboard
- DSH's own shortcuts win, always. The view forwards to VS Code only modifier chords (or `F1`) that the harness page did not consume itself.
- Forwarded whitelist: `F1`/`Ctrl+Shift+P` command palette, `Ctrl+P` quick open, `Ctrl+B` sidebar, `Ctrl+Shift+E`/`Ctrl+Shift+F` explorer/search, `Ctrl+,` settings, `Ctrl+W` close the harness tab (`Cmd` equivalents on mac).
- Known edges (accepted): two-key chords (`Ctrl+K x`) are not forwarded; a chord the harness acts on without swallowing also fires in VS Code. `vllm-copilot.harness.keyboardBridge` turns the whole bridge off.
- This is a bridge, not a workaround to remove: 1.145 removed the webview keyboard protocol and DOM events cannot cross frames. The only future upgrade path is upstream telling the page which chords it consumes.

### Prompt controls (session-scoped)
Three commands, three sidebar rows, one truth each - available before install (the rows sit in the section; nothing on disk is created until the user asks):
- **Set Harness Personality…** (`harness.setPersonality`): Default (upstream prompt untouched) / **Bundled voices** - the four shipped presets (Supportive Mentor, Critical Senior Dev, Sarcastic Robot, Spartan), each touching only the prompt identity line (Supportive Mentor and Spartan append one style sentence under it, Critical Senior Dev and Sarcastic Robot replace it with a short voice block) and stored by portable name in `harness.personality` (never an install path; wins over the file reference) / a detected file under `<globalStorage>/harness-personalities/` / **Load…** any replacements JSON / **Create…** an empty-rule template in an unsaved editor (nothing is written until the user saves) / **Edit** the current file. Session-wide, not per model: dsh carries one personality per session. Model Settings shows the current choice in a clearly separate **DeepSeek Harness (session)** section whose buttons route to these same commands - its personality card and record checkbox are labelled **Copilot**, and there is no second settings truth.
- **Toggle Harness Prompt Recording** (`harness.toggleRecording`): flips `harness.captureSystemMessages` and the live consent marker together; answers with the honest resulting state and the exact workspace file (`.vllm\dsh-system-messages.json`). Refuses to enable with no workspace folder - a recording with no destination is a lie, not a maybe. Never creates the harness folder on a machine where the harness was never installed.
- **Open Harness Recording** (`harness.openRecording`): opens this window's workspace `.vllm\dsh-system-messages.json` directly; a missing file gets the "turn recording ON and send a message" answer, a window without a folder gets "open a folder", and a RUNNING harness bound to another (or to no) workspace is NAMED with the honest answer - another window's file is named, never auto-opened, and rebinding is spelled **Restart** (a Start adopts the survivor and rebinds nothing) - never an empty success, never a pid scan.

### Ways in (`vllm-copilot.harness.openIn`)
| mode | surface | why you would pick it |
|---|---|---|
| `panel` (default) | chromeless editor tab | the intended experience |
| `appWindow` | dedicated Edge/Chrome `--app` window | a second screen: full browser capabilities, still no chrome |
| `embedded` | built-in Browser area | legacy door; has an address bar and the stale-tab bug class |
| `external` | system browser | debugging with devtools |

Fallback is visible: a mode that cannot be honored says so and hands you the next door; nothing silently changes underneath you.

## Settings (surface ones; all under `vllm-copilot.harness.`)
The harness settings that decide how the surface behaves. Every `vllm-copilot.harness.*` key, its default and its meaning: [Configuration Reference → DeepSeek Harness settings](configuration-reference.md#deepseek-harness-settings).

| key | default | contract |
|---|---|---|
| `openIn` | `panel` | way in, with visible fallback |
| `embedPort` | `43171` | stable panel address; busy → ephemeral fallback with a log line |
| `keyboardBridge` | `true` | forward unconsumed chords to VS Code |
| `logLevel` | `info` | `debug` mirrors harness chatter into the **DeepSeek Harness** output channel |
| `personalityFile` | `""` | session-wide personality file; empty = upstream prompt untouched; path change → draining restart, content edits → next request |
| `captureSystemMessages` | `false` | recording on/off; never restarts anything - the marker is re-read per request, so OFF bites immediately |

## Feel invariants (regressions of these are bugs, not preferences)
1. No browser chrome is ever visible in panel mode, including on reload, restart, and revival.
2. The panel URL survives harness restarts; recovery is in-place, never "open a new tab".
3. A view's title names its conversation; nothing ever renames it back to a number.
4. The pill reveals; the `+` creates.
5. DSH keeps every shortcut it handles; VS Code keeps the palette.
6. Every failure mode tells the truth in words a user can act on (waiting card, fallback notice, honest stopped state).
7. Recording consent is the marker, the whole marker and nothing but the marker: it must read exactly `on`, everything else means off, and **OFF cancels every queued, not-yet-committed write on the spot** - a user is never made to wait out a 120 s drain to stop the pen (files already on disk stay). Starting refuses to launch when the marker cannot be written, activation re-asserts it from the setting, and a toggle command never announces success before the marker agrees.

## Known edges (documented, owned)
- Session deep links do not exist upstream (docs/harness-upstream-issues.md entry 3): per-session tabs and "open this chat" from outside are blocked on it; per-view titles work around it and stay correct after restarts.
- Revived tabs re-title themselves within ~1.5 s after reload (the restored title holds until the view reports).
- `appWindow` is Windows-only for now (Edge/Chrome discovery).
- Plugin toggles in the harness GUI persist but cannot hot-apply: this dsh build deadlocks its own live profile reload once any patch content exists at boot, and the GUI's own toast will say "Could not enable: ... root Include entry" (upstream, docs/harness-upstream-issues.md entry 6). vLLM-Copilot's promise is honesty plus the shortest road: when the plugin manager writes the profile, the editor says "saved but not applied" and offers a draining restart, which applies everything. No fake success, no silent retry.
