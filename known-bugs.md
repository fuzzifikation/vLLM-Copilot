# Known Bugs And Improvements

Only outstanding issues. Fixed items → [CHANGELOG.md](./CHANGELOG.md). Feature ideas → [docs/feature-ideas.md](./docs/feature-ideas.md).
Do not bump version without asking.

---

## Code Review 2026-08-10 — verified findings

Full pass over every `src/` file, three parallel deep passes + independent verification of every finding by tracing the actual code. All items below are confirmed real and reachable.

### Over-engineering / dead code / stale

- **Pass-through facade + test-only public exports** — `autoConfig.ts` is a 9-line re-export barrel; `commands.ts:26-27` re-exports `serverFingerprint`, `groupModelsByServer`, `personalityApplicableTo` purely so tests can import from the facade. Deliberate stable-import-surface decision, but it adds a second import surface with no runtime benefit; tests could import from the real modules. Minor gold-plating.

---

## Code Review 2026-08-11 — full pass (good-enough check)

Three parallel review passes (chat pipeline, config/commands UX, lifecycle/metrics) + independent verification of every finding by tracing the actual code. Verdict: **no P0, no crashes/corruption/hangs.** The chat path (streaming, cancellation, tool-call roundtrip, auto-continue bounds, error surfacing) is sound. Findings below are confirmed by code trace. The mechanical findings were fixed in v1.21.0 (see CHANGELOG). The remaining matcher finding was accepted as a fringe case — see **Fringe Cases** below; one by-design behavior is listed here.

### Known / by-design (do not re-file)

- **Deep-dive keeps polling while hidden** — `retainContextWhenHidden: true` (`deepDiveView.ts:39`) keeps the engine subscription alive and scraping every interval until the panel is *closed*. By design; contradicts the dashboard's poll-only-when-visible discipline, but panel state is explicit.

---

## Maintainability

