# AI Assistant Instructions

---

## General Coding Principles

These apply to any codebase.

### Workflow
1. **UNDERSTAND the BIG PICTURE** — read the task, ask clarifying questions, and confirm understanding before starting. Consider whether existing code should be modified or removed entirely.
2. **ANALYZE first** — read files, understand the current state. Never assume.
3. **PROPOSE significant changes** before acting (new files, architectural shifts, removing functionality). Small, obvious fixes (typos, formatting, trivial renames, clear bug fixes) can be applied directly.
4. **If you make a mistake: STOP.** Tell the user immediately — don't hide it, silently fix it, or degrade features to paper over it.

### NEVER DO THESE (without explicit user approval)
- **Run destructive git commands:** `git checkout`, `git stash`, `git reset`, `git clean`, etc.
- **Revert or overwrite files without checking contents first.**
- **HARD RULE, THE BIG ONE: DO NOT PUSH unless the user explicitly asks for a push in that moment.** Not "commit and push" for a trivia file, not "ok", not a previous session's approval, not your own judgment that the unit is ready. Committing locally to save work: always fine, as many commits as you like. A push needs the user's live words ("push it", "commit and push" for a COHERENT UNIT). One push per coherent unit: collapse your micro-commits silently (soft reset, recommit, bland message) before pushing - a push of a test-mock tweak or a two-line wording edit is unacceptable (owner rage 2026-09-04 after 19 pushes since 1.35.3).
- **Change Version** without asking. Never change version. Version change and number must be allowed by the user.
- **Version numbers say NOTHING about releases.** A `-rcN` version in `package.json` means: internal work on a new version, NOT shipped, NOT published, history still editable (untagged rc = draft, squashing it is hygiene). Even a plain version number is not a release until the owner ships it, with live words, in that moment. Never conclude from any version that it "was released", never propose publish/announce/celebrate actions because a version exists. (Owner introduced rc numbering precisely because AIs kept assuming a declared version was a published one, 2026-09-04.)

### Communication
- **Be brief.** Skip fluff, include details only when it matters for decisions or debugging.
- **Summarize your work** when done: what changed, why, and any assumptions made.
- **Ask clarifying questions** when a task is ambiguous — don't guess. Use the Questions tool.
- **Contradict the user** if you believe they are wrong or missing something. Be direct, not deferential.

### Simplicity Over Complexity
- **Question necessity first.** What is the overall purpose? Is the approach actually necessary? If in doubt or unclear, push back or ask.
- **Deleting code is better than adding code.** If existing code no longer serves the goal, remove it. No code is sacred.
- **Prefer fewer files, fewer functions, fewer lines.** Each addition has a maintenance cost.
- **Don't build workarounds on top of workarounds.** Fix the root cause — which is often deleting the problematic code entirely.
- **Pause and reconsider the big picture.** After three or more edits for one problem, stop. Re-read the original goal and propose a simpler path.
- **If the higher purpose is unclear, ask.** Don't guess. Every line of code should serve a user-facing feature.
- **Verified bugs can be fixed directly.** Evaluate bugs twice (be sure it is a bug). If after second evaluation high confidence → fix. Medium/low confidence → ask first.

### Thoroughness
- **Check your work.** Code review your changes and check linter for errors and warnings. 
- **Run tests.** Verify existing tests pass and add tests for new behavior.
- **Point out issues** even if unrelated to the current task. Inform the user. Prefer proactive feedback over silence.
- **Update docs** if your changes affect README, docs/code-review.md, or other documentation.

### Task Approach
- **Decompose, then verify.** Split work into individually verifiable steps. Don't try to do everything at once.
- **Read before writing.** Understand the existing pattern. If existing code is wrong, propose a fix first — don't blindly copy-paste.
- **Use available MCP tools (Context 7) and web search** for API behavior. Training data may be outdated.

---

## This Repository: vLLM-Copilot

