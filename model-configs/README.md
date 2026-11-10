# Bundled Model Configs

Ready-to-use model configurations shipped with the extension. **Add or Reconfigure Server/Model** applies a preset automatically when the model id or server root matches.

| File | Model | Modes | Vision | Thinking |
|------|-------|-------|--------|----------|
| `Agents-A1-config.json` | Agents-A1 (InternScience) | Think-General, Think-Coding, Think-Science, No-Think | ✅ | ✅ |
| `Qwen-Qwen3.6-27B.json` | Qwen3.6-27B | Think-General, Think-Coding, No-Think | ✅ | ✅ |
| `Qwen-Qwen3.6-35B-A3B.json` | Qwen3.6-35B-A3B | Think-General, Think-Coding, No-Think | ✅ | ✅ |
| `Qwen-Qwen3.8-27B.json` | Qwen3.8-27B | Think-Deep, Think-Balanced, No-Think | ✅ (image + video) | ✅ |
| `Qwen-Qwen3.8-Flash-Next.json` | Qwen3.8-Flash-Next | Think-Deep, Think-Balanced, No-Think | ✅ | ✅ |
| `Poolside-Laguna-S-2.1.json` | Laguna-S-2.1 (Poolside) | Think-General, Think-Code, No-Think | ❌ | ✅ |
| `Tencent-Hy3-config.json` | Hy3 (Tencent) | Think-Deep, Think-Light, No-Think | ❌ | ✅ |
| `DeepSeek-V4-Flash.json` | DeepSeek V4 Flash | Think-Max, Think-High, No-Think | ❌ | ✅ |
| `DeepSeek-V4-Pro.json` | DeepSeek V4 Pro | Think-Max, Think-High, No-Think | ❌ | ✅ |
| `DeepSeek-V4.1-Flash.json` | DeepSeek V4.1 Flash | Think-Max, Think-High, No-Think | ✅ | ✅ |
| `Kimi-K3.json` | Kimi K3 (Moonshot) | Think-Max, Think-High, Think-Low | ✅ | ✅ (always on) |
| `Kimi-K3.1-Pro.json` | Kimi K3.1 Pro (Moonshot) | Think-Max, Think-High, Think-Low | ✅ | ✅ (always on) |
| `MiniMax-M3.json` | MiniMax M3 | Think-Always, Think-Adaptive, No-Think | ✅ | ✅ |
| `MiniMax-M3.1-Flash.json` | MiniMax M3.1-Flash | Think-Max, Think-XHigh, Think-High, Think-Medium, Think-Low | ✅ (image + video) | ✅ (adaptive, effort hint) |
| `glm-5.2-config.json` | GLM-5.2 (Z-AI) | Think-Max, Think-High, No-Think | ❌ | ✅ |
| `GLM-5.3.json` | GLM-5.3 (Z.ai, full) | Think-Max, Think-High, Think-Low | ❌ | ✅ (always on) |
| `GLM-5.3-Flash.json` | GLM-5.3-Flash (Z.ai) | Think-Max, Think-High, Think-Low | ✅ | ✅ (always on) |
| `XiaomiMiMo-MiMo-V2.6-RL.json` | MiMo-V2.6 Flash-RL / Pro-RL (Xiaomi, one preset for both + quants) | Think, No-Think | ✅ | ✅ (binary on/off) |

To apply a preset manually, merge its **`config`** fields into an existing entry in your `vllm-copilot.models` array (no reload needed). Preserve that entry's `id`, `server` and optional `vllmModelId`; a preset never supplies model identity. The surrounding `presetVersion`/`match`/`meta` envelope is preset-format only, not user settings.

Model provenance contains `source`, `verified` and `notes`. The picker name belongs in `config.displayName`, not in a second metadata name.

## Mode identifiers and migration

Bundled modes use case-preserving ASCII identifiers with letters, digits and hyphens, such as `Think-Coding`, `Think-XHigh` and `No-Think`. The identifier is also the Local picker label; no second display-name field is needed. Custom names remain supported, but new custom modes should follow the same convention.

Version 1.38.0 automatically migrates recognized legacy names, their `defaultMode` references and existing harness mapping targets. It preserves customized request parameters, model identity, budgets, personalities and custom mode names. The only parameter repairs are exact matches of the known old DeepSeek V4 Pro off-mode and Agents-A1 preservation definitions; customized variants are kept for manual review. A notification explains which changes occurred.

