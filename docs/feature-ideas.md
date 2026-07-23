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

## ✨ Last Request Details Dashboard Entry

> **Category:** Dashboard / observability — a "vitamin" that gives users immediate feedback on the last chat completion without digging into logs. Built on the `usage` object vLLM returns at end of every stream.

**What happens today:** After every chat-completion request, vLLM returns a `usage` block with `prompt_tokens`, `completion_tokens`, `total_tokens`, `reasoning_tokens`, `cached_tokens`, `prompt_time`, `decode_time`, and `num_prompt_tokens`. The extension currently tracks this for token-budget bookkeeping but never surfaces it to the user in the sidebar.

**What it does:** A collapsible tree node in the Dashboard showing the last request's token breakdown per model, sorted by input and output tokens, with a timestamp and "time to first token" (TTFT).

**Feature idea:** Add a **"Last Request Details"** node under each server in the Dashboard tree. Each row shows one completed request with:

- **Model ID** — `vllmModelId` (the server-side alias, not the preset name)
- **Timestamp** — when the request finished (relative, e.g. "2 min ago")
- **Input tokens** — `prompt_tokens` (expanded: cached tokens, reasoning tokens if applicable)
- **Output tokens** — `completion_tokens` (expanded: reasoning tokens, decode tokens)
- **TTFT** — `prompt_time` or derived from response metadata
- **Latency / throughput** — total time and tokens/sec (derived from `decode_time` + `completion_tokens`)

**VS Code use cases:**
- **Token budget sanity-check:** "Why is my context window so small?" → see the input token count
- **Cached prefix awareness:** "Is the prefix cache actually helping?" → compare `cached_tokens` across requests
- **Model comparison:** "Does model A use more tokens than model B for the same prompt?"
- **Debugging slow responses:** High TTFT vs. low throughput tells you whether the bottleneck is prefill or decode

**Why it matters:** The dashboard already shows server-level throughput and queue depth. Adding per-request token details gives users the missing "micro" view — why did *my* last request take that long and cost that many tokens? This is something BYOK never shows.

**Implementation:**
- Store the last N request-usage objects per model (in-memory or `ExtensionContext.storagePath`; N = 1 or 10, TBD)
- Parse `usage` from the end-of-stream `WireUsage` in `streamReader.ts` → `sseParser.ts`
- Add a `LastRequestTreeItem` class (following `ServerTreeItem` / `MetricTreeItem` pattern)
- Auto-purge entries older than a configurable threshold (default: 10 minutes; `vllm-copilot.dashboard.lastRequestRetentionMs`)
- Collapse by default; expand to show sorted rows (by `total_tokens` or timestamp)
- One row per model, or one row per recent request (design decision pending)

**Open questions:**
- **How many entries to keep?** Last one only (lightweight) vs. last N (e.g. 10) for comparison. More entries = more tree items = more UI clutter.
- **Per-model or per-server?** Group under the server node that served the request (model is shown in the row).
- **Persistence?** In-memory only (resets on reload) vs. persisted to `storagePath` (survives reload but adds I/O).
- **Should this integrate with the Deep-Dive view?** Deep-Dive already shows raw Prometheus metrics; a "recent requests" table could live there too.

---

## Currently Exposed via KNOWN_PARAMS ✅

These params are available in the Server Settings UI (`KNOWN_PARAMS` in `serverSettingsView.ts`) and also work via `defaultParams`/`modelModes`:

| Param                                                         | Type                | Notes             |
| ------------------------------------------------------------- | ------------------- | ----------------- |
| `temperature`, `top_p`, `top_k`, `min_p`                      | number              | Sampling control  |
| `repetition_penalty`, `presence_penalty`, `frequency_penalty` | number              | Penalty control   |
| `max_tokens`, `min_tokens`                                    | number              | Output length     |
| `stop`                                                        | json (array)        | Stop sequences    |
| `seed`                                                        | number              | Reproducibility   |
| `skip_special_tokens`                                         | string (true/false) | Output formatting |
| `chat_template_kwargs`                                        | json                | Template control  |
| `reasoning_effort`                                            | string (options)    | Thinking depth    |
| `parallel_tool_calls`                                         | string (true/false) | Tool calling      |

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
| `logprobs`                      | Logprobs           | Token confidence display. Requires UI for visualization (diagnostics, decorations).                                           |
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
