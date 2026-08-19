# Changelog

## Unreleased

### Added

- **Actual OpenRouter cost is captured and tracked (Phase 1 cost data plane)** — OpenRouter's real spend (`usage.cost`, `usage.is_byok`) is now captured end-to-end. The wire type gained `cost`/`cost_details`/`usedByok` (mapped from the wire `is_byok` at the parser layer — distinct name so it can't be confused with VS Code's `isBYOK`), `consumeStream` records it on the Last Request, and the usage store gained a **v2→v3 additive migration** with separate all-time/day cost planes (`allTimeCost`/`daysCost`). The dashboard **prefers actual reported cost** when a model reports any (Last Request Cost row + per-model Today/Overall summary), falling back to the configured per-1M estimate otherwise — actual and estimated cost are **never summed**. `[TOKENS]` output-channel logs now include actual cost and a `(BYOK)` marker. Legacy v2 token records migrate unchanged with no fabricated cost.

### Changed

- **OpenRouter reasoning modes built from the full `reasoning` object** — instead of a hardcoded "Think (High) / No Think" pair, `normalizeOpenRouterModel` now reads OpenRouter's rich `reasoning` metadata: `supported_efforts` yields one `Think (Effort)` mode per level (`high`, `medium`, `low`, `minimal`, …), `supports_max_tokens` (Anthropic-style budget) yields a single `Think` mode, `mandatory` suppresses `No Think`, and `default_effort`/`default_enabled` drive the default mode. Modes serialize as raw `reasoning` params unchanged.

- **Dashboard treats every backend as first-class (no more "degraded")** — the `(degraded)` label and the "Backend" warning row are gone for all non-vLLM servers. The metrics engine now varies its probe set by backend: vLLM hits the full endpoint set (`/health`, `/v1/models`, `/version`, `/metrics`, `/load`); other backends probe only `/v1/models` plus a per-backend context-window resolve (LM Studio `context_length`, llama.cpp `n_ctx`, Ollama `/api/ps`, OpenRouter exact-model) cached for the engine's lifetime. Metric rows render **only when the backend reports them** — no more dash (`—`) placeholders for absent vLLM-only data.
- **Dashboard context window resolved per backend, with transient-failure recovery** — vLLM reads `max_model_len` from `/v1/models`; non-vLLM backends resolve it once from their own endpoint and cache it. A **transient** resolver failure (network, 429/5xx, timeout) now retries on a bounded 60s backoff instead of permanently disabling the context for the session; only a permanent validation failure (model reports no window at all) stops retrying. The window rides in the server tooltip.
- **OpenRouter dashboard renders as a model collection (Phase 2 of Option A)** — the relay node now shows an **Account** node with real credits/limits/free-tier status from OpenRouter's `GET /api/v1/key` (bad/missing key → the node is hidden, never fabricated), plus a **Model Collection** node with one child per configured model, each showing that model's **own** context window, output ceiling, capabilities, reasoning modes, and estimated-or-actual cost + today/overall tokens. The metrics engine now resolves a **per-model** context window (relay models can have different context lengths), cached per model with the same transient/permanent retry semantics. Replaces the interim "suppress Models + Context Window" behavior.
- **Deep-Dive is vLLM-only** — the **vLLM Deep-Dive** right-click command is hidden on non-vLLM server nodes (and guarded in the command itself). Non-vLLM backends don't expose `/metrics`, so the panel would be all empty rows.

## v1.32.0 — OpenRouter backend & configurable initial-response timeout

### Added

- **OpenRouter as a first-class backend (prep wiring)** — `'openrouter'` is now a valid `serverType` (`vllm` | `lmstudio` | `llamacpp` | `ollama` | `openrouter`), accepted by validation, the Server Settings webview dropdown, and the configuration schema. The shared `resolveRuntimeLimits` switch gained an `openrouter` arm that resolves runtime limits from OpenRouter's exact-model endpoint (via the new `src/openRouter.ts` control plane; variant/alias suffixes are stripped for the metadata lookup but preserved for chat).

- **OpenRouter control-plane module (prep, no behavior change)** — new `src/openRouter.ts` with `parseOpenRouterModelRef`, `normalizeOpenRouterModel`, `fetchOpenRouterModel`, and `resolveOpenRouterRuntimeLimits`. Parses slugs/variants/`~`-aliases/verified model-page URLs; fetches the exact-model endpoint with the base slug; normalizes runtime limits, capabilities, reasoning modes, defaults, and estimated per-million USD rates. Live-verified against the OpenRouter API: `per_request_limits` is null in practice (fallback chain `context_length` → `top_provider.context_length`), and variant suffixes (`:free` etc.) 404 on the metadata endpoint, so the lookup strips the suffix while chat keeps the full requested id.

