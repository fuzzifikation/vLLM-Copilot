# Changelog

## v1.19.0 (upcoming) — Native Tree View Dashboard

- **New: vLLM Server Dashboard as native VS Code Tree View** — replaced the webview sidebar with a TreeDataProvider-based sidebar. Server list with collapsible per-server metrics: model names, context window, KV cache usage, running/watching requests, TTFT, TPOT, cache hit rate, MTP speculative decoding metrics, preemptions, evictions.
- **New: status bar health indicator** — color-coded status bar item shows KV cache usage for the first configured server. Clickable to refresh the dashboard. Supports multiple servers (shows first server's status).
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
