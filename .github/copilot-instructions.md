# AI Assistant Instructions

---

## General Coding Principles

These apply to any codebase.

### Workflow
1. **UNDERSTAND the BIG PICTURE** — read the task, ask clarifying questions, and confirm understanding before starting. Consider whether existing code should be modified or removed entirely.
2. **ANALYZE first** — read files, understand the current state. Never assume.
3. **PROPOSE significant changes** before acting (new files, architectural shifts, removing functionality). Small, obvious fixes (typos, formatting, trivial renames, clear bug fixes) can be applied directly.
4. **If you make a mistake: STOP.** Tell the user immediately — don't hide it, silently fix it, or degrade features to paper over it.

### NEVER DO THESE (without explicit user approval)
- **Run destructive git commands:** `git checkout`, `git stash`, `git reset`, `git clean`, etc.
- **Revert or overwrite files without checking contents first.**

### Communication
- **Be brief.** Skip fluff, include details only when it matters for decisions or debugging.
- **Summarize your work** when done: what changed, why, and any assumptions made.
- **Ask clarifying questions** when a task is ambiguous — don't guess. Use the Questions tool.
- **Contradict the user** if you believe they are wrong or missing something. Be direct, not deferential.

### Simplicity Over Complexity
- **Question necessity first.** What is the overall purpose? Is the approach actually necessary? If in doubt or unclear, push back or ask.
- **Deleting code is better than adding code.** If existing code no longer serves the goal, remove it. No code is sacred.
- **Prefer fewer files, fewer functions, fewer lines.** Each addition has a maintenance cost.
- **Don't build workarounds on top of workarounds.** Fix the root cause — which is often deleting the problematic code entirely.
- **Pause and reconsider the big picture.** After three or more edits for one problem, stop. Re-read the original goal and propose a simpler path.
- **If the higher purpose is unclear, ask.** Don't guess. Every line of code should serve a user-facing feature.
- **Verified bugs can be fixed directly.** Evaluate bugs twice (be sure it is a bug). If after second evaluation high confidence → fix. Medium/low confidence → ask first.

### Thoroughness
- **Check your work.** Code review your changes and check linter for errors and warnings. 
- **Run tests.** Verify existing tests pass and add tests for new behavior.
- **Point out issues** even if unrelated to the current task. Inform the user. Prefer proactive feedback over silence.
- **Update docs** if your changes affect README, known-bugs, or other documentation.

### Task Approach
- **Decompose, then verify.** Split work into individually verifiable steps. Don't try to do everything at once.
- **Read before writing.** Understand the existing pattern. If existing code is wrong, propose a fix first — don't blindly copy-paste.
- **Use available MCP tools (Context 7) and web search** for API behavior. Training data may be outdated.

---

## This Repository: vLLM-Copilot-2

### Architecture: No Global Server Settings
- **ALL servers are per-model.** Each model entry in `vllm-copilot.models` has its own `serverUrl` and `requestHeaders`.
- **The ONLY global setting is `enableFileLogging`.**
- There is NO global `serverUrl`, `apiKey`, `requestHeaders`, or sampling params.
- The discovery logic must NOT probe a "global server" — it groups models by their per-model `serverUrl` and discovers from each server independently.
- `VllmConfig.serverUrl`, `VllmConfig.apiKey`, `VllmConfig.requestHeaders` are **deprecated legacy fields** kept only for one-time migration. They must not be used at runtime.

### Version Compatibility
- **Only support newest versions.** Don't add workarounds for old versions unless explicitly requested. This goes for vLLM, VS Code, Copilot.
- Always use the latest version of any library or framework unless the user specifies otherwise. However, this version must be supported by Copilot, VS Code and vLLM.

### Build & Test
- **Compile:** `npm run compile` (runs `tsc -p ./`).
- **Test:** `npm test` (Vitest). Coverage: `npm run test:coverage`.
- **Package a VSIX:** `npm run build` (compiles, tests, then packages with vsce).

## Project Architecture

This is a **VS Code Language Model Chat Provider extension** that routes Copilot requests through a local vLLM server. Data flow:

```
Copilot → provider.ts (VllmChatModelProvider) → vllmClient.ts → vLLM server
```

