# Feature Ideas: vLLM Capabilities → Better VS Code Experience

**Generated:** 2026-06-06
**Updated:** 2026-07-21 (consolidated; shipped items removed or marked done)
**Source:** [vLLM SamplingParams API Reference](https://docs.vllm.ai/en/latest/api/vllm/sampling_params.html)

**Context:** vLLM supports many per-request sampling parameters that the extension doesn't expose yet. These represent opportunities to build features that VS Code's built-in Copilot doesn't have — making vLLM-Copilot the superior local model integration.

> **Tracking:** Only two docs are maintained: this file (new ideas) and [known-bugs.md](../known-bugs.md) (real bugs and nice-to-have refactors). There is no consolidated roadmap.

---

## The Moat: What Makes This Extension Irreplaceable

VS Code's built-in BYOK (Custom Endpoint provider) now covers plain chat, tool calling, vision, streaming, and a thinking-effort picker. Verified against the VS Code source (`extensions/copilot/src/extension/byok/`), the **only** thing BYOK structurally _cannot_ do is send arbitrary request-body parameters:

- `modelOptions` is hard-limited to `temperature` and `top_p` — any other keys are silently dropped.
- `reasoningEffortFormat` only emits a fixed `reasoning_effort` enum; it cannot produce `chat_template_kwargs.enable_thinking`.
- `requestHeaders` touches HTTP headers only, never the body.
- There is no body-passthrough field anywhere in its schema.

**Every feature that sends a vLLM-specific request-body param is therefore something BYOK can never replicate. That is the moat.**

Two buckets:

- 🛡️ **Painkillers (the moat)** — sampling / structured-output params BYOK literally cannot send. These make the extension _irreplaceable_.
- ✨ **Vitamins (on-brand, but replaceable)** — informational / UX features like the Server Status UI and the Model Configuration UI. Genuinely differentiating and worth building, but Microsoft could add equivalents.

> **Fixed.** All six vLLM-specific params (`response_format`, `bad_words`, `structured_outputs`, `repetition_detection`, `ignore_eos`, `min_tokens`) now have `KNOWN_PARAMS` UI entries.

---

## ✅ Custom System Prompt Override

**Done.** Solved by **Model Personalities** (`setModelPersonality` command with predefined presets) and **System Message Replacements** (`systemMessageReplacementsFile` for custom find/replace rules). Users can control what the model sees without full prompt replacement.

---

## ✅ Server Status Dashboard

**Done.** Shipped as a native VS Code Tree View (not a webview). Polls `/metrics`, shows per-server health, loaded models, KV cache, running/waiting requests, TTFT/TPOT, cache hit rate, preemptions, and evictions. Configurable poll interval.

---

## ✅ Last Request Details Dashboard Entry

**Done.** Shipped as a collapsible tree node under each server in the Dashboard. Shows model ID, relative timestamp, input/output tokens, cached tokens, reasoning tokens, and timing metrics (TTFT, generation time, throughput). Displays a hint suggesting `--enable-prompt-tokens-details` and/or `--enable-per-request-metrics` when those server flags aren't set.

## Currently Exposed via KNOWN_PARAMS ✅

These params are available in the Server Settings UI (`KNOWN_PARAMS` in `serverSettingsView.ts`) and also work via `defaultParams`/`modelModes`:

| Param                                                         | Type                | Notes             |
| ------------------------------------------------------------- | ------------------- | ----------------- |
| `temperature`, `top_p`, `top_k`, `min_p`                      | number              | Sampling control  |
| `repetition_penalty`, `presence_penalty`, `frequency_penalty` | number              | Penalty control   |
| `max_tokens`, `min_tokens`                                    | number              | Output length     |
| `stop`                                                        | json (array)        | Stop sequences    |
| `response_format`                                             | json                | Output format     |
| `seed`                                                        | number              | Reproducibility   |
| `skip_special_tokens`                                         | string (true/false) | Output formatting |
| `parallel_tool_calls`                                         | string (true/false) | Tool calling      |
| `chat_template_kwargs`                                        | json                | Template control  |
| `reasoning_effort`                                            | string (options)    | Thinking depth    |
| `bad_words`                                                   | json                | Blocked tokens    |
| `structured_outputs`                                          | json                | Token constraints |
| `repetition_detection`                                        | json                | N-gram early-stop |
| `ignore_eos`                                                  | string (true/false) | Ignore EOS        |

(All params supported via `defaultParams`/`modelModes` now also have `KNOWN_PARAMS` UI entries.)

---

## Not Exposed — 12 Remaining Parameters

These params are defined in vLLM's `SamplingParams` but not exposed by the extension:

| Param                           | Type               | Category           | Interest                                        |
| ------------------------------- | ------------------ | ------------------ | ----------------------------------------------- |
| `allowed_token_ids`             | `list[int]`        | Logits Processing  | 🔧 P4 — specialized vocabulary restriction      |
| `detokenize`                    | `bool`             | Output Formatting  | 🔧 P5 — debug only                              |
| `extra_args`                    | `dict[str, Any]`   | Plugin/Custom      | 🔧 P5 — forward compat hook                     |
| `flat_logprobs`                 | `bool`             | Logprobs/Perf      | 🔧 P5 — needs logprobs first                    |
| `include_stop_str_in_output`    | `bool`             | Output Formatting  | 🔧 P3 — minor convenience                       |
| `logit_bias`                    | `dict[int, float]` | Logits Processing  | 💡 P2 — token steering (power users)            |
| `logprob_token_ids`             | `list[int]`        | Logprobs/Scoring   | 💡 P2 — needs logprobs first                    |
| `logprobs`                      | `int`              | Logprobs/Scoring   | 💡 P2 — token confidence (needs UI for display) |
| `n`                             | `int`              | Generation Control | 💡 Future — blocked on Copilot API              |
| `prompt_logprobs`               | `int`              | Logprobs/Prompt    | 🔧 P4 — prompt analysis                         |
| `routed_experts_prompt_start`   | `int`              | Experts/Routing    | 🔧 P5 — MoE niche                               |
| `spaces_between_special_tokens` | `bool`             | Output Formatting  | 🔧 P5 — formatting tweak                        |
| `stop_token_ids`                | `list[int]`        | Generation Control | 💡 P2 — precise stop control                    |

All are niche or debugging-focused. No P1 (high-impact, general-purpose) features remain.

---

## Remaining Ideas (all P2–P5, niche)

All 12 remaining params are specialized. None are P1 (high-impact, general-purpose).

| Param                           | Category           | Notes                                                                                                                         |
| ------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `n`                             | Generation Control | **Blocked** — Chat Provider API can't render parallel outputs. Would need `InlineCompletionItemProvider` + `/v1/completions`. |
| `logprobs`                      | Logprobs           | **See below** — Logprob Viewer (P2, researched)                                                          |
| `prompt_logprobs`               | Logprobs           | Input token analysis. Dependent on logprobs infrastructure.                                                                   |
| `flat_logprobs`                 | Logprobs           | Perf optimization. Dependent on logprobs infrastructure.                                                                      |
| `logprob_token_ids`             | Logprobs           | Targeted scoring. Dependent on logprobs infrastructure.                                                                       |
| `logit_bias`                    | Logits Processing  | Token steering. Requires tokenizer access to convert strings → IDs.                                                           |
| `stop_token_ids`                | Generation Control | Precise stop control. Tokenizer-dependent.                                                                                    |
| `allowed_token_ids`             | Logits Processing  | Vocabulary restriction. Tokenizer-dependent.                                                                                  |
| `include_stop_str_in_output`    | Output Formatting  | Simple boolean toggle. Minor convenience.                                                                                     |
| `detokenize`                    | Output Formatting  | Debug-only. Rarely useful.                                                                                                    |
| `extra_args`                    | Plugin/Custom      | Forward-compat hook. No validation.                                                                                           |
| `routed_experts_prompt_start`   | Experts/Routing    | MoE niche.                                                                                                                    |
| `spaces_between_special_tokens` | Output Formatting  | Formatting tweak. Minor.                                                                                                      |

**Common theme:** Logprobs and logits-processing params are interesting but require tokenizer access or new UI infrastructure to be useful. Output formatting params are debugging-only.

---

## 💡 Logprob Viewer (P2 — Researched)

> **Category:** Token confidence visualization — a power-user feature that makes the extension irreplaceable. BYOK cannot send `logprobs` in the request body, so this is pure moat.

**What it does:** Shows per-token confidence scores for the last request, color-coded from confident (green) to uncertain (red), covering both reasoning tokens and final output tokens.

**Why it matters:**
- **Debug model quality:** "Why did it generate this wrong answer?" → see where confidence dropped
- **Compare models:** "Which model is more confident in this output?"
- **Reasoning transparency:** See where the model was uncertain **during its thinking process**, not just in the final answer
- **Prompt analysis:** Check if the model actually paid attention to your system prompt

**What vLLM returns (per token):**
```
{
  "token": "hello",
  "logprob": -0.012,        // ~99.8% confident
  "top_logprobs": [
    { "token": "hello", "logprob": -0.012 },
    { "token": "hi", "logprob": -2.34 },
    { "token": "hey", "logprob": -3.11 }
  ]
}
```

**What vLLM returns (reasoning tokens):**
- ✅ Reasoning CONTENT tokens get logprobs
- ❌ Hidden reasoning delimiters (`<think>`, `</think>`) have logprobs suppressed
- Content tokens get logprobs as usual

**Why a webview (not chat window):**
- VS Code chat markdown renderer strips inline HTML (`<span style="...">`)
- KaTeX works because it's an explicit markdown plugin
- Webview gives full CSS control for color-coded rendering
- Follows existing Deep-Dive webview pattern
- Keeps streaming intact in chat (no buffering needed)

**Implementation plan:**
1. Add `logprobs` to `KNOWN_PARAMS` (number field: top N candidates per token)
2. Capture logprobs from SSE stream alongside usage/metrics
3. Store in `lastRequestStore` alongside token counts and timing
4. Dashboard shows "Token Confidence" node under Last Request
5. Clicking opens Logprob Viewer webview with color-coded output
6. Separate sections for reasoning tokens and content tokens

**Open questions:**
- **How much data to store?** Logprobs can be large (top N candidates × tokens). Last request only, or configurable?
- **Color scheme?** Green→yellow→red gradient? Or configurable?
- **Show top alternatives?** Just the chosen token + confidence, or the top 3 candidates?
- **Integrate with Deep-Dive?** Or standalone webview? Could complement the metrics view.

**Effort:** Medium-high. Requires new webview, stream capture changes, and storage in `lastRequestStore`. But the moat value is significant — BYOK literally cannot do this.
