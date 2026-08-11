# Changelog

## v1.22.0 — Token & Cost Usage Tracker

- **Token & cost usage tracker** — a cumulative **Token Usage and Cost** node under each server, **model-first**: one collapsible entry per model (labeled by `displayName`) with **Today** and **Overall** rows. Rows are **price-first** (`$1.90 · 800 k in · 200 k cached · 500 k out`); input is split so cached is never double-counted. A model's collapsed summary reads `$11.51 today and $31.13 in 3.1 days` (today's cost + all-time cost over the recording window). Persisted across reloads (90-day retention).
- **Per-model cost tracking** — optional per-1M `cost` rates (`input` / `output` / `cachedInput` + `currency`), derived at render time so editing a rate re-prices all history. Currency decoration uses a small static symbol map ($ € £ ¥, `credits` for AI Credits, raw-code fallback — no i18n library); also fixes non-USD currencies that previously rendered as a wrong `$`.
- **Set Cost…** — right-click the node to configure a model's rates via guided prompts (model → rates → currency).
- **Reset Usage** — right-click action on the node (server scope) or a palette command (all / per-server); clears all-time + daily. The Last Request node is kept.
- **Live dashboard updates** — Last Request and usage nodes re-render immediately after every prompt (also fixes the stale Last Request node).
- **Removed the Session plane** — it was in-memory state that reset on reload (reading `0` after install); no session identity is available through the provider API. The tracker keeps persisted Today / Overall. No migration — the persisted shape is unchanged (v2 adds `startedAt`, additive).
- **Internal:** `lastRequestStore.ts` merged into `usageStore.ts` — single ingestion point, serialized `globalState` writes, one change event.

## v1.21.0 — Provider & command decomposition + bug fixes

### Fixed

- Duplicate `settings.json` entries no longer created on Set Personality / Replace Config (server-less and shared-model configs).
- Test & Refresh surfaces silent failures (unreachable servers, zero-model servers, diagnostic escape).
- Chat config-read / pipeline failures routed through the standard error path — no more unhandled rejections.
- Cancelling before the first token no longer shows a spurious "model returned no output".
- Diagnostics no longer misattribute proxy failures to a bad certificate chain; TLS `valid` reflects real exit codes.
- **Security:** the diagnostics `openssl` check no longer runs a shell command with an interpolated hostname (command-injection fixed).
- Deep-Dive / dashboard: no duplicate panels per URL spelling, no orphaned pollers, cached data on first open, hidden sidebar no longer polls, no double-subscribing.
- Metrics engines released on last unsubscribe; engines keyed by canonical URL.
- File logs pruned to the 20 most recent (plaintext API keys no longer accumulate unbounded).
- Auto-configure no longer claims tool calling the model provably lacks; preserves token-budget overrides and personality.
- Token-budget fixes: no zero-input / zero-output models; dead UI `max_tokens` layering removed.
- `vv0.6.0` doubled version prefix fixed.

### Changed

- Provider decomposed into `src/provider/*` and `src/commands/*` — behavior-preserving.
- Server Settings: Save/Revert pinned to a sticky action bar with an unsaved-changes indicator; unsaved edits survive refreshes; any scalar field can be cleared.

### Internal

- `test:typecheck` gate added to the build; dead settings/code removed (dashboard.enabled, migration, sentinel drains, last `any` network boundaries).

## v1.20.8 — Test & Refresh consolidation

- Single consolidated popup instead of one toast per server.
- Shared workspace-root path-resolution helper.

## v1.20.7 — Supportive Mentor rename

- "Tough Love" renamed to "Supportive Mentor"; stale docs snapshots removed.

## v1.20.6 — Personality overhaul

- New **Raw (Model Natural)** personality (no persona injected); bundled personalities re-synced on apply; curated dropdown order; Sarcastic Robot de-Bendered; README overhaul.

## v1.20.5 — Personality hardening & picker fixes

- Same model on multiple servers now shows as separate picker entries. ⚠️ Re-select the model once; `settings.json` is not rewritten.
- Empty-field clear semantics unified; webview error boundary; duplicate-`id` warning.

## v1.20.4 — Global personalities

- Personalities are global (follow you across workspaces, survive upgrades); picker in Server Settings; `THIRD-PARTY-NOTICES.txt` generated.

## v1.20.3 — Clear personality

- **"Default (no personality)"** clears a model's replacements; active personality marked in the picker; portable config paths.

## v1.20.2 — Server Settings UX

- Auto-Configure works on unconfigured models; **Remove Server** → **Remove Model** (per-model only).

## v1.20.1 — DeepSeek-V4-Flash-0731 preset

- New model preset with model-card sampling parameters.

## v1.20.0 — Engine unification & bug-squash

