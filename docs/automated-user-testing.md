# Automated User Testing — Research and Recommendation

Question from the owner (2026-10-04): can VS Code be remote-controlled so that
user testing — fresh start, add servers and models, use the extension — runs
automated, to find real bugs while he sleeps? Short answer: **yes, in layers.**
The long answer is this file; the verdict is [Recommendation](#recommendation).

## What we already automate

| Layer | Harness | What it proves | Editor running? |
|---|---|---|---|
| Unit/mock-host | `npm test` (vitest, mocked `vscode`) | logic, wire formats, settings writes | no |
| Real-server | `npm run test:integration` (vitest, `VLLM_INTEGRATION=1`) | `VllmClient` against a live vLLM | no |
| Packed core | `npm run core:proof` | core package alone, no editor, mock backend | no |

The gap between "all green" and "works in the editor" is exactly the manual
Phase-9 chore: activation of the real extension, the QuickPick wizards, the
dashboard tree, the webviews, the settings.json round-trip through the real
host, and Copilot itself calling our provider.

## The automation surface VS Code actually offers

### 1. Extension-host integration tests — `@vscode/test-cli` + `@vscode/test-electron`

Official MS tooling. Downloads a throwaway VS Code build, launches it with our
extension (dev path or VSIX), and runs Mocha scripts **inside the extension
host** with the full `vscode` API. Fresh instance = fresh
`--user-data-dir`/`--extensions-dir` under the harness dir — "starting fresh"
is the default, and per-config isolated user-data dirs are documented usage.
Granular API (`downloadAndUnzipVSCode`, `resolveCliArgsFromVSCodeExecutablePath`)
installs any VSIX or Marketplace extension before launch.

The killer feature for this extension: `vscode.lm.selectChatModels()` +
`LanguageModelChat.sendRequest()` are **stable core API** (verified in the
installed `@types/vscode` 1.128, `selectChatModels` at index.d.ts:20771,
`sendRequest` at :20304). That is literally what Copilot calls on our
`LanguageModelChatProvider`. An extension-host test can:

1. seed `settings.json` (or drive our own commands) to configure a server
   pointing at a loopback mock backend;
2. `selectChatModels({ vendor: 'vllm-copilot' })` (the registered vendor id,
   `src/extension.ts`) — exercises real activation, real discovery, real
   picker-info contribution;
3. `sendRequest(...)` and drain the response — exercises the whole Copilot
   call path: provider → requestBuilder → vllmClient → execute → consumeStream;
4. cancel mid-stream, feed malformed SSE, assert error surfaces — the shapes
   the vitest mock host can only imitate.

No GitHub sign-in needed for any of this: the tests talk to our provider
through the LM API, not through the Copilot Chat UI.

Constraints (documented): CLI-launched extension tests refuse to start when
another instance of the *same product* is running — developing in Insiders
(owner's setup) and testing against Stable dodges it; the harness downloads
its own binaries anyway. Runner is Mocha — it coexists with vitest, the unit
suite is untouched.

### 2. Real UI automation — ExTester (`vscode-extension-tester`, Red Hat)

Drives a **real VS Code desktop window** over Selenium/ChromeDriver (v8.28.x,
Node ≥22, VS Code ≥1.90, latest three minors tested — current stable included).
This is what the vscode-java people use to click through everything. Page
objects cover: command palette, **InputBox and QuickPick dialogs** (our entire
add-server/add-model/auto-configure wizard surface), notifications, status bar,
views, context menus, and **webviews** (Deep-Dive, Server Settings, Model
Selector). `extest setup-and-run` downloads VS Code, packages and installs our
VSIX, launches, runs Mocha; screenshots on failure built in, coverage flag
exists.

Concretely automatable user journeys: fresh instance → run
`vllm-copilot.addServer` → type URL into the InputBox → pick through the
QuickPick → assert settings.json changed correctly → run
`testAndRefreshModels` → assert the dashboard tree grew → open Deep-Dive →
assert the webview rendered. Every wizard in `src/vscode/commands/` — thirty-odd
contributed commands — is scriptable surface.

### 3. Copilot Chat end-to-end (the true "user experience")

The last mile — model picker shows our model, prompt sent in Chat, response
streams — needs the GitHub Copilot Chat extension installed **and
authenticated** in the test instance. Auth is the only genuinely awkward
part:

- Install: trivial (`--install-extension github.copilot-chat`).
- Sign-in: interactive GitHub OAuth. Workable pattern: **warm profile** —
  sign in once by hand in a profile dir, then copy that user-data dir per run.
  Secret storage on Windows is DPAPI-bound to the *Windows account*, not the
  profile dir, so a copied profile still decrypts on the same machine and
  user. Needs a spike to confirm for the current build; CI-hosted runners
  (ephemeral VMs) would have to re-auth headfully or skip this layer.
- Driving the Chat view: no official page objects exist for Copilot Chat's
  UI; selectors into its internals rot without notice. The Copilot side must
  stay a thin release-gate smoke (send one prompt, assert streamed text),
  never a suite.

Complement, not substitute: the `vscode.lm` layer (§1) gives the same
provider coverage with zero auth and zero fragility; §3 only proves the
Copilot glue we don't own.

### 4. Angles considered and rejected

- **Browser-hosted VS Code** (`code-server`, `serve-web`, vscode.dev): Copilot
  does not run on non-Microsoft products or in web hosts — already field-
  documented in [dsh-bridge-plan](./dsh-bridge-plan.md) (VSCodium no-Copilot
  research). The one surface we most need to test is absent. Dead end.
- **Remote tunnels as the remote control**: `code tunnel` mirrors the desktop
  into a browser; automating that browser automates VS Code by telephone.
  Works, but ExTester drives the same desktop directly — the tunnel is a
  middle layer with an extra login and no test value. "Remote" is solved
  operationally: run the suite over SSH/scheduled task, read artifacts after.
- **Windows UIA / AutoHotkey / pywinauto**: coordinate-and-name automation of
  an Electron app whose DOM is already scriptable. Strictly worse than §2.
- **DIY Playwright** (the vscode repo's own internal harness pattern):
  ExTester is that idea already packaged and version-maintained against real
  VS Code releases. Rebuilding it violates every simplicity law here.
- **Computer-use/AI agents clicking around**: nondeterministic, unrepeatable;
  a bug "found" by an agent can't be pinned by a regression tripwire. Fine for
  demos, wrong as infrastructure.

## Bug-finding machinery (the actual goal, not green checkmarks)

Suites prove known paths. *Finding* bugs needs the surrounding rig:

1. **Loopback fault-injection proxy.** Promote the packed-proof mock backend
   (`CONSUMER_SOURCE` in `scripts/core-proof.mjs`) to a standalone runner:
   modes for truncating SSE mid-event, invalid JSON payloads, 429/500/502
   before and mid-stream, header hangs, slow-drip past the inactivity
   timeout, colon-style vLLM error continuations. Every UI/extension-host
   scenario talks to this, so every fault mode runs against the *real*
   stack.
2. **Overnight sweep.** Matrix: fresh profile × seeded scenario (empty
   settings → wizard flow; pre-seeded server → dashboard ops; OpenRouter
   entry with and without key) × fault mode. Inputs randomized within legal
   shapes (URL variants, weird model ids, token-budget edge values).
3. **Oracles.** A run is red when: an error notification appears (ExTester
   reads the notification center); the extension's own file log
   (`vllm-copilot.enableFileLogging` — already shipped, already structured
   `[ERROR]`) gains `[ERROR]`/unhandled-rejection lines; an uncaught
   exception hits the extension host; a scenario exceeds its deadline
   (hung-stream tripwire); settings.json drifts from the scenario's
   expected state.
4. **Artifacts per run.** Screenshot on failure (built into ExTester), plus
   copied `settings.json`, extension log files, and the mock's request
   journal. A red run must be reproducible from the artifact folder alone.
5. **Pin what bites.** Every bug the sweep finds becomes one focused vitest
   or extension-host tripwire — house law: tests exist as tripwires for real
   breakage, and the sweep is how we *find* the breakage worth pinning.

## Cost and fragility, honestly

| Layer | Setup cost | Run time | Fragility | Finds |
|---|---|---|---|---|
| §1 extension-host LM tests | ~1 day harness | seconds per case, headless-ish | low (stable API) | provider lifecycle, streaming, cancellation, config round-trip, activation bugs |
| §2 ExTester UI suite | ~2-3 days flows | minutes per flow, real windows | medium (UI internals, version-coupled) | wizard dead-ends, webview breakage, dashboard/state divergence — the Phase-9 checklist |
| §3 Copilot Chat smoke | ~1 day + warm profile | minutes | high (their UI, not ours) | picker integration, auth-adjacent glue |
| §1+§2 rig (proxy, sweep, oracles) | ~1 day on top | overnight batch | low | the unknown-unknowns |

Windows caveat for all: each run pops real VS Code windows — overnight or a
second monitor/VM, not while he's typing. Linux CI would need `xvfb` for
§2/§3; §1 runs anywhere a display can be faked.

## Recommendation

Build in this order; each step pays rent before the next starts:

**Status (2026-10-05): Spike A is built and green.** `npm run test:e2e` (config `.vscode-test.mjs`, scenarios `test/e2e/`) runs three scenarios inside a downloaded throwaway VS Code stable with the real extension: settings-seeded activation via the vendor selector, a full tool turn asserted on the wire bytes the loopback mock actually received, and mid-flight cancellation with real connection teardown and no re-ask - 3 passing in ~5 s after the binary is cached. Kept out of `npm run build`; the VSIX payload excludes `out-e2e/` and `.vscode-test/`. No product bug fell out of the first runs: an apparent tool-name truncation was a lying fixture (it split a name that real vLLM sends complete and exactly once - verified against vllm-project/vllm parsers and their own reconstructor assertion). The rail earns its keep as the regression tripwire for activation, the wire path, and cancellation, not as a day-one bug find.

Field-verified facts from building it (trust these over assumptions):
- Wire contract, from vLLM's streaming tool parsers: the tool-call **name** arrives complete exactly once (their `StreamingToolReconstructor` asserts it); only **arguments** are diffed across deltas. Fixtures that "split the name" invent behavior no mainstream backend sends.
- `@vscode/test-cli`'s runner defaults to mocha **`ui: 'tdd'`**; a bdd suite dies with `describe is not defined` unless the config states `mocha: { ui: 'bdd' }`. It reads like an ESM loader bug; it is not - ESM test files load fine through Node's require(esm).
- `vscode.lm.selectChatModels({ vendor })` activates the extension (manifest event `languageModel_chatVendor:<vendor>`; VS Code 1.140 additionally generates `onLanguageModelChatProvider:<vendor>` from the contribution) and returns the provider's models with **no Copilot sign-in and no user pre-selection** - the harness log shows VS Code auto-selecting the model (`event=select-default`). The §1 no-auth assumption holds on 1.140.
- The `LanguageModelChat.sendRequest()` promise settles only when the provider response completes; cancellation must be armed from outside the `await` (a timer or a parallel task), never from inside the drain loop.
- Live-backend smoke (same harness, `test/e2e/live.e2e.ts`): a real-vLLM scenario set that SELF-SKIPS unless `VLLM_E2E_SERVER_URL` is set in the environment, so the default `npm run test:e2e` stays green offline. It closes the Phase-9 "real vLLM tool turn" gap the mock cannot: real discovery, tokenizer, tool parser, and streaming bytes. No hostname, key, or model id from any real deployment is ever committed; the file reads them only from the environment.
- Ergonomic entry `npm run test:e2e:live` (`scripts/run-live-e2e.mjs`): reads the developer's OWN VS Code user settings, lists configured models, asks which to use (`--model <wireId>` or `--list` for non-interactive), and hands the connection details to the test process as child env. Zero setup, zero secrets in the repo: the machine already holds the credentials because the extension itself uses them. Display law learned the loud way: this extension's generated ids EMBED the hostname (config ids read "model on host", server ids are slugged URLs), so the listing prints only wire ids and user-chosen displayNames.
- Verified: with no env the four live tests report pending; with a dead loopback URL the host process reaches `before()` and fails at `/v1/models` without echoing the hostname, proving env propagates through `@vscode/test-cli` into the extension host. First real run against a live vLLM server: 7 passing (3 mock + 4 live) in 8 s - publish, text turn, forced tool call, mid-stream cancel, all on real bytes.
- New-user onboarding walk (`test/e2e/newUser.e2e.ts`, in the same harness): empty settings → `vllm-copilot.addServerModel` → first prompt, scripted WITHOUT Selenium. Spike B's stated goal, achieved for ~80 lines instead of ExTester's 2-3 days: the test file runs in the SAME extension host as the extension, so the suite stubs `showInputBox`/`showQuickPick`/`showInformationMessage`/`showWarningMessage` in-process and the wizard's own calls hit the stubs (verified: everything between dialogs - fetch, detection, validation, settings write - is real product code). Answers are chosen by dialog TITLE, never call order (the flows fire-and-forget toasts; an order-based script is a timing house of cards), and every scripted keystroke is run through the flow's own `validateInput` first. Asserted: the dialog sequence walked, the exact settings the user keeps, and a full tool turn answered by the just-created model over the wire. Green first run: 5 passing (3 mock + 2 walk) in 6 s.
- Spike B as originally scoped (ExTester over the real renderer) remains unbuilt and now covers only what this cannot: real quickpick RENDERING, webview liveness (Deep-Dive), and dashboard tree clicks.

1. **Spike A (first): `@vscode/test-cli` + `vscode.lm` E2E.** One scenario:
   fresh instance, seed settings at the loopback mock, `selectChatModels`
   sees our models, `sendRequest` streams a tool turn, cancel mid-stream.
   Highest bug-yield per hour, lowest fragility, no Copilot dependency. If
   `selectChatModels` misbehaves without Copilot Chat installed (unverified
   assumption — verify first), install `github.copilot-chat` into the test
   instance unauthenticated as the workaround.
2. **Spike B: ExTester wizard walk.** addServer wizard → settings.json →
   Test & Refresh → tree assertion → Deep-Dive webview renders. This is the
   core of the manual Phase-9 list, scripted.
3. **The rig:** fault-injection proxy + oracles + artifact capture; wire an
   `npm run test:e2e` (kept out of `npm run build` — these are nightly
   hunters, not per-commit gates; the build gauntlet already has enough
   right to fail).
4. **Spike C, last and thin:** warm-profile Copilot Chat release-gate smoke.

This converts the manual Phase-9 acceptance from "hours of clicking" into
"run one command overnight, read the artifact report, keep the VSIX install
as final human sign-off." Acceptance stays the owner's ruling — automation
informs it, never replaces it.