### P2 - Untested data layer
Dashboard tree-provider behavior is now covered (`test/dashboard.test.ts` — visibility/epoch subscription lifecycle, offline/online rendering, dispose). Deep-dive webview still lacks tests (plain JS, no harness; the host side `deepDiveView.ts` is exercised only via the metrics engine's tests). `MetricsParser`, `parseRawMetrics`, `parseLabels`, and the formatting helpers (`fmtPct`, `fmtMs`, `fmtN`, `fmtTokens`, `fmtThroughput`, `shortUrl`) are covered.

## Over-engineering

- **Discovery re-fetches `/v1/models` per model config, not per server** — `discoverModels` (`provider/discovery.ts`) runs `getModelContextWindow` per config, so N configs pointing at one server produce N identical `/v1/models` fetches. `testAndRefresh` already groups by server (`groupModelsByServer` in `commands/testAndRefresh.ts`); discovery doesn't reuse that. Non-functional today (just redundant network I/O during refresh), but a natural consolidation target if discovery is ever touched.
- **`deriveTokenBudget` throws on missing `max_model_len`, but discovery always guards first** — `discoverModels` (`provider/discovery.ts`) checks `if (!maxModelLen)` before calling `buildModelInfo`, so the throw in `deriveTokenBudget` is unreachable from the provider. It's a reasonable contract for the pure function (callers must guarantee a value), just defensive-only in practice.

## Personalities And System Messages

### P3 - Server Settings webview picker wiring is untested
The host-side flow is covered: `applyPersonality` and the webview save path (via `configStore.replaceModelConfig`/`patchModelConfig`, tested in `test/configStore.test.ts`) have focused tests (id-keyed multi-preset, clear semantics, composite-id new entries), the replacement engine (`promptReplacer.ts`), the capture write path (`enqueueWrite`), and `loadReplacements` path resolution (absolute + workspace-relative) are tested. What remains untested is the `serverSettings.js` picker wiring itself (selector keying, apply/clear message payloads, `save()` id/vllmModelId assignment) — it's plain webview JS with no test harness.

---

## Fringe Cases — accepted, no fix

Confirmed real but deliberately not fixed. **Criterion: extremely low chance of happening AND minor concern if it happens.** These are documented so a future pass doesn't re-file or "fix" them without explicit approval. The fix would cost more (or risk more) than the failure it prevents.

- **Test & Refresh's matcher disagrees with the actual chat wire id for quantized/cross-org variants** — T&R matches `normalizeModelId` (org-aware, quantization-agnostic); chat sends the exact configured `vllmModelId`; discovery matches exact `m.id` or `m.root`. A config whose `vllmModelId` is a base name against a server serving only the quantized variant is reported `✓ OK` by T&R even though chat sends an id the server may not accept. Fringe because: vLLM serves root-name aliases by default (most quantized deployments accept the base id, so chat works), and the failure it could mask (exact-id rejection) surfaces **loudly** at request time, not silently — T&R merely under-predicts a self-reporting failure in a rare configuration. Fixing risks resurrecting the A1 "false parked" bug (already fixed + tested).
- **Shared 5s abort can report a healthy server as offline** — `vllmMetrics.ts` `fetchAllEndpoints` uses one `AbortController`/5s timer for all five parallel fetches; a slow `/metrics` aborts everything including `/health` → false "Offline". Bounded (5s is generous); cosmetic dashboard state that self-corrects next tick.
- **`pendingSave` stale flag on a failed webview save** — if the host's config write throws, no `data` message consumes `pendingSave`; a later external models-write while the user has re-edited re-renders and wipes the draft. Requires a failed write + re-edit + external write; the host already toasts the failure. Fixing needs an error-acknowledgment message type — over-engineering for the frequency.
- **`maxInputTokens` can be 0 for a 1-token model window** — `tokenBudget.ts` guarantees input ≥ 1 for every real window (≥ 2k); only a hypothetical 1-token window breaks the invariant. Not worth a clamp that would break the input + output === maxModelLen invariant for zero real-world value.
- **Deep-Dive duplicate tree ids under two raw URL spellings of one server** — the dashboard/deep-dive dedupe engines and panels by normalized URL, but a config listing both `http://host:8000` and `http://host:8000/v1` yields two server nodes whose `LastRequest` child uses the same normalized id. VS Code expansion-state quirk only; requires the user to configure two spellings of one server.
- **Renaming/removing the default mode leaves the `defaultMode` select stale** — the modes section rebuilds but the `defaultMode` dropdown is not re-derived until a re-render, so a dangling mode name can be saved. Soft failure (`config.ts` warns; `modelInfo.ts` falls back to the first mode).

---

## False Positives (keep AI from re-filing)

- **Global writes** — the config store (`replaceModelConfig`/`patchModelConfig` in configStore.ts) writes to Global only. Intentional: design is "always write to user settings."
- **Config entries match by extension `id` + `serverUrl`, not `vllmModelId`** — correct (shared via `findModelConfigIndex` in config.ts, using `resolveConfigId`). `vllmModelId` is the wire id only and may repeat across presets/servers; the extension key is `id` (with a `vllmModelId` fallback for legacy hand-written entries). Do not "fix" this back to wire-id matching.
- **Unreachable models are removed from the picker after refresh** — `discoverModels` (`provider/discovery.ts`) skips any model whose server doesn't report `max_model_len` (offline/error/not-loaded) and never adds it to `cachedModels`, so after `clearCache()` + the change event the Copilot picker no longer lists it. By design (gripe 2). A stale entry visible after refresh is VS Code's own picker cache, not a discovery bug.
- **Id-less configs get a composite picker id (`"<model> on <host>"`)** — discovery derives it via `buildModelId` so the same `vllmModelId` on two servers stays distinct; `resolveOverrideForModel` round-trips the composite back to the id-less config that produced it. Fixed the picker-collision bug (gripes 3 & 4). By design, not a bug. A duplicate explicit `id` in settings is the only remaining collision source and is warned about during discovery.
- **Dashboard uses first model's `requestHeaders` per server** — correct. `--api-key` is global per vLLM process; two presets on one server can't have different auth.
- **`serverSettings.js` `d.ontoggle`** — `secState` is the only source of truth on every render; config values use `[data-f]`/`[data-k]`/`.mode-card` paths, not `secState`.
- **Bundled presets duplicate the boilerplate-removal rules** — the five `prompt-replacements/` presets repeat the same ~9 removal rules verbatim. Declared **by design, not a bug**: each personality is a self-contained, fully-editable file, and anyone building their own personality gets the complete picture instead of a personality glued to hidden fixed base rules. The copy-paste drift is a maintenance tax, not a correctness bug — the drift canary (`npm run check:prompt-drift`) is the accepted mitigation. Do not refactor to a shared base layer / composition / build-time generation without user approval.
- **`provideTokenCount` blocks event loop** — `getConfiguration()` is in-memory, not disk. Cold-cache cost is negligible.
- **`dashboard.ts` `Promise.all` has no per-fetch timeout** — `fetchAllEndpoints` in `vllmMetrics.ts` has a 5s `AbortController` covering all parallel requests. Bug fixed in v1.20.0.
- **`vllmClient.ts:214` Promise.race fragility** — code now in `streamReader.ts:153-169`, pattern is correct: `timeoutId` assigned synchronously, `result` never read in error path.
- **Personality dropdown applies immediately (no Save All)** — intentional: selecting a personality writes global settings on `change`, unlike every other field which waits for Save All Changes. The raw `systemMessageReplacementsFile` field is synced so a subsequent Save All still writes the same value. Consequence: **Revert cannot undo a personality change** (already written). By design, not a bug.
- **Unserialized read-modify-write on `models`** — `configStore.ts` writes each read → mutate → write the whole array with no queue or version check, so two overlapping writers lose one update. **Declined, not a bug**: every writer is a human-invoked modal or single webview action (`addServerFlow`, `autoConfigureFlow`, `personality`, `serverSettingsView`), and the read→write gap is a sub-second `config.update()`. Two writes overlapping that window requires a user to trigger two separate UI actions faster than a settings write commits. Never observed; a serialization queue would add complexity to the most critical write path to guard a fringe case. Do not re-file.

---

## Known Limitations

- **`extractFamily` heuristic** recognizes 8 families (codellama, llama, qwen, mistral, phi, gemma, deepseek, falcon). Others fall through to org name — non-fatal sort key only, authoritative family comes from preset or HF discovery.
- **Tool results can't carry binary/image data** — OpenAI wire format only allows `string` content for `role: 'tool'`.
- **MCP servers need a utility model for BYOK** — VS Code 1.128+ sets `chat.byokUtilityModelDefault` automatically; older versions can't use MCP-backed Agent mode.
- **Corporate TLS with incomplete cert chains** — Node/OpenSSL trust path vs SChannel. Fix: server sends complete chain, or set `NODE_EXTRA_CA_CERTS`.
- **Clean Copilot Sessions won't run on remote host** — `os.homedir()` points at remote; run from local extension host instead.
- **`system-messages.json` dedupes by `receivedContent`** — documented "write once per unique message" behavior. The same original system prompt sent through different models or personalities overwrites `deliveredContent`/`rulesApplied` with the latest write.
- **Non-global `systemMessageReplacementsFile` paths apply but aren't listed** — a model whose `systemMessageReplacementsFile` points anywhere outside global storage (legacy `.vllm/...` paths, or any custom/absolute path) still gets those rules applied at request time, but the picker only knows bundled + global personalities, so the webview dropdown shows "Default" while the hint shows the raw path. Three entry points set it (webview dropdown, `Set Model Personality` command, raw field below the dropdown) and only the dropdown is dropdown-aware. Re-apply via the picker to move it to global storage.
- **Applied personality path is machine-specific (breaks Settings Sync)** — applying a personality stores an **absolute** `systemMessageReplacementsFile` path into global storage (`.../globalStorage/vllm-copilot/personalities/...`). Settings Sync pushes `vllm-copilot.models` between machines, but the global-storage file does not sync, so on a second machine the path won't exist and the personality silently stops applying (a `[WARN] Replacements file not found` in the Output channel). **Partial mitigation since v1.20.6:** bundled presets are extension-owned and self-heal on re-apply — `ensureGlobalPersonality` resolves the bundled twin by basename and re-creates the global copy, so re-selecting the personality in the picker fixes it. User-created personalities (no bundled twin) still break with no recovery path. Not fully portable across machines by design; a portable reference scheme (e.g. `personalities:<name>`) would be required to fix completely.
- **Personality rules silently no-op when Copilot's prompt drifts** — presets use exact-substring `find` rules against Copilot's *hidden* boilerplate, which Microsoft changes without notice (the presets already enumerate 3 safety variants + 3 identity variants as evidence). When a new variant ships, the rules stop matching: the personality still "works" (identity rules still hit), but boilerplate the user believes is stripped stays in. `matchedRuleNames` is only recorded in the opt-in capture file — no WARN when 0 rules match the main agent message. **Mitigation: `npm run check:prompt-drift`** (scripts/check-prompt-drift.mjs) — compares every preset `find` against the current VS Code prompt source on GitHub and fires on dead rules or changed source SHAs. Still a canary, not proof: the authoritative re-verification is a fresh `systemMessageCapture` run, then `--update-baseline`.
- **Identity-removal rules can orphan the model-name fragment** — the main and GPT-5 identity rules end their `find` at `...state that you are using ` (trailing space, before the dynamic model name). After removal, the trailing `{model_name}.` remains in the system prompt. Not fixable by exact-substring match alone (model name is dynamic); cosmetic.
- **`prompt-replacements-raw.json` is the only preset with no injected persona** — intentional. It exists to strip Microsoft's safety/identity/behavioral boilerplate and leave the model's own trained behavior untouched. Unlike the other presets it has no identity-replacement or core-principles rules; a future Copilot prompt change that adds new behavioral boilerplate will silently no-op here too (same drift canary covers it, `npm run check:prompt-drift`).