### Core files:
| File | Responsibility |
|---|---|
| `src/extension.ts` | Activation, command registration, lifecycle |
| `src/provider.ts` | `LanguageModelChatProvider` impl. Streams response to Copilot. |
| `src/vllmClient.ts` | HTTP client. Config cache owner, SSE streaming, request construction. |
| `src/config.ts` | Config types (`VllmConfig`, `ModelConfig`), validation, resolution helpers. |
| `src/types.ts` | Shared wire-format types & SSE events only. No business logic. |
| `src/messageConverter.ts` | VS Code ↔ OpenAI/vLLM message format conversion. |
| `src/streamReader.ts` | SSE stream reader. Uses `eventsource-parser` for spec-compliant line parsing + inactivity timeout. |
| `src/sseParser.ts` | vLLM-specific SSE layer: JSON parse of `data:` chunks + tool call accumulation. Sits on top of `streamReader.ts`. |
| `src/sessionManager.ts` | Session state management across turns. |
| `src/tokenBudget.ts` | Token budgeting for input context windows. |
| `src/modelInfo.ts` | Builds `LanguageModelChatInformation` from server + override configs. |
| `src/modelUtils.ts` | Model ID/family detection utilities. |
| `src/commands.ts` | User-facing VS Code commands (configure, refresh, test, etc.). |
| `src/autoConfig.ts` | Auto-detect model config from vLLM server + HuggingFace. |
| `src/logger.ts` | File-based request/response logging. |
| `src/usageReporting.ts` | Token usage tracking and reporting. |

### Key patterns:
- **Config ownership:** `VllmClient` owns the config cache. Everyone reads through it. Single source of truth — adding a second cache causes stale reads.
- **Types in `types.ts`** exist only to break circular imports. No logic lives there.
- **Model overrides** (`model-configs/`) let users customize server models (modes, capabilities, token limits).
- **ESM throughout.** All imports use `.js` extensions per TypeScript 5+ ESM rules.

### Test structure:
- Unit tests in `test/*.test.ts`, one file per source module.
- Integration tests in `test/integration/`.
- Mocks in `test/__mocks__/vscode.ts` — VS Code API is mocked at the module level.

## VS Code Extension Conventions

Non-negotiable for this codebase:

- **Everything that allocates resources must be `Disposable`.** Timers, event listeners, output channels, providers — all disposed in `dispose()` and pushed to `context.subscriptions` in `activate()`.
- **Cancellation tokens must be respected.** `chatCompletionStream()` receives a `vscode.CancellationToken`. Check `token.isCancellationRequested` in loops; pass `AbortSignal` to `fetch()`.
- **Use `context.secrets` for sensitive data** (API keys). Never log or cache keys in plain text.
- **Proposed APIs require `enabledApiProposals` in package.json.** `chatProvider` is already enabled. Don't remove it.
- **Event emitters must be disposed.** `vscode.EventEmitter.dispose()` cancels firing and clears listeners.
- **Settings changes fire `onDidChangeConfiguration`.** React to them — never require reload. Cache invalidation is the pattern.
- **Output channels are for user-visible logs.** Use structured format: `[INFO]`, `[WARN]`, `[ERROR]`.

## Anti-Patterns

Things this codebase has been burned by — don't repeat:

- **Global server probing at discovery.** There is no global server. Discovery groups models by per-model `serverUrl`. Do not add a "global server" fetch path.
- **Duplicate config caching.** Only `VllmClient` caches config. Other files read through it.
- **SSE parsing in the provider.** `streamReader.ts` owns SSE line parsing (via `eventsource-parser`); `sseParser.ts` owns JSON parsing + tool call accumulation. `provider.ts` consumes structured events.
- **Hand-rolled SSE parsing.** The prior hand-rolled parser was replaced with `eventsource-parser` (battle-tested, used by Vercel AI SDK). Do not revert to manual line parsing.
- **String-based type guards when interfaces exist.** Use the types in `types.ts`. If a cast is needed, document why.
- **Loading all model configs unconditionally.** `model-configs/` can grow. Load selectively.
- **Synchronous blocking in async callbacks.** VS Code callbacks are async. Don't await in constructors or sync paths.