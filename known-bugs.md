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

## Personalities And System Messages

### P3 - Server Settings webview picker wiring is untested
The host-side flow is covered: `applyPersonality`/`saveModelConfig` have focused tests (id-keyed multi-preset, clear semantics, composite-id new entries), the replacement engine (`promptReplacer.ts`), the capture write path (`enqueueWrite`), and `loadReplacements` path resolution (absolute + workspace-relative) are tested. What remains untested is the `serverSettings.js` picker wiring itself (selector keying, apply/clear message payloads, `save()` id/vllmModelId assignment) — it's plain webview JS with no test harness.

### P4 - Bundled presets duplicate the boilerplate-removal rules
All five presets in `prompt-replacements/` repeat the same ~9 removal rules verbatim (3 safety variants, 3 identity variants, generic-agent, short/impersonal). When Copilot's prompt changes, every file must be edited in lockstep — a copy-paste drift risk. Open to ideas (shared base layer / composition / build-time generation), but not pressing.

---

## False Positives (keep AI from re-filing)

- **Global writes** — `saveModelConfig` writes to Global only. Intentional: design is "always write to user settings."
- **Config entries match by extension `id` + `serverUrl`, not `vllmModelId`** — correct (shared via `findModelConfigIndex` in config.ts, using `resolveConfigId`). `vllmModelId` is the wire id only and may repeat across presets/servers; the extension key is `id` (with a `vllmModelId` fallback for legacy hand-written entries). Do not "fix" this back to wire-id matching.
- **Dashboard uses first model's `requestHeaders` per server** — correct. `--api-key` is global per vLLM process; two presets on one server can't have different auth.
- **`serverSettings.js` `d.ontoggle`** — `secState` is the only source of truth on every render; config values use `[data-f]`/`[data-k]`/`.mode-card` paths, not `secState`.
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
- **Applied personality path is machine-specific (breaks Settings Sync)** — applying a personality stores an **absolute** `systemMessageReplacementsFile` path into global storage (`.../globalStorage/vllm-copilot/personalities/...`). Settings Sync pushes `vllm-copilot.models` between machines, but the global-storage file does not sync, so on a second machine the path won't exist and the personality silently stops applying (a `[WARN] Replacements file not found` in the Output channel). Not portable across machines by design; a portable reference scheme (e.g. `personalities:<name>`) would be required to fix.
- **Personality rules silently no-op when Copilot's prompt drifts** — presets use exact-substring `find` rules against Copilot's *hidden* boilerplate, which Microsoft changes without notice (the presets already enumerate 3 safety variants + 3 identity variants as evidence). When a new variant ships, the rules stop matching: the personality still "works" (identity rules still hit), but boilerplate the user believes is stripped stays in. `matchedRuleNames` is only recorded in the opt-in capture file — no WARN when 0 rules match the main agent message. **Mitigation: `npm run check:prompt-drift`** (scripts/check-prompt-drift.mjs) — compares every preset `find` against the current VS Code prompt source on GitHub and fires on dead rules or changed source SHAs. Still a canary, not proof: the authoritative re-verification is a fresh `systemMessageCapture` run, then `--update-baseline`.
- **Identity-removal rules can orphan the model-name fragment** — the main and GPT-5 identity rules end their `find` at `...state that you are using ` (trailing space, before the dynamic model name). After removal, the trailing `{model_name}.` remains in the system prompt. Not fixable by exact-substring match alone (model name is dynamic); cosmetic.
- **`default-prompt-replacements.json` sits in the personalities dir** — it's a legacy-array file (no `meta`), so it's correctly not discovered as a personality, but it's read+parsed on every discovery scan and confusingly placed beside the `{ meta, rules }` presets. Move it (e.g. to `docs/`) or give it a `meta` block.
