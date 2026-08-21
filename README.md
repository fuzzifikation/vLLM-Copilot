<div align="center">

<a href="https://github.com/fuzzifikation/vLLM-Copilot">
<img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/docs/images/logo.png" width="240" alt="vLLM-Copilot">
</a>

# vLLM-Copilot
[![VS Marketplace](https://img.shields.io/badge/Get_on_VS_Marketplace-blue?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=System-Sciences.vllm-copilot) [![vLLM](https://img.shields.io/badge/vLLM-Primary-01C286)](https://github.com/vllm-project/vllm) [![OpenRouter Supported](https://img.shields.io/badge/OpenRouter-Supported-00B3A6?logo=openrouter&logoColor=white)](https://openrouter.ai) [![Last Commit](https://img.shields.io/github/last-commit/fuzzifikation/vLLM-Copilot)](https://github.com/fuzzifikation/vLLM-Copilot/commits/main) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/LICENSE)

**Your vLLM serverved models inside GitHub Copilot. Built for teams and production.**
GitHub Copilot provides the familiar chat, tools, and model picker; You provide the model. No data ever gets sent to Copilot!
**Multi-server, multi-user.** Full vLLM request control, live observability, strict data residency. Also works with OpenRouter (400+ cloud models, no local infrastructure, many free options), llama.cpp, LM Studio, and Ollama.
</div>


For teams running AI on their own vLLM servers for many users, this gives you the professional Copilot integration: 

- **Data handling**: **No third party. No subscription. No affiliation. No central service. No telemetry.** Prompts, code, and company data go only to each model's configured inference server. They are not sent to GitHub Copilot or GitHub or anywhere else! 
- **Production vLLM observability**: a live dashboard of server availability, queue status, KV-cache usage, TTFT, throughput, per-request token details, and a cumulative token & cost tracker. Your admins and users will know what is going on!
- **Multi-server, multi-user by design**: each server and model carries its own endpoint, auth, sampling, and token budget. Different teams, environments, or credentials stay isolated and independently managed. But all models are available in the model picker of familiar Copilot!
- **Full request control**: model modes give you any vLLM parameter, such as thinking effort, sampling, structured output, and token budgets. Switch them per model from the Copilot picker.
- **OpenRouter**: add any of **~415 cloud models** in a few clicks. Useful for teams without GPU capacity. Real context window, capabilities, pricing, and **actual spend** (`usage.cost`) show on the dashboard. See [Using OpenRouter](#using-openrouter).
- **Other backends supported**: llama.cpp, LM Studio, and Ollama alongside vLLM, each with core features like chat, streaming, tools, personalities, and usage tracking.

<div align="center">
For full view expand the details-arrow:
<details>
<summary><img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/docs/images/overview.jpg" width="500" alt="Overview of all vLLM-Copilot features"></summary>

<img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/docs/images/overview.jpg" alt="Overview of all vLLM-Copilot features (full size)">

</details>

<em>Every vLLM-Copilot feature at a glance. Click to zoom.</em>

</div>

If you want to support this work: [![Sponsor via PayPal](https://img.shields.io/badge/Sponsor-PayPal-00457C?logo=paypal&logoColor=white)](https://paypal.me/DieterSchwarzmann) [![Support on Ko-fi](https://img.shields.io/badge/Support-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/fuzzifikation) [![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github&logoColor=white)](https://github.com/sponsors/fuzzifikation)

---

## Contents

- [Quick Start](#quick-start)
- [What makes this different from BYOK?](#what-makes-this-different-from-byok)
- [Enterprise & team deployment](#enterprise--team-deployment)
- [Features](#features)
- [Servers & backends](#servers--backends)
- [Commands](#commands)
- [Development](#development)
- [Support](#support)

## Quick Start

**Requirements:** GitHub Copilot Chat (you need a GitHub account, but no subscription), plus either a running model server (vLLM, llama.cpp, LM Studio, Ollama) or an OpenRouter API key.

> **Add a vLLM server** (or llama.cpp, ollama, lm-studio)

<table>
<tr><td>

1. **Install** this extension from the VS Code Marketplace.
2. **Open the vLLM panel:** click the **V** icon in the activity bar (left sidebar). The **Dashboard** opens.
3. **Add your vLLM server & model:** *(same for llama.cpp, lm-studio, ollama)* in the Dashboard, click **Add or Reconfigure Server/Model** at the bottom of the tree → enter your server URL → *(optional) enter vLLM API key and HTTP request headers from IT* → pick a model → done. The extension auto-configures the model (family, capabilities, context window) from the server and bundled presets or HuggingFace.
4. **Edit settings** *(optional)*: open the **Model Settings** view (below the Dashboard) to adjust displayName, params, model modes, and more. No `settings.json` editing required.
5. **Change the personality** *(optional)*: in **Model Settings**, pick a model and choose a personality from the dropdown in its **General** section (or `Ctrl+Shift+P` → **Set Model Personality**). Pick **Default (no personality)** later to clear it.
6. **Chat:** Open Copilot Chat, pick your model from the dropdown. Switch modes from the same picker.

</td></tr>
</table>

> **Add OpenRouter Model** (full provider support, cost tracking and auto selection)

<table>
<tr><td>

- In **Step 3**, enter `https://openrouter.ai` as the server URL, or paste the full web path to the model, e.g. `https://openrouter.ai/poolside/laguna-s-2.1:free` (this pre-fills the model picker). Then enter your OpenRouter API key from [openrouter.ai/keys](https://openrouter.ai/keys) when prompted.
</td></tr>
</table>

> **Remote (SSH/WSL/Containers):** This extension runs on the remote host (`extensionKind: workspace`). Install it **while connected to the remote window** and VS Code places it on the remote extension host automatically. If you installed it locally first, the remote won't pick it up on its own. Install it on the remote explicitly (Extensions view → *Install in SSH: … / WSL: … / Dev Container: …*).



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

## Enterprise & team deployment

vLLM-Copilot gives companies (and individuals) controlled access to GitHub Copilot through their own inference infrastructure. Operations get live serving metrics, per-model usage and cost tracking. A highly robust output correction of the model ensures automatic recovery from incomplete or malformed output.

**No subscription. No third party receives work content beyond the configured inference server. No affiliation. No central service. No telemetry.** GitHub Copilot supplies the familiar chat, tools, model picker, and other interaction features. Prompts, code, and company data go only to the configured inference server, never to GitHub Copilot or GitHub. Other extension traffic carries no work content; it is limited to model metadata, configuration, metrics, and service status.

- **Multi-server at scale**: add any number of vLLM servers and use their models interchangeably. Each server and model keeps its own endpoint, auth, sampling, and token budget, giving you isolation across teams, environments, or credentials.
- **Per-model credentials**: every model entry carries its own `requestHeaders` / auth, so different scopes and keys are managed independently rather than sharing one global key.
- **Cost tracking per model**: cumulative token and USD spend (Today / Overall), with OpenRouter models preferring their **actual reported cost** (`usage.cost`).
- **Reliability for daily use**: models misbehave, and this extension repairs it (see [Robustness](#robustness) below), alongside bounded `Retry-After` handling, TLS/proxy/cert diagnostics, and chat session cleanup.

### Server Dashboard
Open it with the **V** icon in the activity bar (left sidebar).

<table>
<tr>
<td valign="top" width="62%">

The live observability that makes it worthwhile for teams. A native sidebar (no webviews, no extra ports) shows live metrics per server, showing only the rows each backend actually reports:

- **Queue status**: running and waiting request counts (or *idle*) at a glance
- **Expandable metrics**: context window, vLLM version, KV cache usage & hit rate, TTFT, output and prefill speed (tok/s)
- **MTP / speculative decoding**: acceptance rate, draft depth, proposal count (when active)
- **Last Request Details**: per-server node with the most recent request's tokens (input, output, cached, reasoning), timing (TTFT, queue time, generation time), and throughput. Updated immediately after every prompt, not on the poll interval. The Output channel shows the same exact counts after every request: input/output, cached tokens (prefix cache hit %), cache creation tokens, output throughput (tok/s), and speculative-decoding stats.
- **Token Usage and Cost**: a model-first tree, one entry per model carrying the price on the collapsed line (`$11.51 today and $31.13 total`), expanding to **Today** and **Overall** token rows. Sub-cent costs keep fine precision; **OpenRouter models use their actual reported cost** (`usage.cost`), never summed with rates. **Reset Usage** is a right-click action. See [usage.md](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/docs/usage.md) for the design.
- Right-click a **vLLM** server for the **Deep-Dive** webview.

</td>
<td valign="top" width="38%">

<img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/docs/images/ServerDashboard-with-Last-Request.png" width="100%" alt="Server dashboard sidebar showing live metrics and last request details">

<em>Live server metrics with Last Request details: token counts with context/budget percentages, TTFT (reported vs. measured), generation throughput, and queue time.</em>

</td>
</tr>
</table>

### Robustness

Models misbehave. Instead of letting a bad response reach your team, the extension repairs the stream so they see working output. This is the difference between a demo and a daily driver.

- **Auto-continue on empty or truncated responses.** Some models (notably Qwen) occasionally return zero tokens or stop mid-sentence. The extension retries with an assistant prefill, so you never see a blank or cut-off answer. Configurable per model (`autoContinueRetries`, default 1).
- **Tool-call repair.** When a model truncates a tool call mid-JSON (`finish_reason: 'length'`), the extension recovers the partial call with `jsonrepair` + `best-effort-json-parser`. These are the same libraries Copilot's BYOK uses, so the call is not dropped to empty `{}`.
- **Bounded retries.** Transient server errors are retried once, honoring `Retry-After` (capped at 10 s), and never after partial output has already been streamed.
- **Connection diagnostics.** Corporate proxy? TLS-inspecting gateway? Missing intermediate certs? **Test & Refresh Models** verifies servers are reachable, lists loaded models, and corrects ID mismatches. **Diagnose Connection** runs a deep report comparing SChannel vs. OpenSSL, DNS/TCP reachability, cert-chain inspection, proxy detection, and a settings dump, with a one-line failure classification.

---

## Features

### Model Settings
Open it with the **V** icon in the activity bar (left sidebar); it sits below the Dashboard.
<table>
<tr>
<td valign="top" width="62%">

A visual editor for per-model configuration, no `settings.json` required:

- Server & model selectors, including unconfigured models
- **Auto-Configure** re-runs preset/HuggingFace discovery (modes, capabilities, token budgets, defaults)
- Sectioned layout: General, Token Budget, Capabilities, Request Params, Transport, **Model Modes**, System Prompt
- **Parameter picker** with known params and type hints; enum and boolean params render as dropdowns
- **Remove Model**, **Revert**, and auto-refresh on config changes

</td>
<td valign="top" width="38%">

<img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/docs/images/Server-Settings.png" width="100%" alt="Model Settings webview for editing per-model configuration">

<em>Edit model configuration in a visual editor. No `settings.json` required.</em>

</td>
</tr>
</table>

<table>
<tr>
<td valign="top" width="62%">

**Model modes** are named parameter presets you switch between from the Copilot model picker, like profiles for different tasks: deep reasoning, precise coding, creative work. Each mode merges its parameters into the vLLM request on top of the model defaults.

- **Thinking toggles**: `enable_thinking: true/false` (from bundled presets)
- **Sampling presets**: temperature/top_p combinations for creative vs. precise output
- **Structured output**: JSON schema enforcement for data extraction
- **Anything vLLM supports**: bad words, repetition detection, token budgets

**Add vLLM Server & Model** auto-generates modes from bundled presets (or OpenRouter reasoning metadata). An example config and the full syntax are in the [Manual → Model modes](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/docs/manual.md#model-modes).
</td>
<td valign="top" width="38%">

<img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/docs/images/model-mode.png" width="100%" alt="Model mode picker showing different configurations">

<em>Switch between model modes directly from the Copilot model picker: Think, No Think, Precise, etc.</em>

</td>
</tr>
</table>

**Hidden System Instructions (capture & replace)**. Copilot injects ~21KB of hidden safety and identity rules into every request. Capture them, then replace them:

1. Set `vllm-copilot.systemMessageCapture: true`
2. Unique system messages are written to `.vllm/system-messages.json`
3. Write a JSON file of find/replace rules
4. Point `systemMessageReplacementsFile` at it on the model entry

Replacements are exact substring matches, applied sequentially to every system message before it reaches vLLM.

**Workspace custom instructions**. `.github/copilot-instructions.md`, `AGENTS.md`, and `CLAUDE.md` are merged into the system message, the same way VS Code handles workspace-level custom instructions.

### Personalities & System Prompts

This uses the System-Instructions-Replacement of above with pre-made instructions. Two ways to control what the model sees as its system prompt.

**Personality presets** replace Copilot's ~21KB of system-prompt boilerplate with something useful. Pick one per model (Model Settings → General, or **Set Model Personality**); **Default** restores the original. The choice follows you across workspaces.

| Preset | What it does |
|--------|--------------|
| **Default (no personality)** | No replacements; Copilot's original system prompt |
| **Raw (Model Natural)** | Strips Microsoft's safety, identity, and behavioral boilerplate. No persona injected. |
| **Supportive Mentor** | Patient mentor who builds better engineers. High standards, honest feedback, explains the why. |
| **Critical Senior Dev** | Cold architectural judgment. Evaluates code and trade-offs with zero sentiment. |
| **Sarcastic Robot** | Brilliant, condescending, politically incorrect. Fixes your code anyway. |
| **Spartan** | Minimalist replies: short, little to read, to the point. Saves tokens. |

Bundled presets are extension-owned and re-synced on every apply; custom behavior belongs in your own replacement file (below) or a user-created personality.



### Chat Session Cleanup

Copilot accumulates session data across workspaces. **Clean Copilot Sessions** lets you pick which workspaces to wipe when sessions grow stale. Access via `Ctrl+Shift+P` → **Clean Copilot Sessions** (under Utilities).

---

## Servers & backends

### vLLM request controls

Beyond the basics, vLLM request-body parameters give you full request control. Configure them in `defaultParams` (model-wide) or `modelModes` (switchable from the picker). They are not exposed by the BYOK Custom Endpoint.

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

### Supported servers

**vLLM is the primary target and gets the full feature set.** llama.cpp, LM Studio, Ollama, and OpenRouter are supported alongside it with the core features.

| Backend | Status | Notes |
|---------|--------|-------|
| **vLLM** | ✅ Primary | Full feature set: vLLM request parameters, per-request server metrics, all dashboard rows |
| **llama.cpp** | ✅ Core | OpenAI-compatible `/v1/chat/completions`; context window from `/v1/models` |
| **LM Studio** | ✅ Core | Same as llama.cpp |
| **Ollama** | ✅ Core | Same as llama.cpp; `tool_choice` values are dropped (the parameter isn't supported by Ollama's API), tool calling itself works |
| **OpenRouter** | ✅ Managed remote | Fixed endpoint `https://openrouter.ai/api`; host-only detection; model picked from the ~415-model catalog |

The backend is auto-detected on Add Server and in Model Settings; set it explicitly per model via `serverType`.

**Every backend gets:** native Copilot integration (chat, tools, vision, streaming), model modes, personality presets, hidden-system-prompt capture & replace, per-server auth/sampling/token budget, auto-continue on empty responses, token usage & cost tracking, and Test & Refresh / Connection Diagnostics.

**vLLM-only:** vLLM-specific request parameters, per-request server metrics (TTFT/TPOT, KV cache, speculative decoding), and the Deep-Dive webview. Other backends show client-measured throughput instead; the dashboard shows only the rows each backend actually reports and resolves the model's context window per backend.

### Using OpenRouter

OpenRouter is a managed remote: no server to run, nothing to install. Add one fixed endpoint and pick from ~415 cloud models. Setup is covered in [Quick Start](#quick-start) above. A `:free` suffix is a routing variant and always stays on the free model. Full guide, manual config, and attribution headers: [OpenRouter guide](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/docs/openrouter.md).

### Server Deep-Dive (vLLM)

<table>
<tr>
<td valign="top" width="62%">

Right-click a **vLLM** server node → **vLLM Deep-Dive** opens a per-server webview with the full metric set: histogram breakdowns (TTFT/TPOT/token counts) as hoverable bars and the raw metric dump. vLLM-only, since non-vLLM backends don't expose `/metrics`.
</td>
<td valign="top" width="38%">

<img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/docs/images/Server-Stats-Webview.png" width="100%" alt="Server Deep-Dive webview showing full live metrics with histograms">

<em>Full per-server metrics with live polling, histogram breakdowns, and raw metric dump.</em>

</td>
</tr>
</table>

---

## Commands

| Command | What it does |
|---------|--------------|
| **Add vLLM Server & Model** | Guided flow: enter server URL → discover models → auto-configure → save. An `openrouter.ai` server URL routes into the OpenRouter flow (server → key → model pick) |
| **Test & Refresh Models** | Verify servers, list models, correct ID mismatches, check network settings |
| **Set Model Personality** | Pick a model, pick a personality preset (or **Default** to clear), apply instantly |
| **Configure Utility Model** | Switch utility model for MCP servers (`mainAgent` / `copilot` / `none`) |
| **Update Auth** | Rotate API key or change auth headers for a server (right-click on server node) |
| **vLLM Deep-Dive** | Open per-server webview with full metrics and histograms (right-click a **vLLM** server node) |
| **Remove Model** | Remove a single configured model (button in Model Settings webview) |
| **Remove Server** | Remove a configured server and all its models (command palette, with confirm) |
| **Open Log File** | Open today's debug log |
| **Clear Log Files** | Delete all debug logs (except the active one) |

**Utilities** (maintenance, not daily workflow):

| Command | What it does |
|---------|--------------|
| **Diagnose Connection** | Deep TLS/proxy/DNS/cert diagnostic report |
| **Clean Copilot Sessions** | Wipe stale Copilot sessions across workspaces |

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

## More details

This page covers the essentials. Every setting, parameter, and backend detail is in the [vLLM-Copilot Manual](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/docs/manual.md).

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