- **OpenRouter onboarding in Add Server** — the guided flow detects an `openrouter.ai` server URL and runs onboarding with the same ordering as every other backend: **server URL → API key → model pick**. The model is picked from the ~415-model public catalog (filter-as-you-type); pasting a full model-page URL only *pre-fills* the picker. Then an unauthenticated exact-model metadata resolve (real context window, output ceiling, capabilities, pricing, reasoning modes) and save with the fixed URL (`https://openrouter.ai/api`). `detectServerType` now classifies the `openrouter.ai` host, so re-add / Test & Refresh work too. Previously OpenRouter could only be configured by hand-editing `serverType`.

- **Per-model `initialResponseTimeoutMs`** — the hardcoded 60-second budget for the server to send the first response headers is now a per-model setting (default `180000` = 3 minutes; `0` = wait indefinitely). If the server accepts the connection but never responds — model loading, queue backlog — the request aborts with an actionable message instead of hanging.

### Fixed

- **Credential hygiene (OpenRouter prep, no behavior change)** — request header *values* no longer leave trusted extension code: the Add Server output-channel log now shows headers as `[REDACTED]` (key names kept), and the Server Settings webview receives a public model projection with the `requestHeaders` field stripped entirely. The webview never reads headers, and the patch-save path preserves stored headers on save, so no behavior change.

- **Honest initial-response timeout message** — the user-facing error for the first-response-header timeout previously dumped the raw abort string. It now explains that the server did not respond in time (model loading / server busy), names the per-model `initialResponseTimeoutMs` setting to raise (milliseconds, `0` = wait indefinitely), and points to the Output channel for details.

- **OpenRouter routing is host-only** — the Add-flow branch now routes to OpenRouter **only** when the server URL's host is `openrouter.ai`. The server field is a server; the model is always picked from the catalog (a pasted model-page URL just pre-fills the picker). A bare model id or any other host falls through to the normal server flow — never hijacked into an OpenRouter model lookup.

- **OpenRouter onboarding requires an API key** — the prompt previously said "Chat requires it" but let you proceed with an empty key, saving a keyless config. The key box now validates non-empty (OpenRouter bills per account, even free routes).

- **`initialResponseTimeoutMs` schema rejects negatives** — the settings schema now enforces `minimum: 0`. A negative already behaved like `0` (disabled) at runtime and `validateConfig` warns on it; the schema closes the door at the settings UI.

- **Duplicate "Update Auth" prompt removed on OpenRouter re-add** — the Add flow already collects the key + headers, so choosing "Update Auth" on an existing model previously fired a SECOND, generic vLLM-flavored wizard and discarded the just-entered key (which could even clear the required OpenRouter key). `updateServerAuth` now accepts the already-collected headers and reuses them; when invoked standalone it is provider-aware (required, OpenRouter-flavored key prompt for an `openrouter.ai` server).

- **README + source comments corrected to the current OpenRouter flow** — stale text describing bare-`author/slug` routing, metadata-before-key ordering, and "the user's input is a MODEL" were replaced with the actual behavior: host-only routing (`openrouter.ai`), server → key & headers → model pick, and the pasted model-page URL merely pre-filling the picker.

## v1.31.0 — Pooled output/prefill speed & hardened metrics parsing

### Added

- **Dashboard Speed row** — pooled output & prefill throughput replacing the ITL-derived `Throughput` row. `Output` = Σ `request_generation_tokens` / Σ `request_decode_time_seconds`; `Prefill` = Σ `request_prompt_tokens` / Σ `request_prefill_time_seconds` (tok/s). The pooled ratios count every emitted token, so MTP/spec-decoded output rates are honest (ITL recorded one sample per engine step and undercounted); decode-time denominator excludes prefill. Falls back to TPOT inversion when the source metrics are absent.

### Fixed

- **Deep-dive histogram parsing** — `parseRawMetrics` misclassified every histogram family's `_sum` as a gauge and `_count` as a counter (string-suffix heuristics). The `# TYPE` line is now authoritative; `_sum`/`_count`/`_bucket` samples resolve to the histogram family correctly.

### Changed

