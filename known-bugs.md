# Known Bugs And Improvements

Only outstanding issues are listed here. Fixed items belong in [CHANGELOG.md](./CHANGELOG.md); proposed features belong in [docs/feature-ideas.md](./docs/feature-ideas.md).

The list was audited against the current source and tests on 2026-07-21, with a deep review pass on 2026-07-28. Items are retained only when the behavior is reproducible from the code or the maintainability concern is concrete. Similar findings are consolidated.

---

## Maintainability And Over-Engineering

These are not necessarily user-visible failures, but they impose a concrete maintenance or packaging cost.

### P1 - Large Modules And Complex Command Closure

- **`autoConfig.ts` is a ~1,040-line multi-purpose module** - it combines preset loading, HuggingFace and vLLM fetching, config generation, BYOK utility-model setup, and progress UI. The responsibilities can be separated when this area is next changed, reducing the cost and risk of local edits.
- **`provider.ts` is a 944-line orchestration module** - stream consumption, auto-continue retry state, post-stream diagnostics, and error classification are all coordinated here. The existing `StreamOutcome` boundary provides a natural extraction point for stream/retry handling.
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

- **`vllmMetrics.ts` and `dashboard.ts` have zero test coverage** — the Prometheus parser (`MetricsParser`), aggregation logic, formatting helpers, and raw-data fetcher (`fetchServerRawData`) are shared between the sidebar and the upcoming deep-dive webview, but have no unit or integration tests. A bug in metric-line regex parsing would silently corrupt every dashboard poll. Prioritize parser tests before the webview depends on this code.

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

### P1 - `LastRequestData.maxModelLen` stores input budget, not context window

- **`provider.ts:587`** sets `lastRequestData.maxModelLen = model.maxInputTokens || 0`, but the field is documented as "context window (max_model_len from server)". `model.maxInputTokens` is only the input half of the context window (context minus output budget). The actual `maxModelLen` from `deriveTokenBudget` is available but never set on the `LanguageModelChatInformation` object, so the provider can't access it. **Impact:** the dashboard's "Total Tokens" line shows `input + output` as a percentage of `maxInputTokens` only, so context-window usage is inflated to 2× the real number (e.g. 50% utilization displays as 100%). **Fix:** either set `maxModelLen` on the model info object in `modelInfo.ts::buildModelInfo()`, or compute it as `model.maxInputTokens + model.maxOutputTokens` at the call site in `provider.ts`.

### P1 - Migration writes per-model `maxModelLen` never flow through to token budgeting on re-activation

- **`migration.ts::migrateToPerModelServer`** writes migrated `models` to Global scope, but **`migrateToCompositeIds`** runs after and also writes to Global. If both migrations are needed and the user also has a workspace-scoped `models` value, the workspace value wins on read (VS Code precedence: Workspace > Global), so the migrated per-model entries are invisible and the user retains the broken global-server config. This was noted in the False Positives section as a "separate concern" but it is actually a real latent bug: the migration flag is set to `true` after the first run, so the user never gets a second chance to migrate — they're stuck with a broken config. **Note:** since the repo's initial commit (July 21, 2026) was a "clean public release (neutralized internal references)" with no prior git history, this migration code is effectively dead for all new users — nobody has legacy global settings in the `vllm-copilot` namespace. It only matters if a user manually copies settings from the old private `vllm-2-copilot` extension. **Fix:** either skip the migration flag if the write target is shadowed, or write to the same scope that currently holds the `models` value. Consider removing the migration code entirely if the public release is truly greenfield.

### P2 - Auto-continue mutation of `openaiMessages` by index is fragile

- **`provider.ts:296-310`** pushes an assistant prefill message and tracks its index in `prefillIndex`. On retry, it replaces `openaiMessages[prefillIndex]` with a grown prefill. This works for two attempts, but the logic doesn't guard against `prefillIndex` becoming stale if `openaiMessages` is modified by an intermediate step (e.g. if `processSystemMessages` or `convertMessages` were to change the array length — currently they don't, but the invariant is undocumented). More importantly, the prefill message is always `{ role: 'assistant', content: assistantPrefill }` with no `tool_calls`, so if the model's first attempt emitted a tool call that wasn't consumed, the retry sends it as plain text content — the server may misinterpret the tool call arguments as user-visible text. **Fix:** either document the invariant (no messages are inserted/removed between retries) or restructure to rebuild the message array rather than mutate by index.

### P2 - `serverSettingsView.ts::saveModelConfig` matches by `vllmModelId + serverUrl`, not by composite `id`

- **`serverSettingsView.ts:195-204`** finds the existing model to update by comparing `m.vllmModelId || m.id` against `updates.vllmModelId || updates.id`. After composite-id migration, models have `id = "<model> on <host>"` and `vllmModelId = "<model>"`. If two models have the same `vllmModelId` but different `serverUrl`s (legitimate, same model on two servers), and you edit one, the match is correct because `serverUrl` is also compared. But if you edit a model whose `vllmModelId` was not set (so `id` is used as the wire identity) and the server URL was changed, the match still uses the old `serverUrl` from `updates` — which is the new value being saved. This means changing a model's `serverUrl` via the settings webview can cause it to overwrite a *different* model if it happens to have the same `vllmModelId`. **Fix:** match by the composite `id` (which is unique per server+model pair), falling back to structural matching only when `id` is not set.

