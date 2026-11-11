# vLLM-Copilot 1.39.0: The harness you were missing, one click from your servers.

Distribution. The DeepSeek Harness has existed for weeks and most of you never heard of it, so it now lives where you already work.

**A third section in the vLLM sidebar, under the Dashboard: DeepSeek Harness.** Open it with the **V** icon. If the bridge is not installed, the section says what the harness is and offers **Install DeepSeek Harness Bridge** - that opens the bridge extension page inside VS Code, where Install waits. Command alternative: **vLLM-Copilot: Try the DeepSeek Harness (Alpha)**.

**Once the bridge is installed, the section becomes its control panel.** Install or update the harness, start it, stop it, restart it (draining in-flight requests), open a harness view, show its logs, get its status, open its settings. The rows come from the installed bridge itself, so the sidebar can never offer you a command that extension does not have - and installing or uninstalling the bridge updates the section without reloading the window.

**What the harness is.** Copilot keeps taking controls away, so we stopped waiting. The DeepSeek Harness (DSH) is our replacement for the Copilot agent. It runs inside VS Code, with your own vLLM model doing the thinking. Your models, modes, parameters and personalities come along, and its usage lands in the same tracker. In our testing it beats the Copilot harness today. The bridge (`System-Sciences.dsh-bridge`) needs this extension and declares it as a dependency, so the servers you configured here are the servers it runs on. It is in alpha, and testers are what it needs.

## If you skipped 1.38

This page opens once per installed version, so for most of you it is the only news you get. What 1.38.0 to 1.38.2 changed, and still holds:

- Sixteen presets for this year's releases carry the thinking-off switch and the effort rungs that model's own chat template accepts, plus an output-length ladder sized to its documented window: NVIDIA Nemotron-3 and Nemotron-3.5, Gemma 4, Tencent Hy4, inclusionAI Ling, Qwen3.8, Mistral Large 4 and Small 4, Poolside Laguna, Ornith, StepFun Step-3.5-Flash. Presets are served live from the repository, so your installed extension offers new ones the day they land.
- A mode that is an effort level answers to Microsoft's own name (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), so the picker shows VS Code's wording and the Agents window stops hiding choices it cannot render. A mode that is a behavior keeps its name (`Think-Coding`, `Think-Always`, `Tooling`, `Agent`, `Chat-Fast`). Your entries renamed themselves on the next start with every parameter intact; an older chat needs one mode reselection.
- No preset value is a guess. Each came from that model's `chat_template.jinja`, its `config.json` or `generation_config.json`, or one explicit sentence on its card. Where a card gave only a range, or published no template, the preset sets nothing and your checkpoint keeps authority. Qwen3.8-2.4T and Mistral Large 4 have no thinking-off mode because both reject a reasoning-off request outright.
- Selecting a mode the model does not offer falls back to that model's default mode and logs the substitution. Before 1.38.2 such a selection applied no mode parameters at all, so a thinking model silently stopped sending its thinking flags.
- Personalities strip Microsoft's boilerplate again, and their rules anchor the prompt wording the Agents window ships today, so a rename on Microsoft's side no longer leaves your persona unapplied.
- Local chat stays the complete experience. Output Length needs it, and so does any tool list longer than the 128 tools the Agents window sends for a BYOK request.

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