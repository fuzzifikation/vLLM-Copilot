# Changelog

## v1.22.0 — Token & Cost Usage Tracker

### Added

- **Cumulative Token Usage tracker in the Dashboard** — a new **Token Usage** node under each server shows **Today / Session / Total** token counts (input, output, cached, reasoning) with a per-model breakdown. Persisted across reloads in `globalState` (day buckets, 90-day retention). Includes a per-server **Reset Usage** action and a `vLLM-Copilot: Reset Usage` palette command (all / per-server scope).
- **Per-model cost tracking** — optional `cost` config on each model entry (`input` / `output` / `cachedInput`, per 1,000,000 tokens, in a `currency` unit defaulting to `USD`, or `"AI Credits"` for Copilot-picker comparison). Cost is derived at render time from the stored token counts, so editing a rate re-prices all history without migration. Shown on the per-model Token Usage rows and as a **Cost** row on the Last Request node.
- **`Set Cost…` entry point** — right-click the **Token Usage** node to configure a model's per-1M cost rates through guided prompts (model → input/output/cached-input → currency). Writes the `cost` block via the config store; the dashboard re-renders immediately.
- **Live dashboard updates** — both the **Last Request** and **Token Usage** nodes now re-render immediately after every completed prompt via a change event from the combined usage store, instead of waiting for the metrics poll interval. This also fixed a pre-existing bug where the Last Request node was stale for up to `pollIntervalMs` after each request.

### Internal

- **`lastRequestStore.ts` merged into `src/usageStore.ts`** — a single ingestion point (`recordRequest`) captures the last request AND accumulates the cumulative counters, with one change event feeding both dashboard nodes. Serialized `globalState` writes prevent lost updates under rapid completions. Added `test/usageStore.test.ts` (accumulation, persistence round-trip, retention, reset, cost math).

## v1.21.0 — Provider & command decomposition + bug-squash edition

### Fixed

- **Set Model Personality no longer appends a duplicate entry for server-less models** — a model without a `serverUrl` can't be matched by the config store (`findModelConfigIndex` needs both id and serverUrl) and fell through to the append branch, writing a duplicate into `settings.json`. The command now skips such models with a warning. Guarded by `personalityApplicableTo` with a regression test.
- **Add Server & Model no longer appends a duplicate on Replace Config** — replacing an existing model built a fresh composite `id`, so the config store (which matches on `id` + server URL) could not find the custom/preset-derived `id` of the existing entry and appended instead. The existing entry's `id` is now retained on replace.
- **Add Server & Model disambiguates when multiple configs share a model** — if several configured entries on a server expose the same wire model id (e.g. a preset-derived entry beside a discovered one), Replace Config now asks which entry to replace instead of silently targeting the first match.
- **Test & Refresh: silent-failure scenarios now surface** — (1) the deep-diagnostic offer now targets a real unreachable server even when a server-less config precedes it in the list; (2) a reachable server that serves zero models is now reported instead of silently dropped; (3) server-less configs are reported separately and no longer trigger a misleading network-gating warning; (4) a diagnostic failure can no longer skip the model-cache clear (moved to `finally`) or escape the command.
- **Stale comments corrected and a misleading message fixed** — the `sessionManager.ts` comments referencing a Python batch process (the code uses `node:sqlite`) are reworded; the unreachable "No personality presets found." guard message in the Set Model Personality command is now accurate ("No personality action was selected.") and marked as a narrowing-only guard.
- **Removed a redundant `onView` activation event** — the Server Settings webview is contributed via `contributes.views`, which already activates the extension when shown, so the explicit `onView:vllm-copilot.serverSettings` event was redundant and generated a packaging warning.
- **Config-read and pipeline failures no longer escape unhandled** — a rejected config read or system-message pipeline failure during a chat request is now routed through the same error classification as stream failures (quiet on user cancel, `[ERROR]` log + chat note otherwise). Previously these escaped `provideLanguageModelChatResponse` as unhandled rejections with no Output-channel or user-facing diagnostics.
- **Fixed the startup warning: `vllm-copilot.setPollInterval` now declared in `contributes.commands`** — the command was registered at runtime and referenced by the dashboard, but absent from the manifest's `commands` section, so VS Code logged "Menu item references a command which is not defined in the 'commands' section" at startup. It is now declared (without a category, so it stays out of the command palette and keyboard-shortcut discovery, matching its dashboard-only intent).

### Changed

- **Decomposed the provider and config flows into measured submodules** — `provider.ts` (was ~1,000 lines) is now a thin class that owns lifecycle, cache, remote guards, and delegation. The response pipeline (`requestBuilder`, `consumeStream`, `outcome`), system-message pipeline (`systemMessagePipeline`), discovery (`discovery`), auto-continue orchestration (`streamOrchestrator`), post-stream diagnostics + error classification (`postStream`), and the client contract (`contracts`) live in `src/provider/*`. The former `autoConfig.ts` grab-bag was split into `src/commands/*` (`presets`, `hfDiscovery`, `serverAuth`, `byok`, `addServerFlow`, `autoConfigureFlow`) with `autoConfig.ts` reduced to a thin facade. All behavior-preserving — no user-facing change; every extracted module is now coverage-measured.
- **`commands.ts` imports `VllmChatModelProvider` as a type-only dependency** (`import type`) — it was only ever used in type positions.
- **Extracted the Test & Refresh and Set Model Personality workflows out of `commands.ts`** — `registerTestAndRefreshModelsCommand` (+ `serverFingerprint`/`groupModelsByServer`) → `src/commands/testAndRefresh.ts`; `registerSetModelPersonalityCommand` (+ `personalityApplicableTo`) → `src/commands/personality.ts`. `commands.ts` is now a thin facade re-exporting them beside its remaining thin registrations. Behavior-preserving; both workflows gained command-flow tests and are now coverage-measured (`testAndRefresh.ts` 92.6% / `personality.ts` 95.9% stmts).
- **Server Settings: Save/Revert moved into a sticky action bar with an unsaved-changes indicator** — the "Save All Changes" button sat at the bottom of a long form, so editing the top fields meant scrolling to the end to commit. The action bar (Save All + Revert) is now pinned to the top of the view and stays visible while scrolling. Save All and Revert are disabled until the draft diverges from the persisted config, and a "● Unsaved changes" warning appears the moment any field is edited; Revert keeps its discard-draft behavior (re-render from persisted state). Personality and system-prompt capture remain auto-applied (unchanged).

### Internal

