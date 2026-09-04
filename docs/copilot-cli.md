# Use GitHub Copilot CLI with your vLLM server

GitHub Copilot CLI is GitHub's terminal coding agent: plan mode, autopilot, subagents,
hooks, MCP servers, sandboxing, session resume - the same agent harness you see in the
VS Code Agents ecosystem, running in a plain terminal. And it can run entirely on **your
own vLLM server**, no GitHub-hosted model in the loop.

This is complementary to vLLM-Copilot, not a competitor to it:

| Surface | What talks to your vLLM server |
|---|---|
| VS Code Copilot Chat (ask / edit / agent) | **vLLM-Copilot** (this extension) |
| VS Code Agents window (`Open in Agents`) | **vLLM-Copilot** via Agent Host BYOK ([guide](./agents-window.md)) |
| Terminal agent (`copilot`) | **Copilot CLI BYOK** (this guide) |
| Scripts / CI / your own apps | **Copilot SDK** (see below) |

All three speak OpenAI-compatible HTTP to the same vLLM endpoint you already run.

---

## Quick start (3 environment variables)

The Copilot CLI routes all model traffic to a custom provider when these are set
([official docs](https://docs.github.com/copilot/concepts/agents/about-copilot-cli#using-your-own-model-provider)).
The `openai` provider type works with **any OpenAI-compatible endpoint - vLLM included** (it's
named in GitHub's own docs).

**PowerShell:**

```powershell
$env:COPILOT_PROVIDER_BASE_URL = "http://localhost:8000/v1"
$env:COPILOT_MODEL = "Qwen-Qwen3.8-27B"   # the served model id, required with a custom provider
copilot
```

**bash / zsh:**

```bash
export COPILOT_PROVIDER_BASE_URL="http://localhost:8000/v1"
export COPILOT_MODEL="Qwen-Qwen3.8-27B"
copilot
```

| Variable | Meaning |
|---|---|
| `COPILOT_PROVIDER_BASE_URL` | Base URL of your endpoint - include the `/v1` path for vLLM |
| `COPILOT_PROVIDER_TYPE` | `openai` (default - correct for vLLM), `azure`, or `anthropic` |
| `COPILOT_PROVIDER_API_KEY` | Only if vLLM was started with `--api-key` |
| `COPILOT_MODEL` | Required with a custom provider; also settable via `--model` |

Run `copilot help providers` in your terminal for the full provider reference.

---

## vLLM server requirements

The CLI is an **agent**: unlike chat, it cannot work with a plain text-completion model.

1. **Tool calling (function calling) and streaming are mandatory** - the CLI errors out
   without them. Serve the model with tool support, e.g.:

   ```bash
   vllm serve Qwen/Qwen3-32B \
     --enable-auto-tool-choice \
     --tool-call-parser hermes \
     --max-model-len 131072
   ```

   (Pick the `--tool-call-parser` that matches your model family; see the
   [vLLM tool-calling docs](https://docs.vllm.ai/en/latest/features/tool_calling.html).)

2. **Context window:** GitHub recommends at least **128k tokens** for real agent work -
   agents accumulate file contents, tool results, and reasoning fast. A 32k model technically
   works but will compact sessions constantly.

3. **Reasoning models:** the CLI passes reasoning effort through to bring-your-own-model
   providers (`--reasoning-effort` flag / `/model` picker), which maps naturally onto vLLM
   reasoning parsers.

> **Tip:** the model presets in this repo's `model-configs/` directory document each model's
> context window, output budget, and recommended sampling parameters - the same numbers you
> need when choosing what to serve for the CLI.

---

## Scripting and CI: the Copilot SDK

For headless automation, the [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
drives the same agent from Node.js, Python, Go, Rust, Java, or .NET. Its BYOK docs list
*"Other OpenAI-compatible: vLLM, LiteLLM, etc."* as supported providers:

```typescript
import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient();
const session = await client.createSession({
  model: "Qwen-Qwen3.8-27B",
  provider: {
    type: "openai",
    baseUrl: "http://localhost:8000/v1",
  },
  onPermissionRequest: /* approve/deny policy */,
});
await session.sendAndWait({ prompt: "Fix the failing tests" });
```

That's a full agent loop (tools, file edits, shell) running against your GPU - usable as a
PR bot, a lint fixer, or a refactor robot without per-request cloud fees.

---

## What this does *not* do

- The CLI does **not** read vLLM-Copilot's `vllm-copilot.models` settings - point it at the
  same servers yourself (the env vars above).
- vLLM-specific request-body parameters (chat_template_kwargs, custom stop strings, and the
  rest of this extension's moat) are **not** sent by the CLI - it speaks stock OpenAI
  requests. Fine-tuned per-model behavior stays a vLLM-Copilot feature.
- ACP: the CLI can *also* act as an [ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
  so other agent clients (Zed, etc.) can drive it - again against your endpoint via the same env vars.