User, workspace and folder overrides have distinct completion markers. A failed or incomplete bundled-catalogue load cannot record completion; catalogue or settings-write failures retry on the next start.

Missing harness mappings are added only when a bundled preset matches and the saved effective reasoning/template controls agree with that preset. Sampling and output-budget customizations are kept. Collisions, invalid mappings and ambiguous controls are left for manual review with warnings in Output. OpenRouter modes get the identifier rename, but no HF preset mapping is invented for them.

## Copilot harness mapping

Every preset declares `config.copilotHarnessMapping` beside `modelModes`. Keys are Copilot harness effort values (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`); values name existing modes. The extension publishes those effort values and translates selections back to the original mode parameters. Local retains the descriptive labels and unmapped modes; the Copilot harness shows standard effort labels and filters out unmapped names. The mapping itself never reaches the server.

A non-empty mapping must include the default mode. Each target must exist and appear only once; an effort key must not also name a different mode. Invalid mappings produce a configuration warning and a picker warning, and the extension retains the original Local choices instead of guessing aliases. With no mapping, existing mode behavior is unchanged.

Effort-based presets map the actual backend effort, not the display label. DeepSeek V4.1's `Think-High` therefore maps from `xhigh`, matching vLLM's effort-75 encoding. Tencent's `none` maps to the existing mode that sends the backend's `no_think` value. Always-thinking models have no `none` mapping.

Agents-A1, Qwen3.6, Poolside, MiniMax M3 and MiMo have no matching effort ladder. Their `high` key is an explicit alias for the default thinking mode; `none` selects off. The alias does not add a backend effort parameter. Domain presets (Coding, Science, Code) and MiniMax's Adaptive mode remain unmapped and stay available through Local and Model Settings.

The 2026-11-10 settings audit checked the current model cards, configs, generation defaults, available chat templates and applicable vLLM recipes. Poolside leaves sampling to the checkpoint defaults, as its [current NVFP4 card](https://huggingface.co/poolside/Laguna-S-2.1-NVFP4#sampling) recommends; both thinking presets remain available. DeepSeek V4 Pro's `No-Think` explicitly disables reasoning. Agents-A1 no longer sends the ignored `preserve_thinking` option; its official template retains reasoning only within the current turn.

The migration adds compatible mappings to existing configured models; unresolved cases need a manual mapping or Auto-Configure. It does not reapply new sampling recommendations, including Poolside's checkpoint-default change. Existing chats' old mode selections resolve to the new identifiers, but VS Code may omit the picker readout and checkmark until the mode is selected once again. Released extensions without the new allowlist entry reject these updated remote presets and fall back to their bundled copies. Publish the preset changes only with supporting extension code.

## Presets are served live

Beyond shipping inside the VSIX, the presets in this directory are served **live**: when you add a model, the extension checks [index.json](index.json) on GitHub and offers a matching preset - including brand-new ones - with provenance (what it does, source, verification date) before you confirm. A preset pushed to `main` reaches every user the same day, no VSIX release needed. Offline or blocked? Bundled presets, exactly as before.

For maintainers:

- Every preset uses the **v2 envelope**: `presetVersion` / `match` (match patterns) / `meta` (provenance, displayed) / `config` (the loadable ModelConfig minus identity & transport). Unknown `config` keys reject the whole file - server URLs and headers are structurally impossible.
- `index.json` is **generated - never hand-edit**. Run `npm run gen:presets` in the **same commit** as any preset change, so the live list on `main` never lags the directory. A Vitest drift guard makes the build fail on a stale list, so a shipped VSIX can never carry one.
- Comments: use `//` only, on its own line or after a value. The extension reads presets with a tolerant JSONC parser, but `index.json` is generated by a dependency-free script that is not, and a block comment or a trailing comma in a preset would break `npm run gen:presets` while passing every other check. A Vitest test enforces this on every shipped file.

For the full configuration schema and copy-paste snippets for `bad_words`, `structured_outputs`, `repetition_detection`, `chat_template_kwargs`, and sampling presets, see the [vLLM-Copilot Manual](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/docs/manual.md) and the [Configuration Reference](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/docs/configuration-reference.md).
