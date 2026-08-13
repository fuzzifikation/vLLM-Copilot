# Changelog

## v1.22.1 — Docs & internal notes

- **Docs:** removed the stale vendored `chatProvider` proposal declaration (`docs/vscode.proposed.chatProvider.d.ts`, never compiled); corrected the `configurationSchema` / `modelConfiguration` docs and comments — these are `chatProvider`-proposal fields (absent from stable `@types/vscode`, declared upstream), not undocumented reverse-engineered APIs. Fixed a fabricated `@types/vscode ≥ 1.120.0` graduation note for `LanguageModelThinkingPart` (proposal-gated).
- **Internal:** comments only. No functional or runtime change.

## v1.22.0 — Token & Cost Usage Tracker

- **Token & cost usage tracker** — a cumulative **Token Usage and Cost** node under each server, **model-first**: one collapsible entry per model (labeled by `displayName`) carrying the price (`$11.51 today and $31.13 in 3.1 days` — today's cost + all-time cost over the recording window), expanding to **Today** and **Overall** token rows (`800k in · 200k cached · 500k out`; input split, cache never double-counted). Persisted across reloads (90-day retention).
- **Per-model cost tracking** — optional per-1M `cost` rates (`input` / `output` / `cachedInput` + `currency`), derived at render time so editing a rate re-prices all history. Costs round to 2 decimals (fine precision on the per-request Last Request row); token counts round to whole thousands. Currency decoration uses a small static symbol map ($ € £ ¥, `credits` for AI Credits, raw-code fallback — no i18n library); also fixes non-USD currencies that previously rendered as a wrong `$`.
- **Set Cost…** — right-click the node to configure a model's rates via guided prompts (model → rates → currency).
- **Reset Usage** — right-click action on the node (server scope) or a palette command (all / per-server); clears all-time + daily. The Last Request node is kept.
- **Live dashboard updates** — Last Request and usage nodes re-render immediately after every prompt (also fixes the stale Last Request node).
- **Removed the Session plane** — it was in-memory state that reset on reload (reading `0` after install); no session identity is available through the provider API. The tracker keeps persisted Today / Overall. No migration — the persisted shape is unchanged (v2 adds `startedAt`, additive).
- **Internal:** `lastRequestStore.ts` merged into `usageStore.ts` — single ingestion point, serialized `globalState` writes, one change event.

## v1.21.0 — Provider & command decomposition + bug fixes

### Fixed

- Duplicate `settings.json` entries no longer created on Set Personality / Replace Config (server-less and shared-model configs).
- Test & Refresh now reports silent failures (unreachable servers, zero-model servers) instead of passing silently.
- A failing diagnostic no longer skips the model-cache clear.
- Chat config-read / pipeline failures routed through the standard error path — no more unhandled rejections.
- Cancelling before the first token no longer shows a spurious "model returned no output".
- Diagnostics no longer misattribute proxy/network failures to a bad certificate chain.
- TLS diagnostics report `valid: false` on a failed handshake, not just on a verify error.
- **Security:** the diagnostics `openssl` check no longer runs a shell command with an interpolated hostname (command-injection fixed).
- Deep-Dive no longer opens duplicate panels for different spellings of the same server URL.
- Deep-Dive no longer orphans a metrics poller on a second `ready` or on close during the ready handshake.
- Deep-Dive shows cached data immediately on first open instead of "Loading…" until the first poll.
- Dashboard no longer keeps polling a hidden sidebar or double-subscribes on overlapping refreshes.
- Metrics engines are released when the last subscriber unsubscribes, and are keyed by canonical server URL.
- File logs pruned to the 20 most recent (plaintext API keys no longer accumulate unbounded).
- Auto-configure no longer claims tool calling the model provably lacks.
- Auto-configure preserves token-budget overrides and personality.
- Token budgets no longer produce zero-input or zero-output models.
- Dead Copilot `max_tokens` UI layering removed (the chat control now reaches the wire).
- Dashboard no longer shows "vv0.6.0" for the vLLM version.

### Changed

- Provider decomposed into `src/provider/*` and `src/commands/*` — behavior-preserving.
- Server Settings: Save/Revert moved into a sticky action bar with an unsaved-changes indicator.
- Server Settings: unsaved edits survive external config refreshes.
- Server Settings: any scalar field can be cleared.

### Internal

- Added a typecheck build gate and removed obsolete code.

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
