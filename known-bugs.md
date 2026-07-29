# Known Bugs And Improvements

Only outstanding issues are listed here. Fixed items belong in [CHANGELOG.md](./CHANGELOG.md); proposed features belong in [docs/feature-ideas.md](./docs/feature-ideas.md).

The list was audited against the current source and tests on 2026-07-21, with a deep review pass on 2026-07-28. Items are retained only when the behavior is reproducible from the code or the maintainability concern is concrete. Similar findings are consolidated.

---

## Maintainability And Over-Engineering

These are not necessarily user-visible failures, but they impose a concrete maintenance or packaging cost.

### P1 - Large Modules And Complex Command Closure

- **`autoConfig.ts` is a ~1,073-line multi-purpose module** (verified 2026-07-28; originally cited as ~1,040, slightly stale) - it combines preset loading, HuggingFace and vLLM fetching, config generation, BYOK utility-model setup, and progress UI. The responsibilities can be separated when this area is next changed, reducing the cost and risk of local edits.
- **`provider.ts` is a ~1,012-line orchestration module** (verified 2026-07-28; originally cited as 944, stale) - stream consumption, auto-continue retry state, post-stream diagnostics, and error classification are all coordinated here. The existing `StreamOutcome` boundary provides a natural extraction point for stream/retry handling.
- **`testAndRefreshModels` is one roughly 200-line command closure with five responsibilities** - parallel checks, mismatch correction, per-model reporting, network-gating checks, and the deep-diagnostic offer. Its modal branches are difficult to test independently. Extracting behavior-scoped helpers would leave the command as a small orchestrator without changing the intentional one-dialog-per-model UX.

### P1 - Dead migration code (`migration.ts` is cargo-culted from private repo)

- **`migration.ts::migrateToPerModelServer` and `migrateToCompositeIds` are dead code.** The repo's initial commit (2e6f710, "clean public release (neutralized internal references)") has no prior git history — it was imported from a private `vllm-2-copilot` repo. The migration reads legacy global settings from the `vllm-copilot` namespace (e.g. `vllm-copilot.serverUrl`, `vllm-copilot.temperature`), but no user of this public release has ever had those keys. The migration flag is set to `true` on first activation, so the code runs once, finds nothing, and exits. **Remove `migration.ts`, its registration in `extension.ts`, and the `vllm-copilot.apiKey` secret deletion.** This eliminates 237 lines of dead code, two globalState flags, and the latent bug documented in the Bugs section (Global-scope write shadowed by workspace-scoped `models`).

### P2 - Redundant Stream Queue Control Flow

- **`streamReader.ts` drains `eventQueue` in three near-identical places and repeats the same error/done checks** - `eventsource-parser` invokes `onEvent` synchronously during `parser.feed()`, so the drain before the next read and the final drain after the loop are redundant for the normal flow. Consolidating the post-feed drain and post-stream checks would reduce the state space future changes must reason about.
- **The auto-continue request-options ternary has a dead false arm** - when no assistant prefill exists, `provider.ts` assigns `mergedOptions` unchanged; only the continuation branch adds fields. The trackers are required, but the ternary obscures that only one request-shape mutation exists. Build a copy once and apply the continuation fields conditionally.

### P2 - Module-Level Extension Version State

- **`diagnostics.ts` stores the extension version in mutable module state** - `setExtensionVersion()` must be called during activation, and otherwise reports the sentinel `'unknown'`. This implicit dependency makes the diagnostic function harder to test and allows call-order mistakes. Pass the version into `runDiagnostics()` instead.

### P2 - Misleading Documentation And Comments
- **`streamReader.ts` says the fetch abort signal is inert after streaming starts** - the signal can cancel an in-flight body stream. The direct `reader.cancel()` listener is still useful because it interrupts the pending read directly, but the comment should describe that rationale accurately.
- **`buildAuthHeaders()` is documented as the canonical header builder without stating its scope** - runtime requests use sanitized per-model `requestHeaders` through `resolveServerConfig`; `buildAuthHeaders()` is used by write and migration paths. The JSDoc should distinguish those paths.
- **`promptReplacer.ts` parses each personality file twice** - discovery calls `loadPersonalityMeta()`, then applying the selected file calls `loadPromptReplacements()`, so the same file is read and JSON-parsed again. A shared parser can return metadata and rules together while preserving the existing discovery and application APIs.

