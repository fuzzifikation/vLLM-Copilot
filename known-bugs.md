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

### P1 - Multiple presets of the same server model share personality state
The configuration supports several presets (distinct `id`s) that point at the same server + `vllmModelId`. Both personality-management entry points break with this setup:
- **Server Settings webview** collapses them into a single selector entry and keys active-personality state by `vllmModelId`, so the second preset is unreachable in the UI.
- **`setModelPersonality` command** lists every preset, but `saveModelConfig` locates the entry via `findModelConfigIndex(vllmModelId, serverUrl)` and updates the FIRST match, so applying to a later preset overwrites the first one's personality.
Enumerate presets by their unique config `id` in webview state/messages, and prefer an exact-`id` match in `saveModelConfig` before falling back to `(vllmModelId, serverUrl)`.

### P3 - Custom replacement path resolution is untested
There are no focused tests for Windows/POSIX handling of absolute and workspace-relative `systemMessageReplacementsFile` paths in `loadReplacements` and `resolveActivePersonality`. The implementation uses platform path helpers, but these cases remain unverified.

### P3 - Server Settings personality message flow lacks focused tests
The replacement engine (`promptReplacer.ts`) and the capture write path (`enqueueWrite`) now have focused tests, and discovery/config-merge semantics are covered. The Server Settings `applyPersonality`/`saveModelConfig` message flow and the webview picker wiring remain untested (tied to the P1 webview identity work above).

---

## False Positives (keep AI from re-filing)

- **Global writes** — `saveModelConfig` writes to Global only. Intentional: design is "always write to user settings."
- **`saveModelConfig` matches by `vllmModelId + serverUrl`** — correct (now shared via `findModelConfigIndex` in config.ts).
- **Dashboard uses first model's `requestHeaders` per server** — correct. `--api-key` is global per vLLM process; two presets on one server can't have different auth.
- **`serverSettings.js` `d.ontoggle`** — `secState` is the only source of truth on every render; config values use `[data-f]`/`[data-k]`/`.mode-card` paths, not `secState`.
- **`provideTokenCount` blocks event loop** — `getConfiguration()` is in-memory, not disk. Cold-cache cost is negligible.
- **`dashboard.ts` `Promise.all` has no per-fetch timeout** — `fetchAllEndpoints` in `vllmMetrics.ts` has a 5s `AbortController` covering all parallel requests. Bug fixed in v1.20.0.
- **`vllmClient.ts:214` Promise.race fragility** — code now in `streamReader.ts:153-169`, pattern is correct: `timeoutId` assigned synchronously, `result` never read in error path.
---

## Known Limitations

- **`extractFamily` heuristic** recognizes 8 families (codellama, llama, qwen, mistral, phi, gemma, deepseek, falcon). Others fall through to org name — non-fatal sort key only, authoritative family comes from preset or HF discovery.
- **Tool results can't carry binary/image data** — OpenAI wire format only allows `string` content for `role: 'tool'`.
- **MCP servers need a utility model for BYOK** — VS Code 1.128+ sets `chat.byokUtilityModelDefault` automatically; older versions can't use MCP-backed Agent mode.
- **Corporate TLS with incomplete cert chains** — Node/OpenSSL trust path vs SChannel. Fix: server sends complete chain, or set `NODE_EXTRA_CA_CERTS`.
- **Clean Copilot Sessions won't run on remote host** — `os.homedir()` points at remote; run from local extension host instead.
- **`system-messages.json` dedupes by `receivedContent`** — documented "write once per unique message" behavior. The same original system prompt sent through different models or personalities overwrites `deliveredContent`/`rulesApplied` with the latest write.
- **Legacy `.vllm/` personality references still apply but aren't listed** — a model whose `systemMessageReplacementsFile` points at a `.vllm/...` path still gets those rules applied at request time (custom replacement-file path), but the picker no longer lists it as a named personality. The webview dropdown shows "Default" while the hint shows the raw path. Re-apply via the picker to move it to global storage.