### P3 - Prometheus `parseLine` regex is overly permissive on label parsing

- **`vllmMetrics.ts:195`** uses `/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)$/` to parse Prometheus lines. The label regex `([^}]*)` matches everything up to the first `}`, which means labels with values containing `}` (e.g. a model name with a closing brace, which is valid in Prometheus label values since they are quoted) will fail to parse correctly. Additionally, the metric-name character class `[a-zA-Z0-9_:]*` does not include `.` — while vLLM's current metrics use underscores, the Prometheus name grammar allows dots and some custom metrics may use them. This is a low-probability issue but silently drops metrics. **Fix:** use a proper Prometheus line parser or at minimum extend the metric-name class to `[a-zA-Z0-9_:.\-]` and make the label parser quote-aware.

### P3 - `fetchServerMetrics` timeout aborts in-flight fetches without per-fetch error handling

- **`vllmMetrics.ts:252-302`** sets a 5-second timeout via `AbortController` and then performs sequential `fetch` calls with the abort signal. If the timeout fires during the health check, the signal aborts, and the subsequent `fetch` calls for models/version/metrics will also be aborted. The `catch { /* non-critical */ }` blocks around individual fetches swallow abort errors silently, but the health check fetch has no try/catch — if the timeout fires during the health check, the `fetch` throws an `AbortError` that is caught by the outer `try/catch` and returns `emptyMetrics()`. This is actually correct behavior, but the silent swallowing of model/metrics fetch errors means a timeout during the models-fetch can make the dashboard report `models: []` even when the server is healthy. **Fix:** distinguish abort errors from genuine fetch failures in the catch blocks, so aborted fetches are not treated as server errors.

### P3 - `provider.ts::provideTokenCount` returns a synchronous promise that blocks the event loop

- **`provider.ts:669`** is an `async` function that calls `await this.client.getConfigCached()`. If the config cache is cold, this triggers a full `getConfig()` which calls `vscode.workspace.getConfiguration()` — a synchronous, blocking call. VS Code calls `provideTokenCount` repeatedly during chat to compute token budgets. If the config isn't cached yet (or was just invalidated), the first token-count call blocks the event loop while reading settings from disk. **Fix:** ensure the config is pre-warmed during activation, or make the token-count path fall back to the default estimate (3.5 chars/token) when config isn't available, rather than awaiting the cache.

### P3 - `diagnostics.ts::extensionVersion` module state causes silent failures in tests