- **Added a `test:typecheck` gate (`tsc -p test/tsconfig.json --noEmit`), wired into `npm run build`** — the Vitest mock surface (`test/__mocks__/vscode.ts`) is now a typed stand-in for the real `@types/vscode` API, and every test file type-checks against it. This surfaced and fixed genuine latent bugs (a stale `VllmConfig` fixture referencing removed legacy fields, wrong `fetch` mock return shapes, a mis-typed personality resolver stub) plus ~30 shape-mismatch test bugs. The gate runs ~2s and prevents the mock surface from rotting.
- **Removed the last `any`-typed network JSON boundaries** — `/v1/models` responses in `vllmClient.ts`, `testAndRefresh.ts`, `addServerFlow.ts` and `hfDiscovery.ts` are now cast to `{ data?: VllmModel[] }`-shaped types, and `modelInfo.ts` types the undocumented `configurationSchema` field via an explicit intersection instead of `any`.
- **Cancelling a chat request before the first token no longer shows a spurious "model returned no output" error** — `reportPostStreamDiagnostics` used to run unconditionally after the retry loop with no cancellation guard, so pressing Escape during time-to-first-token (or a reasoning-only phase) surfaced a `⚠️ The model returned no output` message plus a `[WARN]`, contradicting the quiet-cancel contract that `handleResponseError` already honored. Post-stream diagnostics are now skipped on cancellation, with a regression test.
- **Diagnostics no longer misattributes proxy/network failures to an incomplete certificate chain** — the "Transport comparison" block in `diagnostics.ts` fired whenever the patched fetch failed and a direct/system transport succeeded, regardless of the cause. Since the direct transport bypasses the proxy, the canonical corporate-proxy case (patched fetch fails through the proxy, direct succeeds) was reported as "the server is not sending the complete certificate chain" — the opposite of the report's own conclusion. The block is now gated on the Node fetch actually failing with a TLS error. Added the first `formatReport` tests (`test/diagnostics.test.ts`).
- **Diagnostics `openssl` check no longer runs a shell command** — `runChainBuildOpenSSL` interpolated the user-supplied hostname into `exec(\`echo | openssl s_client -connect ${hostname}:${port} ...\`)`. WHATWG URL parsing accepts shell metacharacters in hostnames (verified: `http://$(id):443` → hostname `$(id)`), so a crafted `serverUrl` was shell-executed on macOS/Linux. Now `spawn('openssl', [...], { stdio: ['ignore','pipe','pipe'] })` with an argument array — no shell, no interpretation.
- **Auto-Configure preserves user-set token-budget overrides** — re-configuring an existing model silently dropped `maxInputTokens` and `estimateCharsPerToken` (the preservation list kept other transport settings but not these two), so a user's "reserve headroom" and chars-per-token settings vanished on re-configure. Both are now preserved alongside the other infra/personal fields, with the regression test extended.
- **Server Settings "Save All Changes" can now clear a personality via the raw field** — the webview deleted empty field values from the save payload, so clearing the `systemMessageReplacementsFile` text input sent *absent* rather than `''`, and `patchModelConfig` preserved the old personality. The store's documented `''`-clears contract was unreachable from the only webview save path. The field now sends `''` explicitly.
- **Test & Refresh now matches a config to its quantized server variant** — the command matched the configured `vllmModelId` against served wire ids strictly, so a config for `Qwen/Qwen3.6-27B` against a server serving `Qwen/Qwen3.6-27B-FP8` (which works in chat, where `resolveOverrideForModel` is quantization-agnostic) was reported "parked" and the user steered to re-adopt a model they already configured. Matching is now org-aware and quantization-agnostic via `normalizeModelId`, consistent with the rest of the extension. Regression test added.
- **Server Settings "Save All Changes" can now clear any scalar field** — clearing a field and saving silently did nothing: the webview encoded empty values as `undefined`/absent, and `patchModelConfig`'s shallow merge preserves absent keys, so only the personality field (which sent `''`) could be cleared. Empty `displayName`, token budgets, `estimateCharsPerToken`, transport settings, `defaultMode` (`(none)`), and a fully-emptied `defaultParams` now send the same explicit `''` clear signal, and the store's `normalizeModelEntry` maps `''` → delete for every clearable scalar (checked with `=== ''`, so a legitimate `0` like `streamInactivityTimeout: 0` = infinite survives). Tests added for both patch and replace paths.
- **Server Settings no longer discards unsaved edits when the form is dirty** — a `models` change from any source (the auto-applied personality dropdown, auto-configure, add/remove model, Set Personality, editing settings.json) answers with a full form re-render that wiped uncommitted edits in the draft. The host now lets the `onDidChangeConfiguration` listener own the single refresh, and the webview decides at message time on live state: after a Save All the form re-renders and the dirty indicator resets; on any *other* refresh while the form is dirty, state is merged (persisted baseline + active-personality label) and the draft survives. The decision is state-based, not a one-shot flag, so it holds under concurrent refreshes. Revert and Save All still work as before.
- **Dashboard "Last Request" no longer silently missing for non-canonical server URLs** — the store writes the last request keyed by the NORMALIZED server URL (`resolveServerConfig` → `normalizeServerUrl`), but the dashboard looked it up by the raw `model.serverUrl`. Any config using a scheme-less, trailing-slash, or `/v1` URL (the common OpenAI-compat paste form) rendered no Last Request node — silent, no error. The lookup now normalizes to match the store. Regression test added.
- **Removed the dead Copilot `max_tokens` modelOption layering** — `options.modelOptions` (which can carry the chat UI's `max_tokens`) was spread into the request and then unconditionally overwritten by the model's context-window-derived `maxOutputTokens`, so the UI control never reached the wire. The re-assert after layering is the guarantee; other modelOptions (temperature, top_p, …) still flow through the layering. Test added.
- **A `maxOutputTokens: 0`/negative override is no longer sent as `max_tokens: 0`** — it passed straight through the budget clamp and vLLM rejected the request. The override is now clamped to at least 1, degrading a deliberate misconfiguration to a minimal output instead of a broken request. Test added.
- **A `maxInputTokens: 0`/negative override is no longer advertised as a no-input model** — the picker showed a model that can take no prompt. The override is now clamped to at least 1 (subject to the remaining input room). Tests added.
- **Test & Refresh now reports parked models on a server that also has matches** — a server hosting a healthy model plus a configured model whose wire id isn't served reported pure success, silently dropping the broken one. The success line now appends "— parked: <ids>". Test added.
- **`logBodyLimit` changes apply mid-session without rotating the log file** — the setting was read only once at logger init, so changing it (e.g. `0` for full bodies) required toggling file logging or reloading. The config-change handler now updates the active logger's limit in place (the limit is read at write time), so a mid-session change takes effect immediately and the current log file stays intact. Test added.
- **TLS diagnostics no longer report `valid: true` for a failed handshake** — the openssl chain check set `valid: !verifyError`, so a connection reset / protocol error / server shutdown mid-handshake (non-zero exit, no `verify error:` line) was reported as a valid chain. The exit code is now honored: a non-zero exit — including a timed-out or killed process, whose exit code is `null` and is now treated as a failure — is not `valid`.
- **Deep-Dive no longer opens duplicate panels per URL spelling** — panels were keyed by the raw `serverUrl`, so `http://host:8000`, `http://host:8000/`, and `http://host:8000/v1` opened separate panels for one physical server (the metrics engine already deduped by normalized URL). Panels are now keyed by the normalized URL too.
- **Deep-Dive no longer orphans a metrics poller on a second `ready`** — a re-posted `ready` (webview recycle / manual reload) overwrote the engine subscription, orphaning the first callback so the engine could poll that server for the rest of the session. A second `ready` is now ignored once the panel is ready — and the cached raw data is re-pushed, so a reloaded page doesn't sit on "Loading…" until the next poll tick.
- **Deep-Dive no longer delays showing cached data on first open** — the cached-data push ran before the panel's ready flag was set (the push guards on it), so the first-open view sat on "Loading…" until the first poll tick. The ready flag is now set before subscribing/pushing, restoring the immediate cached snapshot on both first open and reload.
- **Token budget no longer collapses to zero input for small-context models** — a model whose window is at or below the default output budget (e.g. 4096) had its output clamped to the full window, leaving `maxInputTokens = 0` — advertised as a model that can take no prompt at all. The output budget is now reduced to always reserve at least one input token. Test codifies the invariant (`maxInputTokens >= 1`).
- **Auto-configure no longer claims tool calling the model provably lacks** — the HF chat-template tool-support detection ran, but step 4 unconditionally set `capabilities.toolCalling = true` on every auto-configured model, so the detection was theater and there was no path to `false`. A template that provably lacks tool markers now yields `toolCalling: false`; unknown (no template) stays permissive. Regression test added.
- **Auto-configure summary no longer reports `max_new_tokens` as a "generation default"** — the confirm-dialog listed `max_new_tokens` from the HF generation config, but `defaultParams` never applied it (output is controlled by the extension's `maxOutputTokens`), so the user believed an output ceiling was active when it wasn't. Removed from the summary.
- **Deep-dive view no longer leaks a metrics poller when closed during the ready handshake** — if the panel closed between the webview posting `ready` and the handler running, `onDidDispose` fired with no subscription to dispose, then the queued handler subscribed unconditionally, scraping that server every interval for the rest of the session. The `ready` branch now returns early when the panel is already disposed.
- **Dashboard no longer keeps polling a hidden sidebar or double-subscribes** — `setVisible(true)` fires async `refreshSubscriptions`, which awaits `getConfig`; a `setVisible(false)` during that gap disposed an empty subscription array, then the continuation subscribed anyway, polling a hidden sidebar every interval. And two overlapping refreshes (e.g. a config change racing a show) both subscribed, double-polling until the next toggle. The continuation now re-checks a visibility flag and a refresh epoch after the await and aborts if the sidebar was hidden, the provider disposed, or a newer refresh superseded it.
- **Metrics engines are released when the last subscriber unsubscribes** — `ServerMetricsEngine.dispose()` (which stops polling and removes the engine from the module-level registry) was dead code; the only teardown path (`unsubscribe`) stopped polling but never removed the engine, so the registry accumulated one zombie engine per server URL ever configured. The last unsubscribe now disposes the engine, so a closed dashboard/deep-dive fully releases its poller. Behavioral regression test added.
- **Removed the unreachable `Promise.allSettled` rejected branch in discovery** — every discovery task self-catches and resolves with `{ model, error }`, so the "Should not happen" else was dead code a future reader could not safely assume was inert. It now carries an explicit comment instead of a misleading defensive branch.
- **Removed the dead `vllm-copilot.dashboard.enabled` setting** — it was declared in the manifest and documented ("When disabled, polling stops") but never read anywhere; the tree view is created unconditionally and polling is gated only by view visibility. Setting it to `false` did nothing. Setting + docs row removed.
- **`streamReader` drain sites no longer duplicate a triplicated catch** — the identical `try { yield* drainAndCheck(); } catch (e) { if (e === STOP_ITERATION) break; else throw e; }` appeared at four sites around a unique sentinel object. `drainAndCheck` now returns a boolean (`true` once the stream reached its natural end) instead of throwing a sentinel, so every call site is `if (yield* drainAndCheck()) break;` — the sentinel and the per-site try/catch are gone, with no behavior change.
- **Removed the dead "or type '0' for custom" hint in the parameter picker** — `serverSettings.js` showed the hint under a `<select>`-only modal where nothing can be typed and `parseInt(sel.value) === 0` selects the first *known* parameter, not custom. The hint claimed a custom path that doesn't exist.
- **Deep-Dive no longer mislabels `server_load` as a request count** — the Deep-Dive view rendered the 0..1 utilization ratio from `/load` under "GPU-Utilizing Requests" via the raw number formatter (`0.5`), reading as a count. It is now labeled "Server Load" and rendered as a percentage (`50%`), consistent with the no-data branch.
- **File logs now retain only the 20 most recent files** — every activation wrote a new timestamped `vllm-copilot-<ts>.log` holding unredacted auth headers, and the only cleanup was the manual "Clear Log Files" command, so the storage dir grew one plaintext-API-key file per reload with no bound. `init()` now prunes to the 20 newest (skipping the active file). Test added.
- **`DashboardTreeProvider.dispose()` now disposes its tree-data emitter** — the tree view disposed only its engine subscriptions, leaving the `EventEmitter` alive past the extension lifetime, a stated-convention violation (`provider.ts` already disposes its emitter). Now matches the convention.
- **Server Settings no longer posts to a dead webview** — `onDidDispose` never cleared `this.view` or reset `isWebviewReady`, so an in-flight `refreshWebview` (entry guard passed, then `await getConfig`) could `postMessage` to a disposed view. The dispose handler now nulls both, and the refresh path re-checks the view before the single `postMessage`.
- **Dashboard no longer shows "vv0.6.0" for the vLLM version** — the tree prepended its own `v` to the version string from `/version`, but vLLM already returns the version with a leading `v` (e.g. `v0.6.0`), so the dashboard rendered a doubled prefix. Now renders the version as-is. Found by the new `test/dashboard.test.ts` (which pinned the expected value and caught the double-`v`); the same file adds coverage for the tree provider's visibility/epoch subscription lifecycle, offline/online rendering, and dispose.
- **Metrics engines are keyed by canonical server URL** — the engine registry (and dashboard/deep-dive) keyed by the raw configured string, so hand-edited variants of one server (`http://host:8000`, `http://host:8000/`, `http://host:8000/v1`) spawned separate engines polling the same physical vLLM process. `getMetricsEngine` now normalizes via `normalizeServerUrl`, so variants share one engine and one poller.

## v1.20.8 — Test & Refresh consolidation & path-resolution dedup

### Fixed

- **Test & Refresh popup overflow** — instead of one toast per server (which collapsed into the Notification Center with 3+ servers), the command now shows a single consolidated popup for all reachable servers and a single one for all failures. Reachable servers hosting models not configured in `settings.json` get one hint directing to Server Settings. The old per-server "configure now" wizard was removed in favor of that single hint.

### Changed

- **Deduplicated workspace-root path resolution** — `provider.loadReplacements` and `personalityStore.resolveActivePersonality` both hand-rolled "resolve a relative `systemMessageReplacementsFile` against the first workspace folder." Extracted a single shared `resolveWorkspaceRelativePath` helper in `config.ts` so the two call sites can never drift. No behavior change.

## v1.20.7 — Supportive Mentor rename & preset cleanup

### Changed

- **"Tough Love" renamed to "Supportive Mentor"** — the name now matches the actual warm, patient mentor persona (the old name implied a harshness the content never had). The bundled preset was renamed to `prompt-replacements-supportive-mentor.json`. A one-time migration replaces any stale global copy and rewrites model configs that referenced the old path.
- **Stale `docs/prompt-replacements-*.json` snapshots deleted** — they were drifted copies of the shipped presets, not read at runtime. `docs/custom-system-prompt.md` now points at the real `prompt-replacements/` location.

## v1.20.6 — Personality overhaul, command cleanup & README refresh

### New

- **Raw (Model Natural) personality** — strips Microsoft's safety, identity, and behavioral boilerplate with **no persona injected**, leaving the model's own trained behavior untouched. Also removes the standalone "Keep your answers short and impersonal" instruction. The legacy `default-prompt-replacements.json` (bundled + docs copy) was promoted into this preset and deleted.
- **Personality picker shows live descriptions** — the Server Settings dropdown now renders the selected personality's description under the select, so you know what you're getting before you commit.
- **Critical Senior Dev and Tough Love are now distinct** — Critical Senior is cold, code-architecture judgment (the code, not the coder); Tough Love is a mentor building better engineers (explains the why, celebrates progress).
- **Bundled personalities are extension-owned** — applying a bundled preset now always re-syncs its global copy from the shipped file, so stale or hand-edited copies are replaced on re-apply. User-created personalities keep the never-clobber contract.
- **Curated personality dropdown order** — bundled presets appear in a defined order; user-created personalities sort after, alphabetically.

### Changed

- **Sarcastic Robot is de-Bendered** — the preset no longer names the copyrighted character or its catchphrases; it now channels the generic "golden-age sarcastic sci-fi robot" archetype. Same voice, zero IP exposure.
- **Spartan description clarifies the value** — explicitly notes it saves tokens and that the economy is in how it talks, not what it builds; code stays complete.
- **Command palette cleanup** — the dead `refreshDashboard` command was removed and the raw-ID `setPollInterval` entry is hidden from the palette (still reachable via the dashboard's Refresh Interval row).
- **README overhaul** — outcome-first hero, audience framing, dashboard bullet, and a new `overview.jpg` so visitors can see the whole extension at a glance.

## v1.20.5 — Personality hardening & model picker fixes

### Fixed

- **Same model on multiple servers now shows as separate picker entries.** Discovery gives id-less configs a unique composite id (`"<model> on <host>"`), so the same vLLM model hosted on two servers no longer collapses to a single entry — and one server going offline no longer hides the other. Request-time config lookup round-trips the composite id back to the right model.
  - ⚠️ **Migration note (id-less configs only):** the picker label changes from `<model>` to `<model> on <host>`. Re-select the model once in the picker. Your `vllm-copilot.models` settings are **not** rewritten — the id is derived at discovery, not persisted.
- **Personality collision detection** — applying a personality whose filename collides with an existing, different (or unrecognized) global file now raises an error instead of silently binding to the wrong file.
- **Consistent clear semantics** — Server Settings "Save All Changes" now deletes an empty `systemMessageReplacementsFile` (matching **Set Model Personality → Default**) instead of storing a lingering `""`, and no longer resurrects the old value on clear.
- **Webview-created model entries get composite ids** — saving an unconfigured model in Server Settings uses `buildModelId`, so the same model saved on two servers can no longer produce duplicate ids.
- **Webview message-handler error boundary** — a failing apply-personality/save no longer becomes an unhandled rejection.
- **Clearer empty-response diagnostics** — distinguishes a transport-level stream cut (no finish reason) from unusual server-reported finish values.
- **Duplicate explicit `id` warning** — discovery warns when two configs share the same explicit `id` (the only remaining picker-collision source).

### New

- **Server Settings: "Personality and System Prompt" section** — the Personality and System Prompt collapsibles are merged into one; the dropdown is labeled **"Personality (global)"**; and a **"Record system messages"** toggle exposes the `systemMessageCapture` setting right in the sidebar (previously only in Settings UI).
- **Prompt-drift canary** — `npm run check:prompt-drift` compares every personality preset `find` rule against the current VS Code prompt source on GitHub and fires on dead rules or changed source SHAs. See `docs/custom-system-prompt.md`.
- **Personality hover tooltips** — the Server Settings personality dropdown shows each preset's description as a hover tooltip.

### Internal

- Shared `normalizeModelEntry` for the clear semantics across both `saveModelConfig` paths; added tests for the system-message pipeline, webview save paths, personality store, composite-id derivation, and preset integrity.

## v1.20.4 — Global personalities & Server Settings polish

- **New: personalities are global.** Selecting one (Server Settings sidebar or `Set Model Personality`) copies it into the extension's global storage (`personalities/`), so it follows you across workspaces and survives extension upgrades. No longer requires an open workspace. Legacy `.vllm/` copies are still discovered.
- **New: personality picker in Server Settings** — a dropdown in each model's section, with the active personality marked and applied immediately. Model, display name, and system prompt controls moved up for a cleaner per-model flow.
- **Fixed:** Server Settings no longer resets the selected model to the first entry after a change.
- **New: `THIRD-PARTY-NOTICES.txt`** — generated via `npm run license:notices` from the licenses of shipped runtime dependencies, required for Marketplace distribution.

## v1.20.3 — Clear personality & show active personality

- **New: "Default (no personality)"** in **Set Model Personality** — pick it to remove the model's system message replacements and restore Copilot's original system prompt.
- **Active personality shown** — the current choice is marked with a check in the picker and shown in the placeholder (`Current: …`).
- **Portable config path** — `.vllm/` preset paths are now stored with forward slashes in `settings.json`, so the setting is OS-portable.

## v1.20.2 — Server Settings UX fixes

- **Fixed: Auto-Configure now works on unconfigured models** — Server Settings lists server-reported models even when they have no settings entry, but clicking **Auto-Configure** on one failed with "No config found". It now borrows the server's auth headers from a sibling configured model and runs the full add flow (preset/HuggingFace discovery), producing a complete new `vllm-copilot.models` entry.
- **Fixed: "Remove Server" button removed ALL models on a server** — renamed to **Remove Model**: it now deletes only the selected model's settings entry, never its siblings on the same server.
- **New command** — `vllm-copilot.removeModel` (title "Remove Model"), registered in package.json and wired into the Server Settings webview. `vllm-copilot.removeServer` remains available from the command palette for an explicit, confirmed server-wide removal.

## v1.20.1 — DeepSeek-V4-Flash-0731 model config

- **New model preset** — `DeepSeek-V4-Flash-0731`: dedicated config for the official 0731 release with model-card-recommended sampling parameters (`temperature=1.0`, `top_p=0.95`). Think modes only send `reasoning_effort` (vLLM auto-injects `enable_thinking`); No Think sends all params directly. Updated documentation with links to DeepSeek API thinking mode docs, vLLM reasoning parser behavior, and HuggingFace model card recommendations.

## v1.20.0 — Major Improvement! Bug-squash edition: engine unification, structural cleanup, 9 bugs fixed, and better UX for server adding

- **Unified metrics engine** — created `ServerMetricsEngine` in `vllmMetrics.ts`: reference-counted polling engine shared by dashboard and deep-dive. Starts on first subscriber, stops on last. Single fetch cycle produces both `ServerMetrics` (aggregated) and `ServerRawData` (raw buckets) from one set of HTTP responses. Eliminated duplicate 2x-per-interval fetches when both views were open. Removed standalone `fetchServerMetrics()` and `fetchServerRawData()` (logic subsumed into `fetchAllEndpoints()`).
- **Dashboard: removed config cache bypass bug** — no longer calls `getConfig(context)` on every 15s poll. Config read once on visibility change and re-read on settings change. Dashboard subscribes to the shared engine; tree re-renders coalesced via `queueMicrotask` gate.
- **Deep-dive: no longer owns its poll cycle** — subscribes to the shared engine, receives push notifications. Removed independent `fetchServerRawData()` timer.
- **Consolidated `streamReader.ts` drain loop** — replaced 3 near-identical `eventQueue` drain sites with a single `drainAndCheck()` helper generator. `STOP_ITERATION` sentinel cleanly separates "break" from real errors.
- **Corrected `streamReader.ts` abort signal comment** — the old comment claimed the abort signal was "inert" after streaming started, which is wrong. Updated to explain `reader.cancel()` is the preferred path for clean teardown.
- **Fixed: `buildAuthHeaders()` JSDoc didn't document its limited scope** — now clearly marked as "write/migration paths only" (Add Server, Update Auth). Runtime never uses it.
- **Refactored auth input** — extracted `promptForServerAuth()` shared helper (`autoConfig.ts`) for API key + custom headers input. Used by both Add Server and Update Auth. Single source of truth for the two-step input, validation, and combination.
- **Eliminated duplicate import** in `commands.ts` — removed `buildAuthHeaders` and `parseHeadersInput` imports (both now accessed via `promptForServerAuth`). `buildAuthHeaders` is only used internally in `autoConfig.ts`.
- **Added three-way failure dialog** — `handleServerFailure()` in `autoConfig.ts` replaces the old Cancel-only exit when Add Server cannot reach the server. Users now choose:
  - **Discard** — abandon, try again later
  - **Run Diagnostic** — runs `runDiagnostics` with the exact in-memory URL + headers (no settings write needed)
  - **Keep Anyway** — saves a minimal stub (`{ id, vllmModelId, serverUrl, requestHeaders }`) so the user can auto-configure or edit later
- **Aligned auth input prompts** — both Add Server and Update Auth now use the same wording for API key and custom headers descriptions. Clarified quotation requirements for custom header input.
- **New model preset** — `Qwen/Qwen3.6-35B-A3B` with Think (General), Think (Coding), and No Think modes.
- **Updated `model-configs/README.md`** — added Qwen3.6-35B-A3B to the preset table.
- **Fixed: `promptReplacer.ts` parsed each personality file twice** — both `loadPersonalityMeta()` and `loadPromptReplacements()` independently read+parsed the same file. Extracted shared `readPersonalityFile()` with a module-level `Map` cache so discovery and application share the same I/O+parse. Exported `clearPersonalityCache()` for the Set Personality command to use when it copies a new file.
- **Fixed: cache poisoning on personality rewrite** — `registerSetModelPersonalityCommand()` now imports and calls `clearPersonalityCache()` after copying a new preset file, so the next request loads fresh rules instead of stale cached ones.
- **Removed `src/migration.ts` (237 lines), `test/migration.test.ts` (56 lines), and their registration in `extension.ts`.** The repo's initial commit (2e6f710) was a clean public release imported from a private repo — no user of this public release has ever had legacy global settings. Eliminates two globalState flags, a latent write-shadowing bug, and 293 lines of cargo-culted dead code.
- **Fixed: `fetchServerMetrics` shared `AbortController` swallowed timeout aborts as "online with zero models".** Each inner catch now detects `controller.signal.aborted` and re-throws to the outer handler, producing `{ online: false, error: 'Cannot connect: ...' }` instead of reporting the server as online with no models.
- **Fixed: `deleteChatKeys` returned `0` on any failure, indistinguishable from "no keys existed."** Now returns `-1` on error; `cleanWorkspace` propagates `dbError: boolean` to `commands.ts`, which shows a warning when database deletion fails.
- **Removed `RetryLogger` interface** (single implementation, YAGNI). `fetchWithRetry` now takes plain `onRetry`/`onRetrySuccess` callbacks instead of a strategy object.
- **Fixed: `clearLogFiles()` sync-in-async** — switched from synchronous `readdirSync`/`unlinkSync` to async `fs.promises` calls to match the function's async signature.
- **Fixed: `buildModelInfo()` inline type redeclaration** — changed `override` parameter from inline type duplicating `ModelConfig` to `Partial<ModelConfig>` so new fields propagate automatically. Same fix applied to `buildConfigurationSchema()` (`Pick<ModelConfig, 'modelModes' | 'defaultMode'>`).
- **Fixed: session manager logs silently dropped before init** — replaced `outputWarned` flag with pre-init message queue that flushes to the output channel once `setSessionManagerOutput()` is called.
- **Metrics polling now reuses shared helpers** — `fetchAllEndpoints()` uses `buildEndpoint()` (from `config.ts`) and `buildRequestHeaders()` (from `fetchRetry.ts`) instead of inline URL/header construction, removing the last duplication between the chat and metrics HTTP paths.
- **Fixed: metrics engine stalls on fetch error** — `tick()` wrapped in `try/catch/finally` so polling continues on transient failures instead of stopping permanently.
- **Fixed: engine `dispose()` left zombie in registry** — `dispose()` now removes the engine from the registry on cleanup.
- **Fixed: engine auth headers not propagated on re-use** — `getMetricsEngine()` calls `engine.setHeaders()` when returning an existing engine, so dashboard re-subscribes pick up changed auth.
- **Fixed: deep-dive stale auth headers on header-only update** — `registerUpdateServerAuthCommand()` now pushes new headers to the metrics engine via `getMetricsEngine(serverUrl)?.setHeaders()`, so an open deep-dive panel uses fresh auth immediately.
- **Shared model matching helper** — added `findModelConfigIndex()` to `config.ts` using `normalizeServerUrl` + `resolveVllmModelId`. Both `autoConfig.ts` and `serverSettingsView.ts` now call the same function for model identity matching, eliminating the URL-normalization divergence between the two `saveModelConfig` implementations.

### Test & Refresh: server-grouped testing, auto-configure in no-match flow

- **Refactored `testAndRefreshModels`** — models are now grouped by unique server (fingerprinted by URL + auth headers) so each server is queried exactly once. Single consolidated popup replaces N per-model modals. Server-level status: ✓ (ok), ✗ (error), or no-match (reachable but nothing configured).
- **New no-match flow** — when a server is reachable but no configured model ID matches, the user is offered to **Pick Model** or **Auto-Configure** inline, with the option to update an existing config in-place or add a new entry.
- **Extracted helpers** — `serverFingerprint()`, `groupModelsByServer()`, `handleNoMatchServers()`, `updateExistingConfig()`, `addNewConfig()`. The closure is no longer a single 5-responsibility function.
- **Removed `selectMismatchesToPrompt()`** — superseded by the server-grouped no-match flow.

### Server Settings: Auto-Configure and Remove Server buttons

- **Dashboard right-click menu trimmed** — now only shows **Update Auth** and **vLLM Deep-Dive**. The destructive "Remove Server" and "Auto-Configure" are moved to the Server Settings webview.
- **Server Settings webview** — two new action buttons at the top: **Auto-Configure** (re-runs preset/HuggingFace discovery for the selected model) and **Remove Server** (deletes all models for that server from settings, with a confirm dialog). Both delegate to existing commands.
- **`registerAutoConfigureModelCommand`** — now accepts optional `{ serverUrl, vllmModelId }` arg to skip the QuickPick when called from the webview.
- **`registerRemoveServerCommand`** — accepts `skipConfirm` flag. Webview passes it (the webview already shows its own confirm). Dashboard right-click path still shows the modal.
- **`applyAutoConfigUpdate`** exported for reuse.

### Smart URL normalization

- **`normalizeServerUrl`** — port-based scheme detection: `host:8000` → `http://`, bare `host` → `https://`. Also strips trailing `/v1` path segment (commonly copied from OpenAI base URLs like `https://api.openai.com/v1`).
- **New tests** — 7 test cases for scheme detection and `/v1` stripping.

### Updated `known-bugs.md`

- Crossed off `registerTestAndRefreshModelsCommand()` as a large module (refactored).
- Removed stale `selectMismatchesToPrompt` false-positive entry (function no longer exists).

## v1.19.96 — Removed `id` from bundled model presets

- **Removed `"id"` from all 7 model presets.** Preset matching uses `vllmModelId` only — `id` is reserved for the user's own settings identifier.

## v1.19.95 — Cross-org model matching; auto-continue fix; dashboard fixes

- **Fixed: auto-continue retried after a pure tool-call turn.** Added `&& !outcome.hadToolCalls` guard so the model isn't re-asked after it already issued a tool call with `finish_reason: 'stop'`.
- **Added: cross-org + quantization-agnostic model matching.** `nvidia/DeepSeek-V4-Flash-NVFP4` now resolves to the `deepseek-ai/DeepSeek-V4-Flash` preset. New `modelMatchKey()` strips org + quantization, then lowercases.
- **Fixed: dashboard phantom entries.** Only server-reported models are listed, not configured-but-unserved ones.
- **Fixed: dashboard "Total Tokens" percentage denominator.** Changed from `maxInputTokens` (input-only budget) to full context window (`maxInputTokens + maxOutputTokens`), so usage percentage now reflects actual context utilization rather than a mildly inflated figure.

## v1.19.94 — Lower VS Code floor to 1.122; correct `node:sqlite` rationale; known-bugs audit

- **Lowered `engines.vscode` from `^1.125.0` to `^1.122.0`.** The previous `^1.125.0` floor was set in v0.15.1 on the claim that `node:sqlite` only became loadable without `--experimental-sqlite` once VS Code bundled Node 24. That was wrong: `--experimental-sqlite` was removed on the Node 22.x line in **Node 22.13.0 (Jan 2025, PR nodejs/node#55890)**. **VS Code 1.122.0 (May 2026) bundles Node 22.22.1** per its `cgmanifest.json` (tag `nodejs/node@22.22.1`) — well past the unflag, so `import { DatabaseSync } from 'node:sqlite'` loads cleanly and only emits an `ExperimentalWarning`. Verified against the bundled Node here: a `:memory:` DB is opened, written, and queried successfully without any flag. The prior CHANGELOG entry conflated "stable" with "unflagged" and is corrected for the record.
- **Corrected the stale comment in `src/sessionManager.ts`** at the `node:sqlite` operations section. Previously read "`≥1.125 → Node 24, where it is stable and unflagged`" — inaccurate on two counts (the flag was removed on Node 22.13.0, not gated behind Node 24; and `node:sqlite` is still Stability 1.2/R release-candidate in current Node docs, so "stable" is wrong too). Replaced with the accurate lineage: unflagged since Node 22.13.0; VS Code 1.122+ ships a Node version past that.
- Note: `node:sqlite` is still Stability 1.2 (Release candidate) in current Node docs, so an `ExperimentalWarning` is still expected on use — that is informational, not a loadability problem.
- **`known-bugs.md` audit pass.** Verified every entry against current source. Refreshed stale line counts (`autoConfig.ts` → 1,073, `provider.ts` → 1,012). Rewrote the `provider.ts` auto-continue entry — the real bug is the missing `&& !outcome.hadToolCalls` guard on the retry condition (retries fire after a tool-call turn), not the originally-claimed "tool-call arguments replayed as plain text" (in nudge mode `assistantPrefill` stays empty, so nothing is replayed). Corrected the `serverSettingsView.saveModelConfig` impact (editing `serverUrl` pushes a duplicate entry + orphan, not "overwrites a different model"). Rewrote the `fetchServerMetrics` P3 to capture the genuinely-mishandled mid-flight abort case (server reported `online: true, models: []`). Downgraded the "vllmMetrics has zero coverage" claim — the parser IS tested (349-line test file); only `fetchServerMetrics` and `dashboard.ts` are untested. Moved four false positives to the dedicated section: `serverSettings.js` `d.ontoggle` (secState is the source of truth on every render), `provideTokenCount` "blocks reading from disk" (`getConfiguration` is in-memory), `dashboard.ts` "no per-fetch timeout" (`fetchServerMetrics` has its own 5s `AbortController`; line also stale, 208→238), and `vllmClient.ts:214` "Promise.race fragility" (stale — the code lives in `streamReader.ts:139-152` now, and the cited `ReferenceError` cannot occur).

## v1.19.92 — Test & Refresh: stop nagging about parked models

- **Fixed: false ✓ rows in Test & Refresh** — the `found` matcher compared a model's `root` (the underlying checkpoint) against the user's `vllmModelId`. Since `root` is shared across aliases and quantizations, the check would return ✓ for models the server isn't actually serving. Matching is now strictly on `m.id === vllmModelId`.
- **Fixed: Test & Refresh nagged about intentionally parked models** — if you keep multiple model presets on the same server but only run one at a time (e.g. a Qwen preset alongside Laguna), every other entry got the "Pick Model" modal because it wasn't on the server. Now: the corrective prompt fires only when NO configured model on that server verified ✓ (i.e. the server is up but serves nothing the user configured). Healthy-server / parked-model cases are reported as a single ✗ row in the per-model modal and skipped from the prompt loop. The stale config stays in your settings untouched until you actually swap servers.

## v1.19.91 — Fixed NVFP4 quantization suffix matching

- **Fixed: Poolside Laguna-S-2.1 preset not picked up for NVFP4 variants** — `normalizeModelId()` did not recognize `-NVFP4` as a quantization suffix, so a server serving `poolside/Laguna-S-2.1-NVFP4` would not match the bundled preset for `poolside/Laguna-S-2.1`. Added `-NVFP4` to the recognized suffix list so all quantized variants resolve to the base model preset.

## v1.19.90 — Poolside Laguna-S-2.1 config and aligned default temperature

- **Added: Poolside Laguna-S-2.1 model config** — new preset with Think and No Think modes, sampling parameters from Poolside's published M.1/XS.2 technical report (temperature=1.0, top_k=20, same recipe and eval harness). Requires vLLM `--reasoning-parser poolside_v1 --tool-call-parser poolside_v1`. Text-only model, no vision.
- **Fixed: built-in default temperature aligned with vLLM** — `DEFAULT_REQUEST_PARAMS.temperature` changed from 0.7 to 1.0 to match vLLM's OpenAI-compatible API default. Model presets that specify their own temperature remain unaffected; this only changes the fallback for models without explicit params.

## v1.19.86 — Fixed cached_tokens always reported as 0

- **Fixed: `cached_tokens` always 0 in VS Code usage reporting** — `createUsageDataPart()` was reading `usage.cached_tokens` (top-level) instead of `usage.prompt_tokens_details?.cached_tokens` (nested per OpenAI/vLLM schema). This caused Copilot's usage tracker to report zero cached tokens, making prefix-cached requests appear as full fresh input. Cost accounting for environments with differential pricing (e.g., cache-read cheaper than input) was significantly overestimated. Now reads the correct nested path with a fallback to the top-level field for non-standard backends. Thanks to @BinaryFusion-00 for the detailed report.

## v1.19.8 — Remote connection UX fix

- **Fixed: confusing behavior when extension is not installed on remote** — Previously, connecting via Remote-SSH/WSL/devcontainer with the extension installed locally would silently fail with no clear error. Now: (1) a warning popup appears at activation explaining the issue, (2) clicking "Show Me" opens the Extensions view pre-searched for vLLM-Copilot where you can click "Install on {remote}", and (3) the model picker returns no models so ghost entries can't be selected.

## v1.19.5 — Last Request Details, createdCacheTokens, and Server Settings params

- **New: Last Request Details in Dashboard** — collapsible tree node under each server showing per-request token counts (input, output, total, cached, reasoning), timing metrics (TTFT, queue time, generation time), and throughput. Requires vLLM server flags `--enable-prompt-tokens-details` (for cache tokens) and `--enable-per-request-metrics` (for timing). Displays a hint when server flags aren't set so users know what to enable.
- **Fixed: createdCacheTokens not shown** — dashboard now displays `createdCacheTokens` from the vLLM usage block (cache creation tokens, distinct from `cachedTokens` which are cache hits). Removed unused exports from `lastRequestStore.ts`.
- **Added: 6 missing vLLM params to Server Settings** — `min_tokens`, `response_format`, `bad_words`, `structured_outputs`, `repetition_detection`, and `ignore_eos` are now available in the KNOWN_PARAMS picker. Combined with the previous 13, all vLLM params supported via `defaultParams`/`modelModes` now have UI entries.
- **Reordered: KNOWN_PARAMS by usage frequency** — organized into logical groups (sampling → output length → sampling refinement → penalties → output control → reproducibility → tools/formatting → vLLM-specific) instead of alphabetical.

## v1.19.4 — Repo housekeeping and documentation

- **Added: CONTRIBUTING.md** — development setup, key rules, and PR/issue guidelines.
- **Added: Issue and PR templates** — standardized bug reports, feature requests, and PR checklists.
- **Fixed: README badges** — replaced retired shields.io VS Marketplace badges with working alternatives (GitHub release, last commit, static Marketplace link).
- **Fixed: GitHub release notes** — replaced broken `vscode-file://` URLs in v1.19.3 release with proper Marketplace link.
- **Added: Repo topics** — discoverability keywords (vllm, copilot, vscode-extension, ai, llm, local-llm).
- **Added: Keywords in package.json** — matches repo topics for Marketplace discoverability.
- **Fixed: .vscodeignore duplication** — removed redundant `docs/prompt-replacements-*.json` include (only `prompt-replacements/` is shipped).

## v1.19.3 — Dead-code cleanup and a small UX fix

- **Added: `[WARN]` Output when model family falls back to the heuristic** — `extractFamily`'s known-family list only covers 8 names, and any model without a preset-declared or HuggingFace-derived `family` falls through to the org-name guess. The provider now emits a `[WARN]` to the Output channel for each affected model on every non-silent discovery pass, so users can tell the family shown in the picker is an estimate rather than authoritative. Silent discovery (cached) does not re-emit the warning. The family string remains a non-fatal sort key.
- **Fixed: webview listener leak in `ServerSettingsViewProvider`** — `resolveWebviewView` pushed the `onDidReceiveMessage` and `onDidChangeConfiguration` disposables into `context.subscriptions`, which lives for the entire extension lifetime. Re-resolution of the view (after dispose + re-show) leaked an additional pair of listeners each time, eventually causing duplicated `save` events and `refreshWebview` calls against stale views. Both disposables are now chained to `webviewView.onDidDispose`, so they are torn down with their owning view. Matches the existing pattern in `deepDiveView.ts`.
- **Removed: dead `autoConfigureModel()` `preFetchedInfo` parameter and branch** — no caller passed it; the caching shortcut was speculative. Re-add only when a caller actually needs it.
- **Removed: unused `VllmModelInfo.owned_by` field** — declared in `autoConfig.ts` but never read for matching or generation.
- **Removed: dead `ServerTreeItem.requestHeaders` field** — populated in the dashboard tree-item constructor but never read by any consumer. Context-menu commands extract `arg?.serverUrl` and re-read config via `vscode.workspace.getConfiguration()`.
- **Unified: `FetchModel` (commands.ts) and `VllmModel` (vllmClient.ts) into a single shared wire type** — `VllmModel` now lives in `types.ts` alongside the other `/v1/models` and SSE wire contracts; one declaration instead of two that could drift.

## v1.19.2 — Bug fixes
- **Fixed: Server Settings webview silently discarded vllmModelId edits** — the Models dropdown is the vllmModelId selector; a redundant text input was rendered as editable but silently overwritten on save. Removed the text input and relabeled the dropdown.
- **Fixed: Status bar showed first-server health independent of selected model** — the status bar polled the first configured server on a hardcoded 15 s interval and could not track picker changes. Removed entirely — server health is available in the dashboard tree view.
- **Fixed: Dead duplicate null-check in registerConfigureServerCommand** — commands.ts had two consecutive identical null-checks; the second was unreachable. Removed the dead line.

## v1.19.1 — Per-model settings webview

- **New: Server Settings webview in vLLM sidebar** — sibling webview to the dashboard tree for editing per-model configuration. No more manual `settings.json` edits.
- **New: server model discovery** — fetches `/v1/models` per server and populates a combined dropdown of configured + unconfigured models. Selecting an unconfigured model creates a new entry automatically.
- **New: parameter picker** — "Add Parameter" in Model Modes and Request Params offers a dropdown of known parameters (temperature, top_p, chat_template_kwargs, etc.) with friendly labels and type hints.
- **New: defaultMode picker** — dropdown in the Model Modes section to select which mode is active for the model.
- **New: system prompt personality button** — "Set Personality..." button in the System Prompt section launches the `vllm-copilot.setModelPersonality` command.
- **New: remove buttons on params** — ⊗ button on each mode parameter and request parameter row for inline deletion.
- **New: validate-webview-js script** — `npm run validate-webview-js` parses all `resources/*.js` with `vm.createScript` to catch syntax errors before packaging.

## v1.19.0 (upcoming) — Native Tree View Dashboard

- **New: vLLM Server Dashboard as native VS Code Tree View** — replaced the webview sidebar with a TreeDataProvider-based sidebar. Server list with collapsible per-server metrics: model names, context window, KV cache usage, running/watching requests, TTFT, TPOT, cache hit rate, MTP speculative decoding metrics, preemptions, evictions.
- **New: automatic polling** — dashboard metrics refresh at a configurable interval (`vllm-copilot.dashboard.pollIntervalMs`, default 15s).
- **New: MTP speculative decoding visibility** — Prometheus `spec_decode_num_draft_tokens_total`, `spec_decode_num_accepted_tokens_total`, and `spec_decode_num_drafts_total` are parsed and displayed as MTP acceptance rate, draft depth, and total proposal count.
- **New: all model names per server** — model aliases are discovered from `/v1/models`, Prometheus metrics, and config, then merged into a collapsible Models subtree.
- **New: Context Window display** — `max_model_len` from `/v1/models` endpoint, formatted as "32K".
- **New: Throughput (tokens/sec)** — derived from TPOT as `1000 / avgTPOTms`, replacing raw TPOT display.
- **New: clickable Refresh Interval** — top-of-tree row opens inline input box (accepts `15s`, `30s`, `1m`, etc.), saves directly to settings. Polling timer restarts automatically when interval changes.
- **Removed: webview sidebar** — `DashboardWebview` class and all webview HTML/JS generation code deleted. No more `type: webview` in package.json for the dashboard.
- **Docs: configuration-reference.md** — new Dashboard section with full metrics table, data sources, and settings reference.

## v0.18.0 (upcoming) — Historical reasoning preservation

- **New: host-owned reasoning history** — forwards historical VS Code `LanguageModelThinkingPart` content as structured assistant `reasoning` for vLLM requests, without maintaining a private conversation transcript.
- **New: `languageModelThinkingPart` proposal support** — enabled separately from `chatProvider` for current VS Code hosts that provide thinking history.
- **Tested: public message conversion path** — historical reasoning is covered through the same `convertMessages()` path used by the provider.

## v0.17.2 (upcoming) — Personality presets, diagnostic fixes, auto-config hardening

- **Fixed: TLS diagnostic report lied about auto-fix result** — `diagnostics.ts` reconstructed `reportTlsFix` as `{ exported: true, intermediateSubject }` instead of forwarding the actual `TlsFixResult` from `tryExportMissingIntermediate()`. The report always claimed success, dropped `pemPath`, and hid export errors. Now forwards the real result so the user sees actual export status, PEM file path, and `NODE_EXTRA_CA_CERTS` instructions.
- **Fixed: auto-config invented Qwen-specific sampling params for every model** — `parseModelModes()` applied Qwen3.6-style temperature, top_p, and presence_penalty values to any model whose chat template contained `enable_thinking`, regardless of family. Non-Qwen models (DeepSeek, GLM, etc.) received inappropriate per-mode values. Deleted `parseModelModes()` entirely — auto-discovery no longer scans Jinja templates to guess model capabilities. Thinking modes must be defined in `model-configs/` presets or user settings, from authoritative sources only.
- **Fixed: auto-config invented per-mode sampling differences from genConfig** — the prior `parseModelModes()` would clamp and adjust generation_config values per mode (higher temp for Think, lower for No Think), which is speculation, not discovery. Auto-configure now only uses authoritative sources: `generation_config.json` for shared baseline params, `pipeline_tag` for vision, `config.model_type` for family.
- **New: 5 bundled personality presets** — `docs/prompt-replacements-{tough-love,critical-partner,sarcastic-genius,senior-dev,spartan}.json`. Each preset removes safety boilerplate, identity rules, and generic fluff, then injects distinct behavioral instructions. Users point `systemMessageReplacementsFile` at the preset of their choice.
- **New: "Set Model Personality" command** — `vLLM-Copilot: Set Model Personality` guides users through picking a model, picking a personality, copying the preset to `.vllm/`, and updating the model's `systemMessageReplacementsFile` automatically. Config cache is cleared so replacements take effect immediately.
- **New: HF generation_config wired into defaultParams** — auto-configure now applies `generation_config.json` values (temperature, top_p, top_k, repetition_penalty) as the model's `defaultParams`. These are authoritative inference params from the model's own config, not invented values. Per-mode presets can still override them.
- **Fixed: system message capture dedup race condition** — concurrent chat requests could overwrite each other's new entries because both read the same file snapshot before writing. Writes are now serialized with a promise chain that always cleans up on error.
- **Fixed: lock chain poisoning** — if the file write threw (disk full, permissions), the rejected promise sat permanently in the lock, deadlocking all future writes. Now uses `try/finally` to always clear the lock.
- **Fixed: corrupt JSON file crash** — `JSON.parse` result is validated with `Array.isArray()` before use. Non-array JSON logs a warning and starts fresh.
- **Fixed: personality not taking effect immediately** — `clearCache()` is called after the personality command so replacements are active on the next request.
- **Fixed: auto-configure wiping personality** — `systemMessageReplacementsFile` is now preserved in `saveModelConfig` so re-running auto-configure doesn't erase the user's choice.
- **Fixed: silent ENOENT on missing replacements file** — `fs.access()` check before loading warns with the absolute path when a configured file doesn't exist.

## v0.17.0 (upcoming) — System message capture + replacement pipeline

- **New: `systemMessageCapture` setting** — replaces the old `captureSystemMessages` / `enableDebugLogging` settings. When enabled, captures all incoming Copilot system messages to `.vllm/system-messages.json` (single file, deduped by content). Each entry includes `receivedContent`, `deliveredContent`, and `rulesApplied`. Useful for discovering which prompt types route through the extension and for creating replacements.
- **New: `systemMessageReplacementsFile` per-model config** — point to a JSON file of `{ ruleName, find, replace }` pairs. Replacements are applied as exact substring matches, sequentially. Matched rules are recorded in the capture file.
- **Unified capture + replace pipeline** — `captureAndReplaceSystemMessages()` in `provider.ts` does both in one pass: extracts original text, applies replacements (in-place mutation), then captures to file. `convertMessages()` is now pure — no replacement logic.
- **Removed: `extractCopilotSystemPrompt` command** — the `systemMessageCapture` setting provides continuous capture, making a one-shot extraction command obsolete.
- **Removed: `captureSystemMessages`, `loadPromptReplacements`, `extractToolResultText` methods** from `provider.ts` — consolidated into single pipeline.
- **Simplified `messageConverter.ts`** — removed `armExtractionHook()` and `replacements` parameter from `convertMessages()`.
- **Prompt architecture research documented** — `docs/custom-system-prompt.md` includes full VS Code Copilot prompt architecture: reusable building blocks (`SafetyRules`, `CopilotIdentityRules`, etc.), source code URLs, message type inventory, and design decisions.
- **`docs/copilot-integration.md` updated** — added prompt architecture section with building blocks table and key source URLs.
- **New: 5 bundled personality presets** — `docs/prompt-replacements-{tough-love,critical-partner,sarcastic-genius,senior-dev,spartan}.json`. Each preset removes safety boilerplate, identity rules, and generic fluff, then injects distinct behavioral instructions. Users point `systemMessageReplacementsFile` at the preset of their choice. See README "Personality Presets" section.

## v0.15.2 (2026-07-12) — Test & Refresh mismatch correction + command-surface pruning

- **Test & Refresh Models now offers to correct a mismatched `vllmModelId`** — when a configured model isn't found on its server (renamed alias, typo, casing drift, HuggingFace id used where the server serves a different id), the command shows a warning with a **Pick Model** action, then a QuickPick of the server's actual model ids (with `max_model_len` and `root` hints). The chosen id is persisted in place via the shared `saveModelConfig` path; the result row updates to `✓ … (corrected → <id>)` without a redundant re-check. Cancel keeps the broken config. Skipped when the server returns zero models (different problem). The picker runs sequentially after the parallel check phase so concurrent `saveModelConfig` writes cannot race.
- **Shared picker + persistence between Add Server & Model and Test & Refresh** — extracted `pickModelFromServer(models, host, title?)` and exported `saveModelConfig` from `autoConfig.ts`. Both flows now share the same QuickPick UX (model id as label, `max_model_len` as description, `root` as detail) and the same dedup + per-entry persistence path. `addServerModel`'s inline picker is replaced by the shared helper; `testAndRefreshModels`'s new correction path uses it too.
- **Removed the `Auto-Configure Model` command** — it was dead as a standalone entry. `addServerModel` already calls `autoConfigureModel()` directly as its "Auto-Discover" branch (preset first, HuggingFace fallback). The standalone command only confused users with the "Auto-Configure vs Add" distinction. The `autoConfigureModel` function itself stays; only the command registration (`vllm-copilot.autoConfigureModel`) and `registerAutoConfigureCommand` (~190 lines) are removed.
- **Removed the `AI Configure Model` command and deleted `src/aiConfigurePrompt.ts` (~215 lines) + `docs/ai-configure-prompt.md`** — the command generated a research-prompt markdown file for an external AI. With the JSON schema now documented in the README's Configuration Reference (Full Syntax Reference + Typical Example + per-model table), users can paste the schema into any AI themselves; shipping 215 lines of template code was unwarranted. No remaining callers.
- **New `vLLM-Copilot: Utilities` palette category** — moved `Diagnose Connection (TLS / Proxy / Network)` and `Clean Copilot Sessions` out of the main `vLLM-Copilot` category into a separate `vLLM-Copilot: Utilities` category so daily-workflow commands (Add, Test & Refresh, Configure Utility Model, log commands) are visually separated from maintenance/diagnostic tools. Command surface: 9 → 7 (5 main + 2 utilities).
- **Stale-doc cleanup** — removed all current-state references to the deleted commands from `README.md` (Quick Start + Configuration Reference), `docs/config-examples.md`, `docs/feature-ideas.md`, and the `package.json` `modelModes` description. Historical entries in `CHANGELOG.md` (prior releases) intentionally left intact as a release timeline.

## v0.15.1 (2026-07-12) — sessionManager refactor: Python → node:sqlite

- **Refactored `sessionManager.ts` to use `node:sqlite` instead of Python** — the "Clean Copilot Sessions" command previously shelled out to Python (via `execFile`) with hand-crafted Python scripts written to temp files as string arrays. It now uses Node's built-in `node:sqlite` module (`DatabaseSync`, `prepare`, `run`, `get`). `deleteChatKeys` runs a parameterized `DELETE FROM ItemTable WHERE key = ?` per key, summing `result.changes` for the row count. `countSessionsBatch` opens each DB read-only, fetches the `chat.ChatSessionStore.index` row, parses its JSON `entries` map for the count, and swallows per-DB errors as zero (same behavior as the Python version — one bad DB doesn't sink the scan). All `node:sqlite` calls are wrapped in try/finally with `db.close()` for connection cleanup.
- **Removed the Python runtime dependency** — Python is no longer needed for `sessionManager.ts`. The `pythonAvailable()` pre-check in `commands.ts` and the `runPython()` helper (temp file + `py`/`python`/`python3` search + 30s timeout) are gone. The command is now self-contained.
- **Bumped `engines.vscode` to `^1.125.0`** — `node:sqlite` is stable and unflagged starting with Node 23.4, and VS Code 1.125 (June 2026) bundles Electron 42 → Node 24, so `DatabaseSync` is available without an experimental flag. Earlier VS Code versions bundled Node 20/22 where the module was either missing or behind `--experimental-sqlite`.
- Behavior verified end-to-end with a temp-DB smoke test: 2/10 keys deleted (correct), unrelated key preserved, missing index returns 0, malformed JSON returns 0, missing DB file returns 0, missing `ItemTable` returns 0.

## v0.15.0 (2026-07-11) — eventsource-parser migration + packaging fix + content:null fix

- **Migrated SSE parser to `eventsource-parser`** — replaced the hand-rolled SSE line parser in `streamReader.ts` with `eventsource-parser` (v3.1.0, MIT, the same library the Vercel AI SDK uses). The hand-rolled parser was fragile around chunk boundaries, comment lines, and field validation — all now handled by the battle-tested library. `sseParser.ts` remains unchanged as the vLLM-specific JSON layer. `streamReader.ts` now uses `createParser()` with a callback-queue pattern: events are collected in an `onEvent` callback and yielded from the async generator. A `normalizeSSE()` bridge prepends `\n` before each `data:` line because vLLM sends single-`\n` separators while the SSE spec (and `eventsource-parser`) requires `\n\n`. On stream end, `\n\n` is fed to flush any buffered event. All 288 tests pass.
- **Fixed: extension not registering (empty Output channel)** — the VSIX excluded `node_modules/` without re-including `eventsource-parser`, so the extension failed to activate at load time with no visible error. `.vscodeignore` now re-includes `eventsource-parser/package.json`, `LICENSE`, and `dist/index.js`. This was a silent registration failure — the extension's Output channel never appeared.
- **Fixed: `content: null` on assistant messages with tool calls** — `convertAssistantMessage()` emitted `content: null` when an assistant message had tool calls but no text. Some vLLM chat templates render Python's `str(None)` → `"None"` into the prompt when `content` is `null`, corrupting the conversation and causing empty or garbled responses. Now emits `content: ""` (empty string), matching the format the auto-continue nudge already uses. Updated `OpenAIChatMessage.content` type to `string | OpenAIContentPart[]` (removed `| null`). Auto-continue retry logic is unaffected — it tracks response-side `outcome.hadContent`/`outcome.contentBuffer`, not request message formatting.
- **Code review completed** — full review with grade (75/100). Findings added to `known-bugs.md`. Remaining items are improvements (test coverage, file splits, bundler, fetchRetry jitter) and known limitations (character-based token estimation, proposed API dependency).

## v0.14.14 (2026-07-11) — Diagnose Connection command + error surfacing

- **New: "Diagnose Connection" command** — runs a deep network diagnostic that compares PowerShell (SChannel) vs Node `fetch` (OpenSSL) against the same endpoint, checks DNS/TCP reachability, dumps VS Code network settings + env vars, and — on Windows — builds the SChannel certificate chain with element listing. The report goes to a dedicated Output channel the user can copy-paste when reporting issues. No new dependencies (PowerShell via `child_process`, Node built-ins for DNS/TCP).
- **"Test & Refresh Models" now surfaces full error causes** — the catch block previously showed only `err.message` ("fetch failed"), hiding the real reason. It now uses `describeError()` to show the full cause chain (e.g. `fetch failed ← caused by: Error: unable to verify the first certificate [UNABLE_TO_VERIFY_LEAF_SIGNATURE]`) right in the warning dialog.
- **"Test & Refresh Models" offers diagnostic on failure** — when any model fails to connect, the command now offers to run the deep diagnostic on the first failed server.
- **"Add vLLM Server & Model" offers diagnostic on failure** — when the connection test fails during the Add Server flow, the command now uses `describeError()` for the error message and offers to run the diagnostic using the in-memory URL + headers the user just typed (not from settings — the server isn't saved yet). The user can decline and re-enter info, or run the diagnostic to see the root cause.
- **Diagnostic covers all typical failures** — DNS resolution, TCP/firewall reachability, TLS certificate (SChannel vs Node comparison + chain build), proxy misconfig, proxy auth (407), API auth (401/403), wrong URL (404), server errors (5xx), timeouts, VS Code settings gating, env var conflicts, and version incompatibility.

## v0.14.13 (2026-07-10) — Network diagnostics + doc corrections

- **Test & Refresh now checks VS Code network gating settings** — when a connection fails, the command checks `http.proxySupport`, `http.fetchAdditionalSupport`, and `http.systemCertificates` (the three settings that gate VS Code's patched `fetch`). If any are non-default (e.g. IT pushed `http.proxySupport: off` via managed policy), a warning popup lists which ones and offers an "Open Settings" button. No popup when everything is healthy — no noise for normal users.
- **Discovery errors now logged with specific cause** — `getModelContextWindow` previously swallowed errors silently (returned `undefined`). It now logs `[WARN] getModelContextWindow: <specific error>` to the Output channel, so users see _why_ discovery failed (DNS failure, TLS error, 401, timeout) instead of the provider's generic "failed to connect" message.
- **Corrected `http.proxyStrictSSL` documentation** — all docs (README, known-bugs, CHANGELOG, proxy.ts, extension.ts) incorrectly claimed `http.proxyStrictSSL` is respected by the patched fetch. Verified against VS Code source (`proxyResolver.ts`, `@vscode/proxy-agent`): `proxyStrictSSL` is only consumed by the main-process `RequestService` (http/https module path), NOT by the fetch patch. Undici always verifies (`rejectUnauthorized: true`) — this is stricter, not weaker. The `http.proxyStrictSSL: false` troubleshooting recommendation was removed; `NODE_EXTRA_CA_CERTS` is the correct workaround for cert issues.
- **Added gating settings to all docs** — `http.proxySupport` (default `override`), `http.fetchAdditionalSupport` (default `true`), `http.systemCertificates` (default `true`) must all stay at defaults for the patched fetch to work. These are now documented in README, known-bugs, CHANGELOG, proxy.ts, and extension.ts.
- **Removed unused `@vscode/dts` devDependency** — it was a CLI tooling package that wasn't used anywhere in the build or test pipeline.

## v0.14.12 (2026-07-10) — Truncated tool-call recovery (best-effort JSON parser)

- **Recover partial content from truncated tool-call arguments** — when `finish_reason: 'length'` cuts a tool call mid-string-value (a common vLLM scenario with long `edit_file` / `write_to_file` calls), `jsonrepair` throws because it can't close unterminated strings, and the user previously got a tool call with empty `{}` args. Added a third parsing tier using `best-effort-json-parser` (the same library Copilot's BYOK path uses for the same reason): it closes open strings/arrays/objects and preserves the partial content the model produced. The user now sees what the model was trying to write instead of an empty tool call. On a truncated `{"path":"foo.ts","content":"def hello`: `jsonrepair` FAILs, `parsePartialJson` returns `{"path":"foo.ts","content":"def hello"}`. The user also still gets the existing `[WARN] tool call arguments may be truncated (finish_reason: length)` diagnostic. Added `best-effort-json-parser` dependency.

## v0.14.11 (2026-07-10) — Proxy/TLS code removed (delegated to VS Code)

- **Removed all extension-side proxy/TLS code** — the prior approach (`configureGlobalProxy`, `configureSystemCaTrust`, `tls.setDefaultCACertificates`, `setGlobalDispatcher(new EnvHttpProxyAgent(...))`) **overrode** VS Code's carefully-configured patched `globalThis.fetch` and broke TLS on corporate laptops presenting internally-signed certificates (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`), the very problem it was trying to fix. VS Code's extension host installs a patched `globalThis.fetch` at startup (via `proxyResolver.ts` → `patchGlobalFetch`) that handles proxy routing (`http.proxy`, `HTTP(S)_PROXY`), `http.noProxy`, and the OS certificate store (`loadAdditionalCertificates`, gated by `http.systemCertificates` default `true`) per-request. The patch is gated by `http.proxySupport` (default `override`) and `http.fetchAdditionalSupport` (default `true`). Using plain `fetch()` — which _is_ the patched fetch — gets all of this for free. `src/proxy.ts` is now a documentation-only stub; `test/proxy.test.ts` deleted; the `undici` dependency removed. Matches how BYOK works (it uses the same patched fetch via `__vscodePatchedFetch` / `electron.net.fetch`). Note: `http.proxyStrictSSL` is NOT wired into the fetch path (undici always verifies) — this is stricter, not weaker. Residual limitation: if a proxy presents an incomplete chain (missing intermediate not in the OS store), set `NODE_EXTRA_CA_CERTS` to a PEM containing the corporate root + intermediate — Node does not fetch intermediates via AIA the way Windows SChannel does.

## v0.14.10 (2026-07-10) — TLS fix corrected (reverted in v0.14.11) + BYOK guard

- **Corrected the OS-trust-store fix** — v0.14.9 set `process.env.NODE_USE_SYSTEM_CA` at activation, which does nothing (that is not a real Node env var; `--use-system-ca` is a startup CLI flag that cannot be injected into the running extension host). Replaced with `tls.setDefaultCACertificates()` (Node 22.15+), the true **runtime** equivalent: it loads the merged OS trust store (`default` + `system` + `extra`) into Node's process-wide default CA set, which undici's global `fetch` honors — verified. _Superseded in v0.14.11: this still overrode VS Code's patched fetch dispatcher and broke TLS on corporate networks; both approaches were removed and the extension now uses plain `fetch()`._
- **Guard `chat.byokUtilityModelDefault` write** — the setting only exists in VS Code 1.128+. On older versions writing it threw `... is not a registered configuration` (a noisy `[WARN]`). The extension now checks the setting is registered (via `inspect().defaultValue`) before writing and swallows write failures, so nothing is logged on VS Code < 1.128.

## v0.14.9 (2026-07-10) — Corporate TLS certificate fix (reverted in v0.14.11)

- **Use OS trust store for TLS verification** — the extension now sets `NODE_USE_SYSTEM_CA=1` before any network call, making Node's `fetch` use the OS trust store (SChannel on Windows) instead of Node's bundled CA list. This makes TLS verification behave identically to the browser and PowerShell: SChannel auto-fetches missing intermediate certificates via AIA, which Node's OpenSSL-based crypto does NOT do. On corporate networks this is the #1 "works in PowerShell but not in fetch" failure (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). Fixes the `fetch failed` errors behind TLS-inspecting proxies and with internally-issued server certificates. _Superseded in v0.14.11 — `NODE_USE_SYSTEM_CA` is a no-op at runtime; the whole proxy/TLS layer was removed and replaced with plain `fetch()`._
- **Trust the OS certificate store for TLS** — Node's `fetch` (undici) validates certificates against Node's bundled Mozilla roots only and ignores the OS trust store. On corporate networks this caused `fetch failed` where PowerShell/Edge/Chrome succeed: a TLS-inspecting proxy (MITM) or a server with an internally-issued cert presents a certificate signed by a corporate root CA that lives in the OS store but not Node's bundle. The extension now merges the OS trust store (and `NODE_EXTRA_CA_CERTS`) into undici's dispatcher — both on the proxy path and on direct connections — so those certs are trusted while strict verification stays on. Gated behind `http.proxyStrictSSL` (when off, verification is skipped as before) and degrades gracefully on Node builds without `tls.getCACertificates`. _Superseded in v0.14.11 — that dispatcher merge overrode VS Code's patched fetch and broke TLS on corporate networks; the extension now delegates entirely to VS Code's patched `globalThis.fetch`._
- **Network errors now surface their cause** — `fetch` throws a generic `TypeError: fetch failed` and buries the real reason (TLS/cert code, `ECONNREFUSED`, `ENOTFOUND`, proxy `407`) in `err.cause`. Discovery, chat retry, and the Add-Server flow now log the unwrapped cause chain (with error codes) so corporate-proxy / certificate problems are diagnosable instead of showing only "fetch failed".

## v0.14.8 (2026-07-10) — BYOK utility model support

- **Auto-configure `chat.byokUtilityModelDefault`** — on extension activation (and after each model save), the extension now ensures `chat.byokUtilityModelDefault` is set to `mainAgent`. This fixes the `No utility model is configured for 'copilot-utility-small'` error that occurs when MCP servers trigger Copilot's Agent mode with BYOK models. The setting is only written if it has never been configured — explicit user choices (`copilot`, `none`) are respected.
- **Configure Utility Model command** — new **vLLM-Copilot: Configure Utility Model** command lets users choose between `mainAgent` (use selected BYOK model for utility tasks), `copilot` (use GitHub Copilot's built-in utility models), or `none` (no utility model). Access via Command Palette.

## v0.14.7 (2026-07-10) — Corporate TLS trust & error visibility

- **Trust the OS certificate store for TLS** — Node's `fetch` (undici) validates certificates against Node's bundled Mozilla roots only and ignores the operating-system trust store. On corporate networks this caused `fetch failed` where PowerShell/Edge/Chrome succeed: a TLS-inspecting proxy (MITM) or a server with an internally-issued cert presents a certificate signed by a corporate root CA that lives in the OS store but not Node's bundle. The extension now merges the OS trust store (and `NODE_EXTRA_CA_CERTS`) into undici's dispatcher — both on the proxy path and on direct connections — so those certs are trusted while strict verification stays on. Gated behind `http.proxyStrictSSL` (when off, verification is skipped as before) and degrades gracefully on Node builds without `tls.getCACertificates`. _Superseded in v0.14.11 — the dispatcher merge overrode VS Code's patched fetch and broke TLS on corporate networks; the extension now delegates entirely to VS Code's patched `globalThis.fetch`._
- **Network errors now surface their cause** — `fetch` throws a generic `TypeError: fetch failed` and buries the real reason (TLS/cert code, `ECONNREFUSED`, `ENOTFOUND`, proxy `407`) in `err.cause`. Discovery, chat retry, and the Add-Server flow now log the unwrapped cause chain (with error codes) so corporate-proxy / certificate problems are diagnosable instead of showing only "fetch failed".

## v0.14.0 (2026-07-09) — Simplified discovery

- **Discovery reads from settings + vLLM server** — the model picker reads `vllm-copilot.models` from settings, then queries each model's vLLM server for `max_model_len` (context window). All models are queried in parallel. This also serves as a server availability check — offline servers are skipped with a warning.
- **`maxModelTokens` removed from settings** — context window is now read exclusively from the vLLM server during discovery. Users can still limit input budget via `maxInputTokens` (clamped to `max_model_len - maxOutputTokens`). `maxModelTokens` in existing settings is silently ignored.
- **Removed `dedupByRoot`** — the alias deduplication logic was a silent point of failure: if vLLM served multiple aliases (same root, different ids), `dedupByRoot` could pick a different alias than the configured `vllmModelId`, causing auth headers to vanish. Discovery now trusts the settings `vllmModelId` unconditionally.
- **`serverUrl` and `requestHeaders` never depend on `vllmModelId`** — server-level config (URL, auth headers) is always sent. If `vllmModelId` is wrong, the server returns 404 with a clear error. Previously, a mismatched `vllmModelId` cascaded to strip the server URL and auth headers, making diagnosis impossible.
- **Reload prompts removed** — all "Reload window" dialogs have been replaced with non-blocking notifications. Settings changes take effect immediately via the `onDidChangeConfiguration` → `clearCache` → `onDidChangeLanguageModelChatInformation` event chain.
- **Stale diagnostic logging removed** — the `[ERROR] No model override found` warning is gone because discovery no longer produces unmatched models.

## v0.13.2 (2026-07-08) — Model Settings Reference

- **Model Settings Reference command** — new **vLLM-Copilot: Model Settings Reference** command opens a webview panel showing all available model configuration properties in a searchable table. Each property includes its type, default value, and description (with nested properties like `capabilities.toolCalling` shown indented). Solves the "I don't know what setting does X" discovery problem for per-model settings. Access via Command Palette → "Model Settings Reference".
  > ⚠️ **Removed.** This command is no longer registered in `package.json`. The configuration reference now lives in the README and `docs/config-examples.md` instead.

## v0.13.1 (2026-07-08) — Proxy support, composite model ids, and UX fixes

- **Corporate proxy support** — the extension now respects VS Code's `http.proxy` / `http.proxyStrictSSL` / `http.noProxy` settings and the `HTTP(S)_PROXY` environment variables. All outbound `fetch()` calls (chat, discovery, auto-configure) are routed through the proxy automatically. Loopback hosts (`localhost`, `127.0.0.1`, `::1`) are always bypassed so local vLLM instances and port-forwarded servers work behind a proxy without manual configuration. Proxy is reconfigured at runtime when `http.*` settings change — no reload needed. _Superseded in v0.14.11 — extension-side proxy routing was removed; VS Code's patched `globalThis.fetch` handles `http.proxy`/`noProxy`/`proxyStrictSSL` per-request now._
- **Composite model ids** — model entries are now identified as `"<model> on <host>"` (e.g. `zai-glm-52 on host.example.com`). This makes the picker readable without a `displayName`, and — crucially — lets the same model served from two servers coexist as distinct entries (manual load balancing). A one-time migration rewrites existing entries on first launch. The raw server model id is preserved as `vllmModelId` (the wire identity sent to vLLM).
- **API key is Bearer-only** — the Add / Update flow now sets only `Authorization: Bearer <key>` from the API key prompt. The automatic `x-api-key` header was removed; custom gateway keys (e.g. `X-API-Key`, Cloudflare Access) are a separate concern and belong in the custom-headers step. Single source of truth: `buildAuthHeaders` in `config.ts`.
- **Auto-configure never touches connection settings** — both the preset and HuggingFace branches of the standalone **Auto-Configure Model** command now explicitly preserve the model's existing `serverUrl` and `requestHeaders` (API keys, auth, routing headers). Previously this relied on an implicit `?? prev` fallback.
- **Fix: `&` visible in dialog buttons** — the standalone Auto-Configure dialogs rendered `&Use Preset` and `&Auto-Discover` literally (VS Code doesn't support `&` mnemonics in message buttons). Fixed.
- **Fix: Replace button in Auto-Configure did nothing** — the "already configured" overwrite warning used `label: '&Replace'` but compared `confirm?.label !== 'Replace'`, which was always true. Clicking Replace was silently treated as cancel. Fixed using reference comparison.
- **README Quick Start rewritten** — now focuses on using the extension (install → Add Server → use in Copilot). Server-side `vllm serve` flags moved to the Troubleshooting table where they belong.
- **Private repo URL removed** — the internal GitHub URL was present in README, the `vsce` build script (`--baseContentUrl`), and an internal documentation file. All removed. `launch.json` publisher id corrected to `private.vllm-copilot`.

## v0.13.0 (2026-07-08) — Per-model cleanup & API key onboarding

Builds on the v0.12.2 per-model rewrite with a code-review pass, a simpler onboarding flow, and the removal of all remaining legacy global-server scaffolding.

- **Single add command** — removed the duplicate **Connect to vLLM Server** command; **Add vLLM Server & Model** is now the one guided flow.
- **Update Server / Auth command** — new **Update vLLM Server / Auth for a Model** command to rotate an API key or move a model to a new server. It updates only `serverUrl` and `requestHeaders`, preserving the model's `modelModes`, `defaultParams`, capabilities, and token budgets exactly (unlike Add, which re-runs auto-configure).
- **API key prompt** — the Add-Server flow now asks for an optional API key (masked input) and folds it into the model's `requestHeaders` as `Authorization: Bearer <key>` + `x-api-key: <key>`. Custom headers entered afterwards win over the key-derived ones. Auth is stored as plaintext per-model headers in settings — there is no secret storage.
- **Zero global-field dependency** — deleted the deprecated `serverUrl`/`apiKey`/`requestHeaders` fields from `VllmConfig` and every runtime read/fallback. `resolveServerConfig(override)` now takes only the model; `fetchWithRetry`/`listModels`/`chatCompletionStream` require per-model server config. Removed the dead global-apiKey plumbing threaded through the auto-configure and refresh/test fetch helpers.
- **Alias de-duplication fix** — when a vLLM server exposes several `--served-model-name` aliases of the same checkpoint (same `root`), the picker now shows only the configured alias (or one representative). Multiple deliberately-configured aliases of the same model are all kept — no silent drops.
- **Root-based preset matching** — Auto-Configure now matches a `model-configs/` preset by the server model's `root` (its real checkpoint) as well as its id, so a preset authored for the repo id (e.g. `zai-org/GLM-5.2-FP8`) still applies when you configured a short server alias (e.g. `zai-glm-52`).
- **Presets never rewrite identity** — applying a preset preserves your model's own `id` and `vllmModelId` exactly; the preset's id/vllmModelId are used only for matching. Everything else (modes, params, capabilities, budgets) is applied as before.
- **GLM-5.2 preset corrected** — rebuilt `model-configs/glm-5.2-config.json` from the vLLM recipe and `generation_config.json`: removed the invalid `top_k: 0` (GLM-5.2 uses no top_k), aligned sampling to `temperature 1.0 / top_p 0.95` (and `top_p 1.0` for the Code mode), and simplified the thinking modes to the two official `reasoning_effort` levels (`max`, `high`) plus non-think.
- **Presets now ship in the VSIX** — `model-configs/*.json` were previously excluded from packaging, so **Auto-Configure** could never find a preset in an installed extension. They're now bundled (only the dev README is excluded).
- **Add flow offers presets** — when you add a model whose server connects, **Add vLLM Server & Model** now checks the bundled presets (by id or the server model's `root`) and offers **Use Preset** vs **Auto-Discover (HuggingFace)** right away — so curated configs are one step, not two.
- **Removed `capabilities.supportsThinking`** — the flag was written by Auto-Configure but never read (VS Code exposes only `imageInput`/`toolCalling`; the thinking-mode picker is driven by `modelModes`). Deleted from the type, the settings schema, the auto-config writer, the presets, and the docs. Thinking is still fully controlled per-mode via `chat_template_kwargs` (`enable_thinking` / `reasoning_effort`).
- **Unified param layering** — `buildRequest` now resolves sampling params through the same `resolveRequestParams` used by the tests (built-in defaults ← Copilot `modelOptions` + `max_tokens` ← model `defaultParams` ← selected mode), removing duplicated layering logic and giving the tests a real runtime seam.
- **Tests** — added `dedupByRoot` coverage (alias collapsing, multi-config retention, root grouping) and `resolveRequestParams` runtime-options layering tests; rewrote the header/sanitization tests around the per-model resolver.

## v0.12.2 (2026-07-08) — Per-model everything

**Breaking (auto-migrated):** there is no global server or global sampling anymore. Every setting is per-model, and a one-time migration on first launch moves your existing global `serverUrl`, `requestHeaders`, API key, and sampling/token settings into each model entry, then clears the globals.

- **Per-model server (required)** — each model entry carries its own `serverUrl`. Models without one are skipped with a warning.
- **Credential isolation** — a model's `requestHeaders` are used only for that model's server and are never shared with (or leaked to) other servers. The global API key is no longer sent to per-model servers.
- **Layered params** — request params resolve as built-in defaults → model `defaultParams` → the selected `modelModes` entry. New per-model field `defaultParams` holds model-scope request params (same shape as a mode).
- **Per-model token/transport** — `maxOutputTokens`, `estimateCharsPerToken`, `streamInactivityTimeout`, and `autoContinueRetries` are now per-model with built-in defaults. Context window (`max_model_len`) is auto-discovered from the vLLM server during discovery and cannot be set in settings.
- **Guided onboarding** — new **Add vLLM Server & Model** command: enter a server URL + headers, discover its models, auto-configure the chosen one, and save it. **Auto-Configure** / **AI Configure** / **Refresh** / **Test Connection** now operate per-model across all configured servers.
- **Forgiving input** — the Add-Server header prompt and `model-configs/*.json` preset loading now use `jsonrepair`, so shorthand like `X-API-Key: abc`, single quotes, missing braces, or trailing commas are repaired instead of rejected/skipped.
- **Removed global settings** — `serverUrl`, `requestHeaders`, `temperature`, `topP`, `topK`, `minP`, `repetitionPenalty`, `presencePenalty`, `frequencyPenalty`, `seed`, `stopSequences`, `maxOutputTokens`, `minOutputTokens`, `maxModelTokens`, `thinkingTokenBudget`, `streamInactivityTimeout`, `autoContinueRetries`, `estimateCharsPerToken`, `badWords`, `ignoreEos`, `repetitionDetection`, `structuredOutput`. `enableFileLogging` remains the only global. These values now live on each model (or its `defaultParams`).

## v0.12.1 (2026-07-07) — Thorough code review

- **Token budget clamp** — `deriveTokenBudget` now enforces `maxInputTokens + maxOutputTokens ≤ maxModelLen`. Previously conflicting per-model overrides (input + output exceeding the context window) would silently produce an impossible budget, causing server rejections with confusing errors.
- **Tool choice preservation** — `tool_choice` is no longer silently overwritten to `undefined` when `toolMode` is not `Required`. Copilot's own `tool_choice` from `modelOptions` (if ever sent) is now preserved.
- **Auto-configure UX** — Removed unexpected warning popups (`showFetchWarning`) during the auto-configure progress flow. Supplementary fetch failures are reported via the summary text instead of stacked modal dialogs.
- **Type safety** — Converted 5 `catch (err: any)` to `catch (err: unknown)` across source files. Fixed `isImagePart` to use a type predicate, eliminating an `as` cast at the call site.
- **Header merge correctness** — `buildRequestHeaders` now accepts `HeadersInit` through a `normalizeHeaders` helper, properly handling `Headers`, `string[][]`, and `Record` input shapes.
- **Config validation** — Added cross-field check: `minOutputTokens > maxOutputTokens` now produces a warning.
- **Cleanup** — Removed dead test function (`getChatBody`), duplicate non-SSE response tests (consolidated to one file), stale `tokenizerMode` field from 4 test stubs, and simplified repeated capability initialization in auto-config.

## v0.12.0 (2026-07-07) — Structured Outputs (Phase 2)

- **Structured Outputs** — Enforce output constraints at the token level. Set `vllm-copilot.structuredOutput` with exactly one of `json` (JSON schema), `regex` (pattern), `choice` (exact choices), or `grammar` (EBNF). Guarantees schema-compliant output — not "hope the model complies". Requires vLLM ≥ v0.12.0.

### README reorganization

- Consolidated all vLLM-specific features (modelModes, multi-parameter sampling, enable_thinking, vLLM params) into one prominent **vLLM-Specific** section. The README now clearly separates BYOK-compatible settings from the moat features that justify this extension.

## v0.11.0 (2026-07-06) — Per-model server & headers

- **Per-model `serverUrl`** — A model preset can now point to a different vLLM server than the global one. On refresh, models are also discovered from each custom server (fault-tolerant: a dead custom server no longer blocks discovery of others).
- **Per-model `requestHeaders`** — Merged on top of the global `requestHeaders`; identical names are overwritten, new names added.
- **Per-server API keys** — Model-level `requestHeaders` can now override the `Authorization` header, so different servers can use different keys. The global key (SecretStorage) remains the default and is inherited when not overridden.

### Behavior change

- Header priority is now **auth → model/custom headers → caller headers**. Previously auth always won; now a model's `requestHeaders` can override it (needed for per-server keys).

## v0.10.0 (2026-06-29) — Smarter continuation & workspace instructions

- **Colon-truncation continuation** — Auto-continue now also triggers when a response ends mid-sentence on a trailing colon (`finish_reason: stop`). Unlike the empty-response nudge, it resumes the _same_ assistant turn using vLLM's `continue_final_message`/`add_generation_prompt` flags, so already-streamed text is never duplicated.
- **Workspace custom instructions** — The extension now reads `.github/copilot-instructions.md`, `AGENTS.md`, and `CLAUDE.md` from the workspace and injects them as a system message (VS Code does not forward these to third-party chat providers). Cached with a file watcher that invalidates on edit/delete and config change.

### Bugs fixed

- **File-watcher leak in instruction cache** — Watchers are now disposed on every invalidation path (change/delete/config), preventing duplicate watchers on rapid edits.

## 0.9.1

- **Session cleaning on Windows**: Added `py` (Python Launcher) as the first Python interpreter attempt on Windows, fixing session cleaning on corporate machines where `python`/`python3` commands are blocked by Microsoft Store app execution aliases.

Notable changes to vLLM-Copilot, newest first.

---

## v0.9.0 (2026-06-24) — Auto-continue on empty responses

- **New `vllm.autoContinueRetries` setting** (integer, default `1`) — When the model returns an empty response with `finish_reason: stop` (after thinking or tool results), the extension automatically retries using the **assistant prefill** technique: appending `{role: 'assistant', content: ''}` to the message history and re-sending. All retries happen within a single chat call, invisible to Copilot. Set to `0` to disable.

## v0.8.10 (2026-06-24) — Error handling & timeout fixes

- **Genuine network failures (ECONNRESET, socket hang up) silently swallowed** — `isGracefulTermination()` was too broad, treating all network-level errors as "VS Code did it". Now only `TypeError: terminated` (the specific signature of VS Code calling `.terminate()` on a stream) is treated as graceful. All other errors surface to the user as actionable messages.
- **Inactivity timeout fires during tool execution** — The old wall-clock `setTimeout` kept ticking while the generator was paused at `yield` during tool calls, causing spurious timeouts after any tool execution >30s. Rewrote to measure `reader.read()` latency instead — only runs while actually waiting on the network, immune to generator pauses.
- **Removed `requestTimeout` setting** — Was redundant. VS Code's cancellation token + `streamInactivityTimeout` + error handling cover all real failure modes. The 60s fetch timeout was misnamed (really a connection timeout), leaked on the happy path, and added a confusing setting.
- **`streamInactivityTimeout` now defaults to 0 (disabled)** — Large models can have long pauses between tokens. A 30s default caused false positives. Users who want it can still enable it.

## v0.8.9 (2026-06-20) — Tooling & repo hygiene

No runtime behavior change; maintenance only.

- Removed ESLint (`lint` script + `@eslint/js`, `eslint`, `typescript-eslint` deps): the flat config was missing so it never ran; strict TypeScript covers it. Pruned 80 packages.
- Deleted `build.sh`; folded its correct `--baseContentUrl` into the `npm run build` script (which had a duplicated `https://example.com` placeholder). Documented `compile`/`test`/`build` in `.github/copilot-instructions.md`.
- Removed stale `src/tokenizerManager.ts` reference from `vitest.config.ts` coverage excludes.
- Removed stale `plan.md` / `build.sh` entries from `.vscodeignore`; added `coverage/` and `*.tsbuildinfo` to `.gitignore`.
- Decluttered root markdown: deleted `backtick-problem.md`, `newplan.md`, `competitor_investigation-task.md`; moved `ai-configure-prompt.md` and `competitor-analysis.md` into `docs/`.

### Bugs fixed

- **HTTP 400 TextEncodeInput from vLLM** — `options` spread could overwrite `messages` body key. Added `PROTECTED_BODY_KEYS` guard in `chatCompletionStream` so `model`, `messages`, `stream`, `stream_options` cannot be overwritten. Added pre-send validation to throw an actionable error if `messages` is invalid.
- **JSON error body not truncated** — Added `.slice(0, 500)` to `JSON.stringify(data.error)` for consistency with text body handling.
- **Duplicate fetch logic in autoConfig** — Extracted `fetchWithTimeout()` helper with centralized timeout + auth header logic. All four fetch call sites now use the shared helper.

---

## 2026-06-20

### Bugs fixed

- **Config caching duplication in provider** — Added `getConfigCached()` to the provider; all `getConfig(this.context)` calls replaced. Config is now cached alongside VllmClient, invalidated on settings change.
- **EventEmitter never disposed** — Provider now implements `vscode.Disposable` with `dispose()` that cleans up emitter and timer. Registered as disposable in `extension.ts`.
- **Cancellation token not propagated in model discovery** — `listModels()` now accepts optional `AbortSignal`; provider wires `CancellationToken` to `AbortController` and disposes listener in `finally`.
- **`provideTokenCount` has no error handling** — Added try/catch with fallback to default 3.5 chars/token and warning log on config read failure.
- **`connectionErrorShown` flag reset logic** — Added 60s timer reset on failure in addition to existing success reset, so transient errors can be re-reported.
- **Specific error messages lost in generic user messages** — Known errors (e.g., missing `max_model_len`) now surface their specific message instead of a generic "Failed to connect" popup.
- **Inconsistent error vs. warning severity** — Changed HTTP error in configure command from `showWarningMessage` to `showErrorMessage`. Policy: all HTTP errors and network failures are `showErrorMessage`; only supplementary data fetches (HuggingFace) remain warnings.
- **No activation-level error handling** — `activate()` wraps the entire body in try/catch with full stack logging to the output channel and a user-facing error message with "Open Output" button.
- **File logger init failure is silent** — `FileLogger.init()` logs `[INFO]` on success and `[ERROR]` with reason on failure to the output channel.
- **`sessionManager.ts` has zero logging** — `runPython()` now logs every attempt (`python` / `python3`) with `[WARN]` on failure and throws a detailed error so callers can surface it. Temp-file write failures are also logged and thrown.

---

## 2026-06-19

### Bugs fixed

- **`autoConfigureModel` Promise.all crash on network error** — Replaced `Promise.all` with `Promise.allSettled`; rejections logged to summary.
- **Network retry ignores user cancellation** — Re-wired caller abort signal in network retry path, matching the 5xx retry pattern.
- **`TypeError: terminated` (SocketError: other side closed) misclassified as user abort** — Added socket closure patterns (`other side closed`, `ECONNRESET`, `socket hang up`, `SocketError`) to `formatError()` before the generic `terminated` fallback.
- **`TypeError: terminated` / `ECONNRESET` after file reads treated as hard error** — Added `isGracefulTermination()` helper in `provider.ts` to detect VS Code-initiated connection resets (no cancellation token fired) and treat them as graceful stops: quiet `[INFO]` log, no user-facing error.
- **Empty chat response when stop or graceful termination produces no content** — Both `isEmptyStopAfterTool` and `isGracefulTermination` paths now report a minimal text part to chat so VS Code doesn't show "Sorry, no response was returned."
