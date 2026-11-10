# Bundled Model Configs

Ready-to-use model configurations shipped with the extension. **Add or Reconfigure Server/Model** applies a preset automatically when the model id or server root matches.

| File | Model | Modes | Vision | Thinking |
|------|-------|-------|--------|----------|
| `Agents-A1-config.json` | Agents-A1 (InternScience) | Think-General, Think-Coding, Think-Science, `none` | ✅ | ✅ |
| `Qwen-Qwen3.6-27B.json` | Qwen3.6-27B | Think-General, Think-Coding, `none` | ✅ | ✅ |
| `Qwen-Qwen3.6-35B-A3B.json` | Qwen3.6-35B-A3B | Think-General, Think-Coding, `none` | ✅ | ✅ |
| `Qwen-Qwen3.8-27B.json` | Qwen3.8-27B | `xhigh`, `medium`, `low`, `none` | ✅ (image + video) | ✅ |
| `Qwen-Qwen3.8-Flash-Next.json` | Qwen3.8-Flash-Next | `xhigh`, `medium`, `low`, `none` | ✅ | ✅ |
| `Poolside-Laguna-S-2.1.json` | Laguna-S-2.1 (Poolside) | Think-General, Think-Code, `none` | ❌ | ✅ |
| `Tencent-Hy3-config.json` | Hy3 (Tencent) | `high`, `low`, `none` | ❌ | ✅ |
| `DeepSeek-V4-Flash.json` | DeepSeek V4 Flash | `max`, `high`, `none` | ❌ | ✅ |
| `DeepSeek-V4-Pro.json` | DeepSeek V4 Pro | `max`, `high`, `none` | ❌ | ✅ |
| `DeepSeek-V4.1-Flash.json` | DeepSeek V4.1 Flash | `max`, `xhigh`, `none` | ✅ | ✅ |
| `Kimi-K3.json` | Kimi K3 (Moonshot) | `max`, `high`, `low` | ✅ | ✅ (always on) |
| `Kimi-K3.1-Pro.json` | Kimi K3.1 Pro (Moonshot) | `max`, `high`, `low` | ✅ | ✅ (always on) |
| `MiniMax-M3.json` | MiniMax M3 | Think-Always, Think-Adaptive, `none` | ✅ | ✅ |
| `MiniMax-M3.1-Flash.json` | MiniMax M3.1-Flash | `max`, `xhigh`, `high`, `medium`, `low` | ✅ (image + video) | ✅ (adaptive, effort hint) |
| `glm-5.2-config.json` | GLM-5.2 (Z-AI) | `max`, `high`, `none` | ❌ | ✅ |
| `GLM-5.3.json` | GLM-5.3 (Z.ai, full) | `max`, `high`, `low` | ❌ | ✅ (always on) |
| `GLM-5.3-Flash.json` | GLM-5.3-Flash (Z.ai) | `max`, `high`, `low` | ✅ | ✅ (always on) |
| `XiaomiMiMo-MiMo-V2.6-RL.json` | MiMo-V2.6 Flash-RL / Pro-RL (Xiaomi, one preset for both + quants) | `high`, `none` | ✅ | ✅ (binary on/off) |
| `Qwen-Qwen3.8-2.4T-A95B.json` | Qwen3.8-2.4T-A95B (Qwen, open base of hosted Max) | `xhigh`, `medium`, `low` | ❌ | ✅ (always on) |
| `Ornith-1.0-1.5.json` | Ornith 1.0 / 1.5 (ornith-ai, one preset for both generations) | `high`, Think-Code, `none` | ✅ | ✅ |
| `NVIDIA-Nemotron-3-Nano-4B.json` | Nemotron-3 Nano-4B (NVIDIA) | `high`, Tooling, `none` | ❌ | ✅ |
| `NVIDIA-Nemotron-3-Super.json` | Nemotron-3 Super 120B-A12B (NVIDIA) | `high`, `low`, `none` | ❌ | ✅ |
| `NVIDIA-Nemotron-3-Ultra.json` | Nemotron-3 Ultra 550B-A55B (NVIDIA) | `high`, `medium` | ❌ | ✅ (required with tools) |
| `NVIDIA-Nemotron-3.5-Lightning.json` | Nemotron-3.5 Lightning 30B-A3B (NVIDIA) | `high`, `none` | ❌ | ✅ |
| `NVIDIA-Nemotron-3.5-Bolt.json` | Nemotron-3.5 Bolt 74B-A9B (NVIDIA) | `high`, `medium`, `none` | ✅ | ✅ |
| `Google-Gemma-4.json` | Gemma 4 31B / 26B-A4B / E4B / E2B (Google; 12B unpublished template) | `high`, `none` | ✅ | ✅ (off by default upstream) |
| `Tencent-Hy4.json` | Hy4 (Tencent) | `high`, `none` | ❌ | ✅ |
| `InclusionAI-Ling-3.1-flash.json` | Ling-3.1-flash and Ling-3.1-flash-1019 (InclusionAI) | `high`, `none` | ❌ | ✅ |
| `InclusionAI-Ling-3.0-flash.json` | Ling-3.0-flash (InclusionAI) | `high`, `none` | ❌ | ✅ |
| `InclusionAI-Ling-3.0-tiny.json` | Ling-3.0-tiny (InclusionAI) | `high`, `none` | ❌ | ✅ |
| `Mistral-Large-4.json` | Mistral Large 4 (Mistral AI) | `high`, `medium`, `low` | ✅ | ✅ (always on) |
| `Mistral-Small-4.json` | Mistral Small 4 (Mistral AI) | `high`, `none` | ✅ | ✅ |
| `Poolside-Laguna-XS-M.json` | Laguna XS.2 / M.1 / XS-2.1 (Poolside — no `preserve_thinking` on these) | `high`, `none` | ❌ | ✅ |
| `StepFun-Step-3.5-Flash.json` | Step 3.5 Flash (StepFun) | Agent, Chat-Fast | ❌ | ✅ (always on) |