### P2 - Untested Shared Data Layer

- **`vllmMetrics.ts` and `dashboard.ts` test coverage** (revised 2026-07-28) — `test/vllmMetrics.test.ts` is a 349-line file exercising `parseLabels`, `MetricsParser` (12+ cases), `parseRawMetrics`, `fmtPct`, and `fmtMs`. The original "zero test coverage" claim is false; the metric-line regex IS covered. **Not covered:** `fetchServerMetrics` (the HTTP layer — see the P3 shared-`AbortController` bug, where a missing test let that behavior ship), the `dashboard.ts` tree provider itself, and the formatting helpers that operate on already-aggregated counts. Prioritize tests for `fetchServerMetrics` and the dashboard tree before the deep-dive webview depends on this code.

### P2 - Smaller Structural Costs

- **`modelInfo.ts::buildModelInfo()` redeclares a partial model override shape inline** - the local structural type can silently omit fields as `ModelConfig` evolves. Reuse `ModelConfig` or name an intentional subset so the narrowing remains visible.
- **`logger.ts::clearLogFiles()` performs synchronous directory and unlink operations inside an `async` function** - clearing a large log directory blocks the extension host even though callers receive a Promise. Use the promise-based filesystem APIs or make the synchronous behavior explicit.
- **`fetchRetry.ts` uses a small `RetryLogger` strategy object for one implementation** - the only implementation is a `VllmClient` getter that writes two messages to one Output channel. Inlining the optional Output channel or a pair of callbacks would remove an abstraction that currently has no independent implementation.

### P3 - Session Manager Coupling

- **`sessionManager.ts` uses module-level mutable output-channel state** - logging depends on `setSessionManagerOutput()` having run before any operation. Passing the channel through the operations that log would make the dependency explicit and eliminate the silent-no-op fallback.
- **Several session-manager operations are declared `async` while doing synchronous SQLite work** - `deleteChatKeys()` and the database scan use `DatabaseSync`, so the event loop is still blocked despite the Promise return type. Either expose synchronous APIs or move the database work off the extension-host thread.

---

## Bugs And Issues (Deep Review — 2026-07-28)

Audited against current source. Each item is verified reproducible from the code.

### P3 - `LastRequestData.maxModelLen` stored input budget instead of context window (fixed 2026-07-29)

- **`provider.ts:595`** set `lastRequestData.maxModelLen = model.maxInputTokens || 0`, but the field represents the context window. The dashboard's "Total Tokens" line divided `input + output` by the input-only budget, mildly inflating the percentage (e.g. 44K/120K ≈ 36.7% instead of 44K/128K ≈ 34.4% for a 128K context with 8K output). **Fixed:** changed to `(model.maxInputTokens || 0) + (model.maxOutputTokens || 0)`.

### P1 - Migration writes per-model `maxModelLen` never flow through to token budgeting on re-activation

- **`migration.ts::migrateToPerModelServer`** writes migrated `models` to Global scope, but **`migrateToCompositeIds`** runs after and also writes to Global. If both migrations are needed and the user also has a workspace-scoped `models` value, the workspace value wins on read (VS Code precedence: Workspace > Global), so the migrated per-model entries are invisible and the user retains the broken global-server config. This was noted in the False Positives section as a "separate concern" but it is actually a real latent bug: the migration flag is set to `true` after the first run, so the user never gets a second chance to migrate — they're stuck with a broken config. **Note:** since the repo's initial commit (July 21, 2026) was a "clean public release (neutralized internal references)" with no prior git history, this migration code is effectively dead for all new users — nobody has legacy global settings in the `vllm-copilot` namespace. It only matters if a user manually copies settings from the old private `vllm-2-copilot` extension. **Fix:** either skip the migration flag if the write target is shadowed, or write to the same scope that currently holds the `models` value. Consider removing the migration code entirely if the public release is truly greenfield.

### P2 - Auto-continue mutation of `openaiMessages` by index is fragile

- **`provider.ts:288-329`** pushes an assistant prefill message and tracks its index in `prefillIndex` (`openaiMessages[prefillIndex] = prefillMessage`). The index mutation is safe under the current code path — `buildRequest` runs once before the loop and no messages are inserted/removed between attempts; the invariant is undocumented. **Verified 2026-07-28.**

