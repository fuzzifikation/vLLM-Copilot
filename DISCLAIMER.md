# Disclaimer

vLLM-Copilot is MIT-licensed software, provided as-is. This page states what that means in practice. Using the extension means you accept it. The [MIT license](LICENSE) is the grant; this page does not add rights and does not take that disclaimer away.

## What this extension does not do

This extension does not protect anyone from misuse, by a human or by a model.

It does not provide security or safety guardrails. It does not filter prompts, model output, tool calls, or agent actions for harm, legality, policy, or fitness for any purpose. GitHub Copilot may inject safety or identity rules; personality presets other than Default strip those rules on purpose. After that, the model runs as you configured it. You own the policy.

It cannot guarantee the absence of bugs. Bugs can cause data loss, security problems, unsafe tool use, broken production systems, or other unintended consequences.

## Language models

Language models produce incorrect, unsafe, biased, or malicious output. They can also misuse this extension: they may drive Copilot tools, edit or delete files, run commands, exfiltrate context to the inference server you configured, and act inside the VS Code Agents window or Copilot CLI with whatever permissions that environment has. This extension does not stop them, sandbox them, or review their actions.

## Your responsibility

You choose the servers, keys, models, personalities, parameters, and backends. You review output before you trust it. You own access control, secrets, compliance, production change control, and whatever a model does with tools in your workspace. You are in charge, and you are fully responsible.

## Source

The source is public: [https://github.com/fuzzifikation/vLLM-Copilot](https://github.com/fuzzifikation/vLLM-Copilot). You can inspect the code, this disclaimer, and the MIT license before you install or use the extension. Installing or using it is your choice.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS, COPYRIGHT HOLDERS, OR CONTRIBUTORS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
