# Custom System Prompt Override

**Status:** Implemented (v0.17.0) — capture + replacement pipeline is unified and position-preserving
**Related:** [feature-ideas.md](./feature-ideas.md) — "Custom System Prompt Override" entry
**Research:** VS Code Copilot source code analysis, 2026-07-14

---

## Problem

Copilot injects hidden boilerplate into every system message that the user cannot see, edit, or opt out of. This includes:

1. **Model-specific instructions** — ~21KB of agent behavior rules
2. **Reusable building blocks** — `<SafetyRules />`, `<CopilotIdentityRules />`, etc.
3. **Per-request variations** — model name, date, operating system, tools available

**The user cannot see or edit the Copilot boilerplate.** It's injected by VS Code and hidden. This feature gives them visibility and granular control.

---

## How VS Code Builds System Messages

### Architecture

Copilot uses a JSX-like prompt-tsx system where prompts are composed of reusable components. Every system message is a composition of:

```
<SystemMessage priority={1000}>
    [UNIQUE FIRST LINE - identifies prompt type]
    <CopilotIdentityRules />     ← reusable block
    <SafetyRules />              ← reusable block
</SystemMessage>

<InstructionMessage priority={900}>
    <EditorIntegrationRules />   ← reusable block
    <ResponseTranslationRules /> ← reusable block
    [prompt-specific additional rules]
</InstructionMessage>
```

### Reusable Building Blocks (Single Source of Truth)

All prompts import these shared components:

| Component | Source File | Content (abbreviated) |
|-----------|-------------|----------------------|
| `<SafetyRules />` | [safetyRules.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/base/safetyRules.tsx) | "Follow Microsoft content policies... harmful, hateful, racist, sexist..." |
| `<LegacySafetyRules />` | [safetyRules.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/base/safetyRules.tsx) | Same as above + "or completely irrelevant to software engineering" |
| `<Gpt5SafetyRule />` | [safetyRules.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/base/safetyRules.tsx) | Same as SafetyRules but without "Keep your answers short" |
| `<CopilotIdentityRules />` | [copilotIdentity.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/base/copilotIdentity.tsx) | "When asked for your name, you must respond with 'GitHub Copilot'. When asked about the model you are using, you must state that you are using {model_name}." |
| `<GPT5CopilotIdentityRule />` | [copilotIdentity.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/base/copilotIdentity.tsx) | "Your name is GitHub Copilot. When asked about the model you are using, state that you are using {model_name}." |
| `<Gpt55CopilotIdentityRule />` | [copilotIdentity.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/base/copilotIdentity.tsx) | "Your name is GitHub Copilot. When asked about the model you are using, state 'I am GitHub Copilot'." |
| `<EditorIntegrationRules />` | [editorIntegrationRules.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/panel/editorIntegrationRules.tsx) | "Use Markdown formatting... include programming language name... Avoid wrapping in triple backticks..." |
| `<ResponseTranslationRules />` | [responseTranslationRules.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/base/responseTranslationRules.tsx) | Language/translation handling rules |
| `<PatchEditRules />` | [patchEditGeneration.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/codeMapper/patchEditGeneration.tsx) | Code edit/patch formatting rules |
| `<ResponseRenderingRules />` | [editorIntegrationRules.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/panel/editorIntegrationRules.tsx) | Math integration, Mermaid integration |

### Dynamic Values

Only `CopilotIdentityRules` injects dynamic content:
- **`{this.promptEndpoint.name}`** — The model name (e.g., "MiX: Qwen3.6-27B", "GPT-5", "Claude Sonnet 4")

All other blocks are static text.

### Source Code URLs