### Architecture: Server Registry, Models Reference It
- **Servers are registry entries.** The top-level `vllm-copilot.servers` setting is an explicit lookup table of server entries (`id`, `serverUrl`, optional `requestHeaders`, `serverType`, `displayName`). Each model entry in `vllm-copilot.models` has a required `id` and `server` (the registry entry's id) — models never carry URLs, auth headers, server types, or server labels.
- **The global settings are the `servers` registry plus the standalone toggles/diagnostics keys** (`enableFileLogging`, `logBodyLimit`, `systemMessageCapture`, `fixEmptyToolParameters`, `dashboard.pollIntervalMs`). Everything else lives inside a `servers` entry or a `models` entry.
- There is NO global `serverUrl`, `apiKey`, `requestHeaders`, or sampling params. The registry is not "a global server" — it is a table; nothing may resolve a server unless a model references its entry.
- The discovery logic must NOT probe a "global server" — it groups models by their `server` reference (resolved through the registry) and discovers from each server independently.
- There are NO deprecated legacy fields on `VllmConfig` — `serverUrl`, `apiKey`, and `requestHeaders` were removed outright by the registry migration.

### Version Compatibility
- **Only support newest versions.** Don't add workarounds for old versions unless explicitly requested. This goes for vLLM, VS Code, Copilot.
- Always use the latest version of any library or framework unless the user specifies otherwise. However, this version must be supported by Copilot, VS Code and vLLM.

### Build & Test
- **Compile:** `npm run compile` (runs `tsc -p ./`). This type-checks `src/` ONLY — it never proves the test files compile.
- **Test:** `npm test` (Vitest). Tests exist only as tripwires for real breakage (wire format, settings.json writes, provider lifecycle) — no coverage metric, no ceremony tests.
- **Package a VSIX:** `npm run build` = compile + vitest + **test typecheck** (`tsc -p test/tsconfig.json`) + vsce package. `test/tsconfig.json` extends the root tsconfig, so any compiler flag added at root also applies to `test/**`.
- **Gauntlet rule:** any tsconfig/compiler-flag change must be verified with `npm run build` (or at least `npx tsc -p test/tsconfig.json --noEmit`). Verifying only compile+test+dep:check once shipped an rc that failed its own build (35 dead test symbols, 2026-09-05). Neither `npm run rent` nor `npm run dep:check` type-checks `test/**`.

### Changelog Policy
- **Only issues a user actually experienced in a SHIPPED version get a `Fixed` entry.** A bug that was introduced and fixed within the same unreleased cycle is work-in-progress, not news — no entry, ever. This includes bugs seen only during the author's own rc/VSIX testing: an unpublished rc is not a shipped version.
- **New features deserve entries.** Internal refactors and implementation details do not.
- **Never compare against never-shipped intermediate behavior** ("before, during this rc, X happened"). If no user ever saw it, it never happened.
- **Intent before content, always.** A release gets a short intent paragraph directly under the version heading (the goal of the release, why it exists), before `### Added`. Each major structural change likewise states its goal first, then the change as its consequence. Never bury the why mid-paragraph, and state it once: the release-level intent paragraph replaces per-entry restatements of the same goal.
- Be terse in the changelog - this is for users to read. The commit messages can be verbose - those are for AI to read.
- **PowerShell: never put `$(...)` in a double-quoted git commit message** — PowerShell command-substitutes it and silently corrupts the message. Use single quotes.
- **`package.json` `changelog` field points at the CHANGELOG.md blob URL, never at GitHub releases.** Marketplace versions and git releases are deliberately different things; not every version gets a git release. Note: a VSIX-installed extension shows the packaged `CHANGELOG.md` snapshot in the extension page's CHANGELOG tab and ignores the manifest field; the field only feeds Marketplace installs.

### code-review.md Policy
- `docs/code-review.md` tracks **live issues only**. When a finding is fixed, DELETE its entry in the same commit. No status sections, no "fixed by" annotations, no archives, no grades: git history holds what was done, and nobody reads accomplishment logs. Rejection lists, deferred architecture, and accepted product decisions stay (standing rulings, not history).

### Standing Review Rulings (owner-decided — do not re-propose)
- The >50K floor on configured `contextWindow` (`isValidContextWindow`) is intentional: distrust user guesses below Copilot's usable headroom. The asymmetry with server-reported windows (>0) was ruled WAD by the owner (2026-09-10).
- `detectServerType` aux probes (LM Studio/Ollama): hard errors (403/405/5xx) abort ONLY when no `/v1/models` candidate exists; with a candidate they fall through to the vllm gateway classification.
- `listServerModels` shares the layer-1 list memo with the resolvers; Test & Refresh clears both memo layers at pass START for live truth. The ≤5s staleness for the Model Settings badge consumer is owner-accepted — do not add a bypass.

### Key Storage
- All keys (vLLM API and HTTP headers) are stored in plain text in settings. This is fine. Do not surface this as an error. Putting secrets into secret storage maybe worthwhile for something but not here. This is a key project decision and if the Laptop of a user gets compromised and password hacked, it will be simple to get the keys from secret storage. So the only reason would be screenshots that are pasted on the internet. Well - so far it is easier to work with keys in plaintext. Do not surfact this error when code reviewing.
- Do avoid keys in any other location. Never in the codebase! If you ever find keys or servernames in this codebase, immediately stop and push to git and inform the user vehemently. But user settings are not in the codebase.

## Project Architecture

This is a **VS Code Language Model Chat Provider extension** that routes Copilot requests through a local vLLM server. Data flow:

```
Copilot → provider/provider.ts (VllmChatModelProvider) → provider/vllmClient.ts → vLLM server
```

### Extension placement invariant

`package.json` keeps `"extensionKind": ["workspace"]`. In a remote window, request code must run on the workspace host beside the remote vLLM or OpenRouter endpoint so addresses such as `localhost:8000` keep their intended meaning. Keep workspace-only placement; UI or mixed placement is not a fallback. If the optional local config-file backend is enabled, the workspace-hosted extension reaches the client file through VS Code's local `vscode-userdata:` provider, with no second extension. That route is verified end to end (local write, WSL read/write, automatic local observation in the open editor); the mechanism, the VS Code source facts, and the rebuild procedure live in `docs/remote-local-file-bridge.md`.

### Core layout:
| Path | Responsibility |
|---|---|
| `src/extension.ts` | Activation, command registration, lifecycle |
| `src/types.ts` | Shared wire-format types & SSE events only. No business logic. |
| `src/provider/` | Request path: `provider.ts` (`LanguageModelChatProvider` impl, streams to Copilot), `vllmClient.ts` (HTTP client, config cache owner), `requestBuilder.ts`/`chatTransport.ts`, `streamOrchestrator.ts`/`consumeStream.ts`, `streamReader.ts` + `sseParser.ts` (SSE), `messageConverter.ts` (VS Code ↔ OpenAI/vLLM formats), `modelInfo.ts` (picker info + family detection), `systemMessagePipeline.ts` (personality/capture), `discovery.ts`, `postStream.ts` |
| `src/state/` | `config.ts` (types `VllmConfig`/`ModelConfig`, validation, resolution helpers), `configStore.ts` (the sole settings.json writer), `serverCore.ts` + `serverRegistry.ts` (registry entries, URL/identity rules) |
| `src/commands/` | User-facing commands: add server/model flows, auto-configure + HF discovery, auth rotation, presets (bundled + remote), personalities, Test & Refresh |
| `src/migrations/` | One-shot config migrations at activation (registry migration, output-length offer) |
| `src/backends/` | Backend specifics: OpenRouter catalog/aliases, runtime limits (per-backend context windows) |
| `src/ui/` | Dashboard tree, Deep-Dive + Server Settings webviews, Connection Diagnostics |
| `src/usage/` | Usage store (`usage.json` persistence) + usage reporting to Copilot |
| `src/shared/` | File logger, fetch retry, token budget, session manager, error envelope, config-schema tool |

### Key patterns:
- **Config ownership:** `VllmClient` owns the config cache. Everyone reads through it. Single source of truth — adding a second cache causes stale reads.
- **Types in `types.ts`** exist only to break circular imports. No logic lives there.
- **Model overrides** (`model-configs/`) let users customize server models (modes, capabilities, token limits).
- **ESM throughout.** All imports use `.js` extensions per TypeScript 5+ ESM rules.

### Test structure:
- Unit tests in `test/*.test.ts`. Tests exist only as tripwires for real breakage (wire format, settings.json writes, provider lifecycle, shipped-bug canaries) — no coverage metric, no ceremony tests.
- Integration tests in `test/integration/`.
- Mocks in `test/__mocks__/vscode.ts` — VS Code API is mocked at the module level.

## VS Code Extension Conventions

Non-negotiable for this codebase:

- **Everything that allocates resources must be `Disposable`.** Timers, event listeners, output channels, providers — all disposed in `dispose()` and pushed to `context.subscriptions` in `activate()`.
- **Cancellation tokens must be respected.** `chatCompletionStream()` receives a `vscode.CancellationToken`. Check `token.isCancellationRequested` in loops; pass `AbortSignal` to `fetch()`.
- **API keys are stored in plain text in settings, by project decision** (see Key Storage). Do not "fix" this by moving keys to `context.secrets` — that rule was reversed on purpose. Keys may still be redacted from user-visible logs and diagnostics.
- **`enabledApiProposals` was removed from `package.json` (2026-09-10, verified against VS Code 1.137 source).** `chatProvider` graduated to stable (in `@types/vscode` since ≥1.128, ungated at runtime). `LanguageModelThinkingPart` is still proposal-only in TYPES but ungated at runtime — reached via feature detection in `consumeStream.ts`. Declarations we are not allowlisted for do nothing except log a `CANNOT USE these API proposals` ERR in every production window. Only re-add an entry when actually testing a live proposal in an F5 dev host (dev mode grants declared proposals), and remove it before shipping.
- **Event emitters must be disposed.** `vscode.EventEmitter.dispose()` cancels firing and clears listeners.
- **Settings changes fire `onDidChangeConfiguration`.** React to them — never require reload. Cache invalidation is the pattern.
- **Output channels are for user-visible logs.** Use structured format: `[INFO]`, `[WARN]`, `[ERROR]`.

### Verified VS Code API facts (field-tested — trust these over doc tools)

The `get_vscode_api` doc tool returns stale proposal-era docs. Source of truth: `node_modules/@types/vscode/index.d.ts`.

- The Copilot model picker does NOT re-query providers when opened — it renders VS Code's cache; only the provider's `onDidChangeLanguageModelChatInformation` event re-renders it. `provideLanguageModelChatInfo` runs on activation, `selectLanguageModels()`, and provider change events (all `silent: true` for us).
- A provider THROWING during model resolve surfaces as a passive vendor-group status line inside the picker (never a popup) and is vendor-wide — it wipes ALL rows. Useless for per-model failures: keep unreachable models as OFFLINE rows instead.
- `TreeDragAndDropController<T>` requires BOTH `dragMimeTypes` and `dropMimeTypes`; `handleDrag` MUTATES the transfer (no return). Self-drop (reorder) needs the tree's own mime `application/vnd.code.tree.<viewidlowercase>` in `dropMimeTypes`. Full autopsy incl. impossible-API bans (no between-row indicator, ghost-gap hack forbidden): `docs/dashboard-dnd.md`.
- Static `arguments` in `view/item/context` menu contributions do NOT reach the command (silent no-op with undefined args). Encode variants in separate command identities, never in contribution arguments.
- Menu-contribution `title` overrides in `view/item/context` are IGNORED (VS Code 1.128, tested). The `contributes.commands` title is the single source of truth for tree context-menu labels.

### Webview View Conventions

- **External JS/CSS files in `resources/` are NOT compiled by TypeScript.** Always validate with `node --check resources/*.js` after changes. Run `npm run validate-webview-js` to check all shipped Webview JavaScript.
- **Never put inline `<script>` inside template literals.** The `</script>` closing tag will terminate the script block prematurely regardless of escaping. Always use separate `.js` files loaded via `<script src="${webview.asWebviewUri(uri)}">`.
- **Use a ready handshake.** Webview installs message listener → posts `{ type: 'ready' }` → extension sends initial state. Do NOT post data immediately after setting `webview.html` (race condition).
- **Restrictive CSP from the start.** Use `default-src 'none'; style-src ${cspSource}; script-src ${cspSource};` — never omit CSP. `style-src 'unsafe-inline'` is a deliberate, documented exception across all three shipped webviews: our webview code sets element styles directly at runtime, and `script-src` stays locked to `${cspSource}` with no `unsafe-inline` or `unsafe-eval`. Do not "fix" the style exception by refactoring inline styles into CSS files; that is hours of churn for no security gain. New webviews should still start from the restrictive policy and add the exception only if they need it.
- **Convert local asset URIs with `webview.asWebviewUri()`.** Set `localResourceRoots` to the actual asset directory.
- **Webview JS has no TypeScript checking.** Common gotchas: `element?.onclick = fn` is a parse error (optional chaining can't be on LHS of assignment), `ontoggle` not `onToggle`, etc.
- **Debug blank or noninteractive Webviews with `Developer: Open Webview Developer Tools`** — check the webview console before changing the architecture.

## Anti-Patterns

Things this codebase has been burned by — don't repeat:

- **Global server probing at discovery.** There is no global server. The registry is a lookup table, not a default. Discovery groups models by their `server` reference. Do not add a "global server" fetch path.
- **Duplicate config caching.** Only `VllmClient` caches config. Other files read through it.
- **SSE parsing in the provider.** `streamReader.ts` owns SSE line parsing (via `eventsource-parser`); `sseParser.ts` owns JSON parsing + tool call accumulation. `provider.ts` consumes structured events.
- **Hand-rolled SSE parsing.** The prior hand-rolled parser was replaced with `eventsource-parser` (battle-tested, used by Vercel AI SDK). Do not revert to manual line parsing.
- **String-based type guards when interfaces exist.** Use the types in `types.ts`. If a cast is needed, document why.
- **Loading all model configs unconditionally.** `model-configs/` can grow. Load selectively.
- **Synchronous blocking in async callbacks.** VS Code callbacks are async. Don't await in constructors or sync paths.
- **`openRouterFlow.ts` importing from `addServerFlow.ts`.** The Add wizard imports the OpenRouter flow (as a step-0 branch); a reverse import is a module cycle. The duplicated confirm+save UX is deliberate — do not "unify" it. Keyless connections stay filtered out of the onboarding reuse picker (reuse would 401 at chat).
- **Removing the empty-tool-`parameters` injection as a "pointless workaround".** Some OpenRouter providers answer a 200 then 502 mid-stream when any tool definition omits `parameters` — VS Code Copilot emits no `parameters` key for zero-argument tools. `requestBuilder.ts` injects `{ type: "object", properties: {} }`, gated by the `fixEmptyToolParameters` setting (default on). Verified by binary search on a live 502 body; do not delete it.

---

## Structural / Over-engineering Reviews

Repo-specific essentials only. The full law, ledger, standing doctrine, pre-emptively-waived list, and complete tooling details live in `docs/complexity-audit.md` — read it before running a review; it is the single repo-side source. When asked for a structural review or over-engineering hunt:

- **Paths, not files.** Enumerate user-visible functional paths; state each path's **Intent** first — over-engineering is only measurable against a stated purpose. One mermaid call-flow diagram per path; judge by graph shape (fan-out, pass-through layers, back-edges, dual ownership, special-case branches, asymmetry). Graphs miss semantic bloat: when a node label looks suspiciously simple for its Intent, read the function.
- **Review mode stays on.** Nothing gets edited during diagramming. Findings are `P<path>-<n>` IDs (never F-prefixed — F is a cluster label) with severity and user decision recorded in the ledger; the user rules on every finding before code changes. Cluster-analyze, cluster-fix; accepted amputations execute as one commit unit.
- **Rent law (pass 2).** Every function/module/file must be genuinely large OR have ≥2 independent production call sites (distinct caller functions inside the home file count; unit tests are NOT customers). Small single-caller helpers get absorbed; single-caller sequential chains doing one job collapse into ONE function. "Large" is per-case (phases/branches, no line quota); "consistency" alone does not pay rent. A newly proposed named thing must cite its census rent or its Intent-phase argument. Structure beats test seams: reroute or replace the test, never keep bad structure for ceremony.
- **Tooling:** `npm run dep:check` (file-level gates, two cruises), `npm run rent` (function rent census), `npm run cluster` (placement), `npm run dep:graph`. Before executing any amputation unit, re-run `npm run rent -- --tsv` and verify the unit's caller claims against the fresh table — and diff after. Trust nothing: not memory, not the audit's own tables, not a reviewer agent's report — verify every published claim against bytes. ENTRY-class wiring (`register*`/`ensure*` whose sole caller is the `extension.ts` activation block) is never absorb-bait.
- The review persona itself is the user-level language-agnostic `Structural Review` agent (settings-synced); this repo keeps no copy of its description.