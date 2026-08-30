# vLLM-Copilot Manual

The detailed guide to vLLM-Copilot. The [README](../README.md) is the quick pitch; this is the full explainer for anyone who wants to understand how the extension actually works. Everything under `docs/` lives in the repository and is not shipped inside the extension package.

---

## Table of contents

1. [Getting started](#getting-started)
2. [Core concepts](#core-concepts)
3. [Servers & backends](#servers--backends)
4. [Configuration](#configuration)
5. [Model modes](#model-modes)
6. [Observability & cost](#observability--cost)
7. [Personalities & system prompts](#personalities--system-prompts)
8. [Reliability & tooling](#reliability--tooling)
9. [Copilot integration](#copilot-integration)
10. [Commands](#commands)
11. [Troubleshooting](#troubleshooting)
12. [Reference index](#reference-index)

---

## Getting started

- **Quick Start** — install, add a server/model, first chat: see the [README Quick Start](../README.md#quick-start).
- **Requirements** — GitHub Copilot Chat (no subscription needed) plus either a running model server or an OpenRouter API key: see [Quick Start](../README.md#quick-start).
- **Remote setups (SSH/WSL/Containers)** — the extension runs on the remote host (`extensionKind: workspace`). Install it while connected to the remote window; a local-first install won't be picked up by the remote automatically. See the note in [Quick Start](../README.md#quick-start).

---

## Core concepts

Three ideas explain most of how the extension is designed.

### 1. Every model entry is self-contained

There is **no global server**. Each entry in `vllm-copilot.models` carries its own `serverUrl`, `requestHeaders` (auth), token budgets, capabilities, and params. A single model entry points at exactly one server; the same physical server can back many entries. Different teams, environments, or credentials stay isolated because nothing is shared between entries.

The only global settings are diagnostics and logging (`vllm-copilot.systemMessageCapture`, `vllm-copilot.enableFileLogging`, `vllm-copilot.logBodyLimit`) and the dashboard poll interval (`vllm-copilot.dashboard.pollIntervalMs`).

### 2. Parameter resolution chain

For any request, parameters merge from lowest to highest priority:

```
server defaults (unset params omitted) → model defaultParams → the selected modelModes entry
```

So a model can define a baseline in `defaultParams` and switch between named presets (modes) on top of it from the model picker.

### 3. The context window is never guessed

Each backend's context window is read from its own documented endpoint (see the [backend table in the Configuration Reference](configuration-reference.md#backend-specific-context-resolution)). `maxInputTokens` is computed as the window minus the **effective output budget** (the resolved `max_tokens`: a selected `modelModes` entry, else `defaultParams.max_tokens`, else `maxOutputTokens`), and can only be clamped further. A model whose backend reports no valid window is refused rather than served with a made-up budget.

---

## Servers & backends

**vLLM is the primary target and gets the full feature set.** The other backends are supported alongside it with the core features.

| Backend | Status | Notes |
|---------|--------|-------|
| **vLLM** | ✅ Primary | Full feature set: vLLM request parameters, per-request server metrics, all dashboard rows, Deep-Dive |
| **llama.cpp** | ✅ Core | OpenAI-compatible `/v1/chat/completions`; context window from `/v1/models` |
| **LM Studio** | ✅ Core | Same as llama.cpp |
| **Ollama** | ✅ Core | Same as llama.cpp; `tool_choice` values are dropped (Ollama's API doesn't support the parameter), tool calling itself works |
| **OpenRouter** | ✅ Managed remote | Fixed endpoint `https://openrouter.ai/api`; model picked from the ~415-model catalog |

The backend is auto-detected when you add a server and in Model Settings; it can also be set explicitly per model via `serverType` (`vllm` \| `lmstudio` \| `llamacpp` \| `ollama` \| `openrouter`).

### What every backend gets

Native Copilot integration (chat, tools, vision, streaming), model modes, output length picker, personality presets, hidden-system-prompt capture & replace, per-server auth/sampling/token budget, auto-continue on empty responses, token usage & cost tracking, and Test & Refresh / Connection Diagnostics.

### What is vLLM-only

vLLM-specific request parameters (structured outputs, `chat_template_kwargs`, token budgets, and more), per-request server metrics (TTFT/TPOT, KV cache, speculative decoding), and the Deep-Dive webview. Other backends show client-measured throughput instead, and the dashboard shows only the rows each backend actually reports.

### OpenRouter

A managed remote: add one fixed endpoint, pick from ~415 cloud models, pay per use (many have free routes). The Add flow detects any `openrouter.ai` URL and routes into the OpenRouter branch. Each model can pin a provider slug and a routing mode. Full guide, including the URL table, manual config JSON, and attribution headers: **[Using OpenRouter](openrouter.md)**. Architecture notes: [openrouter-integration.md](openrouter-integration.md).

---

## Configuration

All settings live under `vllm-copilot` in VS Code Settings (`Ctrl+,` → search `vllm`). The top-level settings are:

| Setting | Purpose |
|---------|---------|
| `vllm-copilot.models` | The array of per-model entries (server, auth, params, modes, cost). |
| `vllm-copilot.systemMessageCapture` | Capture unique Copilot system messages to `.vllm/system-messages.json` (for building replacements). |
| `vllm-copilot.enableFileLogging` | Write request/response logs to a daily file (see **Open Log File**). |
| `vllm-copilot.logBodyLimit` | Maximum characters of request/response bodies to log per entry. `0` = no truncation. |
| `vllm-copilot.dashboard.pollIntervalMs` | Dashboard metrics polling interval (default 15000 ms). |

Everything else lives on each model entry. The important fields:

- **`serverUrl`** — required. The server hosting this model.
- **`requestHeaders`** — HTTP headers for auth/routing. Isolated per server.
- **`id`** / **`vllmModelId`** — entry key vs. actual model ID on the server (allows aliases).
- **`maxOutputTokens`** / **`maxInputTokens`** — output cap and the computed input budget.
- **`defaultParams`** — model-wide baseline request params (snake_case vLLM body keys).
- **`modelModes`** / **`defaultMode`** — switchable named presets, and which one starts active.
- **`maxOutputTokens`** — max response tokens. As an **array**, an ordered list of token counts shown as a second model-picker dropdown ("Output Length"), independent of modes: the first entry is the default and the desired budget; when the dropdown is present the user's pick overrides `max_tokens`.
- **`capabilities`** — `toolCalling` (default true) and `imageInput` (vision, default false).
- **`autoContinueRetries`** — retries for empty/truncated responses (default 1).
- **`systemMessageReplacementsFile`** — path to a find/replace JSON file for system messages.
- **`cost`** — per-model cost rates for the usage tracker (per 1M tokens).

Full reference with every field, defaults, and the complete parameter table: **[Configuration Reference](configuration-reference.md)**.

### Quick minimal config

The **Add vLLM Server & Model** command generates this automatically. A minimal hand-written entry looks like:

```json
"vllm-copilot.models": [
  {
    "id": "Qwen/Qwen3.6-27B-FP8 on localhost:8000",
    "vllmModelId": "Qwen/Qwen3.6-27B-FP8",
    "serverUrl": "http://localhost:8000"
  }
]
```

> It auto-detects `family`, `max_model_len`, capabilities, and applies bundled presets.

### vLLM-specific request controls

These are sent as vLLM request-body parameters (configured in `defaultParams` or `modelModes`) and are not exposed by the BYOK Custom Endpoint: `top_k`, `min_p`, `repetition_penalty`, `length_penalty`, `spaces_between_special_tokens`, `structured_outputs`, `bad_words`, `repetition_detection`, `chat_template_kwargs`, `thinking_token_budget`, `stop_token_ids`, `ignore_eos`, `min_tokens`, `truncate_prompt_tokens`, `skip_special_tokens`, `include_stop_str_in_output`, `allowed_token_ids`. Each is described in the [README](../README.md#vllm-request-controls) and the [Configuration Reference](configuration-reference.md).

---

## Model modes

Model modes are **named configurations** for a model that you switch between from the Copilot model picker, like profiles for different tasks: one for deep reasoning, one for precise code, one for creative work. Each mode is a set of parameters merged into the vLLM request on top of `defaultParams`.

```json
"modelModes": {
  "Think": {
    "chat_template_kwargs": { "enable_thinking": true, "preserve_thinking": true },
    "temperature": 1.0, "top_p": 0.95
  },
  "No Think": {
    "chat_template_kwargs": { "enable_thinking": false },
    "temperature": 0.7, "top_p": 0.8
  },
  "Precise": { "temperature": 0.1, "top_p": 0.1, "top_k": 20 }
}
```

The **Add vLLM Server & Model** command auto-generates modes from bundled presets (`model-configs/`) or HuggingFace data. Model-specific recommendations (e.g. Qwen sampling parameters): **[Model Modes & inference parameters](modelmodes.md)**.

Output **length** is deliberately not a mode knob. Models and presets whose `maxOutputTokens` is an **array** get a second, independent **"Output Length"** dropdown next to the mode picker; the user's pick overrides any `max_tokens` set in modes or `defaultParams` (always clamped to the model's ceiling). The pick is also what the extension **advertises** to Copilot as the output budget — and since Copilot derives the prompt budget as (context − output), **a shorter pick hands the freed tokens to your prompt**: more headroom for long conversations when you don't need a 64K answer. A **shorter** pick lands on the very next response's `max_tokens` instantly; a **longer** pick lands once Copilot's context display re-resolves on the first request after the change (the extension re-publishes model metadata then — the same mechanism, and the same one-request lag, mode switches use). The wire never exceeds the advertised output budget: Copilot sizes the prompt against it, so promising more could overflow the context window (or hard-fail on providers that validate it). If you pinned `maxInputTokens` explicitly, you own the split and the trade-off does not apply. Modes describe behavior — thinking depth, sampling — not response size.

Right after an update or after giving a model its first menu, VS Code's settings dropdown can lag and show only the mode section — a known VS Code snapshot quirk ([microsoft/vscode#333413](https://github.com/microsoft/vscode/issues/333413); the model list hover already shows an **Output Length** chip when the menu is live). If the section is missing: open the model list once and click the **Output Length** chip on the model; the menu opens from there and the settings dropdown heals immediately.

---

## Observability & cost

### Server Dashboard

A native Tree View sidebar (no webviews, no extra ports) with live metrics per configured server: queue status (running/waiting/idle), expandable metrics (context window, vLLM version, KV cache usage and hit rate, TTFT, output and prefill speed), MTP/speculative decoding stats, and Last Request Details (token counts, TTFT, queue time, generation time, throughput — updated immediately after every prompt, not on the poll interval). Open it with the **V** icon in the activity bar (left sidebar). Command alternative: **View → vLLM-Copilot → Dashboard**.

### Server Deep-Dive

A vLLM-only webview with the full server metric set: histogram breakdowns (TTFT/TPOT/token counts) with hoverable bars and the raw metric dump. Right-click a vLLM server node → **vLLM Deep-Dive**.

### Token usage & cost

After every request, the Output channel shows exact token counts (input/output, cached tokens with prefix-cache hit %, cache creation tokens, throughput, TTFT, speculative decoding stats). The dashboard adds a **model-first** usage tracker under each server: one entry per model, price on the collapsed line, expanding to **Today** and **Overall** token rows. Key semantics:

- Input is split so cache-read tokens are never double-counted; totals are always prompt + completion.
- Sub-cent costs keep fine precision (a $0.0007 request shows `$0.0007`, not `$0.00`).
- OpenRouter models prefer their actual reported cost (`usage.cost`) and never sum it with configured rates.
- **Reset Usage** is a right-click action on the node.

Full design (data model, persistence, retention, summation semantics): **[Token & Cost Usage Tracker](usage.md)**.

---

## Personalities & system prompts

### Personality presets

Personalities replace Copilot's ~21KB system-prompt boilerplate with something useful, per model, no JSON editing. Pick one from Model Settings or via **Set Model Personality**; **Default (no personality)** restores the original prompt. The choice is copied to the extension's global storage, so it follows you across workspaces and survives upgrades.

The bundled presets are: **Raw (Model Natural)** (strips the boilerplate, no persona), **Supportive Mentor**, **Critical Senior Dev**, **Sarcastic Robot**, and **Spartan** (minimalist, saves tokens). Each is described in the [README](../README.md#personalities--system-prompts).

Bundled presets are extension-owned and re-synced on every apply, so edits to a bundled preset get clobbered. Custom behavior belongs in your own replacement file or a user-created personality. Details: **[Custom System Prompt / Personality Presets](custom-system-prompt.md)**.

### Hidden system instructions (capture & replace)

Copilot injects hidden instructions into every request (~21KB of safety rules and identity instructions). To see and modify them:

1. Set `vllm-copilot.systemMessageCapture: true`.
2. Unique system messages are written to `.vllm/system-messages.json`.
3. Write a JSON file of find/replace rules (`{ ruleName, find, replace }`).
4. Point `systemMessageReplacementsFile` at it on the model entry.

Replacements are exact substring matches, applied sequentially to every system message before it reaches vLLM. Matched rules are logged in the capture file. The prompt-building architecture behind this: [copilot-integration.md](copilot-integration.md).

### Workspace custom instructions

The extension merges `.github/copilot-instructions.md`, `AGENTS.md`, and `CLAUDE.md` into the system message, the same way VS Code handles workspace-level custom instructions.

---

## Reliability & tooling

- **Auto-continue on empty responses.** Some models (notably Qwen) occasionally return zero tokens or truncated output. The extension retries with an assistant prefill so you never see a blank or cut-off response. Configurable per model (`autoContinueRetries`, default 1). Details: [auto-continue.md](auto-continue.md).
- **Tool call & truncated response recovery.** When vLLM truncates a tool call mid-JSON (`finish_reason: 'length'`), the extension uses `jsonrepair` + `best-effort-json-parser` (the same libraries Copilot's BYOK uses) to recover partial content instead of dropping it to empty `{}`.
- **Connection diagnostics.** **Test & Refresh Models** verifies servers, lists models, corrects ID mismatches, and checks VS Code network gating. **Diagnose Connection** is a deep report comparing SChannel vs. OpenSSL, DNS/TCP reachability, cert chain inspection, proxy detection, and a VS Code settings dump, with a one-line classification of the failure.
- **One-click migration.** Upgrading from an older version auto-migrates legacy global server/sampling settings into per-model entries on first launch. One-time, idempotent, no data loss.
- **Chat session cleanup.** The **Clean Copilot Sessions** command lets you pick which workspaces to wipe when sessions grow stale.

---

## Copilot integration

vLLM-Copilot implements the VS Code **Language Model Chat Provider** interface. Copilot routes chat requests to the provider, which sends them to the model's server via the OpenAI-compatible wire protocol (chat completions with SSE streaming), then streams the response back into Copilot. Tool calls, vision, subagent capabilities, and thinking modes are surfaced through the provider's model metadata.

- The **Configure Utility Model** command switches which model backs MCP servers (`mainAgent` / `copilot` / `none`).
- Model modes and personalities are switched from the Copilot model picker and the extension's own sidebar UI.

Deep dive into how the extension plugs into Copilot, sessions, and tool calls: [copilot-integration.md](copilot-integration.md).

---

## Commands

| Command | What it does |
|---------|--------------|
| **Add vLLM Server & Model** | Guided flow: enter server URL → discover models → auto-configure → save. An `openrouter.ai` URL routes into the OpenRouter flow. |
| **Test & Refresh Models** | Verify servers, list models, correct ID mismatches, check network settings. |
| **Set Model Personality** | Pick a model, pick a personality preset (or **Default** to clear). |
| **Configure Utility Model** | Switch utility model for MCP servers (`mainAgent` / `copilot` / `none`). |
| **Update Auth** | Rotate API key or change auth headers for a server (right-click on server node). |
| **vLLM Deep-Dive** | Open the per-server metrics webview (right-click a vLLM server node). |
| **Remove Model** | Remove a single configured model (button in Model Settings). |
| **Remove Server** | Remove a configured server and all its models (command palette, with confirm). |
| **Open Log File** | Open today's debug log. |
| **Clear Log Files** | Delete all debug logs except the active one. |
| **Diagnose Connection** | Deep TLS/proxy/DNS/cert diagnostic report (utilities). |
| **Clean Copilot Sessions** | Wipe stale Copilot sessions across workspaces (utilities). |

---

## Troubleshooting

- TLS / proxy / corporate network issues: run **Diagnose Connection**.
- Stalled requests: check `initialResponseTimeoutMs` (the model may still be loading or the queue backed up) and `streamInactivityTimeout`.
- Free OpenRouter routes that feel dead are rate-limited, not broken.
- Diagnostics settings and the troubleshooting guide: **[Configuration Reference → Diagnostics & Troubleshooting](configuration-reference.md)**.
- Known limitations are listed at the end of the [Configuration Reference](configuration-reference.md).

---

## Reference index

| Doc | Covers |
|-----|--------|
| [Configuration Reference](configuration-reference.md) | Every model entry field, defaults, full parameter table, JSON syntax, troubleshooting, known limitations. |
| [Model Modes](modelmodes.md) | Inference parameter recommendations and model-mode usage. |
| [Token & Cost Usage Tracker](usage.md) | Usage/cost data model, persistence, retention, reset behavior. |
| [Using OpenRouter](openrouter.md) | OpenRouter setup, URL table, manual config, attribution headers. |
| [Custom System Prompt / Personality Presets](custom-system-prompt.md) | System-prompt capture & replace pipeline. |
| [Auto-Continue](auto-continue.md) | Empty/truncated response retry — how it works, config, and known limitations. |
| [Agents window](agents-window.md) | Using vLLM models in the VS Code "Open in Agents" window (Agent Host BYOK). |
| [Copilot integration](copilot-integration.md) | How the extension plugs into Copilot, sessions, tool calls. |

**Maintainer-only docs:** [OpenRouter architecture](openrouter-integration.md) · [Third-party compatibility plan](thirdparty-compatibility-plan.md) · [SGLang compat plan](sglang-compat-plan.md) · [Feature ideas](feature-ideas.md) · [Code review](code-review.md).
