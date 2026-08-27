# Changelog

## v1.33.1 — New model presets: Qwen3.8-Flash-Next & GLM-5.3-Flash

### Added

- **Qwen3.8-Flash-Next preset** — new `qwen4_exp` family (125B-A6B MoE, multimodal, 262K native context). Three modes: **Think (Deep)** (`reasoning_effort: xhigh`), **Think (Balanced)** (`medium`) and **No Think**, each with the official sampling recipe and its own output budget (32K/32K/16K) so large-codebase input is never starved. Serve with `--reasoning-parser qwen3 --tool-call-parser qwen3_xml`. The 1M-context YaRN server recipe is documented in the preset header as opt-in only (static YaRN can degrade short-context quality).
- **GLM-5.3-Flash preset** — new `glm5_next` family (320B-A18B, natively multimodal, 1M native context). Thinking is always on, so modes are **Think (Max / High / Low)** via `reasoning_effort` (no No-Think mode, unlike GLM-5.2). Output budgets 64K/32K/16K. Serve with `--reasoning-parser glm45 --tool-call-parser glm47`.
- Both presets match any quantization variant (FP8/NVFP4/GGUF) via substring matching.

## v1.33.0 — Rename servers & V symbol in the model picker

### Added

- **Rename Server** — right-click any server in the Dashboard and give it a friendly name (e.g. `IT Server for GLM5.2`) instead of the bare host. The name is used everywhere the server is shown — Dashboard tree, Deep-Dive panel title, and the Model Settings server dropdown. Clear it any time to show the URL again.
- **Rename applies to the whole server** — the name is written to every model sharing that server URL, so all its entries stay in sync.
- **Not for OpenRouter** — the fixed `openrouter.ai` relay endpoint can't be renamed (menu hidden there).
- **Your V in the model picker** — every model (vLLM, LM Studio, llama.cpp, Ollama, and OpenRouter) now shows the project's own V icon instead of a generic fallback. The glyph is derived from `resources/vllm-icon.svg` with the left arm as a hollow outline, and is built from the tracked `scripts/build-vllm-icon-font.py`.

### Fixed

- **Server names survive reconfigure** — re-running Auto-Configure or applying a preset no longer wipes a custom server name.
- **Deep-Dive panels retitle live** — renaming while a Deep-Dive panel is open updates its title immediately, instead of showing the old name until reopen.

### Changed

- **Whitespace-safe names** — a hand-edited whitespace-only name is treated as unset and falls back to the URL.

## v1.32.4 — Focus-loss and auth data-safety fixes

### Fixed

- **Add Server headers box stays open** — switching to another app (Teams, email, password manager) to copy HTTP headers no longer auto-dismisses the input and skips them, which made the server probe report "server not reachable". All input prompts now stay open on focus loss, so you can always switch programs mid-entry.
- **Update Auth no longer wipes your headers** — rotating just the API key (or just the proxy headers) merges into the existing per-model headers instead of replacing the whole set, so custom headers like CF-Access survive an auth update.
- **Model Settings no longer loses unsaved edits on a failed save** — if a save fails (e.g. a settings write error), the form keeps your changes and the "unsaved" indicator instead of a later unrelated refresh silently discarding them.

## v1.32.3 — Ask Copilot to configure your models; per-mode response limits

### Added

- **Ask Copilot to configure your model** — in chat, just say *"configure my Qwen3.6 with Think / No Think modes"* and Copilot writes a valid model entry for you. If it doesn't pick up the schema on its own, type `#vllmModelSchema` to attach it. No files are created.
- **Per-mode response limits** — each model mode can set its own output ceiling (e.g. `"Think": { "max_tokens": 32768 }`). The extension sends it and updates Copilot's context bar when you switch modes.
- **New Manual & OpenRouter guides** — and a restructured README that no longer repeats itself or stale facts.

### Changed

