# vLLM-Copilot 1.38.2: Sixteen models your picker had never heard of.

Presets and mode names. The bytes each mode sends on the wire did not change.

**Sixteen new model presets, every one a 2026 release.** NVIDIA Nemotron-3 (Nano-4B, Super, Ultra) and Nemotron-3.5 (Lightning, Bolt-74B), Google Gemma 4, Tencent Hy4, inclusionAI Ling (3.1-flash, 3.0-flash, 3.0-tiny), Qwen3.8-2.4T-A95B, Mistral Large 4 and Small 4, Poolside Laguna (XS.2, M.1, XS-2.1), Ornith 1.0/1.5 and StepFun Step-3.5-Flash. Thinking on, thinking off, and the effort rungs in between - wherever the model actually has them.

**We did not guess a single value.** Each knob came out of that model's own `chat_template.jinja`, its `config.json` or `generation_config.json`, or one explicit sentence on its card. Where a card gave only a range, or published no template at all, the preset sets nothing and your checkpoint keeps authority. That is also why some of these have no "think less" mode: Qwen3.8-2.4T and Mistral Large 4 reject a reasoning-off request outright, Step-3.5-Flash has no switch to press at all, and NVIDIA's Ultra card demands thinking with non-empty content whenever tools are sent - and Copilot always sends tools.

**Qwen3.8 got the Low rung it always supported.** The 27B and Flash-Next presets offered xhigh and medium, so the mode list never showed Low although the template accepts it. It is there now, and it answers Copilot's Low choice.

**Reasoning rungs are now named the way Copilot names them.** A mode that *is* an effort level takes Microsoft's own value - `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` - so the picker shows VS Code's wording for it (*Extra High*, *Balanced reasoning and speed*) and the Agents window stops hiding choices it cannot render. Calling the same thing `Think-High` and translating it to `high` afterwards was a lookup for nothing. Modes that are a behavior rather than a rung keep their names: `Think-Coding`, `Think-Science`, `Think-Always`, `Tooling`, `Agent`, `Chat-Fast`. Your existing entries rename themselves on the next start with every parameter intact, and a parameter every mode shared now lives in the preset's `defaultParams` once instead of being copied into each mode. Open a chat you had before and pick the mode once if its tick mark went missing.

**You do not need this update for the presets.** They are served live from the repository, so your installed extension offers them the day they land when you add a model. The VSIX carries the same files for offline use.

New installation: **Add or Reconfigure Server/Model** in the vLLM Dashboard, then pick your model under Copilot's **vLLM-Copilot** tab.

Microsoft still owes you six fixes. All six have open reports at microsoft/vscode, filed by us:

- [microsoft/vscode#347351](https://github.com/microsoft/vscode/issues/347351) - the 128-tool ceiling
- [microsoft/vscode#340138](https://github.com/microsoft/vscode/issues/340138) - model modes and Output Length missing from the picker
- [microsoft/vscode#333413](https://github.com/microsoft/vscode/issues/333413) - picker settings stale after an update
- [microsoft/vscode#333802](https://github.com/microsoft/vscode/issues/333802) - subagents reject your BYOK models
- [microsoft/vscode#326597](https://github.com/microsoft/vscode/issues/326597) - historical thinking dropped before we see it
- [microsoft/vscode#321761](https://github.com/microsoft/vscode/issues/321761) - reserved output room ignores your output cap

**We are building our own agent harness, inside VS Code.** Copilot keeps taking controls away, so we stopped waiting. The DeepSeek Harness (DSH) is our replacement for Copilot's agent. It runs inside VS Code, with your own vLLM model doing the thinking. Your models, modes, parameters and personalities come along, and its usage lands in the same tracker. In our testing it beats Copilot's harness today. It is in alpha, and we need testers. Open an [issue in this repository](https://github.com/fuzzifikation/vLLM-Copilot/issues) and say you want to test DSH.

Add your reproduction; Microsoft moves when reports pile up. Everything else that bites you is ours: [report it](https://github.com/fuzzifikation/vLLM-Copilot/issues) and we take it from there.

[Setup and remaining limitations](https://github.com/fuzzifikation/vLLM-Copilot#known-issues)
