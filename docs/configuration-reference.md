# Configuration Reference

> **Quick start:** Run **Add vLLM Server & Model** from the Command Palette to auto-generate model entries. Use this reference when you need to customize advanced settings.

All settings are under `vllm-copilot` in VS Code Settings (`Ctrl+,`, search `vllm`). There are three top-level settings: `vllm-copilot.models` (array of per-model entries), `vllm-copilot.systemMessageCapture` (capture system messages to `.vllm/system-messages.json`), and `vllm-copilot.enableFileLogging` (request/response logs). Everything else lives on each model entry.

**Each model entry is self-contained** — it carries its own `serverUrl`, `requestHeaders`, token budgets, capabilities, and params.

---

## Model Entry Fields

| Field | Default | Description |
|-------|:-------:|-------------|
| `serverUrl` | — | **Required.** vLLM server URL (OpenAI-compatible). Each model targets its own server. |
| `requestHeaders` | `{}` | HTTP headers for this server (auth, routing). **Isolated** — never shared across servers. |
| `id` | — | **Required.** Unique entry key. Add flow sets this to `"<model> on <host>"`. |
| `vllmModelId` | same as `id` | Actual model ID on the vLLM server (for aliases). |
| `displayName` | same as `id` | Human-readable name in the model picker. |
| `family` | auto-detected | Model family (e.g. `qwen3_5`, `llama`). From HuggingFace or extracted from model ID. |
| `maxOutputTokens` | `4096` | Max tokens per response. Server enforces its own hard limit. |
| `maxInputTokens` | computed | Auto-computed as `max_model_len - maxOutputTokens`. Set only to reduce further. |
| `estimateCharsPerToken` | `3.5` | Chars-per-token for local token estimation. |
| `defaultParams` | `temp: 0.7, top_p: 1.0` | Model-scope generation params. Layered under `modelModes`. |
| `modelModes` | — | Switchable named presets (Think/No Think, etc.). Bundled presets auto-applied by **Add vLLM Server & Model**; for existing entries, hand-edit and copy from [`model-configs/`](../model-configs/). |
| `defaultMode` | first mode | Which mode is active before the user picks one. |
| `capabilities.toolCalling` | `true` | Model supports tool/function calling. |
| `capabilities.imageInput` | `false` | Model supports vision/image input. |
| `streamInactivityTimeout` | `0` (off) | SSE stream timeout in ms. `0` = wait indefinitely. |
| `autoContinueRetries` | `1` | Retry attempts on empty/truncated responses (assistant prefill). `0` = off. |
| `systemMessageReplacementsFile` | — | Path to a JSON file of `{ ruleName, find, replace }` pairs applied to every system message. See [System Message Replacements](#system-message-replacements) below. |

**Resolution chain (highest wins):** built-in defaults → model `defaultParams` → the selected `modelModes` entry.

---

## Parameters for `defaultParams` and `modelModes`

Any vLLM chat body field except `model`, `messages`, `stream`, `stream_options`. *(vLLM-only)* marks params OpenAI does not accept.

> **Note:** `max_tokens` is **not** in the table — the extension always sets it from `maxOutputTokens`, so listing it in your params has no effect. Set `maxOutputTokens` on the model entry instead.

| Param | Description |
|-------|-------------|
| `temperature` | Sampling temperature (0–2). Built-in default `0.7`. `0` = greedy |
| `top_p` | Nucleus sampling threshold (0–1). Built-in default `1.0` |
| `top_k` | Top-k sampling (int). −1 = disabled *(vLLM-only)* |
| `min_p` | Minimum probability threshold (0–1) *(vLLM-only)* |
| `presence_penalty` | Topic-repetition discouragement (−2 to 2) |
| `frequency_penalty` | Token-repetition discouragement (−2 to 2) |
| `repetition_penalty` | Repetition penalty (1.0 = none) *(vLLM-only)* |
| `length_penalty` | Beam-search length penalty (1.0 = none) *(vLLM-only)* |
| `seed` | Random seed for reproducibility |
| `stop` | Stop sequences (string or array of strings) |
| `stop_token_ids` | Stop on token IDs *(vLLM-only)* |
| `include_stop_str_in_output` | Include the stop string in output (default false) *(vLLM-only)* |
| `ignore_eos` | Ignore EOS and keep generating (use with `min_tokens`) *(vLLM-only)* |
| `min_tokens` | Minimum output tokens before stop sequences are honored |
| `skip_special_tokens` | Strip special tokens from output (default true) *(vLLM-only)* |
| `spaces_between_special_tokens` | Insert spaces between special tokens (default true) *(vLLM-only)* |
| `truncate_prompt_tokens` | Cap prompt length server-side (−1 = none) *(vLLM-only)* |
| `thinking_token_budget` | Max reasoning tokens (requires `--reasoning-parser`; −1 = unlimited) *(vLLM-only)* |
| `bad_words` | Words the model must not generate *(vLLM-only)* |
| `repetition_detection` | N-gram repetition early-stop: `{ max_pattern_size, min_count, min_pattern_size }` *(vLLM-only)* |
| `structured_outputs` | Token-level constraints: `json`, `regex`, `choice`, or `grammar` (mutually exclusive) *(vLLM-only, ≥ v0.12.0)* |
| `chat_template_kwargs` | vLLM chat template params (e.g. `{ "enable_thinking": true }`) *(vLLM-only)* |
| `allowed_token_ids` | Restrict generation to these token IDs *(vLLM-only; niche)* |

> **Enabled by default:** Every model has `repetition_detection` enabled with safe defaults (`max_pattern_size: 5, min_pattern_size: 2, min_count: 3`). This catches runaway loops without affecting normal output. Override in a model's `defaultParams` if needed, or set `max_pattern_size: 0` to disable.

---

## Typical Example

A working chat model — minimum viable config. No modes, no custom params, just authorizes a model on a server. Everything else uses built-in defaults (`temperature: 0.7`, `top_p: 1.0`, `maxOutputTokens: 4096`):

```json
"vllm-copilot.models": [
  {
    "id": "Qwen/Qwen3.6-27B on localhost:8000",
    "vllmModelId": "Qwen/Qwen3.6-27B",
    "serverUrl": "http://localhost:8000"
  }
]
```

> **Tip:** Run **Add vLLM Server & Model** to generate this — it auto-detects `family`, `max_model_len`, and capabilities, and applies a bundled preset if one fits.

---

## Full Syntax Reference

> ⚠️ **This is a syntax reference, not a recommended starting point.** Do not copy these values — they cover every supported field/param so you can see the JSON shape. For real starting points, use **Add vLLM Server & Model** or see the [Typical Example](#typical-example) above.

```jsonc
"vllm-copilot.models": [
  {
    // ── Identity ───────────────────────────────────────────
    "id": "Qwen/Qwen3.6-27B on localhost:8000",   // required; unique preset key (Add flow: "<model> on <host>")
    "vllmModelId": "Qwen/Qwen3.6-27B",            // server-side model ID (use for aliases)
    "displayName": "Qwen 3.6 27B (debug)",            // picker label
    "family": "qwen3_5",                               // picker grouping; auto-detected from HF

    // ── Server & auth (per-model, isolated) ──────────────
    "serverUrl": "http://localhost:8000",             // required
    "requestHeaders": {                               // auth/routing; never shared across servers
      "Authorization": "Bearer token-abc123",
      "X-Custom-Header": "value"
    },

    // ── Token budgets ─────────────────────────────────────
    // `max_model_len` (context window) is auto-discovered from /v1/models — do NOT set it here.
    "maxOutputTokens": 8192,                           // max tokens per response (default 4096)
    "maxInputTokens": 28672,                           // optional; clamp below (max_model_len − maxOutputTokens)
    "estimateCharsPerToken": 3.5,                      // for local token estimation (default 3.5)

    // ── Capabilities ──────────────────────────────────────
    "capabilities": {
      "toolCalling": true,                             // default true
      "imageInput": false                             // default false
    },

    // ── Stream & retry ────────────────────────────────────
    "streamInactivityTimeout": 30000,                  // ms with no SSE data before abort; 0 = wait forever
    "autoContinueRetries": 1,                          // retries on empty response via assistant prefill; 0 = off

    // ── System message replacements (optional) ────────────
    "systemMessageReplacementsFile": "../../.vllm/prompt-replacements.json",

    // ── defaultParams: always-on, model-scope ────────────
    // Layered under selected mode. Built-in defaults: temperature=0.7, top_p=1.0.
    "defaultParams": {
      // — Standard sampling (OpenAI-compatible) —
      "temperature": 0.7,                // 0–2. 0 = greedy
      "top_p": 0.95,                     // 0–1, nucleus threshold
      "top_k": 40,                       // int; −1 = disabled (vLLM-only)
      "min_p": 0.05,                     // 0–1, minimum probability threshold (vLLM-only)
      "presence_penalty": 0.0,           // −2 to 2
      "frequency_penalty": 0.0,          // −2 to 2
      "repetition_penalty": 1.0,         // 1.0 = none (vLLM-only)
      "length_penalty": 1.0,             // beam-search only; 1.0 = none
      "seed": 42,                        // int for reproducibility; omit for random

      // — Stop conditions —
      "stop": ["\n\nUser:", "\n\n\n"],   // str | list[str]
      "stop_token_ids": [151645, 151643],// list[int] (vLLM-only)
      "include_stop_str_in_output": false,// bool, default false (vLLM-only)
      "ignore_eos": false,               // ⚠️ true = never stops on EOS; use with min_tokens (vLLM-only)
      "min_tokens": 1,                   // ignore stop until N tokens emitted

      // — Output detokenization —
      "skip_special_tokens": true,        // default true (vLLM-only)
      "spaces_between_special_tokens": true, // default true (vLLM-only)
      "truncate_prompt_tokens": -1,      // −1 = none; cap prompt length server-side (vLLM-only)

      // — vLLM-specific features —
      "bad_words": ["I cannot", "I apologize", "As an AI"], // blocked tokens (vLLM-only)
      "repetition_detection": {          // N-gram early-stop; distinct from repetition_penalty (vLLM-only)
        "max_pattern_size": 4,           // longest N-gram tracked
        "min_count": 3,                  // repetitions before stop fires
        "min_pattern_size": 1            // ignore patterns shorter than this
      },
      "thinking_token_budget": 4096,     // reasoning models; −1 = unlimited (needs --reasoning-parser)
      "allowed_token_ids": [13, 330, 1463], // only allow these token IDs (vLLM-only; niche)

      // — Chat template (per-model) —
      "chat_template_kwargs": {           // passed to the tokenizer's chat template
        "enable_thinking": true,
        "preserve_thinking": true
      },

      // — Structured output (pick ONE: json | regex | choice | grammar) —
      // vLLM ≥ v0.12.0. All four are mutually exclusive within one params block.
      "structured_outputs": {
        "json": {
          "type": "object",
          "properties": { "answer": { "type": "string" } },
          "required": ["answer"]
        }
        // "regex": "^\\d{4}-\\d{2}-\\d{2}$"
        // "choice": ["yes", "no"]
        // "grammar": "root ::= [a-z]+"
      }
    },

    // ── modelModes: switchable presets; mode params override defaultParams ──
    "modelModes": {
      "Think": {
        "chat_template_kwargs": { "enable_thinking": true, "preserve_thinking": true },
        "temperature": 1.0,
        "top_p": 0.95,
        "top_k": 20,
        "thinking_token_budget": 8192
      },
      "No Think": {
        "chat_template_kwargs": { "enable_thinking": false },
        "temperature": 0.7,
        "top_p": 0.8,
        "presence_penalty": 1.5
      },
      "Strict JSON": {
        "temperature": 0.1,
        "top_p": 0.1,
        "structured_outputs": { "json": { "type": "object" } }
      },
      "Yes/No": {
        "structured_outputs": { "choice": ["yes", "no"] }
      }
    },
    "defaultMode": "Think"                            // must match a modelModes key
  }
]
```

**Verified against vLLM's OpenAI-compatible API reference** (June 2026): every parameter name above is sent verbatim in the request body. Names marked *(vLLM-only)* are accepted by vLLM's Chat API but not by OpenAI. Field semantics, ranges, and defaults match the upstream `SamplingParams` definition.

---

## Multiple Servers with Isolated Auth

Each model targets its own server; a server's `requestHeaders` are used only for that server and never shared:

```json
{
  "id": "remote-model",
  "vllmModelId": "Some/Model",
  "serverUrl": "https://remote-vllm.example.com",
  "requestHeaders": { "Authorization": "Bearer <token>" }
}
```

---

## System Message Replacements

After capturing system messages (see [Custom System Prompt](./custom-system-prompt.md)), create a JSON file of find/replace rules. Each rule is an exact substring match applied sequentially — empty `replace` removes the matched text:

```json
[
  {
    "ruleName": "Remove SafetyRules block",
    "find": "Follow Microsoft content policies.\nAvoid content that violates copyrights.\nIf you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with \"Sorry, I can't assist with that.\"\nKeep your answers short and impersonal.",
    "replace": ""
  },
  {
    "ruleName": "Shorten identity rule",
    "find": "When asked for your name, you must respond with \"GitHub Copilot\". When asked about the model you are using, you must state that you are using",
    "replace": "Your name is Copilot. You use"
  }
]
```

Then set `systemMessageReplacementsFile` on the model entry to point to this file (relative to `settings.json`).

**How it works:**
- Exact substring match (no regex)
- Applied to **every** system message (not just the first) — chat, progress, title generation, etc.
- Applied in array order, sequentially
- Matched `ruleName`s are logged in the capture file so you can verify

**Getting the exact text to match:** enable `systemMessageCapture`, chat once, then open `.vllm/system-messages.json`. Copy the text from `receivedContent`, escape newlines as `\n` in JSON.

---

## Personality Presets

The extension ships with four pre-built replacement files that transform Copilot's personality. Each preset removes safety boilerplate, identity rules, and generic fluff — then injects distinct behavioral instructions. Pick one, point your model at it:

| Preset | File | Personality |
|--------|------|-------------|
| **Tough Love** | `prompt-replacements/prompt-replacements-tough-love.json` | Direct tutor. Brutally honest feedback to help you grow. Calls out bad patterns, demands better. |
| **Critical Senior Dev** | `prompt-replacements/prompt-replacements-critical-senior.json` | Sharp collaborator who challenges assumptions and surfaces trade-offs. Helps push the project forward. |
| **Sarcastic Robot** | `prompt-replacements/prompt-replacements-sarcastic-robot.json` | Brilliant, condescending, politically incorrect. Finds human code amusingly primitive — but fixes it anyway. |
| **Spartan** | `prompt-replacements/prompt-replacements-spartan.json` | Absolute minimalism. Zero fluff. Short answers. Code first, words only when necessary. |

**Usage:**
```json
{
  "vllm-copilot.models": [
    {
      "id": "my-model",
      "serverUrl": "http://localhost:8000",
      "systemMessageReplacementsFile": "../../prompt-replacements/prompt-replacements-tough-love.json"
    }
  ]
}
```

Path is relative to `settings.json` (usually in `.vscode/` or your user settings location). Use an absolute path if preferred.

**Want to customize a preset?** Copy the file to `.vllm/my-replacements.json`, edit the `replace` fields, and point at your copy.

---

## Diagnostics

| Setting | Default | Description |
|---------|---------|-------------|
| `systemMessageCapture` | `false` | Capture unique Copilot system messages to `.vllm/system-messages.json` |
| `enableFileLogging` | `false` | Write detailed request/response logs (API keys are redacted) |

---

## Troubleshooting

**First, run the right command:**

| If… | Run this |
|---|---|
| You want to know whether your configured servers are reachable and which models loaded | **Test & Refresh Models** — pings `GET /v1/models` per configured server, lists models, surfaces full error causes for failed servers, and warns if VS Code's network gating settings (`http.proxySupport`, `http.fetchAdditionalSupport`, `http.systemCertificates`) are non-default. On failure it offers to escalate to **Diagnose Connection**. |
| A model or server won't connect and you need to find out **why** (TLS, proxy, DNS, cert chain) | **Diagnose Connection** — runs a deep multi-test report against one URL. See below for what it gathers. |

**What Diagnose Connection gathers (goes to its own Output channel — copy-paste to share):**

- **Environment:** extension version, Node version, VS Code version, platform
- **Target URL** + parsed host/port
- **DNS resolution** for the hostname
- **TCP connect** test against host:port
- **Node fetch** (OpenSSL, the same path VS Code's patched `globalThis.fetch` uses) — status code or unwrapped error
- **System-native fetch** for comparison: PowerShell `Invoke-WebRequest` (SChannel) on Windows, `curl` (Secure Transport / OpenSSL) elsewhere
- **Certificate chain inspection** (only on TLS errors, Windows: SChannel chain via PowerShell, others: `openssl s_client`)
- **Proxy detection:** WinHTTP config (Windows) + Windows IE/registry proxy settings (Group Policy can set these silently)
- **VS Code settings dump:** `http.proxy`, `http.proxySupport`, `http.fetchAdditionalSupport`, `http.systemCertificates`, `http.noProxy`, `http.proxyStrictSSL`, etc.
- **Env vars:** `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`
- **Conclusion:** a one-line classification — *reachable* (TLS valid), *auth failure* (401/403), *proxy auth* (407), *server error* (5xx), *TLS trust gap* (system native worked, Node didn't), *DNS/TCP failure*, *proxy/config issue*

> **Why both a Node fetch and a system-native fetch?** If Node fetch fails with a TLS error but PowerShell/curl succeeds, that isolates the failure to VS Code's cert loading — typically a missing corporate intermediate. The full error cause is in the report (e.g. `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`).

### Common issues

| Problem | Solution |
|---------|----------|
| Can't connect | Run **Test & Refresh Models**. If it fails, run **Diagnose Connection** on the failing URL. Confirm `vllm serve` is running and the firewall allows the port. |
| Requests fail on a corporate network | Set VS Code's `http.proxy` setting (e.g. `http://proxy.corp:8080`). The extension uses VS Code's patched `globalThis.fetch` (installed by the extension host at startup), which respects `http.proxy`, `http.noProxy`, and the `HTTP(S)_PROXY` environment variables per-request. Loopback hosts are always bypassed. The patched fetch loads the OS certificate store (`http.systemCertificates`, on by default), so TLS-inspecting proxies and internally-issued server certs work without extra setup. The patch is gated by `http.proxySupport` (default `override`) and `http.fetchAdditionalSupport` (default `true`) — both must stay enabled. |
| `fetch failed` / certificate errors behind a proxy | If **Diagnose Connection** shows a TLS trust gap (system native succeeds, Node fetch fails), point `NODE_EXTRA_CA_CERTS` at a PEM containing the corporate root **and** intermediate CAs. Note: `http.proxyStrictSSL: false` does **not** disable TLS verification for fetch (undici always verifies) — use `NODE_EXTRA_CA_CERTS` instead. |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` on a corporate server whose certificate chain is incomplete | This is a **server-side problem** — the server is not sending the intermediate CA in the TLS handshake. SChannel (Windows) and browsers mask it by fetching the intermediate from the OS CA store, but VS Code's patched `globalThis.fetch` (undici/OpenSSL) requires the full chain from the server. See [Known limitations](#known-limitations) below. |
| 401 Unauthorized | The model's `requestHeaders` are wrong — edit the model entry or re-run **Add vLLM Server & Model** |
| No models in picker | Run **Test & Refresh Models**. Verify each model has a `serverUrl` and that `GET /v1/models` returns entries |
| Copilot spins forever | Check Output channel (`View → Output → vLLM-Copilot`) for errors |
| Tool calls fail | Start vLLM with `--enable-auto-tool-choice --tool-call-parser <parser>` |
| Thinking mode doesn't think | Start vLLM with `--reasoning-parser <parser>` |

### Known limitations

#### Third-party extensions cannot bypass TLS CA verification on servers with incomplete certificate chains

If a server sends only its leaf certificate without the intermediate CA — a common misconfiguration on corporate servers — VS Code's patched `globalThis.fetch` (undici/OpenSSL, used by all third-party extensions including this one) will reject the TLS handshake with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `SELF_SIGNED_CERT_IN_CHAIN`, even when the OS, browsers, and VS Code's first-party BYOK Custom Endpoint connect successfully.

This is a **structural disparity in VS Code**, not a bug in this extension:

- **First-party BYOK / Copilot** route through `ElectronFetcher → electron.net.fetch → Chromium net module` (SChannel on Windows), which retrieves missing intermediates from the OS certificate store.
- **Third-party extensions** are restricted to VS Code's patched `globalThis.fetch` (undici + Node's OpenSSL), which requires the server to send the complete chain.

None of the usual client-side workarounds work for the patched fetch:

- `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA=1`, `NODE_OPTIONS=--use-system-ca`
- `tls.setDefaultCACertificates()` (Node v24.5.0+)
- `http.systemCertificates` setting
- `NODE_TLS_REJECT_UNAUTHORIZED=0`

**Resolution options:**

1. **Preferred — fix the server.** Configure the server to send the complete certificate chain (leaf + intermediate). This is a one-line change in Nginx/Apache/IIS and resolves the problem for every client (Node, curl, browsers, BYOK, this extension).
2. **Fallback — use BYOK (Custom Endpoint) until the server is fixed.** BYOK works because it uses Chromium's network stack (SChannel), which tolerates missing intermediates.
3. **Tracked upstream — [microsoft/vscode#325600](https://github.com/microsoft/vscode/issues/325600).** We've filed an issue requesting either a public API for third-party extensions to configure TLS CAs, or routing `globalThis.fetch` through the same transport BYOK uses.

Run **Diagnose Connection** to confirm this is the cause — it compares SChannel vs Node fetch and reports a "TLS trust gap" when system native succeeds but Node fetch fails.

---

## Commands

| Command | Description |
|---------|-------------|
| **Add vLLM Server & Model** | Guided flow: enter a server URL + optional API key/headers, discover its models, then apply a bundled preset (if one fits) or auto-configure from HuggingFace, and save |
| **Test & Refresh Models** | Verify every configured server is reachable, list models. If any connection fails, shows the full error cause and offers to run a deep diagnostic. Also checks VS Code's network gating settings (`http.proxySupport`, `http.fetchAdditionalSupport`, `http.systemCertificates`) and warns if any are non-default |
| **Diagnose Connection** | Deep network diagnostic: compares PowerShell (SChannel) vs Node `fetch` (OpenSSL), checks DNS/TCP, dumps VS Code settings + env vars, builds SChannel cert chain (Windows). Report goes to a dedicated Output channel for copy-pasting |
| **Open Log File** | Open today's debug log |
| **Configure Utility Model** | Switch the utility model used for MCP servers and Copilot agent mode (`mainAgent`, `copilot`, or `none`) |
| **Clear Log Files** | Delete all debug log files (except the currently active one) |

The following appear under the **vLLM-Copilot: Utilities** category — maintenance tools, not daily workflow:

| Command | Description |
|---------|-------------|
| **Diagnose Connection** | Deep network diagnostic: compares PowerShell (SChannel) vs Node `fetch` (OpenSSL), checks DNS/TCP, dumps VS Code settings + env vars, builds SChannel cert chain (Windows). Report goes to a dedicated Output channel for copy-pasting |
| **Clean Copilot Sessions** | Multi-select dialog: pick which workspaces to wipe Copilot sessions from |