- **Fixed (2026-07-29):** the retry condition previously fired after a pure tool-call turn (no text content, `hadContent=false`, but a finalized tool call, `hadToolCalls=true`, with `finish_reason: 'stop'`). A pure tool-call turn is a COMPLETE turn — `finish_reason: 'stop'` after a tool call is the OpenAI/vLLM convention for "done, here's my tool call" — not a failed empty response. The old condition `(!hadContent || endsWithColon) && finishReason==='stop'` couldn't distinguish "model gave nothing" from "model gave a tool call" (both have `hadContent=false`), so it re-asked the model after it already took a valid action. Added `&& !outcome.hadToolCalls` as a guard. The colon branch is already gated by `hadContent`, so the guard only affects the empty branch — exactly where it's needed. Regression test in `providerAutoContinue.test.ts`.

### P2 - `serverSettingsView.ts::saveModelConfig` matches by `vllmModelId + serverUrl`, not by composite `id`

- **`serverSettingsView.ts:182-205`** finds the existing model to update by comparing `m.vllmModelId || m.id` against `updates.vllmModelId || updates.id` **and** `m.serverUrl` against `updates.serverUrl`. After composite-id migration, models have `id = "<model> on <host>"` and `vllmModelId = "<model>"`.

- **Verified impact (2026-07-28):** the originally-claimed "overwrites a *different* model" is wrong. Tracing the edit-`serverUrl` case: `targetServer = updates.serverUrl` is the **new** URL being saved, so no existing entry with the *old* URL matches — `idx = -1` and a **duplicate entry is pushed**, leaving the old entry dangling. The result is one orphaned old-URL entry plus one new-URL duplicate, not a silent overwrite of a sibling model. The `vllmModelId + serverUrl` match is correct when two models legitimately share a `vllmModelId` on different servers (both fields must match). **Fix:** match by the composite `id` (unique per server+model pair; the webview already populates `id` from the selected model and it is the stable identity across edits), falling back to structural matching only when `id` is not set.

### P3 - Prometheus `parseLine` regex is overly permissive on label parsing

- **`vllmMetrics.ts:195`** uses `/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)$/` to parse Prometheus lines. The label regex `([^}]*)` matches everything up to the first `}`, which means labels with values containing `}` (e.g. a model name with a closing brace, which is valid in Prometheus label values since they are quoted) will fail to parse correctly. Additionally, the metric-name character class `[a-zA-Z0-9_:]*` does not include `.` — while vLLM's current metrics use underscores, the Prometheus name grammar allows dots and some custom metrics may use them. This is a low-probability issue but silently drops metrics. **Fix:** use a proper Prometheus line parser or at minimum extend the metric-name class to `[a-zA-Z0-9_:.\-]` and make the label parser quote-aware.

### P3 - `fetchServerMetrics` shared `AbortController` swallows timeout aborts as "online with empty models"

- **`vllmMetrics.ts:252-302`** allocates a single `AbortController` with a 5s timer and threads it through `/health`, `/v1/models`, `/version`, and `/metrics` in sequence. Each sub-fetch after `/health` is wrapped in `try { ... } catch { /* non-critical */ }`. **Verified 2026-07-28.** If the timer fires mid-way through `/v1/models` (e.g. a slow model list on a busy server), the abort signal trips and every subsequent sub-fetch rejects into its silent `catch { /* non-critical */ }`. The outer `try` sees `healthRes.ok === true`, so `fetchServerMetrics` returns `{ online: true, models: [], maxModelLen: null, ... }` — the dashboard reports the server as **online with zero models** rather than degraded or timed out. The earlier report's "actually correct behavior" caveat is only true when the timeout fires during the `/health` fetch itself (the outer `catch` runs and `emptyMetrics()` is returned); the mid-flight case is genuinely mishandled. **Fix:** distinguish abort errors from genuine fetch failures in the per-fetch catch blocks (e.g. `if (err.name === 'AbortError') ...`), or give `/v1/models` its own per-fetch timeout budget so a slow model list cannot erase the model set.

### P3 - Dashboard bypasses provider config cache on every poll

- **dashboard.ts::getChildren() calls getConfig(context)** on every tree refresh, which invokes `vscode.workspace.getConfiguration()` ~every 15 seconds when the sidebar is visible. VllmClient already maintains a config cache, but the dashboard has no reference to it without creating a circular dependency. At current poll intervals this is acceptable overhead, but it would become a problem if the interval drops or if settings reads grow more expensive. Consider passing a config-snapshot getter from the provider when wiring the dashboard.

