# BIG NEWS: the DeepSeek Harness is built into this extension.

The agent harness that used to be a separate extension now lives here. It runs the servers and models you configured in this extension, in a tab, with no vendor login - and every request it makes lands in your dashboard totals like any other model.

**Open a folder, then press Install DeepSeek Harness…** in the **DeepSeek Harness** section under the **V** icon. It checks Node.js 24.9.0+, `npm` and `pnpm` and names what is missing, downloads the certified harness once (a few minutes; later starts take seconds), and opens the agent. The folder you have open is the project it works on: sessions start there, and its tools read your files and diagnostics and drive your terminal.

**Used the DeepSeek Harness Bridge extension? Uninstall it, then reload this window.** Until it is gone, vLLM-Copilot refuses to run its own harness. Nothing of yours is deleted and nothing is migrated: your old sessions stay in the bridge's folder, and the settings were renamed to `vllm-copilot.harness.*`, so set them again.

**No Copilot? Same story.** In VSCodium or any editor without it, install this extension from Open VSX, add a model, install the harness: a complete agent on your own servers.

**Don't want it? It stays out of your way.** Nothing exists on disk until you press Install - no folders, no status-bar pill, no timers, no notifications.

**VS Code 1.140 is the new minimum**, the harness's floor, because this extension supports current editor versions only.

<img src="https://github.com/fuzzifikation/vLLM-Copilot/raw/main/resources/dsh-working.png" alt="DeepSeek Harness running a live session on a vLLM-Copilot model" width="585">

## Microsoft still owes you five fixes

Five of the six reports we filed are still open at microsoft/vscode. Add your reproduction; Microsoft moves when reports pile up:

- [microsoft/vscode#347351](https://github.com/microsoft/vscode/issues/347351) - the 128-tool ceiling
- [microsoft/vscode#340138](https://github.com/microsoft/vscode/issues/340138) - model modes and Output Length missing from the picker
- [microsoft/vscode#333802](https://github.com/microsoft/vscode/issues/333802) - subagents reject your BYOK models
- [microsoft/vscode#326597](https://github.com/microsoft/vscode/issues/326597) - historical thinking dropped before we see it
- [microsoft/vscode#321761](https://github.com/microsoft/vscode/issues/321761) - reserved output room ignores your output cap

One is fixed: [microsoft/vscode#333413](https://github.com/microsoft/vscode/issues/333413) - the picker read model settings from a stale snapshot, so a new **Output Length** menu needed a config write before it showed. VS Code 1.140.0 asks the provider for its live registration instead, so the menu appears by itself. 1.140.0 is this extension's minimum, so you already have the fix.

Everything else that bites you is ours: [report it](https://github.com/fuzzifikation/vLLM-Copilot/issues) and we take it from there.

[Setup and remaining limitations](https://github.com/fuzzifikation/vLLM-Copilot#known-issues)