# Known Bugs And Improvements

Only outstanding issues. Fixed items → [CHANGELOG.md](./CHANGELOG.md). Feature ideas → [docs/feature-ideas.md](./docs/feature-ideas.md).
Do not bump version without asking.

---

## Maintainability

### P1 - Large modules
- `autoConfig.ts` (~15 exported functions) — `autoConfigureModel()`, `loadModelPresets()`, `findPresetForModel()`, `saveModelConfig()`, `registerAddServerModelCommand()`, `resolveModelConfigForAdd()`, and more. Grab-bag of presets, HF fetch, config gen, BYOK, progress UI.
- `provider.ts` — `provideLanguageModelChatResponse()` (~550 lines), `consumeStream()` (~290 lines), `provideLanguageModelChatInformation()` (~124 lines). Stream, auto-continue, diagnostics, error classification.

### P2 - Untested data layer
Dashboard tree items, deep-dive webview, and formatting helpers lack tests. `MetricsParser`, `parseRawMetrics`, `parseLabels`, `fmtPct`, `fmtMs` are covered.

### P? - Two `saveModelConfig` implementations still diverge
`autoConfig.saveModelConfig` (explicit `serverUrl`/`requestHeaders`/`systemMessageReplacementsFile` preservation, entry replace) and `serverSettingsView.saveModelConfig` (plain `{...existing, ...updates}` merge) now share `normalizeModelEntry` for the `''`-clears / undefined-preserves semantics, but keep **different merge strategies**. Both behave correctly today; the duplication is a drift risk when one side changes. PR #5 flagged "unify during redesign" — still open.

## Over-engineering

- **Discovery re-fetches `/v1/models` per model config, not per server** — `provideLanguageModelChatInformation` runs `getModelContextWindow` per config, so N configs pointing at one server produce N identical `/v1/models` fetches. `testAndRefresh` already groups by server (`groupModelsByServer`); discovery doesn't reuse that. Non-functional today (just redundant network I/O during refresh), but a natural consolidation target if discovery is ever touched.
- **`deriveTokenBudget` throws on missing `max_model_len`, but discovery always guards first** — `provideLanguageModelChatInformation` checks `if (!maxModelLen)` before calling `buildModelInfo`, so the throw in `deriveTokenBudget` is unreachable from the provider. It's a reasonable contract for the pure function (callers must guarantee a value), just defensive-only in practice.

## Code Smells

- **Duplicated workspace-root path resolution** — `provider.loadReplacements` and `personalityStore.resolveActivePersonality` both reimplement "resolve a relative `systemMessageReplacementsFile` against the first workspace folder". They must stay in sync; extract a shared helper.
- **Two divergent `saveModelConfig` implementations** — see the P? entry under Maintainability; the merge-strategy difference is the smell, `normalizeModelEntry` already de-duplicates the clear semantics.

## Personalities And System Messages

### P3 - Server Settings webview picker wiring is untested
The host-side flow is covered: `applyPersonality`/`saveModelConfig` have focused tests (id-keyed multi-preset, clear semantics, composite-id new entries), the replacement engine (`promptReplacer.ts`), the capture write path (`enqueueWrite`), and `loadReplacements` path resolution (absolute + workspace-relative) are tested. What remains untested is the `serverSettings.js` picker wiring itself (selector keying, apply/clear message payloads, `save()` id/vllmModelId assignment) — it's plain webview JS with no test harness.

---

## Model Picker & Discovery

### P? - Test & Refresh popup overflow
`registerTestAndRefreshModelsCommand` emits one toast per unique server, plus one per no-`serverUrl` config, plus one per no-match server, plus up to two more (network-gating warning + "Run Diagnostic?"). VS Code caps visible toasts (~3); with more than 3 servers the rest collapse into the Notification Center and are easily missed (gripe 1). Not a code bug (platform behavior) but a UX gap — consolidate into one summary toast with per-server detail in the Output channel.

---

## False Positives (keep AI from re-filing)

- **Global writes** — `saveModelConfig` writes to Global only. Intentional: design is "always write to user settings."
- **Config entries match by extension `id` + `serverUrl`, not `vllmModelId`** — correct (shared via `findModelConfigIndex` in config.ts, using `resolveConfigId`). `vllmModelId` is the wire id only and may repeat across presets/servers; the extension key is `id` (with a `vllmModelId` fallback for legacy hand-written entries). Do not "fix" this back to wire-id matching.
- **Unreachable models are removed from the picker after refresh** — `provideLanguageModelChatInformation` skips any model whose server doesn't report `max_model_len` (offline/error/not-loaded) and never adds it to `cachedModels`, so after `clearCache()` + the change event the Copilot picker no longer lists it. By design (gripe 2). A stale entry visible after refresh is VS Code's own picker cache, not a discovery bug.
- **Id-less configs get a composite picker id (`"<model> on <host>"`)** — discovery derives it via `buildModelId` so the same `vllmModelId` on two servers stays distinct; `resolveOverrideForModel` round-trips the composite back to the id-less config that produced it. Fixed the picker-collision bug (gripes 3 & 4). By design, not a bug. A duplicate explicit `id` in settings is the only remaining collision source and is warned about during discovery.
- **Dashboard uses first model's `requestHeaders` per server** — correct. `--api-key` is global per vLLM process; two presets on one server can't have different auth.
- **`serverSettings.js` `d.ontoggle`** — `secState` is the only source of truth on every render; config values use `[data-f]`/`[data-k]`/`.mode-card` paths, not `secState`.
- **Bundled presets duplicate the boilerplate-removal rules** — the five `prompt-replacements/` presets repeat the same ~9 removal rules verbatim. Declared **by design, not a bug**: each personality is a self-contained, fully-editable file, and anyone building their own personality gets the complete picture instead of a personality glued to hidden fixed base rules. The copy-paste drift is a maintenance tax, not a correctness bug — the drift canary (`npm run check:prompt-drift`) is the accepted mitigation. Do not refactor to a shared base layer / composition / build-time generation without user approval.
- **`provideTokenCount` blocks event loop** — `getConfiguration()` is in-memory, not disk. Cold-cache cost is negligible.
- **`dashboard.ts` `Promise.all` has no per-fetch timeout** — `fetchAllEndpoints` in `vllmMetrics.ts` has a 5s `AbortController` covering all parallel requests. Bug fixed in v1.20.0.
- **`vllmClient.ts:214` Promise.race fragility** — code now in `streamReader.ts:153-169`, pattern is correct: `timeoutId` assigned synchronously, `result` never read in error path.
- **Personality dropdown applies immediately (no Save All)** — intentional: selecting a personality writes global settings on `change`, unlike every other field which waits for Save All Changes. The raw `systemMessageReplacementsFile` field is synced so a subsequent Save All still writes the same value. Consequence: **Revert cannot undo a personality change** (already written). By design, not a bug.

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
