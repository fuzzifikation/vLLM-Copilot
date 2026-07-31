# Known Bugs And Improvements

Only outstanding issues. Fixed items → [CHANGELOG.md](./CHANGELOG.md). Feature ideas → [docs/feature-ideas.md](./docs/feature-ideas.md).
Do not bump version without asking.

---

## Bugs

### P3 - Dashboard bypasses provider config cache on every poll
`dashboard.ts::getChildren()` calls `getConfig(context)` (~15s interval when sidebar visible). VllmClient has a cache, dashboard can't reach it without circular deps. Acceptable overhead at current intervals.

---

## Maintainability

### P1 - Large modules
- `autoConfig.ts` (~15 exported functions) — `autoConfigureModel()`, `loadModelPresets()`, `findPresetForModel()`, `saveModelConfig()`, `registerAddServerModelCommand()`, `resolveModelConfigForAdd()`, and more. Grab-bag of presets, HF fetch, config gen, BYOK, progress UI.
- `provider.ts` — `provideLanguageModelChatResponse()` (~550 lines), `consumeStream()` (~290 lines), `provideLanguageModelChatInformation()` (~124 lines). Stream, auto-continue, diagnostics, error classification.
- `registerTestAndRefreshModelsCommand()` in `commands.ts` — single large closure with 5 responsibilities (discovery, health check, mismatch detection, model picker prompt, config save).

### P2 - Untested data layer
`fetchServerMetrics` HTTP layer, `dashboard.ts` tree provider, and formatting helpers lack tests. `parseLabels`, `MetricsParser`, `parseRawMetrics`, `fmtPct`, `fmtMs` are covered.

### P3 - Session manager coupling
- Module-level output channel state; `setSessionManagerOutput()` must run first or logs silently drop (fixed: pre-init messages are queued and flushed on init)

---

## False Positives (keep AI from re-filing)

- **Global writes** — `saveModelConfig` writes to Global only. Intentional: design is "always write to user settings."
- **`saveModelConfig` matches by `vllmModelId + serverUrl`** — correct. Both fields derive from same dropdown selection; no orphan/overwrite scenario exists.
- **Dashboard uses first model's `requestHeaders` per server** — correct. `--api-key` is global per vLLM process; two presets on one server can't have different auth.
- **`serverSettings.js` `d.ontoggle`** — `secState` is the only source of truth on every render; config values use `[data-f]`/`[data-k]`/`.mode-card` paths, not `secState`.
- **`provideTokenCount` blocks event loop** — `getConfiguration()` is in-memory, not disk. Cold-cache cost is negligible.
- **`dashboard.ts` `Promise.all` has no per-fetch timeout** — `fetchServerMetrics` has its own 5s `AbortController`. Fixed mid-flight abort bug in v1.20.0.
- **`vllmClient.ts:214` Promise.race fragility** — code now in `streamReader.ts:153-169`, pattern is correct: `timeoutId` assigned synchronously, `result` never read in error path.
- **`selectMismatchesToPrompt` dead code** — it IS called at `commands.ts:263` inside `testAndRefreshModels`. Not dead code, kept for documentation to prevent re-filing.

---

## Known Limitations

- **`extractFamily` heuristic** recognizes 8 families (codellama, llama, qwen, mistral, phi, gemma, deepseek, falcon). Others fall through to org name — non-fatal sort key only, authoritative family comes from preset or HF discovery.
- **Tool results can't carry binary/image data** — OpenAI wire format only allows `string` content for `role: 'tool'`.
- **MCP servers need a utility model for BYOK** — VS Code 1.128+ sets `chat.byokUtilityModelDefault` automatically; older versions can't use MCP-backed Agent mode.
- **Corporate TLS with incomplete cert chains** — Node/OpenSSL trust path vs SChannel. Fix: server sends complete chain, or set `NODE_EXTRA_CA_CERTS`.
- **Clean Copilot Sessions won't run on remote host** — `os.homedir()` points at remote; run from local extension host instead.
