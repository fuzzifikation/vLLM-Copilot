# vLLM-Copilot 1.39.0: The harness you were missing, one click from your servers.

Distribution. The DeepSeek Harness has existed for weeks and most of you never heard of it, so it now lives where you already work.

**What DeepSeek Harness means for current vllm-copilot users**
You do not need to install it if you are happy right now. The DSH harness is in early alpha and still testing.
There are maybe hundreds of other DSH extensions in the marketplace. This one is tightly integrated with vLLM-Copilot and needs no sign-in anywhere: no login, no password, no config - not even DeepSeek knows what you are doing locally.
To run it: install the [DeepSeek Harness Bridge](https://marketplace.visualstudio.com/items?itemName=System-Sciences.dsh-bridge), install the harness from its sidebar commands, then click the little whale pill in the status bar - all of your models work in DSH. DSH has full access to VS Code; vLLM-Copilot takes care of the models and their selectability.

<img src="dsh-working.png" alt="DeepSeek Harness running a live session on a vLLM-Copilot model" width="585">

However, not all features are working currently (notably the system prompt extraction and personality replacements) for DSH. 


**A new sidebar section: DeepSeek Harness**, under the Dashboard, behind the **V** icon. Without the bridge it explains the harness and offers **Install DeepSeek Harness Bridge** - the bridge page opens inside VS Code, where Install waits; the command **vLLM-Copilot: Try the DeepSeek Harness (Alpha)** does the same. With the bridge installed, the section becomes its control panel: install or update the harness, start, stop, restart (draining in-flight requests), open a harness view, logs, status, settings. Its rows come from the installed bridge itself, so it can never offer a command that bridge does not have - and installing or uninstalling updates the section without a window reload.

**What the harness is.** Copilot keeps taking controls away, so we stopped waiting. The DeepSeek Harness (DSH) is our replacement for the Copilot agent: it runs inside VS Code with your own vLLM model doing the thinking, takes your models, modes, parameters and personalities along, and lands its usage in the same tracker. In our testing it beats the Copilot harness today. The bridge ([`System-Sciences.dsh-bridge`](https://marketplace.visualstudio.com/items?itemName=System-Sciences.dsh-bridge)) requires this extension and declares it as a dependency - the servers you configured here are the servers it runs on. Alpha, and testers are what it needs.

## If you skipped 1.38

This page opens once per installed version, so for most of you it is the only news you get. What 1.38.0 to 1.39.0 changed, and still holds:

- Sixteen presets for this year's releases - Nemotron-3 and 3.5, Gemma 4, Tencent Hy4, inclusionAI Ling, Qwen3.8, Mistral Large 4 and Small 4, Poolside Laguna, Ornith, StepFun Step-3.5-Flash - each with the thinking-off switch and effort rungs its own chat template accepts, and an output ladder from its documented window. Presets are served live from the repository, so new ones reach you the day they land.
- A mode that is an effort level answers to Microsoft's own name (`none` through `max`), so the picker shows VS Code's wording and the Agents window stops hiding choices it cannot render; a mode that is a behavior keeps its name (`Think-Coding`, `Agent`, `Chat-Fast`). Your entries renamed themselves on the next start, every parameter intact; an older chat needs one mode reselection.
- No preset value is a guess: each came from that model's `chat_template.jinja`, its config files, or one explicit sentence on its card. Where a card gave only a range, the preset sets nothing and your checkpoint keeps authority - which is why Qwen3.8-2.4T and Mistral Large 4 ship no thinking-off mode: both reject a reasoning-off request outright.
- Selecting a mode the model does not offer now falls back to that model's default mode and logs the substitution; before, it applied no mode parameters at all and a thinking model silently stopped thinking.
- Personalities strip Microsoft's boilerplate again, and their rules anchor the prompt wording the Agents window ships today - a rename on Microsoft's side no longer leaves your persona unapplied.
- Local chat stays the complete experience: Output Length needs it, and so does any tool list longer than the 128 tools the Agents window sends for BYOK.

## Microsoft still owes you six fixes

All six have open reports at microsoft/vscode, filed by us. Add your reproduction; Microsoft moves when reports pile up:

- [microsoft/vscode#347351](https://github.com/microsoft/vscode/issues/347351) - the 128-tool ceiling
- [microsoft/vscode#340138](https://github.com/microsoft/vscode/issues/340138) - model modes and Output Length missing from the picker
- [microsoft/vscode#333413](https://github.com/microsoft/vscode/issues/333413) - picker settings stale after an update
- [microsoft/vscode#333802](https://github.com/microsoft/vscode/issues/333802) - subagents reject your BYOK models
- [microsoft/vscode#326597](https://github.com/microsoft/vscode/issues/326597) - historical thinking dropped before we see it
- [microsoft/vscode#321761](https://github.com/microsoft/vscode/issues/321761) - reserved output room ignores your output cap

Everything else that bites you is ours: [report it](https://github.com/fuzzifikation/vLLM-Copilot/issues) and we take it from there.

[Setup and remaining limitations](https://github.com/fuzzifikation/vLLM-Copilot#known-issues)