- **Unified metrics engine** shared by dashboard and deep-dive — single poll cycle, reference-counted, stops on last subscriber.
- Dashboard no longer re-reads config every poll.
- Add Server: three-way failure dialog (Discard / Run Diagnostic / Keep Anyway).
- Test & Refresh grouped by server; no-match flow offers Pick Model / Auto-Configure.
- Server Settings: Auto-Configure and Remove Server buttons; dashboard context menu trimmed.
- Smart URL normalization (`host:8000` → http, bare host → https, strips `/v1`).
- Removed 293 lines of dead migration code.
- Various fixes: auth-header propagation on re-use, engine zombies, timeout aborts, personality cache poisoning.

## v1.19.96 — Removed `id` from bundled presets

- Preset matching uses `vllmModelId` only — `id` is reserved for the user's settings identifier.

## v1.19.95 — Model matching + auto-continue fix

- Auto-continue no longer retries after a pure tool-call turn.
- Cross-org + quantization-agnostic model matching (NVFP4 → base preset).
- Dashboard: no phantom entries; context-window percentage denominator fixed.

## v1.19.94 — Lowered VS Code floor to 1.122

- `engines.vscode` → `^1.122.0` (`node:sqlite` unflagged since Node 22.13); known-bugs audit.

## v1.19.92 — Test & Refresh parked models

- Matching on `m.id`, not `root`; no more nagging about intentionally parked models.

## v1.19.91 — NVFP4 suffix matching

- `-NVFP4` recognized as a quantization suffix.

## v1.19.90 — Poolside Laguna-S-2.1

- New preset (Think / No Think); default temperature aligned with vLLM's 1.0.

## v1.19.86 — cached_tokens fix

- `cached_tokens` read from the correct nested usage path (was always 0).

## v1.19.8 — Remote connection UX

- Clear warning + "Install on remote" when the extension isn't installed on Remote-SSH / WSL / devcontainer.

## v1.19.5 — Last Request Details

- Last Request node in the dashboard (tokens, timing, throughput; requires server flags); `createdCacheTokens` shown; 6 more vLLM params in the picker.

## v1.19.4 — Repo housekeeping

- CONTRIBUTING, issue/PR templates, README badges, repo topics, packaging fix.

## v1.19.3 — Dead-code cleanup

- `[WARN]` when model family falls back to a heuristic; webview listener leak fixed; unified wire type.

## v1.19.2 — Bug fixes

- Server Settings no longer silently discards `vllmModelId` edits; status bar removed (dashboard covers it).

## v1.19.1 — Server Settings webview

- Per-model settings webview (no manual `settings.json` edits); model discovery; parameter picker; defaultMode picker; `validate-webview-js` script.

## v1.19.0 — Native Tree View Dashboard

- Native VS Code tree-view dashboard replacing the webview sidebar: polling, MTP metrics, context window, throughput, clickable refresh interval.

## v0.18.0 — Historical reasoning

- Forwards historical `LanguageModelThinkingPart` content as assistant reasoning.

## v0.17.2 — Personality presets & auto-config hardening

- 5 bundled personality presets; **Set Model Personality** command; HF `generation_config` wired into `defaultParams`; auto-config no longer invents sampling params; capture/replace race + lock fixes.

## v0.17.0 — System message capture + replacement

- `systemMessageCapture` + `systemMessageReplacementsFile` (find/replace); unified capture-replace pipeline; prompt architecture documented.

## v0.15.2 — Test & Refresh correction + command pruning

- Test & Refresh offers to correct a mismatched `vllmModelId`; shared picker; removed Auto-Configure and AI Configure commands; Utilities palette category.

## v0.15.1 — sessionManager: Python → node:sqlite

- Clean Copilot Sessions now uses Node's built-in `node:sqlite` — no Python runtime.

## v0.15.0 — eventsource-parser + packaging fix

- SSE parsing moved to `eventsource-parser`; fixed a VSIX packaging bug (extension silently not registering); `content: null` tool-call fix.

## v0.14.14 — Diagnose Connection

- Deep network-diagnostic command; full error-cause surfacing in Test & Refresh / Add Server.

## v0.14.13 — Network diagnostics

- Test & Refresh checks VS Code network-gating settings; `http.proxyStrictSSL` docs corrected; removed `@vscode/dts`.

## v0.14.12 — Truncated tool-call recovery

- `best-effort-json-parser` recovers partial tool-call arguments cut by `finish_reason: length`.

## v0.14.11 — Proxy/TLS code removed

- All extension-side proxy/TLS overrides removed — the extension now delegates to VS Code's patched `fetch` (fixes corporate-TLS breakage).

## v0.14.10 / v0.14.9 — TLS attempts (both reverted)

- OS trust-store attempts (`NODE_USE_SYSTEM_CA`, `tls.setDefaultCACertificates`) — both superseded and removed in v0.14.11; BYOK guard added.

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
