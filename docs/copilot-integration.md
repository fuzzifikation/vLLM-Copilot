# Copilot Integration Reference

Hard-won knowledge about how GitHub Copilot interacts with our `LanguageModelChatProvider`.
Derived from investigating the Copilot extension's `package.json` and the VS Code proposed API.

---

## What Copilot sends us

- **Messages** — all messages the caller assembled (no pre-filtering by VS Code)
- **Historical thinking** — current hosts can include assistant `LanguageModelThinkingPart`
  content in those messages; the extension forwards it as vLLM's structured `reasoning`
  field without keeping a private transcript
- **`options.tools`** — available tools for the model to call
- **`options.toolMode`** — `Auto` (model decides) or `Required` (must use a tool)
- **`options.modelConfiguration`** — resolved values from our `configurationSchema` (if we declare one)
- **`options.modelOptions`** — generic pass-through; Copilot currently sends only OTel correlation IDs here, NOT token limits

## What Copilot does NOT send us

- No `max_tokens` / output limit — Copilot does NOT pass this to providers; we determine it ourselves from `config.maxOutputTokens` (or per-model override)
- No context truncation hints — Copilot trusts our declared `maxInputTokens` and self-manages

## What Copilot does with our declared info

| Field we return | How Copilot uses it |
|----------------|---------------------|
| `maxInputTokens` | Budget for `@vscode/prompt-tsx` rendering; compaction trigger threshold |
| `maxOutputTokens` | Context usage widget (total = input + output); model picker display |
| `family` | Capability routing — Copilot picks prompt templates based on family name |
| `capabilities.toolCalling` | Enables Agent mode for the model |
| `capabilities.imageInput` | Routes image pastes to the model |
| `configurationSchema` | Renders settings in model picker UI (e.g., "Model Mode" dropdown) |

## How Copilot Builds Prompts