- **`diagnostics.ts:132`** stores the extension version in a module-level `let` that defaults to `'unknown'` and is only set via `setExtensionVersion()` called from `extension.ts::activate()`. Any code path that calls `runDiagnostics()` without first setting the version (e.g. in unit tests that don't mock `extension.ts`) gets a report with `extensionVersion: 'unknown'`. This is not a runtime bug, but it makes the diagnostic output misleading in tests and could mask version-related issues. The known-bugs.md already lists this as a "P2 - Module-Level Extension Version State" under Maintainability, but it has a concrete behavioral impact on diagnostics quality.

### Code Smells

- **`provider.ts:95`** uses `(vscode as any).LanguageModelThinkingPart` — a runtime cast to `any` to access a proposed API. When `@types/vscode` ships the type, this cast will still compile but is no longer necessary. The comment says "Once @types/vscode ships the type, replace (vscode as any) with vscode" — this is a known tech debt item that should be tracked.
- **`vllmClient.ts:214`** constructs the inactivity timeout using `Promise.race` with a `setTimeout` that calls `reader.cancel()`. If the timeout wins the race, `readPromise.catch(() => {})` is called to suppress the rejection, but the `finally` block still runs `clearTimeout(timeoutId!)` and then proceeds to check `result.done` / `result.value` — which will be `undefined` because `result` was never assigned. The `Promise.race` rejects (not resolves) on timeout, so `result` is never assigned and the `finally` block throws a `ReferenceError: Cannot access 'result' before initialization`. **Wait — this is actually a latent bug:** if the `timeoutPromise` rejects before `readPromise` resolves, the `try { result = await ... }` block throws, the `finally` runs, and then the `catch` block handles the error. So `result` is never used after a timeout. But the `finally` calls `clearTimeout(timeoutId!)` with a non-null-assert that's technically valid because `timeoutId` is assigned in the `Promise` constructor. This is correct but fragile.
- **`dashboard.ts:208`** uses `Promise.all` to fetch metrics for all servers in parallel, but there's no per-fetch timeout (unlike `vllmMetrics.ts::fetchServerMetrics` which has a 5s timeout). Each server fetch could hang indefinitely, and since they're all in `Promise.all`, one slow server blocks the entire dashboard refresh. This is inconsistent with the metrics fetcher's timeout behavior.<tool_call>arg_value></tool_call>

Reviewed 2026-07-21. Items below were first filed as bugs and then rejected as intentional or based on a wrong premise. Kept here so future reviewers (human or AI) do not re-file the same finding.

### P1 - Writes go to `ConfigurationTarget.Global` regardless of source scope

- **`saveModelConfig`, `serverSettingsView.ts::saveModelConfig`, `migrateToPerModelServer`, and `migrateToCompositeIds` all write to Global only.** Filed because if `vllm-copilot.models` is set at workspace scope, the write is shadowed by the workspace value (VS Code precedence is Default < Global < Workspace). **Rejected as intentional:** the extension's design is "always write to global user settings"; the workspace-scope case is out of scope for now and would need an explicit design discussion. *Note for later:* `migrateToPerModelServer` clears legacy keys at *both* Global and Workspace scope but writes the migrated `models` value to Global only, so a workspace-scoped user could end up with a partially-migrated config (legacy shape still winning via workspace read). **UPDATE (2026-07-28):** This is now tracked as a P1 bug in the "Bugs And Issues" section above — the migration flag is set to `true` after the first run, so a workspace-scoped user who hits this is stuck with a broken config and never gets a second chance to migrate. **Additionally (2026-07-28):** The migration code is dead code — the repo's initial commit was a clean import with no prior git history, so no user of the public release has legacy global settings. The entire `migration.ts` module, its registration in `extension.ts`, and its test file are candidates for removal. See "Dead migration code" in the Over-Engineering section.

### P1 - Dashboard & webview use the first model's `requestHeaders` per `serverUrl`

- **Per-server grouped UI collapses multiple presets to one set of headers.** Filed under the premise that two presets on the same `serverUrl` could legitimately need different credentials. **Rejected:** on a real vLLM server `--api-key` is global to the process, and `--served-model-name` aliases all point at the same underlying model — so two presets on one `serverUrl` cannot have different auth. Using the first preset's headers per server is correct. *Adjacent observation (not the originally filed bug):* `requestHeaders` is stored per `ModelConfig`, so editing headers on one preset of a shared server does not propagate to the others in settings — separate concern about the data model, not the read-side "wrong credentials" claim originally filed.

### P3 - Dashboard bypasses provider config cache on every poll

- **`dashboard.ts::getChildren()` calls `getConfig(context)` on every tree refresh**, which invokes `vscode.workspace.getConfiguration()` ~every 15 seconds when the sidebar is visible. `VllmClient` already maintains a config cache, but the dashboard has no reference to it without creating a circular dependency. At current poll intervals this is acceptable overhead, but it would become a problem if the interval drops or if settings reads grow more expensive. Consider passing a config-snapshot getter from the provider when wiring the dashboard in `extension.ts`.

---

## Known Limitations

- **`extractFamily` heuristic only recognizes 8 family names** — `modelUtils.ts::extractFamily` matches `codellama`, `llama`, `qwen`, `mistral`, `phi`, `gemma`, `deepseek`, `falcon`; other families (GLM/ChatGLM, Command R+/Cohere, Aya, Yi, granite, …) fall through to the org name (text before `/`). This is NOT a bug: the authoritative family is the preset-declared `family` (every bundled preset declares one) or HuggingFace's `config.model_type` (written into the stored config by auto-discovery). The heuristic is only a last-resort fallback when neither is available (manual add with HF unreachable), and the resulting family is a non-fatal sort key in the model picker — never used for routing or behavior. When a model hits this fallback path, the provider emits a `[WARN]` to the Output channel so the user knows the family is an estimate.
- **Tool results cannot carry binary or image data** — VS Code's `LanguageModelToolResultPart.content` accepts `LanguageModelDataPart`, but OpenAI's wire format only allows `string` content for `role: 'tool'` messages. The provider correctly filters `LanguageModelDataPart` in `extractToolResultContent()`. This is an OpenAI API constraint, not a fixable bug in the extension.
- **MCP servers require a utility model for local BYOK models** - Agent mode needs a utility model such as `copilot-utility-small`. On VS Code 1.128 and newer, the extension sets `chat.byokUtilityModelDefault` to `mainAgent` and offers the Configure Utility Model command. Older supported VS Code versions do not expose that setting, so users must update VS Code or avoid MCP-backed Agent mode.
- **Corporate TLS can fail on incomplete certificate chains** - VS Code's patched fetch uses the Node/OpenSSL trust path, while Windows SChannel or PowerShell can retrieve missing intermediates from the OS store. The extension does not add missing intermediates to Node's trust configuration automatically. The Diagnose Connection command compares these paths; the durable fix is for the server or proxy to send the complete chain, or for the user to configure `NODE_EXTRA_CA_CERTS`.
- **Clean Copilot Sessions does not operate on the local machine from a remote extension host** - in Remote-SSH or devcontainer contexts, `os.homedir()` points at the remote host, so the command cannot find local Copilot session storage. Run it from a local extension host instead.
