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
- `autoConfig.ts` ~1,073 lines (presets, HF fetch, config gen, BYOK, progress UI)
- `provider.ts` ~1,012 lines (stream, auto-continue, diagnostics, error classification)
- `testAndRefreshModels` ~200-line closure with 5 responsibilities

### P2 - Untested data layer
`fetchServerMetrics` HTTP layer, `dashboard.ts` tree provider, and formatting helpers lack tests. `parseLabels`, `MetricsParser`, `parseRawMetrics`, `fmtPct`, `fmtMs` are covered.

### P2 - Structural costs
- `modelInfo.ts::buildModelInfo()` redeclares partial `ModelConfig` inline — can silently omit fields
- `logger.ts::clearLogFiles()` uses sync FS inside async function
- `fetchRetry.ts` has `RetryLogger` strategy object for one implementation

### P3 - Session manager coupling
- Module-level output channel state; `setSessionManagerOutput()` must run first or logs silently drop
- `deleteChatKeys()` and DB scan declare `async` but use synchronous `DatabaseSync`

---

## False Positives (keep AI from re-filing)

- **Global writes** — `saveModelConfig` writes to Global only. Intentional: design is "always write to user settings."
- **`saveModelConfig` matches by `vllmModelId + serverUrl`** — correct. Both fields derive from same dropdown selection; no orphan/overwrite scenario exists.
- **Dashboard uses first model's `requestHeaders` per server** — correct. `--api-key` is global per vLLM process; two presets on one server can't have different auth.
- **`serverSettings.js` `d.ontoggle`** — `secState` is the only source of truth on every render; config values use `[data-f]`/`[data-k]`/`.mode-card` paths, not `secState`.
- **`provideTokenCount` blocks event loop** — `getConfiguration()` is in-memory, not disk. Cold-cache cost is negligible.
- **`dashboard.ts` `Promise.all` has no per-fetch timeout** — `fetchServerMetrics` has its own 5s `AbortController`. Fixed mid-flight abort bug in v1.20.0.
- **`vllmClient.ts:214` Promise.race fragility** — code now in `streamReader.ts:153-169`, pattern is correct: `timeoutId` assigned synchronously, `result` never read in error path.
- **`selectMismatchesToPrompt` dead code** — called at `commands.ts:263` inside `testAndRefreshModels`.

---

## Known Limitations

- **`extractFamily` heuristic** recognizes 8 families (codellama, llama, qwen, mistral, phi, gemma, deepseek, falcon). Others fall through to org name — non-fatal sort key only, authoritative family comes from preset or HF discovery.
- **Tool results can't carry binary/image data** — OpenAI wire format only allows `string` content for `role: 'tool'`.
- **MCP servers need a utility model for BYOK** — VS Code 1.128+ sets `chat.byokUtilityModelDefault` automatically; older versions can't use MCP-backed Agent mode.
- **Corporate TLS with incomplete cert chains** — Node/OpenSSL trust path vs SChannel. Fix: server sends complete chain, or set `NODE_EXTRA_CA_CERTS`.
- **Clean Copilot Sessions won't run on remote host** — `os.homedir()` points at remote; run from local extension host instead.