To apply a preset manually, merge its **`config`** fields into an existing entry in your `vllm-copilot.models` array (no reload needed). Preserve that entry's `id`, `server` and optional `vllmModelId`; a preset never supplies model identity. The surrounding `presetVersion`/`match`/`meta` envelope is preset-format only, not user settings.

Model provenance contains `source`, `verified` and `notes`. The picker name belongs in `config.displayName`, not in a second metadata name.

## Mode identifiers and migration

A mode identifier is the value the Copilot harness round-trips back to us, so a mode that **is** one of the model's reasoning rungs takes the harness's own effort token and nothing else. VS Code then renders its own wording for that choice, on every host, with no translation table:

| Token | Picker label (VS Code's wording) | Hover text |
|---|---|---|
| `none` | None | No reasoning applied |
| `minimal` | Minimal | Minimal reasoning for fastest responses |
| `low` | Low | Faster responses with less reasoning |
| `medium` | Medium | Balanced reasoning and speed |
| `high` | High | Greater reasoning depth but slower |
| `xhigh` | Extra High | Highest reasoning depth but slowest |
| `max` | Max | Absolute maximum capability with no constraints |
| `ultra` | Ultra | none upstream |

Verified against VS Code source (`extensions/copilot/src/extension/conversation/common/languageModelAccess.ts`, read 2026-11): those eight values are the whole harness vocabulary - seven with labels and hover text, plus `ultra`, which the Agent-Host model router accepts while VS Code itself only capitalizes it. There is no `light`.

Calling a rung `Think-High` and mapping it to `high` bought nothing: same effort on the wire, one more translation, and a label the Agents window refused to render (it shows effort values, not unknown strings). So a rung carries its token. Two rules follow, and a Vitest law enforces both on every shipped preset:

- **The name cannot lie.** A mode that sends an explicit effort - `reasoning_effort` at top level or inside `chat_template_kwargs` - is named exactly that value; the template's `no_think` counts as `none`. DeepSeek V4.1 Flash therefore names its 75-tier mode `xhigh` rather than `high`, because vLLM's `deepseek_v41` tokenizer maps `high` to 50 and `xhigh` to 75.
- **A behavior keeps a name.** Modes that are not rungs - a domain profile (`Think-Coding`, `Think-Science`), a template that only flips thinking on or off (`Think-Always`, `Think-Code`, `Tooling`, `Agent`, `Chat-Fast`) - keep descriptive identifiers, because *High* would tell the user nothing about what they picked. A lighter rung implemented as a chat-template kwarg instead of a `reasoning_effort` value (NVIDIA's `low_effort` / `medium_effort`) is still that rung, so it still carries the token.

Identifiers stay case-preserving ASCII letters, digits and hyphens. Parameters that every mode shares belong in `defaultParams` once, not repeated per mode: resolution is built-in defaults → `defaultParams` → selected mode. That merge is a shallow per-key `Object.assign`, so `chat_template_kwargs` moves up only when every mode sends an identical object; one differing key keeps the whole object in each mode.

Version 1.38.0 automatically migrates recognized legacy names, their `defaultMode` references and existing harness mapping targets. It preserves customized request parameters, model identity, budgets, personalities and custom mode names. The only parameter repairs are exact matches of the known old DeepSeek V4 Pro off-mode and Agents-A1 preservation definitions; customized variants are kept for manual review. A notification explains which changes occurred. Names that were never rung labels (`Think-Deep`, `Think-Balanced`, `Think-Light`, `Think-Always`, `Think-Adaptive`) are deliberately left alone: `Think-Deep` answers `xhigh` on Qwen3.8 and `high` on Hy3, so a global rename would publish a number that contradicts the request. The same check protects existing entries - a rename into a token is skipped when the mode's own parameters send a different effort.

User, workspace and folder overrides have distinct completion markers. A failed or incomplete bundled-catalogue load cannot record completion; catalogue or settings-write failures retry on the next start.

Missing harness mappings are added only when a bundled preset matches and the saved effective reasoning/template controls agree with that preset. Sampling and output-budget customizations are kept. Collisions, invalid mappings and ambiguous controls are left for manual review with warnings in Output. OpenRouter modes get the identifier rename, but no HF preset mapping is invented for them.

## Copilot harness mapping

Mapping is the exception, not the rule: it exists only to point an effort value at a *descriptively named* mode. Six presets use it - `Agents-A1`, `Qwen-Qwen3.6-27B`, `Qwen-Qwen3.6-35B-A3B`, `Poolside-Laguna-S-2.1`, `MiniMax-M3` and `Step-3.5-Flash` - each with a single `"high": <default mode>` alias, so the harness's High choice lands on the authors' recommended thinking mode. Effort keys are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; values name existing modes. Local retains the descriptive labels and unaliased modes; the Copilot harness shows its standard effort label. The mapping itself never reaches the server.

An **identity entry is forbidden**: `{ "none": "none" }` restates what a token-named mode already does, so it is dead config. The migration drops such entries when it rewrites a user's mapping, and the preset test rejects them. Targets must exist and appear only once, and an effort key must not also name a different mode. Invalid mappings produce a configuration warning and a picker warning, and the extension retains the original Local choices instead of guessing aliases. With no mapping, mode behavior is unchanged - a token-named mode publishes itself.

Models whose template forbids thinking-off get no `none` mode at all: Mistral Large 4 and Step 3.5 Flash raise on it, Qwen3.8-2.4T-A95B raises on `enable_thinking: false`, and Nemotron-3 Ultra must keep thinking on whenever tools are sent, which Copilot always does.

The 2026-11-10 settings audit checked the current model cards, configs, generation defaults, available chat templates and applicable vLLM recipes. Poolside leaves sampling to the checkpoint defaults, as its [current NVFP4 card](https://huggingface.co/poolside/Laguna-S-2.1-NVFP4#sampling) recommends; both thinking presets remain available. DeepSeek V4 Pro's `none` mode explicitly disables reasoning. Agents-A1 no longer sends the ignored `preserve_thinking` option; its official template retains reasoning only within the current turn.

The migration adds compatible mappings to existing configured models; unresolved cases need a manual mapping or Auto-Configure. It does not reapply new sampling recommendations, including Poolside's checkpoint-default change. Existing chats' old mode selections resolve to the new identifiers, but VS Code may omit the picker readout and checkmark until the mode is selected once again. Released extensions without the new allowlist entry reject these updated remote presets and fall back to their bundled copies. Publish the preset changes only with supporting extension code.

## Presets are served live

Beyond shipping inside the VSIX, the presets in this directory are served **live**: when you add a model, the extension checks [index.json](index.json) on GitHub and offers a matching preset - including brand-new ones - with provenance (what it does, source, verification date) before you confirm. A preset pushed to `main` reaches every user the same day, no VSIX release needed. Offline or blocked? Bundled presets, exactly as before.

For maintainers:

- Every preset uses the **v2 envelope**: `presetVersion` / `match` (match patterns) / `meta` (provenance, displayed) / `config` (the loadable ModelConfig minus identity & transport). Unknown `config` keys reject the whole file - server URLs and headers are structurally impossible.
- `index.json` is **generated - never hand-edit**. Run `npm run gen:presets` in the **same commit** as any preset change, so the live list on `main` never lags the directory. A Vitest drift guard makes the build fail on a stale list, so a shipped VSIX can never carry one.
- Comments: use `//` only, on its own line or after a value. The extension reads presets with a tolerant JSONC parser, but `index.json` is generated by a dependency-free script that is not, and a block comment or a trailing comma in a preset would break `npm run gen:presets` while passing every other check. A Vitest test enforces this on every shipped file.

For the full configuration schema and copy-paste snippets for `bad_words`, `structured_outputs`, `repetition_detection`, `chat_template_kwargs`, and sampling presets, see the [vLLM-Copilot Manual](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/docs/manual.md) and the [Configuration Reference](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/docs/configuration-reference.md).