- **Server-native sampling by default** — hard-coded `temperature`/`top_p` are no longer forced on every request. Unset sampling params are left to your backend (vLLM uses the model's `generation_config.json`).

### Fixed

- **Outdated docs** — README, configuration reference, and manual now match how the extension actually behaves.

## v1.32.2 — OpenRouter provider selection & dashboard details

### Added

- **Pin an OpenRouter provider per model** — pick Auto or a specific provider from the model's list; a routing mode (Standard / Nitro / Exacto) applies when Auto.
- **Richer OpenRouter dashboard** — each model shows its provider (status + uptime), per-1M pricing, and total context; the Account node shows invested/available credits and usage over time.
- **Provider limits at a glance** — the Provider dropdown shows each option's context window, output cap, and per-1M cost; a warning icon flags when a cap shrinks your output budget.

### Fixed

- **Clearer server errors** — you now see the HTTP code and the server's real message (e.g. `Server error [402] … fewer max_tokens`) instead of a generic failure.
- **Per-model credentials respected** — models sharing a URL with different auth behave as separate servers everywhere (Model Settings, Dashboard, Deep-Dive).
- **OpenRouter output caps** — models capped at the full window no longer fail every request; models without a reported cap fall back to a sensible 10% of the window instead of returning nothing.
- **Provider dropdown works** — no more stuck-on-Auto; choosing Auto actually clears a pinned provider.
- **Real error reasons shown** — OpenRouter's underlying provider message is surfaced instead of a generic `Provider returned error`.
- **Cost tracking hardened** — negative/invalid values no longer distort your totals.
- **Diagnostics don't leak credentials** — proxy/server URLs are redacted in the shareable report.

### Changed

- **Consistent numbers everywhere** — prices and token counts render with US formatting regardless of locale.
- **Faster OpenRouter setup** — just paste the API key; a model-page URL skips the picker.
- **Simpler TLS advice** — dead workarounds removed; certificate errors point you to **Diagnose Connection**.

## v1.32.0 — OpenRouter backend & configurable first-response timeout

### Added

- **OpenRouter** — add any of ~415 cloud models in a few clicks. Context window, output ceiling, tool calling, pricing, and reasoning modes are resolved automatically; the dashboard tracks your actual spend.
- **Reasoning modes reflect the model** — one Think mode per effort level, plus No Think where supported.
- **Per-model first-response timeout** — how long the server may take to start answering before the request aborts (default 10 min; `0` = wait forever).
- **Dashboard works for every backend** — no more `(degraded)`; each backend shows only the rows it can actually report.
- **Deep-Dive is vLLM-only** — hidden on other backends.

### Fixed

- **Actionable timeout error** — explains the server didn't respond in time and points to the timeout setting.

## v1.31.0 — Honest speed numbers & sturdier metrics

### Added

- **Dashboard Speed row** — pooled output & prefill throughput (tok/s), counting every token including speculative decoding. More honest than the old per-step estimate.

### Fixed

- **Deep-dive histogram parsing** — metrics families are classified correctly, so the numbers you see are real.

## v1.30.0 — Third-party backends, measured throughput & safer auto-config

### Added

- **Third-party backends** — llama.cpp, LM Studio, and Ollama as first-class per-model types. Context windows come from each backend's own endpoint; one that can't report a window isn't served (with an actionable error).
- **Auto-detected backend** — Add Server / Model Settings figure out the `serverType` for you.
- **Measured throughput** — a real "Generation (measured)" row for backends without per-request metrics.

### Fixed

- **No more infinite hangs** — a server that accepts the connection but never responds is aborted after 60s.
- **Cancelled/timeout requests aren't retried** — no pointless 1.5s sleep + doubled timeout.

### Changed

- **Smarter preset matching** — case-insensitive substring match (longest wins), so `NVFP4` variants land on the right preset.
- **Exact model matching** — a model id that isn't served fails loudly instead of being silently forgiven.
- **Test & Refresh flags unresolvable models** with ⚠ instead of a false ✓.

## v1.22.1 — Docs & internal notes

- New pre-release Qwen3.8-27B model config.
- Models are flagged so VS Code routes them as user-credential-served (BYOK), enabling MCP/agent-mode utility flows.

## v1.22.0 — Token & cost usage tracker

- **Track token usage & cost per server** — model-first node with today/all-time totals; updates live after every prompt.
- **Set Cost… / Reset Usage** actions; 90-day history retention.

## v1.21.0 — Cleaner commands & bug fixes

### Fixed

- No duplicate `settings.json` entries; Test & Refresh reports silent failures.
- Diagnostics: no unhandled rejections, no spurious "no output" on cancel, no misattributed proxy/TLS errors.
- Deep-Dive: no duplicate panels or orphaned pollers; the dashboard stops polling a hidden sidebar.
- File logs pruned to the 20 most recent.
- Auto-configure: no false tool-calling claims; preserves token budgets and personality.

### Changed

- **Server Settings** — sticky Save/Revert bar, unsaved-changes indicator, any field clearable.

## v1.20.8 — Test & Refresh consolidation

- One consolidated popup instead of one toast per server.

## v1.20.7 — Supportive Mentor rename

- "Tough Love" is now "Supportive Mentor".

## v1.20.6 — Personality overhaul

- New **Raw (Model Natural)** personality — no persona injected.
- Bundled personalities re-sync on apply; your own are never overwritten.
- Curated picker order; Sarcastic Robot cleaned up.

## v1.20.5 — Personality hardening & picker fixes

- Same model on multiple servers shows as separate picker entries. ⚠️ Re-select the model once.
- Webview save failures no longer surface as unhandled errors.

## v1.20.4 — Global personalities

- Personalities follow you across workspaces and survive upgrades; picker in Server Settings.

## v1.20.3 — Clear personality

- **"Default (no personality)"** clears a model's replacements; active personality marked in the picker.

## v1.20.2 — Server Settings UX

- Auto-Configure works on unconfigured models; **Remove Model** is now per-model.

## v1.20.1 — DeepSeek-V4-Flash-0731 preset

- New preset with model-card sampling parameters.

## v1.20.0 — Engine unification & bug-squash

- **Unified metrics engine** — dashboard and deep-dive share one poll cycle; stops when nobody's watching.
- Add Server: clear three-way dialog (Discard / Run Diagnostic / Keep Anyway).
- Smart URL handling (`host:8000` → http, bare host → https, strips `/v1`).
- Removed 293 lines of dead migration code.

## v1.19.x — Steady polish

- **v1.19.96** — preset matching uses the model id only; `id` is yours.
- **v1.19.95** — auto-continue no longer retries after a pure tool-call turn; cross-org + quantization-agnostic matching; dashboard context-window percentage fixed.
- **v1.19.94** — VS Code floor lowered to 1.122.
- **v1.19.92** — no more nagging about intentionally parked models.
- **v1.19.91** — `-NVFP4` recognized as a quantization suffix.
- **v1.19.90** — Poolside Laguna-S-2.1 preset (Think / No Think).
- **v1.19.86** — `cached_tokens` now read from the correct place (was always 0).
- **v1.19.8** — clear warning + "Install on remote" for Remote-SSH / WSL / devcontainer.
- **v1.19.5** — Last Request details in the dashboard (tokens, timing, throughput; requires server flags).
- **v1.19.4** — repo housekeeping (templates, badges, packaging fix).
- **v1.19.3** — warning when a model family falls back to a heuristic; webview listener leak fixed.
- **v1.19.2** — Server Settings no longer discards `vllmModelId` edits; status bar removed (dashboard covers it).
- **v1.19.1** — per-model settings webview (no manual `settings.json` editing); parameter picker.
- **v1.19.0** — native tree-view dashboard (polling, MTP metrics, context window, throughput).

## v0.18.0 — Historical reasoning

- Forwards historical reasoning content as assistant reasoning.

## v0.17.2 — Personality presets & auto-config hardening

- 5 bundled personality presets; **Set Model Personality** command; auto-config no longer invents sampling params.

## v0.17.0 — System message capture + replacement

- Capture system messages and replace text automatically (find/replace pairs).

## v0.15.x — Chat & packaging fixes

- **v0.15.2** — Test & Refresh offers to correct a mismatched model id.
- **v0.15.1** — Clean Copilot Sessions uses Node's built-in SQLite — no Python runtime needed.
- **v0.15.0** — SSE parsing hardened; fixed a packaging bug that silently stopped registration.

## v0.14.x — Diagnostics & network

- **v0.14.14** — **Diagnose Connection** command; full error causes surfaced in Test & Refresh / Add Server.
- **v0.14.13** — Test & Refresh checks VS Code network-gating settings.
- **v0.14.12** — truncated tool-call arguments are recovered, not lost.
- **v0.14.11** — all extension-side proxy/TLS overrides removed — delegates to VS Code's patched `fetch` (fixes corporate-TLS breakage).
- **v0.14.8** — BYOK utility model support + **Configure Utility Model** command.

## v0.13.x — Simpler setup

- **v0.13.2** — Model Settings Reference command (later removed; docs moved to README).
- **v0.13.1** — proxy support (superseded later by VS Code's patched fetch); composite model IDs.
- **v0.13.0** — unified per-model setup, API-key onboarding, bundled presets, no more global-server config.

## v0.12.x — Per-model everything

- **v0.12.2** — moved server, credentials, sampling, token, and transport settings onto each model. **Breaking (auto-migrated).**
- **v0.12.1** — token budgeting, tool-choice preservation, and config-validation fixes.
- **v0.12.0** — token-level structured outputs (JSON, regex, choices, grammars).

## v0.11.x — Per-model servers

- **v0.11.0** — per-model server URLs, request headers, and API-key overrides.

## v0.10.x — Smarter continuation

- **v0.10.0** — auto-continuation for colon-truncated responses; workspace custom instructions.

## v0.9.x — Auto-continue & error handling

- **v0.9.1** — improved Windows session cleaning.
- **v0.9.0** — configurable auto-continuation for empty responses.
- **v0.8.10** — network-failure handling and inactivity timeouts; stream timeout defaults to off.

## v0.8.9 — Tooling & repo hygiene

- Removed unused tooling, build scripts, and stale configuration.
- Prevented request options from overwriting protected chat fields; better error-body truncation and auto-configure handling.
- Fixed configuration caching, disposal, cancellation, token counting, and connection error reporting; sturdier activation and file-logger error handling.
