<div align="center">

# vLLM-Copilot

**Run any vLLM model inside GitHub Copilot — with features BYOK can't match.**

Model modes, thinking toggles, structured output, bad words, repetition detection,
personality presets, and system message control. All switchable from the model picker.

</div>

---

## What makes this different from BYOK?

VS Code's built-in Custom Endpoint (BYOK) handles chat, tools, vision, streaming, and a
thinking-effort picker. It also supports a subset of basic inference parameters, such as
`temperature` and `top_p`, configured for a model.

vLLM-Copilot is for users who want the full vLLM request surface and a richer workflow
around it. It lets you define **model modes** — named configurations you switch between
from the model picker. One model can have separate configurations for reasoning, precise
coding, and creative work, including their sampling and vLLM-specific request settings.

| Feature | BYOK | vLLM-Copilot |
|---------|:----:|:--------------:|
| Chat, tools, vision | ✅ | ✅ |
| Multiple servers (per-model endpoint) | ✅ | ✅ |
| Custom request headers (auth tokens) | ✅ | ✅ |
| Thinking-effort picker (enum only) | ✅ | ✅ (as model mode) |
| Arbitrary `chat_template_kwargs` (including `enable_thinking`) | ❌ | ✅ (switchable per model mode) |
| Sampling params (basic: `temperature`, `top_p`) | ✅ (fixed per model) | ✅ (configurable per model and per model mode) |
| Advanced sampling parameters (`top_k`, `min_p`, `repetition_penalty`, `length_penalty`, etc.) | ❌ | ✅ (switchable per model mode) |
| Named model configurations (model modes) | ❌ | ✅ |
| Full per-model configuration (endpoint, headers, capabilities, token budgets, sampling, and modes) | ✅ (partial) | ✅ |
| Personality presets | ❌ | ✅ |
| Hidden System Instructions (capture & replace) | ❌ | ✅ |
| Auto-continue on empty responses | ❌ | ✅ |
| Chat session cleanup across workspaces | ❌ | ✅ |
| Token usage & throughput stats per request | ❌ | ✅ |

### vLLM-specific request controls

These controls are sent as vLLM request-body parameters. Configure them in
`defaultParams` for a model-wide default, or in `modelModes` to make them switchable from
the model picker. They are not exposed by the BYOK Custom Endpoint.

| vLLM capability | What it enables |
|---|---|
| `structured_outputs` | Constrain output to JSON schema, regex, choices, or grammar |
| `bad_words` | Prevent specific words or phrases from being generated |
| `repetition_detection` | Stop runaway N-gram repetition |
| `chat_template_kwargs` | Pass model-specific chat-template options such as `enable_thinking` and `preserve_thinking` |
| `thinking_token_budget` | Set a reasoning-token budget for supported models |
| `stop_token_ids` | Stop generation on specific token IDs |
| `ignore_eos` | Continue generation past the end-of-sequence token |
| `min_tokens` | Require a minimum number of generated tokens |
| `truncate_prompt_tokens` | Cap prompt length server-side |
| `skip_special_tokens` | Control special-token removal in the output |
| `include_stop_str_in_output` | Keep the matched stop string in the output |
| `allowed_token_ids` | Restrict generation to a selected set of token IDs |

---

## Quick Start

**Prerequisites:** A running vLLM server (any OpenAI-compatible endpoint) + GitHub Copilot.

1. **Install** from the VS Code Marketplace
2. **Add a model:** `Ctrl+Shift+P` → **Add vLLM Server & Model** → enter your server URL → pick a model → done. The extension auto-configures everything (model family, thinking modes, context window) from bundled presets or HuggingFace.
3. **Change the personality (optional):** `Ctrl+Shift+P` → **Set Model Personality** → pick your model → pick a personality → done. Four bundled presets replace Copilot's boilerplate with something actually useful.
4. **Chat:** Open Copilot Chat, pick your model from the dropdown. Switch modes from the same picker.

> **Remote (SSH/WSL/Containers):** This extension runs on the remote host automatically when installed from the Marketplace. VS Code will install it on the remote extension host.

> **Everything is per-model.** There is no global server or global sampling. Each model entry carries its own `serverUrl`, `requestHeaders`, and params. Settings take effect immediately — no reload needed.

---

## Features

### Model Modes — switchable configurations per model

Model modes let you define **named configurations** for a model and switch between them from the Copilot model picker — like having "profiles" for different tasks. Think of them as presets: one for deep reasoning, one for precise code, one for creative brainstorming.

Each mode is a set of parameters merged into the vLLM request. Common use cases:

- **Thinking toggles** — `enable_thinking: true/false` (the extension auto-detects these from HuggingFace)
- **Sampling presets** — different `temperature`/`top_p` combinations for creative vs. precise output
- **Structured output** — JSON schema enforcement for data extraction
- **Anything vLLM supports** — bad words, repetition detection, token budgets

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

> The **Add vLLM Server & Model** command auto-generates modes from bundled presets or HuggingFace data. For existing entries, see the [Configuration Reference](docs/configuration-reference.md).

### Personality Presets

Four bundled personalities that replace Copilot's 21KB system prompt boilerplate with
something actually useful. One command, no JSON editing:

1. **Set Model Personality:** `Ctrl+Shift+P` → pick your model → pick a personality → done