- **OpenRouter prep (no behavior change):** the shared context resolver was widened — `resolveContextWindow(): Promise<number>` became `resolveRuntimeLimits(): Promise<RuntimeModelLimits>` (`{ contextWindow; maxOutputTokens? }`, `src/types.ts`). All four existing backends return `{ contextWindow }` with no output ceiling. `deriveTokenBudget()` gained an optional `reportedMaxOutputTokens` clamp (0/negative degrades to 1 token; `NaN` ignored); `buildModelInfo()` threads it through. Existing backends pass `undefined`, so budgets are bit-identical. Call sites consume `limits.contextWindow`.

## v1.30.0 — Third-party backends, measured throughput & hardened auto-config

### Added

- **Third-party backends** — llama.cpp, LM Studio, Ollama as first-class per-model `serverType` (`vllm` | `lmstudio` | `llamacpp` | `ollama`). Context window resolved from each backend's own endpoint; no fabrication — a backend that can't report a window is not served (actionable error).
- **Add Server / Server Settings auto-detect `serverType`** and persist it.
- **Measured throughput** — `Generation (measured)` row for non-vLLM backends and vLLM servers without per-request metrics.
- **Dashboard degradation notice** — non-vLLM servers labeled `(degraded)`, with vLLM-only rows called out.

### Fixed

- **Chat requests no longer hang indefinitely on a silent server** — an initial POST with no response is aborted after 60s (AbortError, not retried).
- **Cancelled or timed-out requests are no longer retried** — a fetch whose signal is already aborted (user cancel, `AbortSignal.timeout`) exits immediately instead of sleeping 1.5s and doubling the timeout.

### Changed

- **Preset matching is a case-insensitive substring match** (longest wins, org-free ids).
- **Exact wire-id matching** — removed `normalizeModelId`/`modelMatchKey`; `vllmModelId` must be a served model id. `resolveContextWindow`/T&R match `m.id` exactly; `resolveOverrideForModel` keeps only exact + composite tiers. Mismatched configs fail loudly instead of being forgiven.
- **Test & Refresh** — servers whose matched models lack a resolvable context window render ⚠, not ✓.
- **Auto-configure & Add Server** — resolver errors wrapped in an error boundary.
- **Hy3 preset**: `topP` → `top_p`.

## v1.22.1 — Docs & internal notes

- Added pre-release model-config for Qwen3.8-27B (doing what I can to have the best possible setup right when it drops). I will improve the setup once all data are available.
- Removed stale vendored `chatProvider` proposal declaration; corrected `configurationSchema`/`modelConfiguration` docs (proposal-gated, not undocumented) and the `LanguageModelThinkingPart` note.
- Models flagged `isBYOK: true` — VS Code now routes them as user-credential-served (BYOK), enabling MCP/agent-mode utility flows.

## v1.22.0 — Token & Cost Usage Tracker

- **Token & cost tracker** — per-server, model-first usage node with today/all-time cost, persisted Today/Overall (90-day retention). Costs round to 2 decimals; tokens to whole thousands.
- **Set Cost… / Reset Usage** actions.
- Live dashboard updates after every prompt.
- Removed in-memory Session plane; `lastRequestStore.ts` merged into `usageStore.ts`.

## v1.21.0 — Provider & command decomposition + bug fixes

### Fixed

- No duplicate `settings.json` entries; Test & Refresh reports silent failures.
- Diagnostics: no more unhandled rejections, spurious "no output" on cancel, or misattributed proxy/TLS errors; `openssl` command-injection fixed.
- Deep-Dive: no duplicate panels, orphaned pollers, or stale first view. Dashboard stops polling a hidden sidebar.
- File logs pruned to the 20 most recent.
- Auto-configure: no false tool-calling claims; preserves token budgets and personality; no zero-window models.

### Changed

- Provider decomposed into `src/provider/*` and `src/commands/*` — behavior-preserving.
- Server Settings: sticky Save/Revert bar, unsaved-changes indicator, any scalar field clearable.

### Internal

- Added a typecheck build gate; removed obsolete code.

## v1.20.8 — Test & Refresh consolidation

- Test & Refresh shows one consolidated popup instead of one toast per server.
- Shared workspace-root path-resolution helper.

## v1.20.7 — Supportive Mentor rename

- "Tough Love" renamed to "Supportive Mentor"; stale docs snapshots removed.

## v1.20.6 — Personality overhaul

- New **Raw (Model Natural)** personality (no persona injected).
- Bundled personalities are re-synced on apply; user-created ones are never clobbered.
- Curated personality dropdown order.
- Sarcastic Robot is de-Bendered (no copyrighted character references).
- README overhaul.

## v1.20.5 — Personality hardening & picker fixes