### P3 - `diagnostics.ts::extensionVersion` module state causes silent failures in tests

- **`diagnostics.ts:132`** stores the extension version in a module-level `let` that defaults to `'unknown'` and is only set via `setExtensionVersion()` called from `extension.ts::activate()`. Any code path that calls `runDiagnostics()` without first setting the version (e.g. in unit tests that don't mock `extension.ts`) gets a report with `extensionVersion: 'unknown'`. This is not a runtime bug, but it makes the diagnostic output misleading in tests and could mask version-related issues. The known-bugs.md already lists this as a "P2 - Module-Level Extension Version State" under Maintainability, but it has a concrete behavioral impact on diagnostics quality.

### P3 - `sessionManager.ts::deleteChatKeys` returns 0 on `SQLITE_BUSY`, indistinguishable from "no keys"

- **`sessionManager.ts::deleteChatKeys` (line 162)** opens a `DatabaseSync` in default writable mode, runs `DELETE` on `CHAT_KEYS` (11 keys), then `db?.close()` in `finally`. On Windows, `node:sqlite`'s `DatabaseSync` uses exclusive file locking — if VS Code (or another Copilot extension instance) holds a handle to `state.vscdb`, `new DatabaseSync(dbPath)` **throws `SQLITE_BUSY`**. The `catch` block logs `[ERROR] Failed to delete keys...` and returns `0`. `cleanWorkspace()` then proceeds to `removeChatDir`, `removeChatSessions`, `removeChatEditingSessions` and reports `dbKeysRemoved: 0` to the user as if **zero keys existed** rather than "deletion failed due to a locked DB."
- **The `node:sqlite` import type resolves** via `@types/node@^26` (already in devDependencies), so this is **not** a build-breaking issue. The concern is purely the runtime `SQLITE_BUSY` behavior described above.
- **Fix**: Surface `SQLITE_BUSY` as a distinct error message ("VS Code may be using the database — close all Copilot chat sessions and retry") rather than silently reporting `0` keys removed.

### FALSE POSITIVE — `commands.ts::selectMismatchesToPrompt` is exported and called

- **Verification (2026-07-28):** `commands.ts:263` calls `selectMismatchesToPrompt(models, results)` inside `testAndRefreshModels`. The function IS used — it was not dead code. The earlier grep was scoped to test files only and missed the in-file call. **No bug.** Entry moved to False Positives.

### Code Smells

- **`provider.ts:490`** uses `(vscode as any).LanguageModelThinkingPart` (line re-verified 2026-07-28; originally cited as `provider.ts:95`, which is stale) — a runtime cast to `any` to access a proposed API. When `@types/vscode` ships the type, this cast will still compile but is no longer necessary. The comment says "Once @types/vscode ships the type, replace (vscode as any) with vscode" — this is a known tech debt item that should be tracked.
- **`vllmClient.ts:214`** — **moved to False Positives (2026-07-28):** the originally-quoted `Promise.race` / `reader.cancel` block no longer lives in `vllmClient.ts`. The streaming path was extracted to `streamReader.ts:139-152`, where the `Promise.race` + `clearTimeout(timeoutId!)` + `readPromise.catch(() => {})` pattern is correct (timeout rejects → `finally` clears the timer → cancellation-only rejection is suppressed). The original "fragile" analysis was already self-defeating and concluded "correct but fragile"; remove it. The only real concern in that code is that an uncaught `timeoutId` could theoretically be used before assignment, but it cannot happen because the `Promise` constructor runs synchronously and assigns `timeoutId` before `Promise.race` is reached.
- **`dashboard.ts:208`** — **moved to False Positives (2026-07-28):** the line number was stale (the `Promise.all` is at `dashboard.ts:238`). More importantly, the entry claims "no per-fetch timeout, one slow server blocks the entire dashboard" — but each entry in that `Promise.all` calls `fetchServerMetrics`, which has its own internal 5s `AbortController` (`vllmMetrics.ts:252-302`). The per-fetch timeout IS present, just one layer down. The only genuine concern exposed by `fetchServerMetrics`'s shared-abort behavior is documented as a P3 bug above ("fetchServerMetrics shared AbortController swallows timeout aborts").<tool_call>arg_value></tool_call>

## False Positives

Reviewed 2026-07-21. Items below were first filed as bugs and then rejected as intentional or based on a wrong premise. Kept here so future reviewers (human or AI) do not re-file the same finding.

### P1 - Writes go to `ConfigurationTarget.Global` regardless of source scope

- **`saveModelConfig`, `serverSettingsView.ts::saveModelConfig`, `migrateToPerModelServer`, and `migrateToCompositeIds` all write to Global only.** Filed because if `vllm-copilot.models` is set at workspace scope, the write is shadowed by the workspace value (VS Code precedence is Default < Global < Workspace). **Rejected as intentional:** the extension's design is "always write to global user settings"; the workspace-scope case is out of scope for now and would need an explicit design discussion. *Note for later:* `migrateToPerModelServer` clears legacy keys at *both* Global and Workspace scope but writes the migrated `models` value to Global only, so a workspace-scoped user could end up with a partially-migrated config (legacy shape still winning via workspace read). **UPDATE (2026-07-28):** This is now tracked as a P1 bug in the "Bugs And Issues" section above — the migration flag is set to `true` after the first run, so a workspace-scoped user who hits this is stuck with a broken config and never gets a second chance to migrate. **Additionally (2026-07-28):** The migration code is dead code — the repo's initial commit was a clean import with no prior git history, so no user of the public release has legacy global settings. The entire `migration.ts` module, its registration in `extension.ts`, and its test file are candidates for removal. See "Dead migration code" in the Over-Engineering section.

### P2 - `serverSettingsView.ts::saveModelConfig` matches by `vllmModelId + serverUrl`, not by composite `id`

- **Rejected (verified 2026-07-29):** the originally-claimed "overwrites a different model" was wrong (noted in the prior audit). The revised "orphan on serverUrl edit" claim is also wrong: there is no `serverUrl` edit field in the webview. The save payload's `serverUrl` comes from the server dropdown (`S.selServer`), and `vllmModelId` comes from `mc` — both are derived from the same stored config group, so they're always consistent with stored values. Switching the dropdown changes both `S.selServer` AND `mc` simultaneously. The `vllmModelId + serverUrl` match is correct and more robust than matching by composite `id` — it handles legacy entries that predate composite ids and correctly distinguishes the same model on two servers. **No bug.**

### P1 - Dashboard & webview use the first model's `requestHeaders` per `serverUrl`

- **Per-server grouped UI collapses multiple presets to one set of headers.** Filed under the premise that two presets on the same `serverUrl` could legitimately need different credentials. **Rejected:** on a real vLLM server `--api-key` is global to the process, and `--served-model-name` aliases all point at the same underlying model — so two presets on one `serverUrl` cannot have different auth. Using the first preset's headers per server is correct. *Adjacent observation (not the originally filed bug):* `requestHeaders` is stored per `ModelConfig`, so editing headers on one preset of a shared server does not propagate to the others in settings — separate concern about the data model, not the read-side "wrong credentials" claim originally filed.

### P3 — `serverSettings.js` `d.ontoggle` claimed as a no-op

- **Filed:** "in the VS Code Webview `ontoggle` only fires on user click, not programmatic `details.open` changes, so `secState` is never updated and section state is lost across re-renders."
- **Rejected (verified 2026-07-28):** In the actual `resources/serverSettings.js`, `secState` is the **only** source of expansion truth on render (`sec()` returns `isOpen = secState[title] !== false`). The `ontoggle` handler updates `secState` on user toggles. There is no code path where the rendering logic itself changes `details.open` *without* also re-deriving it from `secState` on the next render — so the "persists across re-renders" claim has no trigger. The originally-noted admission was already correct: "config values are still saved correctly" (the read path uses `[data-f]`/`[data-k]`/`.mode-card`/`[data-dk]`, not `secState`). **No bug.**

### P3 — `provider.ts::provideTokenCount` blocks event loop "while reading settings from disk"

- **Filed:** "if the config cache is cold, `await getConfigCached()` triggers `vscode.workspace.getConfiguration()` — a synchronous, blocking call… blocks the event loop while reading settings from disk."
- **Rejected mechanism (verified 2026-07-28):** `vscode.workspace.getConfiguration()` reads from VS Code's **in-memory** configuration store (loaded once at startup), not from disk. The `getConfigCached()` promise is shared across concurrent callers (single in-flight fetch, see `vllmClient.ts:38-46`), so after the first cold-start warm-up, `provideTokenCount` resolves synchronously-ish off the cached promise. The "blocks while reading from disk" mechanism is fiction. The remaining real cost (one-time cold cache populate on first `provideTokenCount`) is negligible and already swallowed inside the awaited promise. **No bug.**

### P3 — `dashboard.ts` `Promise.all` has no per-fetch timeout

- **Filed:** "no per-fetch timeout; one slow server blocks the entire dashboard refresh. Inconsistent with `vllmMetrics.ts::fetchServerMetrics` which has a 5s timeout."
- **Rejected (verified 2026-07-28):** The `Promise.all` is at `dashboard.ts:238` (originally cited as 208, stale). Each entry in that `Promise.all` calls `fetchServerMetrics`, which has its own internal 5s `AbortController` (`vllmMetrics.ts:252-302`). The per-fetch timeout IS present, just one layer down — the entry's premise contradicts itself by acknowledging the timeout exists in the same sentence. The only genuine issue exposed by shared-abort behavior in `fetchServerMetrics` is tracked separately as the P3 "fetchServerMetrics shared AbortController swallows timeout aborts" bug. **No bug here.**

### P2 — `vllmClient.ts:214` `Promise.race` reference-error/fragility claim

- **Filed:** "the `finally` block runs `clearTimeout(timeoutId!)` and proceeds to check `result.done` / `result.value` — `result` is never assigned → `ReferenceError: Cannot access 'result' before initialization`. … This is correct but fragile."
- **Rejected (verified 2026-07-28):** The `Promise.race`/`reader.cancel`/`clearTimeout(timeoutId!)` block no longer lives in `vllmClient.ts` — it was extracted to `streamReader.ts:139-152`. There, `let result: Awaited<typeof readPromise>;` is assigned inside a `try` whose `Promise.race` either resolves (assigning `result`) or rejects (transferring control to the matching `catch`, which never reads `result`). The `finally` only calls `clearTimeout(timeoutId!)` — `timeoutId` is assigned synchronously inside the Promise constructor before `Promise.race` is awaited, so the non-null assert is sound. The original entry's own paragraph already concluded "correct but fragile" — the cited failure mode (post-timeout read of uninitialized `result`) cannot occur. **No bug.**

---

## Known Limitations

- **`extractFamily` heuristic only recognizes 8 family names** — `modelUtils.ts::extractFamily` matches `codellama`, `llama`, `qwen`, `mistral`, `phi`, `gemma`, `deepseek`, `falcon`; other families (GLM/ChatGLM, Command R+/Cohere, Aya, Yi, granite, …) fall through to the org name (text before `/`). This is NOT a bug: the authoritative family is the preset-declared `family` (every bundled preset declares one) or HuggingFace's `config.model_type` (written into the stored config by auto-discovery). The heuristic is only a last-resort fallback when neither is available (manual add with HF unreachable), and the resulting family is a non-fatal sort key in the model picker — never used for routing or behavior. When a model hits this fallback path, the provider emits a `[WARN]` to the Output channel so the user knows the family is an estimate.
- **Tool results cannot carry binary or image data** — VS Code's `LanguageModelToolResultPart.content` accepts `LanguageModelDataPart`, but OpenAI's wire format only allows `string` content for `role: 'tool'` messages. The provider correctly filters `LanguageModelDataPart` in `extractToolResultContent()`. This is an OpenAI API constraint, not a fixable bug in the extension.
- **MCP servers require a utility model for local BYOK models** - Agent mode needs a utility model such as `copilot-utility-small`. On VS Code 1.128 and newer, the extension sets `chat.byokUtilityModelDefault` to `mainAgent` and offers the Configure Utility Model command. Older supported VS Code versions do not expose that setting, so users must update VS Code or avoid MCP-backed Agent mode.
- **Corporate TLS can fail on incomplete certificate chains** - VS Code's patched fetch uses the Node/OpenSSL trust path, while Windows SChannel or PowerShell can retrieve missing intermediates from the OS store. The extension does not add missing intermediates to Node's trust configuration automatically. The Diagnose Connection command compares these paths; the durable fix is for the server or proxy to send the complete chain, or for the user to configure `NODE_EXTRA_CA_CERTS`.
- **Clean Copilot Sessions does not operate on the local machine from a remote extension host** - in Remote-SSH or devcontainer contexts, `os.homedir()` points at the remote host, so the command cannot find local Copilot session storage. Run it from a local extension host instead.
