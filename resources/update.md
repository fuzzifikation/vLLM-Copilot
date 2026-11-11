# vLLM-Copilot 1.39.0: The harness you were missing, one click from your servers.

Distribution. The DeepSeek Harness has existed for weeks and most of you never heard of it, so it now lives where you already work.

**A third section in the vLLM sidebar, under the Dashboard: DeepSeek Harness.** Open it with the **V** icon. If the bridge is not installed, the section says what the harness is and offers **Install DeepSeek Harness Bridge** - that opens the bridge extension page inside VS Code, where Install waits. Command alternative: **vLLM-Copilot: Try the DeepSeek Harness (Alpha)**.

**Once the bridge is installed, the section becomes its control panel.** Install or update the harness, start it, stop it, restart it (draining in-flight requests), open a harness view, show its logs, get its status, open its settings. The rows come from the installed bridge itself, so the sidebar can never offer you a command that extension does not have - and installing or uninstalling the bridge updates the section without reloading the window.

**What the harness is.** Copilot keeps taking controls away, so we stopped waiting. The DeepSeek Harness (DSH) is our replacement for the Copilot agent. It runs inside VS Code, with your own vLLM model doing the thinking. Your models, modes, parameters and personalities come along, and its usage lands in the same tracker. In our testing it beats the Copilot harness today. The bridge (`System-Sciences.dsh-bridge`) needs this extension and declares it as a dependency, so the servers you configured here are the servers it runs on. It is in alpha, and testers are what it needs.

Microsoft still owes you six fixes. All six have open reports at microsoft/vscode, filed by us:

- [microsoft/vscode#347351](https://github.com/microsoft/vscode/issues/347351) - the 128-tool ceiling
- [microsoft/vscode#340138](https://github.com/microsoft/vscode/issues/340138) - model modes and Output Length missing from the picker
- [microsoft/vscode#333413](https://github.com/microsoft/vscode/issues/333413) - picker settings stale after an update
- [microsoft/vscode#333802](https://github.com/microsoft/vscode/issues/333802) - subagents reject your BYOK models
- [microsoft/vscode#326597](https://github.com/microsoft/vscode/issues/326597) - historical thinking dropped before we see it
- [microsoft/vscode#321761](https://github.com/microsoft/vscode/issues/321761) - reserved output room ignores your output cap

Add your reproduction; Microsoft moves when reports pile up. Everything else that bites you is ours: [report it](https://github.com/fuzzifikation/vLLM-Copilot/issues) and we take it from there.

[Setup and remaining limitations](https://github.com/fuzzifikation/vLLM-Copilot#known-issues)