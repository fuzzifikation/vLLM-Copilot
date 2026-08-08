<div align="center">

<a href="https://github.com/fuzzifikation/vLLM-Copilot">
<img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/docs/images/logo.png" width="240" alt="vLLM-Copilot">
</a>

# vLLM-Copilot
[![VS Marketplace](https://img.shields.io/badge/Get_on_VS_Marketplace-blue?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=System-Sciences.vllm-copilot) [![Last Commit](https://img.shields.io/github/last-commit/fuzzifikation/vLLM-Copilot)](https://github.com/fuzzifikation/vLLM-Copilot/commits/main) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/LICENSE)

**Run any vLLM model natively inside GitHub Copilot. No workarounds, no missing features.**
</div>


For anyone using AI models served on vLLM servers, self-hosted or professionally hosted within your company, this gets you:

- **Native Copilot integration**: your models show up in the Copilot model picker with chat, tools, vision, subagent capabilities and context-window stats, fully supported.
- **Live server dashboard**: at-a-glance metrics for every vLLM server right in the sidebar: queue status, KV-cache usage, TTFT, throughput, and per-request token details.
- **Personality presets**: strip Microsoft's 21KB of system-prompt boilerplate, or give a model a character. Per model, no JSON editing.
- **Per-server control**: each server carries its own endpoint, auth, sampling, token budget.
- **Fully configurable model-modes**: Copilot gives you thinking effort. This gives you full control with configurable request parameters, not only thinking, but *any* vLLM parameter. Fully supported in the sidebar-UI.


<div align="center">
For full view expand the details-arrow:
<details>
<summary><img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/docs/images/overview.jpg" width="500" alt="Overview of all vLLM-Copilot features"></summary>

<img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/docs/images/overview.jpg" alt="Overview of all vLLM-Copilot features (full size)">

</details>

*Every vLLM-Copilot feature at a glance. Click to zoom.*

</div>

If you want to support this work: [![Sponsor via PayPal](https://img.shields.io/badge/Sponsor-PayPal-00457C?logo=paypal&logoColor=white)](https://paypal.me/DieterSchwarzmann) [![Support on Ko-fi](https://img.shields.io/badge/Support-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/fuzzifikation) [![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github&logoColor=white)](https://github.com/sponsors/fuzzifikation)

---

## What makes this different from BYOK?

VS Code's built-in Custom Endpoint (BYOK) handles chat, tools, vision, streaming, and a
thinking-effort picker. It also supports a subset of basic inference parameters, such as
`temperature` and `top_p`, configured for a model.

vLLM-Copilot is for users who want the full vLLM request surface and a richer workflow
around it. It lets you define **model modes**: named configurations you switch between
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

> **💡 Tip:** Enable `extensions.autoUpdate` in VS Code settings to get automatic updates. (Auto-updates are disabled by default for extensions using proposed APIs like `chatProvider`.)

1. **Install** from the VS Code Marketplace
2. **Add a model:** `Ctrl+Shift+P` → **Add vLLM Server & Model** → enter your server URL → pick a model → done. The extension auto-configures everything (model family, thinking modes, context window) from bundled presets or HuggingFace.
3. **Edit settings:** Open the **Server Settings** sidebar to adjust displayName, params, model modes, and more. No `settings.json` editing required.
4. **Change the personality (optional):** in the **vLLM Server Settings** sidebar, pick a model and choose a personality from the dropdown in its **General** section (or `Ctrl+Shift+P` → **Set Model Personality**). Pick **Default (no personality)** later to clear it.
5. **Chat:** Open Copilot Chat, pick your model from the dropdown. Switch modes from the same picker.

> **Remote (SSH/WSL/Containers):** This extension runs on the remote host automatically when installed from the Marketplace. VS Code will install it on the remote extension host.

> **Everything is per-model.** There is no global server or global sampling. Each model entry carries its own `serverUrl`, `requestHeaders`, and params. Settings take effect immediately; no reload needed.

---

## Features

### Model Modes: switchable configurations per model

Model modes let you define **named configurations** for a model and switch between them from the Copilot model picker, like having "profiles" for different tasks. Think of them as presets: one for deep reasoning, one for precise code, one for creative brainstorming.

Each mode is a set of parameters merged into the vLLM request. Common use cases:

- **Thinking toggles**: `enable_thinking: true/false` (the extension auto-detects these from HuggingFace)
- **Sampling presets**: different `temperature`/`top_p` combinations for creative vs. precise output
- **Structured output**: JSON schema enforcement for data extraction
- **Anything vLLM supports**: bad words, repetition detection, token budgets

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

<img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/docs/images/model-mode.png" width="500" alt="Model mode picker showing different configurations">

*Switch between model modes directly from the Copilot model picker: Think, No Think, Precise, etc.*

### Personality Presets

Personalities replace Copilot's 21KB system prompt boilerplate with something
actually useful. Pick one per model; no JSON editing:

1. **Set it:** open the **vLLM Server Settings** sidebar, pick a model, choose a personality from the dropdown in the model's **General** section (or `Ctrl+Shift+P` → **Set Model Personality**)
2. **Clear it:** pick **Default (no personality)** to remove replacements and restore Copilot's original system prompt. The active choice is marked and shown.

The selected personality is copied to the extension's global storage, so it follows
you across workspaces and survives extension upgrades.

| Preset | What it does |
|--------|--------------|
| **Default (no personality)** | No replacements; Copilot's original system prompt |
| **Raw (Model Natural)** | Strips Microsoft's safety, identity, and behavioral boilerplate. No persona injected; the model behaves as it was trained. |
| **Tough Love** | Mentor who builds better engineers. High standards, honest feedback, explains the why, celebrates progress. Invested in you, not just your code. |
| **Critical Senior Dev** | Cold architectural judgment. Evaluates code, technical debt, and trade-offs with zero sentiment. The code, not the coder. |
| **Sarcastic Robot** | Brilliant, condescending, politically incorrect. Finds human code amusingly primitive, but fixes it anyway. |
| **Spartan** | Minimalist responses: short, little to read, to the point. Saves tokens. The economy is in how it talks, not what it builds; code stays complete. |

Want to customize? **Bundled presets are extension-owned and re-synced on every apply.**
Editing the global copy of a bundled preset gets clobbered the next time you re-apply it.
Custom behavior belongs in your own replacement file via `systemMessageReplacementsFile`
(see [Hidden System Instructions](#hidden-system-instructions-capture--replace)) or a
user-created personality in global storage.

### Hidden System Instructions (Capture & Replace)

Copilot injects hidden instructions into every request (~21KB of safety rules, identity instructions). This extension lets you capture and surgically modify them:

1. **Enable capture**: set `vllm-copilot.systemMessageCapture: true` in settings
2. **Inspect**: unique system messages are written to `.vllm/system-messages.json`
3. **Create replacements**: write a JSON file of find/replace rules
4. **Apply**: set `systemMessageReplacementsFile` on your model entry

Replacements are exact substring matches, applied sequentially to every system message before it reaches vLLM. Matched rules are logged in the capture file.

### Server Dashboard

A native Tree View sidebar shows live metrics for each configured vLLM server. No webviews, no extra ports.

- **At-a-glance queue status:** Each server shows running and waiting request counts (or *idle*)
- **Expandable metrics:** Model IDs, vLLM version, context window, KV cache usage & hit rate, TTFT, throughput (tokens/sec)
- **MTP / speculative decoding:** Acceptance rate, draft depth, proposal count (when active)
- **Last Request Details:** Per-server node showing the most recent request's token counts (input, output, cached, reasoning), timing metrics (TTFT, queue time, generation time), and throughput. Requires vLLM `--enable-prompt-tokens-details` and `--enable-per-request-metrics` server flags for full detail. Displays hints when flags aren't set.
- **Configurable polling:** Click **Refresh Interval** at the top of the tree to change; enter `15s`, `30s`, `1m`, etc.

Access via **View → vLLM-Copilot → Dashboard** or the sidebar section header.

<img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/docs/images/ServerDashboard-with-Last-Request.png" width="500" alt="Server dashboard sidebar showing live metrics and last request details">

*Live server metrics with Last Request details: token counts with context/budget percentages, TTFT (reported vs. measured), generation throughput, and queue time.*

### Server Settings

<table><tr><td>

A sibling webview to the dashboard lets you edit per-model configuration without touching `settings.json`.

- **Server & model selectors**: pick a server and model from dropdowns; unconfigured models can be selected and saved instantly
- **Auto-Configure button**: re-runs preset/HuggingFace discovery for the selected model, updating modelModes, capabilities, token budgets, and defaults. Works on unconfigured models too: it borrows the server's auth from a sibling model and creates a full new settings entry
- **Remove Model button**: deletes only the selected model's settings entry (with a confirm dialog); never touches other models on the same server
- **Sectioned layout (general → specific):** General, Token Budget, Capabilities, Request Params (baseline), Transport, Model Modes (overrides), System Prompt
- **Parameter picker**: "Add Parameter" offers a dropdown of known params (temperature, top_p, top_k, min_p, seed, reasoning_effort, parallel_tool_calls, skip_special_tokens, etc.) with friendly labels and type hints
- **Enum dropdowns**: `reasoning_effort` renders as a dropdown (none, minimal, low, medium, high, xhigh, max); boolean params show as true/false dropdowns
- **Revert button**: discard unsaved changes and reset to the last saved state
- **Re-opens automatically** on config changes; no manual refresh needed

Access via **View → vLLM-Copilot → Server Settings** or the sidebar section header.

<img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/docs/images/Server-Settings.png" width="500" alt="Server Settings webview for editing per-model configuration">

*Edit model configuration in a visual editor. No `settings.json` required.*

</td></tr></table>

### Server Deep-Dive

A per-server details webview that opens in the editor area with the full set of live server statistics, everything the dashboard sidebar aggregates, plus histogram breakdowns.

- **Open from the Dashboard**: right-click any server node → **vLLM Deep-Dive** (or click the server row in a future release)
- **Live polling**: refreshes at the same `vllm-copilot.dashboard.pollIntervalMs` interval as the sidebar
- **Histograms with tooltips**: TTFT/TPOT/token-count distributions rendered as hoverable bars
- **Full raw metric dump**: the same parser that feeds the dashboard sidebar, shown in full
- **One panel per server**: opening the same server again focuses the existing panel instead of duplicating

<img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/docs/images/Server-Stats-Webview.png" width="500" alt="Server Deep-Dive webview showing full live metrics with histograms">

*Full per-server metrics with live polling, histogram breakdowns, and raw metric dump.*

### Auto-Continue on Empty Responses

Some models (notably Qwen) occasionally return zero tokens or truncated output. The extension automatically retries with an assistant prefill, so you never see a blank or cut-off response. Configurable per-model (`autoContinueRetries`, default: 1).

### Token Usage & Performance Stats

After every request, the Output channel shows exact token counts from vLLM:
- Input/output tokens, cached tokens (prefix cache hit %), cache creation tokens
- Output throughput (tokens/sec), time-to-first-token
- Speculative decoding stats (accepted/rejected predictions)

Additionally, the Dashboard sidebar shows **Last Request Details** per server with the same token and timing data in a persistent, at-a-glance view.

### Connection Diagnostics

Corporate proxy? TLS-inspecting gateway? Missing intermediate certs?

- **Test & Refresh Models**: verify all configured servers are reachable, lists loaded models, corrects model ID mismatches, checks VS Code network gating settings
- **Diagnose Connection**: deep diagnostic comparing SChannel (PowerShell) vs. OpenSSL (Node fetch), DNS/TCP reachability, cert chain inspection, proxy detection, VS Code settings dump. One-line classification of the failure.

### Tool Calling & Truncated Response Recovery

When vLLM truncates a tool call mid-JSON (`finish_reason: 'length'`), the extension uses
`jsonrepair` + `best-effort-json-parser` (the same library Copilot's BYOK uses) to recover
partial content instead of silently dropping it to empty `{}`.

### Workspace Custom Instructions

The extension merges `.github/copilot-instructions.md`, `AGENTS.md`, and `CLAUDE.md` into
the system message, the same way VS Code handles workspace-level custom instructions.

### One-Click Migration from Older Versions

Upgrading from an older version? The extension auto-migrates legacy global server/sampling
settings into per-model entries on first launch. One-time, idempotent, no data loss.

### Chat Session Cleanup

Copilot accumulates session data across workspaces over time. The **Clean Copilot Sessions**
command lets you pick which workspaces to wipe, useful when sessions grow stale or you want
a fresh start. Access via `Ctrl+Shift+P` → **Clean Copilot Sessions** (under Utilities).

---

## Commands

| Command | What it does |
|---------|--------------|
| **Add vLLM Server & Model** | Guided flow: enter server URL → discover models → auto-configure → save |
| **Test & Refresh Models** | Verify servers, list models, correct ID mismatches, check network settings |
| **Set Model Personality** | Pick a model, pick a personality preset (or **Default** to clear), apply instantly |
| **Configure Utility Model** | Switch utility model for MCP servers (`mainAgent` / `copilot` / `none`) |
| **Update Auth** | Rotate API key or change auth headers for a server (right-click on server node) |
| **vLLM Deep-Dive** | Open per-server webview with full metrics and histograms (right-click on server node) |
| **Remove Model** | Remove a single configured model (button in Server Settings webview) |
| **Remove Server** | Remove a configured server and all its models (command palette, with confirm) |
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
- Personality presets (all 5 presets with descriptions)
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

## Development

### License compliance

All production (shipped) dependencies are permissive open-source licenses
(MIT, ISC, BSD-2/3-Clause, Apache-2.0). Compliance is enforced in CI/build:

- `npm run license:check`: fails the build if any *runtime* dependency has a
  license outside the approved allowlist (copyleft like GPL/AGPL/LGPL and
  unknown licenses are rejected). Runs automatically as part of `npm run build`.
- `npm run license:notices`: regenerates `THIRD-PARTY-NOTICES.txt` (required by
  the VS Code Marketplace for redistributed OSS). Run it whenever dependencies
  change and commit the result.
- `THIRD-PARTY-NOTICES.txt` is included in the packaged VSIX.

---

## Support

If vLLM-Copilot saves you time, money, or your sanity, consider fueling the caffeine habit behind it:

- **PayPal**: [paypal.me/DieterSchwarzmann](https://paypal.me/DieterSchwarzmann)
- **Ko-fi**: [ko-fi.com/fuzzifikation](https://ko-fi.com/fuzzifikation)
- **GitHub Sponsors**: [github.com/sponsors/fuzzifikation](https://github.com/sponsors/fuzzifikation)

Every donation is appreciated, even a coffee. It keeps local AI development free and open source.

---

## License

MIT License

Copyright (c) 2026 Systemwissenschaften TGU, TTI GmbH

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
