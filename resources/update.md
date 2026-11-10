# vLLM-Copilot 1.38.1: Copilot moved the controls. We adapted.

Microsoft's Copilot enshittification continues. For local vLLM users, "progress" means more harnesses and fewer visible controls. We keep closing the gaps, and we report the causes upstream.

**Model modes appear as effort labels in the Agents window.** Copilot insists on its own labels, but the mode behind each one is yours, with your parameters. Modes without a label stay in **Local** (bottom left of the chat input) and in **Model Settings**.

**We edited your settings file to make that work.** In the Agents window a model must declare which of its modes answers to each label, and your file had no such declaration. On first start after the update we added it and cleaned up the internal mode names. A notification told you how many models were touched. Your own parameters stayed exactly as you set them. Models we did not recognize were left untouched and are listed in the vLLM-Copilot Output channel. One existing chat may need a mode reselection before its readout returns.

Two Agents-window limits are Microsoft's fault, not yours:

- **Output Length is missing.** VS Code drops our picker data, so the menu you configured never arrives. Use **Local** meanwhile. Report: [microsoft/vscode#340138](https://github.com/microsoft/vscode/issues/340138).
- **The Agents window sends at most 128 tools.** VS Code hard-codes that number, and your server never gets asked. The extra tools vanish and the warning blames your model. Switch the chat to **Local** and your whole tool list ships. Report: [microsoft/vscode#347351](https://github.com/microsoft/vscode/issues/347351).

**Your personality works in the Agents window again.** Microsoft renamed that window's system prompt and rewrote its rules. Our replacements match text exactly, so they quietly stopped matching and the model answered as Microsoft's brand instead of yours. All five presets now match the new text, checked against a capture of the live prompt. Main-window chat never broke.

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