| Preset | What it does |
|--------|--------------|
| **Tough Love** | Direct tutor. Brutally honest feedback to help you grow. Calls out bad patterns, demands better. |
| **Critical Senior Dev** | Sharp collaborator who challenges assumptions and surfaces trade-offs. Helps push the project forward. |
| **Sarcastic Robot** | Brilliant, condescending, politically incorrect. Finds human code amusingly primitive — but fixes it anyway. |
| **Spartan** | Absolute minimalism. Zero fluff. Short answers. Code first, words only when necessary. |

Want to customize? Copy any preset to `.vllm/my-replacements.json`, edit the `replace` fields, point your model at your copy.

### Hidden System Instructions (Capture & Replace)

Copilot injects hidden instructions into every request (~21KB of safety rules, identity instructions). This extension lets you capture and surgically modify them:

1. **Enable capture** — set `vllm-copilot.systemMessageCapture: true` in settings
2. **Inspect** — unique system messages are written to `.vllm/system-messages.json`
3. **Create replacements** — write a JSON file of find/replace rules
4. **Apply** — set `systemMessageReplacementsFile` on your model entry

Replacements are exact substring matches, applied sequentially to every system message before it reaches vLLM. Matched rules are logged in the capture file.

### Server Dashboard

A native Tree View sidebar shows live metrics for each configured vLLM server — no webviews, no extra ports.

- **Per-server metrics:** Models served, context window, KV cache usage & hit rate, TTFT, throughput (tokens/sec), active queue
- **MTP / speculative decoding:** Acceptance rate, draft depth, proposal count (when active)
- **Configurable polling:** Click **Refresh Interval** at the top of the tree to change — enter `15s`, `30s`, `1m`, etc.
- **Status bar indicator:** Color-coded health + KV cache usage in the bottom status bar

Access via **View → vLLM-Copilot → Dashboard** or the sidebar section header.

### Auto-Continue on Empty Responses

Some models (notably Qwen) occasionally return zero tokens or truncated output. The extension automatically retries with an assistant prefill — you never see a blank or cut-off response. Configurable per-model (`autoContinueRetries`, default: 1).

### Token Usage & Performance Stats

After every request, the Output channel shows exact token counts from vLLM:
- Input/output tokens, cached tokens (prefix cache hit %)
- Output throughput (tokens/sec), time-to-first-token
- Speculative decoding stats (accepted/rejected predictions)

### Connection Diagnostics

Corporate proxy? TLS-inspecting gateway? Missing intermediate certs?

- **Test & Refresh Models** — verify all configured servers are reachable, lists loaded models, corrects model ID mismatches, checks VS Code network gating settings
- **Diagnose Connection** — deep diagnostic comparing SChannel (PowerShell) vs. OpenSSL (Node fetch), DNS/TCP reachability, cert chain inspection, proxy detection, VS Code settings dump. One-line classification of the failure.

### Tool Calling & Truncated Response Recovery

When vLLM truncates a tool call mid-JSON (`finish_reason: 'length'`), the extension uses
`jsonrepair` + `best-effort-json-parser` (the same library Copilot's BYOK uses) to recover
partial content instead of silently dropping it to empty `{}`.

### Workspace Custom Instructions

The extension merges `.github/copilot-instructions.md`, `AGENTS.md`, and `CLAUDE.md` into
the system message — the same way VS Code handles workspace-level custom instructions.

### Legacy Configuration Migration

Upgrading from an older version? The extension auto-migrates legacy global server/sampling
settings into per-model entries on first launch. One-time, idempotent, no data loss.

### Chat Session Cleanup

Copilot accumulates session data across workspaces over time. The **Clean Copilot Sessions**
command lets you pick which workspaces to wipe — useful when sessions grow stale or you want
a fresh start. Access via `Ctrl+Shift+P` → **Clean Copilot Sessions** (under Utilities).

---

## Commands

| Command | What it does |
|---------|--------------|
| **Add vLLM Server & Model** | Guided flow: enter server URL → discover models → auto-configure → save |
| **Test & Refresh Models** | Verify servers, list models, correct ID mismatches, check network settings |
| **Set Model Personality** | Pick a model, pick a personality preset, apply instantly |
| **Configure Utility Model** | Switch utility model for MCP servers (`mainAgent` / `copilot` / `none`) |
| **Open Log File** | Open today's debug log |
| **Clear Log Files** | Delete all debug logs (except the active one) |

**Utilities** (maintenance, not daily workflow):

| Command | What it does |
|---------|--------------|
| **Diagnose Connection** | Deep TLS/proxy/DNS/cert diagnostic report |
| **Clean Copilot Sessions** | Wipe stale Copilot sessions across workspaces |

---

## Configuration Reference

See [Configuration Reference](docs/configuration-reference.md) for the complete guide including:

- Model entry fields (all fields, defaults, descriptions)
- Parameters for `defaultParams` and `modelModes` (full param table)
- Full JSON syntax reference (every supported field)
- Multiple servers with isolated auth
- System message replacements (detailed guide)
- Personality presets (all 4 presets with descriptions)
- Diagnostics settings
- Troubleshooting (commands table, TLS, corporate networks, Diagnose Connection)
- Known limitations

### Quick minimal config

```json
"vllm-copilot.models": [
  {
    "id": "Qwen/Qwen3.6-27B-FP8 on localhost:8000",
    "vllmModelId": "Qwen/Qwen3.6-27B-FP8",
    "serverUrl": "http://localhost:8000"
  }
]
```

> Run **Add vLLM Server & Model** to generate this automatically. It auto-detects `family`,
> `max_model_len`, capabilities, and applies bundled presets.

---

## License

MIT

MIT