All prompt files live in:
- **Base directory:** `extensions/copilot/src/extension/prompts/node/`
- **Base components:** [prompts/node/base/](https://github.com/microsoft/vscode/tree/main/extensions/copilot/src/extension/prompts/node/base)
- **Main agent prompt:** [agentPrompt.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/agent/agentPrompt.tsx)
- **Panel prompts:** [panel/](https://github.com/microsoft/vscode/tree/main/extensions/copilot/src/extension/prompts/node/panel)
- **Inline chat prompts:** [inline/](https://github.com/microsoft/vscode/tree/main/extensions/copilot/src/extension/prompts/node/inline)

---

## System Message Types We've Observed

From system message capture (`systemMessageCapture` setting), these message types route through our extension:

| Type | First Line (fingerprint) | Size |
|------|-------------------------|------|
| **Main chat agent** | "You are an expert AI programming assistant, working with a user in the VS Code editor." | ~22KB |
| **Progress - generate** | "You are an expert in writing short, catchy, and encouraging progress messages for a coding assistant." | ~1KB |
| **Progress - edit** | Same as above (different scenario description) | ~1KB |
| **Title generation** | "You are an expert in crafting ultra-compact titles for chatbot conversations." | ~1KB |

Many more types exist in the VS Code source (search, terminal, git, debugging, etc.) but it's unclear which ones route through our extension vs. internal Microsoft endpoints.

### Other Types Found in Source (May Route Through Extension)

| Type | Source File | First Line (fingerprint) |
|------|-----------|-------------------------|
| Search | [search.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/panel/search.tsx) | "You are a VS Code search expert..." |
| Terminal | [terminal.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/panel/terminal.tsx) | "You are a programmer who specializes in using the command line..." |
| Git Branch | [gitBranch.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/panel/gitBranch.tsx) | "You are an expert in crafting pithy branch names..." |
| Explain | [explain.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/panel/explain.tsx) | "You are a world-class coding tutor..." |
| Inline Chat | [inlineChatEditCodePrompt.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/inline/inlineChatEditCodePrompt.tsx) | "You are an AI programming assistant..." |
| Patch Healing | [applyPatchTool.tsx](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/tools/node/applyPatchTool.tsx) | "You are an expert in file editing..." |

---

## Design Decisions

### 1. Approach: Find/Replace Substrings (Not Full Message Replacement)

**Decision: String replacement within system messages, not full message replacement.**

**Rationale:**
- Reusable blocks appear in **dozens of different prompt types**
- Cannot patch VS Code — must intercept at runtime
- Same boilerplate appears across many message types
- Users want to remove/modify specific blocks (e.g., safety rules), not replace entire messages

**Result:** A list of find/replace pairs applied to every system message before it's sent to vLLM.

### 2. Format: JSON (Not YAML)

**Decision: JSON array of find/replace objects.**

**Rationale:**
- Zero dependencies (no `js-yaml` package needed)
- Already the project pattern (`model-configs/*.json`, `package.json`)
- Schema validation is trivial
- Users won't edit by hand — they'll copy exact strings from `system-messages.json`

```json
[
  {
    "ruleName": "Remove SafetyRules block (common variant)",
    "find": "Follow Microsoft content policies.\nAvoid content that violates copyrights.\nIf you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with \"Sorry, I can't assist with that.\"\nKeep your answers short and impersonal.",
    "replace": ""
  }
]
```

Each entry has an optional `ruleName` field for human-readable identification. The `ruleName` is logged and stored in the capture file so users know exactly which rules matched.

**Trade-off:** Multi-line finds require manual `\n` in the JSON string. Users extract from debug logs where the text is already in this format.

### 3. Scope: Every System Message

**Decision: Apply replacements to ALL system messages, not just the first one.**

**Rationale:**
- Safety rules appear in every message type
- Same boilerplate repeats across progress, title, search, terminal, etc.
- Users want consistent behavior across all Copilot features

**Result:** Every system-role message content is scanned and modified before being sent to vLLM.

### 4. Matching: Exact Substring (No Regex)

**Decision: Exact substring match, not regex.**

**Rationale:**
- Simpler, no edge cases with regex escaping
- Users get exact strings from the capture file (`system-messages.json`)
- Exact match is deterministic — no surprise matches

**Trade-off:** Cannot match dynamic content (like model name). For model name, users can match the static prefix: `"you must state that you are using "` and replace the whole line.

### 5. Replacement Order

**Decision: Apply in array order, sequentially.**

Each replacement is applied to the result of the previous one. This allows:
- Remove a line, then insert a replacement at the same position
- Chained transformations if needed

### 6. Configuration Location

**Decision: Per-model, on `ModelConfig`.**

```typescript
interface ModelConfig {
  // ...
  /**
   * Path to a JSON file containing find/replace pairs for system message text.
   * Each pair: { "ruleName": "...", "find": "...", "replace": "..." }
   * Applied to every system message before sending to vLLM.
   * Empty replace string removes the matched text.
   * Recommended: .vllm/prompt-replacements.json
   */
  systemMessageReplacementsFile?: string;
}
```

**Rationale:**
- Different models may need different replacements
- Model-specific identity rules (e.g., GPT vs Claude naming)
- Consistent with existing per-model config pattern

### 7. Multi-Line Support

**Decision: Yes, multi-line finds are supported.**

In JSON, newlines are represented as `\n`. Multi-line finds remove entire blocks in one entry.

**Trade-off:** More fragile if VS Code changes formatting. Single-line replacements are more robust.

### 8. Unified Capture + Replace Pipeline

**Decision: Single function handles both capture and replacement, position-preserving.**

The capture and replacement steps are consolidated into one pipeline (`captureAndReplaceSystemMessages`) that:

1. Iterates the full Copilot message array
2. For each role 3 (system) message — regardless of position:
   - Extracts the original text
   - Captures to `.vllm/system-messages.json` (if capture enabled)
   - Applies configured replacements
   - Places the replaced text back at the **same array index**
3. Non-system messages pass through unchanged

**Position-preserving design:** We don't assume system messages are always at index 0. While current VS Code behavior puts all system messages at the start, neither VS Code nor OpenAI API guarantees this. We iterate the full array and replace each role 3 message in-place.

**Flow:**
```
Copilot message array [msg0, msg1, msg2, ...]
    ↓
┌─ captureAndReplaceSystemMessages()
│   └─ For each message in array:
│       ├─ If role != 3: leave unchanged
│       ├─ If role == 3:
│       │   ├─ Extract receivedContent
│       │   ├─ Apply replacements (if configured) → deliveredContent + rulesApplied
│       │   ├─ Replace text at this index with deliveredContent
│       │   └─ If capture enabled + NEW (dedup by receivedContent):
│       │       └─ Append entry to .vllm/system-messages.json
│   └─ Return modified message array
    ↓
convertMessages() merges all system texts into index 0
    ↓
Send to vLLM
```

**JSON file structure:**
```json
[
  {
    "receivedContent": "You are an expert AI programming assistant...\nFollow Microsoft content policies...",
    "deliveredContent": "You are an expert AI programming assistant...",
    "rulesApplied": [
      "Remove SafetyRules block (common variant)",
      "Remove Copilot identity rule (main variant)"
    ]
  }
]
```

**Rules:**
- File location: `.vllm/system-messages.json` (no `debug/` subfolder)
- Only role 3 (system) messages are captured — role field omitted from JSON
- `receivedContent` — always present (original Copilot text, source of dedup)
- `deliveredContent` — always present when capture is on (equals `receivedContent` if no replacements configured)
- `rulesApplied` — always present when capture is on (empty array if no replacements configured or no rules matched)
- Replacements are applied to every role 3 message on every request (independent of capture)
- Capture to file happens only once per unique message (dedup by `receivedContent`)

### 9. The `.vllm/` Folder Convention

The extension recommends a `.vllm/` directory at the workspace root for project-local vLLM configuration files.

```
.vllm/
├── prompt-replacements.json     # Find/replace pairs for system messages
└── system-messages.json        # Captured system messages (original + after replacement)
```

---

## Implementation Status

### ✅ Done (v0.17.0)
- `src/promptReplacer.ts` — load + apply replacements, exact substring match, `ApplyResult` with `matchedRuleNames`
- `src/config.ts` — `systemMessageReplacementsFile` on `ModelConfig`
- `package.json` — schema for `systemMessageReplacementsFile`
- `docs/default-prompt-replacements.json` — example file with SafetyRules + identity rules
- `docs/prompt-replacements-*.json` — personality presets (Tough Love, Critical Partner, Sarcastic Genius, Senior Dev, Spartan)
- `src/provider.ts` — `captureAndReplaceSystemMessages()` unified pipeline (capture + replace in one pass)
- `src/messageConverter.ts` — simplified, no replacement logic (pure conversion only)
- In-place mutation of role-3 message content so `convertMessages()` sees processed text naturally
- Capture file at `.vllm/system-messages.json` with `receivedContent` / `deliveredContent` / `rulesApplied`

### ⏳ Pending
1. **Unit tests** — tests for `applyPromptReplacements` (promptReplacer.ts) and the consolidated pipeline

---

## Key Principle

**We receive the final compounded system message from Copilot.** All user instruction files (`.github/copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`) are already baked in by Copilot before they reach us. We have no control over how Copilot injects them — we only see the result. Our capture and replacement pipeline operates on these final compounded messages only.