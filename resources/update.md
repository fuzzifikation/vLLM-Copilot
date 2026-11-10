# vLLM-Copilot: Copilot moved the controls. We adapted.

Microsoft's Copilot enshittification continues. For local vLLM users, "progress" apparently means more harnesses and fewer visible controls.

This update tackles the main compatibility and migration problems:

- Choose **Local**, at the bottom left of the chat input, for the most complete experience.
- In the **Copilot harness and Agents window**, mapped model modes now appear under standard effort labels. Those choices still use your configured model parameters.
- **Output Length selection still requires Local.** We reported the missing support to Microsoft in [microsoft/vscode#340138](https://github.com/microsoft/vscode/issues/340138). Your vLLM server did not misplace the menu.

Recognized settings migrate automatically. Customized configurations are preserved or flagged for review rather than overwritten. Existing chats may need one mode reselection to restore their picker readout.

On a new installation, start with **Add or Reconfigure Server/Model** in the vLLM Dashboard, then choose your model under Copilot's **vLLM-Copilot** tab.

I'm also re-evaluating the system-prompt replacements behind the personalities. That work is underway; refreshed personalities are on their way.

[Setup and remaining limitations](https://github.com/fuzzifikation/vLLM-Copilot#known-issues)
