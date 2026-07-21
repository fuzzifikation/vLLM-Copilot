# Known Bugs And Improvements

Only outstanding issues are listed here. Fixed items belong in [CHANGELOG.md](./CHANGELOG.md); proposed features belong in [docs/feature-ideas.md](./docs/feature-ideas.md).

The list was audited against the current source and tests on 2026-07-19. Items are retained only when the behavior is reproducible from the code or the maintainability concern is concrete. Similar findings are consolidated.

### Fixed 2026-07-19

- **P0: TLS diagnostic lied about auto-fix result** — forwarded actual `TlsFixResult` instead of hardcoded `{ exported: true }`. Report now shows real export status, PEM path, and `NODE_EXTRA_CA_CERTS` instructions.
- **P1: Auto-config invented Qwen sampling params for every model** — deleted `parseModelModes()`. Auto-discovery no longer scans Jinja templates to guess thinking modes. User presets (`model-configs/`) are the source of truth.
- **P1: `testAndRefreshModels` did not await the network-gating settings command** — `openSettings` was fired inside a `.then()` callback and the inner `executeCommand` was not awaited. Converted to `await` so failures surface instead of becoming unhandled rejections, consistent with the surrounding awaited calls.

---

## Maintainability And Over-Engineering

These are not necessarily user-visible failures, but they impose a concrete maintenance or packaging cost.

### P1 - Large Modules And Complex Command Closure

- **`autoConfig.ts` is a ~1,040-line multi-purpose module** - it combines preset loading, HuggingFace and vLLM fetching, config generation, BYOK utility-model setup, and progress UI. The responsibilities can be separated when this area is next changed, reducing the cost and risk of local edits.
- **`provider.ts` is a 944-line orchestration module** - stream consumption, auto-continue retry state, post-stream diagnostics, and error classification are all coordinated here. The existing `StreamOutcome` boundary provides a natural extraction point for stream/retry handling.
- **`testAndRefreshModels` is one roughly 200-line command closure with five responsibilities** - parallel checks, mismatch correction, per-model reporting, network-gating checks, and the deep-diagnostic offer. Its modal branches are difficult to test independently. Extracting behavior-scoped helpers would leave the command as a small orchestrator without changing the intentional one-dialog-per-model UX.

### P1 - Packaging Depends On Manual Dependency Re-Inclusion

- **The extension has no bundler and `.vscodeignore` manually re-includes runtime dependency files** - the current file excludes `node_modules/` and selectively restores `eventsource-parser`, `jsonrepair`, and `best-effort-json-parser`. Adding a runtime dependency without updating `.vscodeignore` can produce a VSIX that installs but fails at extension load time. This is a recurring packaging failure mode, not just a theoretical cleanup preference.

### P2 - Redundant Stream Queue Control Flow

- **`streamReader.ts` drains `eventQueue` in three near-identical places and repeats the same error/done checks** - `eventsource-parser` invokes `onEvent` synchronously during `parser.feed()`, so the drain before the next read and the final drain after the loop are redundant for the normal flow. Consolidating the post-feed drain and post-stream checks would reduce the state space future changes must reason about.
- **The auto-continue request-options ternary has a dead false arm** - when no assistant prefill exists, `provider.ts` assigns `mergedOptions` unchanged; only the continuation branch adds fields. The trackers are required, but the ternary obscures that only one request-shape mutation exists. Build a copy once and apply the continuation fields conditionally.

### P2 - Module-Level Extension Version State

- **`diagnostics.ts` stores the extension version in mutable module state** - `setExtensionVersion()` must be called during activation, and otherwise reports the sentinel `'unknown'`. This implicit dependency makes the diagnostic function harder to test and allows call-order mistakes. Pass the version into `runDiagnostics()` instead.

### P2 - Dead Or Speculative Auto-Configuration Surface