**Discovery date:** 2026-07-14  
**Method:** Inspected VS Code Copilot source code in [microsoft/vscode](https://github.com/microsoft/vscode)

### Architecture

Copilot uses a JSX-like prompt-tsx system where prompts are composed of reusable components. Every system message is a composition of:

1. **Unique first line** — identifies the prompt type ("You are an expert in...", "You are a programmer...")
2. **Reusable building blocks** — shared components like `<SafetyRules />`, `<CopilotIdentityRules />`
3. **Prompt-specific rules** — unique instructions for that message type
4. **Dynamic values** — model name (`{promptEndpoint.name}`), date, OS, tools available

### Reusable Building Blocks

All prompts import these shared components (single source of truth):

| Component | Content | Source |
|-----------|---------|--------|
| `<SafetyRules />` | "Follow Microsoft content policies... harmful, hateful, racist, sexist..." | [safetyRules.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/base/safetyRules.tsx) |
| `<LegacySafetyRules />` | Same + "or completely irrelevant to software engineering" | Same file |
| `<CopilotIdentityRules />` | "When asked for your name, you must respond with 'GitHub Copilot'. When asked about the model you are using, you must state that you are using {model_name}." | [copilotIdentity.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/base/copilotIdentity.tsx) |
| `<EditorIntegrationRules />` | Markdown formatting, code block rules | [editorIntegrationRules.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/panel/editorIntegrationRules.tsx) |

**Key insight:** The same blocks appear in dozens of different prompt types. Cannot patch VS Code — must intercept at runtime.

### Message Types We've Observed

| Type | First Line (fingerprint) | Size | Source |
|------|-------------------------|------|--------|
| Main chat agent | "You are an expert AI programming assistant, working with a user in the VS Code editor." | ~22KB | [agentPrompt.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/agent/agentPrompt.tsx) |
| Progress messages | "You are an expert in writing short, catchy, and encouraging progress messages..." | ~1KB | [progressMessagesPrompt.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/inlineChat2/node/progressMessagesPrompt.tsx) |
| Title generation | "You are an expert in crafting ultra-compact titles..." | ~1KB | [title.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/panel/title.tsx) |
| Git branch | "You are an expert in crafting pithy branch names..." | ~1KB | [gitBranch.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/panel/gitBranch.tsx) |

See [custom-system-prompt.md](./custom-system-prompt.md) for full design doc and all 35+ message types found in source.

## Historical Thinking Preservation

**Status (2026-07-20):** BROKEN on VS Code Stable 1.129.1 — upstream Copilot Chat issue.

The extension correctly reports thinking chunks via `progress.report(new ThinkingPart(...))` and forwards any thinking parts it receives as the `reasoning` field. However, Copilot Chat's public-history-to-internal-turn reconstruction flattens assistant responses to visible text only, dropping `LanguageModelThinkingPart` before the provider request is built.

**Verified on:** VS Code 1.129.1 (Stable) — `LanguageModelThinkingPart` is available at runtime (`ThinkingPartAvailable=true`), but second-turn assistant messages have `think=false` on all parts. First-turn reasoning streams correctly; subsequent turns lose the `reasoning` field entirely.

**Root cause:** Copilot Chat, not the extension or VS Code core. The generic Copilot endpoint can transport thinking when supplied; the loss occurs in Copilot Chat's history reconstruction.

**Impact:** `preserve_thinking: true` is effectively a no-op until VS Code ships input support. Multi-turn reasoning quality degrades (model can't see prior reasoning).

**Do NOT add extension-side state or replay cache.** That violates the stateless-adapter boundary and creates sync problems around tool calls, retries, and session restoration.

See [test-preserve-thinking.md](./test-preserve-thinking.md) for the full test procedure and diagnostic evidence.

## Relevant Copilot settings (user-configurable)

| Setting | Effect on us |
|---------|-------------|
| `github.copilot.chat.modelCapabilityOverrides` | Users can alias our model's `family` for different prompt routing |
| `github.copilot.chat.reasoningEffortOverride` | Override reasoning effort sent to models (debugging/eval) |
| `github.copilot.chat.summarizeAgentConversationHistory.enabled` | Copilot auto-compacts conversations (confirms our no-truncation design) |
| `github.copilot.chat.summarizeAgentConversationHistoryThreshold` | Token threshold for triggering summarization |
| `github.copilot.chat.imageUpload.enabled` | Copilot sends images when our model declares `imageInput: true` |
| `github.copilot.chat.inlineChat.enableThinking` | Copilot supports thinking tokens in inline chat |
| `github.copilot.chat.inlineChat.reasoningEffort` | Effort levels: none/minimal/low/medium/high |

---

## Where Copilot Stores Sessions (Disk Layout)

**Discovery date:** 2026-06-15  
**Method:** Inspected `state.vscdb` SQLite files via `tmp/check_sessions.py` and `tmp/inspect_sessions2.py`. Implemented in `src/sessionManager.ts`.

### Architecture

| Location | Windows path | What's stored |
|----------|--------------|---------------|
| **Global DB** | `%APPDATA%/Code/User/globalStorage/state.vscdb` | Global sessions (panel/global context chats) + all user preferences |
| **Per-workspace DB** | `%APPDATA%/Code/User/workspaceStorage/{hash}/state.vscdb` | Workspace-specific sessions + state |
| **Filesystem** | `%APPDATA%/Code/User/workspaceStorage/{hash}/GitHub.copilot-chat/` | Transcripts (`.jsonl`), debug logs, `workspace-chunks.db` |

macOS: `~/Library/Application Support/Code/User/...`  
Linux: `~/.config/Code/User/...`

The `{hash}` is derived from the workspace folder path. The mapping lives in `workspace.json`:
```json
{ "folder": "file:///c%3A/Github%20Projects/vLLM-Copilot" }
```
Multi-root workspaces use a `folders` array instead of a single `folder` string.

### Session Index Format

Both global and per-workspace DBs store `chat.ChatSessionStore.index` as a single key in `ItemTable`:

```json
{
  "version": 1,
  "entries": {
    "{uuid}": {
      "sessionId": "{uuid}",
      "title": "Check tool calling mime type",
      "lastMessageDate": 1781548961884,
      "timing": { "created": ..., "lastRequestStarted": ... },
      "initialLocation": "panel",
      "hasPendingEdits": false,
      "isEmpty": false,
      "permissionLevel": "default"
    }
  }
}
```

**Key insight:** Sessions have **no workspace identifier**. The only link between a session and its workspace is that its transcript file (`{uuid}.jsonl`) exists under that workspace's `GitHub.copilot-chat/transcripts/` directory.

### Related Keys in ItemTable

The following keys hold Copilot session state and are cleaned by the **Clean Copilot Sessions** command:

```
chat.ChatSessionStore.index
chat.terminalSessions
agentSessions.state.cache
agentSessions.model.cache
agentSessions.readDateBaseline2
memento/interactive-session
memento/interactive-session-view-copilot
memento/chat-todo-list
chat.untitledInputState
terminalChat.toolSessionMappings
```

## Implications for our implementation

1. **`family` matters** — if we return `family: "qwen3"` but Copilot doesn't recognize it, it may use generic prompts. We auto-discover the family from HuggingFace's `config.model_type` via the Auto-Configure command. A string-matching heuristic in `modelUtils.extractFamily()` serves as fallback. Users can override routing via `modelCapabilityOverrides`:
   ```json
   "github.copilot.chat.modelCapabilityOverrides": {
     "qwen3_next": "qwen3"
   }
   ```
   This maps our model's family (`qwen3_next`) to a family name Copilot recognizes (`qwen3`).
2. **`configurationSchema` is the official way** to expose reasoning effort in the model picker — not a custom setting.
3. **Agent mode = `toolCalling: true`** — no separate flag needed, it's auto-derived.
4. **Copilot never truncates for us** — it fills up to `maxInputTokens`, then compacts its own history. Our provider receives exactly what fits.

---

## Hard-Won Lessons

### Empty Response: "Sorry, no response was returned."

**Problem:** When a response stream ends with zero content parts (e.g., graceful termination or stop sequence fires before any text is generated), Copilot shows the message **"Sorry, no response was returned."** instead of silently completing.

**Root cause:** Copilot expects at least one content part in the response stream. A stream with only tool calls or an entirely empty stream both trigger this fallback message.

**Fix:** On graceful termination or stop-without-content paths, emit a minimal text part (empty string) to ensure the stream is non-empty.

### Auto-Continue: Recovering Incomplete Responses

Local/self-hosted reasoning models sometimes stop (`finish_reason: stop`) without delivering a usable answer. The provider recovers automatically inside a single `provideLanguageModelChatResponse` call — all attempts share one `progress` reporter, so Copilot sees one seamless stream. Controlled by `vllm-copilot.autoContinueRetries` (default `1`, `0` disables). Implemented in `provider.ts`.

Two distinct triggers, each with its **own** request shape:

1. **Empty response (nudge).** The model emitted only reasoning (or nothing) then stopped. We append an empty assistant prefill `{ role: 'assistant', content: '' }` and re-send under the **default** chat-template flags. vLLM starts a fresh assistant turn — nothing reached Copilot yet, so nothing is lost.

2. **Colon-truncation (continuation).** The streamed content ends on a trailing colon (`…as follows:`) — a sentence cut mid-thought. Here we must **resume** the text already shown, not regenerate it. We set vLLM's continuation flags `continue_final_message: true` and `add_generation_prompt: false`, and grow the assistant prefill with everything streamed so far. vLLM reopens the existing assistant message and returns only **new** tokens. Without these flags, vLLM would treat the prefill as a finished turn and regenerate, duplicating what Copilot already displayed.

The retry check uses the full content buffer (not the last chunk) so a trailing whitespace-only chunk can't hide the colon. `finish_reason: length` (token-limit truncation) and `content_filter` are deliberately excluded — those need different handling, not a continuation nudge.

### Token Usage Display: The `isApiUsage()` Snake-Case Trap

**Problem:** Token usage (context window bar) never appeared in Copilot Chat despite correctly reporting `LanguageModelDataPart`.

**Root cause:** VS Code's internal `isApiUsage()` type guard (in `extChatEndpoint.ts`) validates the JSON payload using **snake_case** keys: `prompt_tokens`, `completion_tokens`, `total_tokens`. If the payload uses camelCase (`promptTokens`, `completionTokens`, `totalTokens`), the guard silently rejects it and the usage is discarded.

**The fix (3 parts):**

1. **Request `stream_options: { include_usage: true }`** in the vLLM body — otherwise the server doesn't emit a trailing usage chunk at all.

2. **Handle usage-only SSE chunks** — the final chunk has `choices: []` (empty array), so the SSE parser must check for `parsed.usage` before skipping chunks with no choices:
   ```typescript
   if (!choice) {
     if (parsed.usage) {
       yield { content: '', toolCallDeltas: [], finishedToolCalls: [], usage: parsed.usage };
     }
     continue;
   }
   ```

3. **Report usage with snake_case keys** — the `LanguageModelDataPart` payload must match VS Code's expectation exactly:
   ```typescript
   const usageData = {
     prompt_tokens: usage.prompt_tokens,
     completion_tokens: usage.completion_tokens,
     total_tokens: usage.total_tokens,
     prompt_tokens_details: { cached_tokens: 0 },
   };
   const usageBytes = new TextEncoder().encode(JSON.stringify(usageData));
   progress.report(new vscode.LanguageModelDataPart(usageBytes, 'usage'));
   ```

**Why this was hard to debug:** The `isApiUsage()` check is in VS Code's compiled Copilot extension code, not documented anywhere, and fails silently — no error in the console, no warning in the output channel. The usage data was simply swallowed.

### `LanguageModelDataPart.json()` MIME Type Trap

**Problem:** Token counts appeared in our `[TOKENS]` output-channel log but never showed in the Copilot Chat token window. The code looked correct.

**Root cause:** Using `LanguageModelDataPart.json(data, 'application/json')` instead of `new LanguageModelDataPart(bytes, 'usage')`. The `.json()` factory sets the MIME type to `'application/json'`, which VS Code's `isApiUsage()` guard silently rejects. Only the `'usage'` MIME type is recognized.

**Fix:** Always use `new TextEncoder().encode(JSON.stringify(data))` + `'usage'` MIME type.

**Lesson:** Never use the `.json()` factory for usage data — it produces the wrong MIME type. This is likely a VS Code API design oversight; `.json()` is meant for structured data parts, not usage reporting.

---

### `configurationSchema`: Model Picker Settings (Thinking Effort)

**⚠️ UNDOCUMENTED API** — `configurationSchema` is not declared in `@types/vscode`, `vscode.proposed.chatProvider.d.ts`, or any public VS Code documentation. It was discovered by reverse-engineering VS Code's compiled extension host. It works reliably as of VS Code 1.120+ but could break in any future release without deprecation notice. The same applies to `options.modelConfiguration` on the request side.

**Status:** Implemented. Runtime undocumented API — not in `@types/vscode` or proposed API declarations, but actively read by VS Code at runtime.

**Discovery:** Found by grepping VS Code's compiled extension host (`extensionHostProcess.js`) and the Copilot extension (`copilot/dist/extension.js`). The Local Model Provider extension (krevas) does NOT use it.

**How it works (from VS Code source):**

1. **Provider returns schema on model info:**
   ```typescript
   {
     id: 'model-id',
     name: '...',
     configurationSchema: {
       properties: {
         reasoningEffort: {
           type: 'string',
           title: 'Thinking Effort',
           enum: ['low', 'medium', 'high'],
           enumItemLabels: ['Low', 'Medium', 'High'],
           enumDescriptions: ['...', '...', '...'],
           default: 'medium',
         }
       }
     }
   }
   ```

2. **VS Code reads `configurationSchema.properties`** — any property with an `enum` array of 2+ values becomes a clickable action in the model picker gear menu.

3. **User selection is persisted** in VS Code's `_modelConfigurations` store (per model ID).

4. **On request, VS Code passes the resolved config** as `options.modelConfiguration`:
   ```typescript
   // In extensionHostProcess.js (minified):
   h = l.provider.provideLanguageModelChatResponse(a.info, o.value.map(hT.to), {
     ...r,
     modelOptions: r.modelOptions ?? {},
     modelConfiguration: r.configuration,  // <-- our schema values land here
     ...
   }, g, s)
   ```

5. **Default resolution:** VS Code auto-merges defaults from `configurationSchema.properties[key].default` with user overrides:
   ```typescript
   // _resolveModelConfigurationWithDefaults:
   if (o?.properties)
     for (let [s, a] of Object.entries(o.properties))
       a.default !== void 0 && (r[s] = a.default);
   return { ...r, ...userOverrides };
   ```

**Schema property format (JSON Schema + VS Code extensions):**

| Field | Type | Purpose |
|-------|------|---------|
| `type` | `"string"` / `"number"` | Value type |
| `title` | `string` | Display label in model picker |
| `enum` | `any[]` | Allowed values (must have 2+ for UI to show) |
| `enumItemLabels` | `string[]` | Human-readable labels for each enum value |
| `enumDescriptions` | `string[]` | Tooltip/description for each enum value |
| `default` | `any` | Default value (used if user hasn't configured) |
| `group` | `string` | UI grouping — `"navigation"` = main model picker dropdown; `"tokens"` = context size panel; omit = gear icon panel |
| `defaultSnippets` | `array` | Used for settings.json snippet generation |

**`group` values (discovered from VS Code source):**

| Value | Where it appears | Example |
|-------|-----------------|---------|
| `"navigation"` | Main model picker dropdown, next to model name | Thinking mode selector |
| `"tokens"` | Context size panel in model picker | `contextSize` on Claude Sonnet |
| *(omitted)* | "Configure..." gear icon panel | Less prominent settings |

**How Copilot uses it for their models:**
- `reasoningEffort` — `enum: ['low', 'medium', 'high']` (or `['none', 'minimal', 'low', 'medium', 'high', 'xhigh']` for some models), `group: "navigation"`
- `contextSize` — `type: 'number'`, `enum: [128000, 1000000]` with `group: "tokens"` for context window selection

**Copilot's naming is misleading:** The property name `reasoningEffort` implies this is only for thinking/reasoning models. It is not. The `configurationSchema` + `modelConfiguration` mechanism is a **general-purpose parameter preset selector**. The enum values are arbitrary strings — Copilot just happens to use "low/medium/high" for their thinking models. We use it for any model, thinking or not.

**Our implementation:**
- Users define `modelModes` in `vllm-copilot.models` — custom parameter presets for each model
- **Auto-Configure** (invoked from the **Add vLLM Server & Model** command) auto-detects thinking-related modes from HuggingFace's chat template (`enable_thinking` / `preserve_thinking`) as a convenience, but `modelModes` is **not limited to thinking**
- We return `configurationSchema` with a `reasoningEffort` property whose enum values are the user's `modelModes` keys, `group: "navigation"`
- **Important:** The `reasoningEffort` property name is what Copilot expects in the schema, but the *values* and *parameters* are completely user-defined. This is a general-purpose parameter preset mechanism — not limited to thinking/reasoning. Any inference parameter (temperature, top_p, chat_template_kwargs, etc.) can be configured per mode.
- Even models with zero thinking capability benefit from model modes — e.g., "Creative" (high temperature, low top_p) vs "Precise" (low temperature, high top_p), or "Fast" vs "Thorough"
- On request, we read `options.modelConfiguration.reasoningEffort` and spread the selected mode's parameters into the vLLM request body
- The title shown in the model picker is "Model Mode" (not "Thinking Effort") to reflect the broader capability

**Context size (not implemented, but possible):**
- Claude Sonnet 4.6 exposes `contextSize` as a number enum with `group: "tokens"`
- To implement: add `contextSize` property to `configurationSchema.properties` with enum of token counts
- On request, read `options.modelConfiguration.contextSize` and use it to adjust `maxInputTokens`/`maxOutputTokens`
- Caveat: vLLM's `max_model_len` is fixed at server startup; changing context size would require re-loading the model

**Caveats:**
- This is NOT a public VS Code API — it could change without notice
- The property name `configurationSchema` must be exact (VS Code checks `configurationSchema?.properties`)
- If the schema has no properties with enum of 2+ values, `getModelConfigurationActions()` returns `[]` and nothing shows in UI
- The `modelConfiguration` property on `options` is also not in `@types/vscode` — must be accessed via `(options as any).modelConfiguration`

### `provideTokenCount`: Cold-Start Latency from `context.secrets.get()`

**Problem:** First prompt after VS Code restart took ~20 seconds. Subsequent prompts were instant.

**Root cause (historical — pre-migration):** VS Code calls `provideTokenCount` **100+ times** before sending a request — once per message and once per available tool schema. With an empty token count cache, every call executed `await getConfig()`, which (under the legacy global-server layout) did `await context.secrets.get('vllm-copilot.apiKey')` — async disk I/O to VS Code's credential storage. This resulted in 100+ sequential disk reads. The current per-model `getConfig()` (in `src/config.ts`) no longer touches `context.secrets` — that read lives only in `src/migration.ts` for the one-time legacy migration.

**The fix:** Cache `estimateCharsPerToken` on the first call. Subsequent calls skip the async `getConfig()` entirely:

```typescript
// Warm up tokenizer config on first call (async — only done once).
if (this.cachedEstimateCharsPerToken === null) {
  const cfg = await getConfig(this.context);
  this.cachedEstimateCharsPerToken = cfg.estimateCharsPerToken;
}
```

Cache is invalidated in `clearCache()` so settings changes are respected.

**Why this was hard to debug:** The slowdown only appeared on cold VS Code startup. F5 debugging showed instant responses because the extension host was already warm. The disk I/O bottleneck was invisible without tracing `getConfig()` calls.

### `provideTokenCount`: Estimate vs. Authoritative Usage

**Key architectural insight (verified 2026-07-11):** `provideTokenCount` returns a *character-based estimate* (`Math.ceil(prompt.length /_charsPerToken)`, default 3.5), NOT the real token count. This is intentional and structurally forced — not a bug.

**What the estimate is used for:** Copilot calls `provideTokenCount` 100+ times per turn (once per message, once per available tool schema, etc.) as a *preflight* check — "do all these things still fit in `maxInputTokens`?" Any blocking network call here stalls that preflight loop; the request never leaves Copilot until every call returns.

**Why `/v1/tokenize` is the wrong fix:** vLLM has a `/v1/tokenize` endpoint that returns the exact count, but calling it per-token-count call (100+ per turn) would serialize 100+ network round-trips into Copilot's preflight loop. Per-model WASM tokenizers are equally unsuitable (multi-hundred-MB binaries per model family). Character estimation is the only practical shape for this API.

**The other half — what IS exact:** Once the actual request fires, vLLM returns authoritative usage in the final SSE chunk (`stream_options: { include_usage: true }`). We already parse and report it back to Copilot as a `LanguageModelDataPart` (see [Token Usage Display](#token-usage-display-the-isapiusage-snake-case-trap) above). So:

| When | What Copilot knows | Source |
|---|---|---|
| During preflight (per tool, per message, per history item) | Approximate | `provideTokenCount` (char/3.5) |
| After request completion | **Exact** | vLLM `usage` → `reportTokenUsage` |

**What this means in practice:** Copilot's view of *what just ran* is exact (vLLM told it). Only its *preview* of the upcoming request is approximate. When the estimate is wrong (CJK / very code-heavy prompts, ±30%), the failure mode is premature or late compaction — not incorrect token accounting. Copilot auto-compacts on overflow; vLLM enforces `max_model_len` server-side either way.

**Testing findings:** Our `len/3.5` token estimate produces estimates that closely match vLLM's authoritative `prompt_tokens` count for English / mixed content — see also the note under [`preserve_thinking`](#preservethinking-context-window-accumulation).

---

### `preserve_thinking`: Context Window Accumulation

Qwen3.6's `preserve_thinking` option (enabled via `chat_template_kwargs`) is a chat template parameter, not a VS Code feature. When `preserve_thinking: true`, the model's chat template **retains `<think>`/`</think>` blocks from historical assistant messages** in the prompt instead of stripping them.

- **Without `preserve_thinking`** — thinking blocks are stripped from history; context stays small; model re-thinks every turn
- **With `preserve_thinking`** — thinking blocks accumulate in conversation history; each turn's `prompt_tokens` grows

**What vLLM reports:** The `usage` object at end of stream (via `stream_options: { include_usage: true }`) contains authoritative counts:

```json
{
  "prompt_tokens": 8500,
  "completion_tokens": 3200,
  "total_tokens": 11700
}
```

`prompt_tokens` includes everything the model processed — system prompt, tool schemas, all conversation history, and accumulated thinking blocks.

**vLLM's `completion_tokens_details`:** On vLLM 0.21, the usage object is flat — no `reasoning_tokens` breakdown in the `/v1/chat/completions` endpoint. Thinking tokens are mixed into `completion_tokens`. The `/v1/responses` endpoint (newer API) does populate `completion_tokens_details.reasoning_tokens`, but that would require a major rewrite to adopt.

**Implication:** VS Code has no visibility into thinking token accumulation. The extension's `maxInputTokens` budget doesn't account for it specifically. The model card says this is intentional — "maintaining full reasoning context can enhance decision consistency and reduce overall token consumption by minimizing redundant reasoning."

**Our implementation:** We log authoritative token counts to the vLLM-Copilot output channel after each request:
```
[TOKENS] model-id  input: 8500 (cached: 0)  output: 3200 (thinking: 0)  total: 11700
```
This lets users watch context growth across turns when `preserve_thinking` is active. The `thinking` field will auto-populate if vLLM adds `reasoning_tokens` to the chat completions endpoint in a future version.

**Recommended:** For agent scenarios (multi-turn, tool calling), `preserve_thinking: true` is beneficial per the model card. For simple chat, it may cause progressive slowdown as context grows. Users can toggle between "Think" and "No Think" modes.

**Testing findings:** Our `len/3.5` token estimate produces estimates that closely match vLLM's authoritative `prompt_tokens` count, confirming our token counting is accurate.

---

### Empty Chat Response: The "No Response Was Returned" Trap

**Problem:** When the model returns an empty response with `finish_reason: stop` (normal after a tool result — the model received the tool output and has nothing further to say), VS Code shows "Sorry, no response was returned" to the user. The output channel logs are correct (`[INFO] model is done`), but the chat UI shows a scary error banner.

**Root cause:** VS Code's chat layer considers a response "missing" if **zero** `progress.report()` calls are made during the response lifetime. When a model returns empty + stop (after a tool result, user stop, or graceful termination), we were returning from `provideLanguageModelChatResponse` without ever calling `progress.report()`.

**Why this happens:**

| Scenario | What the model does | finish_reason | Why empty |
|----------|---------------------|---------------|-----------|
| Tool result acknowledged | Model receives tool output, decides no further action needed | `stop` | Normal completion with nothing to add |
| User clicks stop | Connection reset by VS Code | `terminated` (or none) | User cancelled mid-generation |
| Graceful termination | VS Code closes fetch internally (e.g., after file reads) | `terminated` + `ECONNRESET` | Internal stop, no content needed |

**The fix:** Report a minimal text part (`'\n'`) so VS Code registers the response as "produced":

```typescript
// In isEmptyStopAfterTool and isGracefulTermination paths:
if (!hadContent && !hadToolCalls) {
  progress.report(new vscode.LanguageModelTextPart('\n'));
}
```

**Why a newline and not a message:**
- The model genuinely produced nothing — a message like "Model is done" would be misleading (it implies *we* said something)
- A newline is invisible in the chat UI but satisfies VS Code's "at least one part" requirement
- The output channel still logs the full INFO message for debugging

**Key insight:** VS Code's chat layer has a binary check: did `progress.report()` fire at least once? If no, show "no response" error. If yes, render what was reported (even if empty). This is not documented anywhere and was discovered through user reports of "empty response error" when everything else was working correctly.
