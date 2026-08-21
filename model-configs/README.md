# Bundled Model Configs

Ready-to-use model configurations shipped with the extension. **Add vLLM Server & Model** applies a preset automatically when the model id or server root matches.

| File | Model | Modes | Vision | Thinking |
|------|-------|-------|--------|----------|
| `Agents-A1-config.json` | Agents-A1 (InternScience) | Think (General), Think (Coding), Think (Science), No Think | ✅ | ✅ |
| `Qwen-Qwen3.6-27B.json` | Qwen3.6-27B | Think (General), Think (Coding), No Think | ✅ | ✅ |
| `Qwen-Qwen3.6-35B-A3B.json` | Qwen3.6-35B-A3B | Think (General), Think (Coding), No Think | ✅ | ✅ |
| `Qwen-Qwen3.8-27B.json` | Qwen3.8-27B ⚠️ draft | Think (Deep), Think (Balanced), No Think | ❓ | ✅ |
| `Poolside-Laguna-S-2.1.json` | Laguna-S-2.1 (Poolside) | Think, No Think | ❌ | ✅ |
| `Tencent-Hy3-config.json` | Hy3 (Tencent) | Think (Deep), Think (Light), No Think | ❌ | ✅ |
| `DeepSeek-V4-Flash.json` | DeepSeek V4 Flash | Think (Max), Think (High), No Think | ❌ | ✅ |
| `DeepSeek-V4-Flash-0731.json` | DeepSeek V4 Flash (0731) | Think (Max), Think (High), No Think | ❌ | ✅ |
| `glm-5.2-config.json` | GLM-5.2 (Z-AI) | Think (Max), Think (High), No Think | ❌ | ✅ |

To use a preset manually, copy the JSON object from the corresponding file into your `vllm-copilot.models` array (no reload needed).

For the full configuration schema and copy-paste snippets for `bad_words`, `structured_outputs`, `repetition_detection`, `chat_template_kwargs`, and sampling presets, see the [vLLM-Copilot Manual](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/docs/manual.md) and the [Configuration Reference](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/docs/configuration-reference.md).