- Same model on multiple servers now shows as separate picker entries. ⚠️ Re-select the model once; `settings.json` is not rewritten.
- Empty-field clear semantics unified (empty always means clear).
- Webview save failures no longer escape as unhandled rejections.
- Discovery warns on duplicate explicit `id`s.

## v1.20.4 — Global personalities

- Personalities are global (follow you across workspaces, survive upgrades).
- Personality picker in Server Settings.
- `THIRD-PARTY-NOTICES.txt` generated.

## v1.20.3 — Clear personality

- **"Default (no personality)"** clears a model's replacements.
- Active personality marked in the picker.
- Portable (forward-slash) config paths.

## v1.20.2 — Server Settings UX

- Auto-Configure works on unconfigured models.
- **Remove Server** → **Remove Model** (per-model only).

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

- Reverted superseded TLS trust-store changes; added a BYOK guard.

## v0.14.8 (2026-07-10) — BYOK utility model support

- Configured `chat.byokUtilityModelDefault` for BYOK utility tasks without overriding user choices.
- Added the Configure Utility Model command.

## v0.14.7 (2026-07-10) — Corporate TLS trust & error visibility

- Added OS certificate-store support for TLS. _Superseded in v0.14.11._
- Improved network error reporting.

## v0.14.0 (2026-07-09) — Simplified discovery

- Simplified discovery around configured per-model servers and server-provided context windows.
- Removed `maxModelTokens` and alias deduplication.
- Improved model connection handling and applied configuration changes without reloads.

## v0.13.2 (2026-07-08) — Model Settings Reference

- Added a Model Settings Reference command. _Later removed; documentation moved to the README and configuration docs._

## v0.13.1 (2026-07-08) — Proxy support, composite model ids, and UX fixes

- Added proxy support. _Superseded in v0.14.11 by VS Code's patched `fetch`._
- Added composite model IDs and Bearer-only API-key setup.
- Preserved connection settings during auto-configure and fixed its dialogs.
- Updated onboarding documentation and package metadata.

## v0.13.0 (2026-07-08) — Per-model cleanup & API key onboarding

- Unified model setup and added per-model connection updates and API-key onboarding.
- Removed remaining global-server configuration dependencies.
- Improved aliases, preset matching, request parameter layering, and the GLM-5.2 preset.
- Bundled presets in the VSIX and removed unused thinking capability metadata.

## v0.12.2 (2026-07-08) — Per-model everything

**Breaking (auto-migrated):** moved server, credentials, sampling, token, and transport settings to individual models.

- Added per-model servers, credentials, parameters, token settings, and onboarding.
- Removed global server and sampling settings; only `enableFileLogging` remains global.

## v0.12.1 (2026-07-07) — Thorough code review

- Fixed token budgeting, tool-choice preservation, configuration validation, and header handling.
- Improved auto-configure feedback, type safety, and test cleanup.

## v0.12.0 (2026-07-07) — Structured Outputs (Phase 2)

- Added token-level structured outputs for JSON, regex, choices, and grammars.

### README reorganization

- Reorganized vLLM-specific documentation.

## v0.11.0 (2026-07-06) — Per-model server & headers

- Added per-model server URLs, request headers, and API-key overrides.

### Behavior change

- Changed header precedence to auth, model/custom headers, then caller headers.

## v0.10.0 (2026-06-29) — Smarter continuation & workspace instructions

- Added auto-continuation for colon-truncated responses and workspace custom instructions.

### Bugs fixed

- Fixed an instruction-cache file watcher leak.

## 0.9.1

- Improved Windows session-cleaning compatibility.

Notable changes to vLLM-Copilot, newest first.

---

## v0.9.0 (2026-06-24) — Auto-continue on empty responses

- Added configurable auto-continuation for empty responses.

## v0.8.10 (2026-06-24) — Error handling & timeout fixes

- Improved network failure handling and inactivity timeouts.
- Removed `requestTimeout`; `streamInactivityTimeout` now defaults to disabled.

## v0.8.9 (2026-06-20) — Tooling & repo hygiene

- Maintenance: removed unused tooling, build scripts, stale configuration, and obsolete documentation.

### Bugs fixed

- Prevented request options from overwriting protected chat fields.
- Improved error-body truncation and auto-configure fetch handling.

---

## 2026-06-20

### Bugs fixed

- Fixed configuration caching, disposal, cancellation, token counting, and connection error reporting.
- Improved activation and file-logger error handling.

---

## 2026-06-19

### Bugs fixed

- Improved auto-configure resilience, cancellation, and connection-reset handling.
- Prevented empty responses after graceful stream termination.
