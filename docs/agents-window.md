# Use vLLM models in the Agents window ("Open in Agents")

VS Code's Agents window opens a dedicated space for orchestrating agent sessions across workspaces. Its sessions run in a separate Agent Host process, which does not see extension-provider models unless BYOK and Agents-window support are explicitly enabled.

vLLM-Copilot handles those settings automatically when at least one model is configured. The bootstrap runs during activation and again when the model setting changes, so the first model added after startup follows the same path as models that already existed when the window opened.

| Surface | What talks to your vLLM server |
|---|---|
| VS Code Copilot Chat (ask / edit / agent) | **vLLM-Copilot** - normal chat, everything works |
| **Agents window** (`Open in Agents`, Copilot harness) | **vLLM-Copilot** via Agent Host BYOK (this guide) |
| Terminal agent (`copilot`) | **Copilot CLI BYOK** ([guide](./copilot-cli.md)) |
| Scripts / CI / your own apps | **Copilot SDK** ([guide](./copilot-cli.md#scripting-and-ci-the-copilot-sdk)) |

---

## What the extension sets for you

| Setting | Why |
|---|---|
| `chat.agentHost.byokModels.enabled: true` | Experimental VS Code switch that lets Agent Host sessions use BYOK / extension-provider models. Without it the model picker in the Agents window never asks us for models. |
| `extensions.supportAgentsWindow: { "System-Sciences.vllm-copilot": true }` | The Agents window only activates extensions you opt in by ID; our provider must run there to serve the requests. |

Rules the bootstrap follows:

- **Your explicit values win.** A value you wrote yourself, including `false`, is never overwritten. For `supportAgentsWindow`, only this extension's entry is added and other extensions' entries are preserved.
- **Older VS Code is untouched.** Builds that do not register either setting receive no writes.
- **No empty opt-in.** The helper checks the effective model array and does nothing when no model is configured.
- **Idempotent.** Activation and later model-setting changes may call the helper repeatedly, but explicit values prevent duplicate writes.

## Requirements

1. **VS Code 1.135 or newer** for the current Agents-window extension bridge used by this feature.
2. **A tool-calling model.** Agent sessions hide models that do not declare tool calling. Serve the model with the matching vLLM tool parser and chat template, as described in the [Copilot CLI guide](./copilot-cli.md#vllm-server-requirements).
3. **Roomy context.** Agents accumulate file contents and tool results quickly; 128k or more tokens is recommended.

## Use it

1. Click **Open in Agents** in the title bar or run `Chat: Open Agents Window`. If the Agents window was already open before the extension was enabled, reopen it.
2. Start a new session, select the workspace, and choose the **Copilot** session target.
3. Open the model picker and select one of the vLLM-Copilot models.

Current VS Code versions synchronize the BYOK model bridge to a running Agent Host. A full VS Code restart is not normally required; restarting remains a fallback if an older host or an already open Agents window does not reload the extension opt-in.

![vLLM-Copilot models in the Agents window picker](images/Agents-Window.png)

## Personalities work there too

The Agents window ships its own system prompt (the Copilot CLI runtime prompt,
a different text from classic chat). Your configured **personality preset**
applies there as well: the model gets your persona's voice, the safety block is
replaced by the user-owned security protocol (risks are surfaced to you, you
decide), and the "Co-authored-by: Copilot" commit trailer instruction is
removed. **Default** (no personality) leaves that prompt untouched, as always.
See [Personalities](./custom-system-prompt.md) for the replacement mechanics.

## Fine print

- **Experimental.** Microsoft documents the BYOK bridge as experimental, and Agent Host sessions remain preview functionality. If the picker stays empty after reopening the Agents window, report it to VS Code first.
- **Model Mode / Output Length controls** are rendered by VS Code from provider metadata. Support in the Agents window depends on the host version. Enable `vllm-copilot.enableFileLogging` before blaming the model when a mode appears ignored.
- **Utility tasks** such as titles and commit messages use `chat.byokUtilityModelDefault`, which the extension sets to `mainAgent` unless you chose another value.
- **The Local harness** remains a main-window feature. The Copilot harness with BYOK models is the path for vLLM models in the Agents window.
- Agent Host sessions can use worktree isolation, MCP servers, hooks, and the usual agent customizations. Those are harness features and are outside this extension.