- **`autoConfigureModel()` accepts `preFetchedInfo`, but no call site passes it** - the parameter and branch exist only for a caching scenario that is not implemented. Remove the parameter until a caller actually needs the optimization.
- **`VllmModelInfo.owned_by` is declared but never read** - the auto-configuration type carries a field that does not participate in matching or generation. Remove it or use the shared server-model type.

### P2 - Misleading Documentation And Comments
- **`streamReader.ts` says the fetch abort signal is inert after streaming starts** - the signal can cancel an in-flight body stream. The direct `reader.cancel()` listener is still useful because it interrupts the pending read directly, but the comment should describe that rationale accurately.
- **`buildAuthHeaders()` is documented as the canonical header builder without stating its scope** - runtime requests use sanitized per-model `requestHeaders` through `resolveServerConfig`; `buildAuthHeaders()` is used by write and migration paths. The JSDoc should distinguish those paths.
- **`promptReplacer.ts` parses each personality file twice** - discovery calls `loadPersonalityMeta()`, then applying the selected file calls `loadPromptReplacements()`, so the same file is read and JSON-parsed again. A shared parser can return metadata and rules together while preserving the existing discovery and application APIs.

### P2 - Smaller Structural Costs

- **`commands.ts` and `vllmClient.ts` define duplicate server-model shapes** - the `FetchModel` and `VllmModel` interfaces carry the same wire fields in separate modules. A shared type would prevent the two declarations from drifting.
- **`modelInfo.ts::buildModelInfo()` redeclares a partial model override shape inline** - the local structural type can silently omit fields as `ModelConfig` evolves. Reuse `ModelConfig` or name an intentional subset so the narrowing remains visible.
- **`logger.ts::clearLogFiles()` performs synchronous directory and unlink operations inside an `async` function** - clearing a large log directory blocks the extension host even though callers receive a Promise. Use the promise-based filesystem APIs or make the synchronous behavior explicit.
- **`fetchRetry.ts` uses a small `RetryLogger` strategy object for one implementation** - the only implementation is a `VllmClient` getter that writes two messages to one Output channel. Inlining the optional Output channel or a pair of callbacks would remove an abstraction that currently has no independent implementation.

### P3 - Session Manager Coupling

- **`sessionManager.ts` uses module-level mutable output-channel state** - logging depends on `setSessionManagerOutput()` having run before any operation. Passing the channel through the operations that log would make the dependency explicit and eliminate the silent-no-op fallback.
- **Several session-manager operations are declared `async` while doing synchronous SQLite work** - `deleteChatKeys()` and the database scan use `DatabaseSync`, so the event loop is still blocked despite the Promise return type. Either expose synchronous APIs or move the database work off the extension-host thread.

---

## Known Limitations

- **Tool results cannot carry binary or image data** — VS Code's `LanguageModelToolResultPart.content` accepts `LanguageModelDataPart`, but OpenAI's wire format only allows `string` content for `role: 'tool'` messages. The provider correctly filters `LanguageModelDataPart` in `extractToolResultContent()`. This is an OpenAI API constraint, not a fixable bug in the extension.
- **MCP servers require a utility model for local BYOK models** - Agent mode needs a utility model such as `copilot-utility-small`. On VS Code 1.128 and newer, the extension sets `chat.byokUtilityModelDefault` to `mainAgent` and offers the Configure Utility Model command. Older supported VS Code versions do not expose that setting, so users must update VS Code or avoid MCP-backed Agent mode.
- **Corporate TLS can fail on incomplete certificate chains** - VS Code's patched fetch uses the Node/OpenSSL trust path, while Windows SChannel or PowerShell can retrieve missing intermediates from the OS store. The extension does not add missing intermediates to Node's trust configuration automatically. The Diagnose Connection command compares these paths; the durable fix is for the server or proxy to send the complete chain, or for the user to configure `NODE_EXTRA_CA_CERTS`.
- **Clean Copilot Sessions does not operate on the local machine from a remote extension host** - in Remote-SSH or devcontainer contexts, `os.homedir()` points at the remote host, so the command cannot find local Copilot session storage. Run it from a local extension host instead.
