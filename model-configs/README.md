# Bundled Model Configs

Ready-to-use model configurations shipped with the extension. **Add vLLM Server & Model** applies a preset automatically when the model id or server root matches.

| File | Model | Modes | Vision | Thinking |
|------|-------|-------|--------|----------|
| `Agents-A1-config.json` | Agents-A1 (InternScience) | Think (General), Think (Coding), Think (Science), No Think | ✅ | ✅ |
| `Qwen-Qwen3.6-27B.json` | Qwen3.6-27B | Think (General), Think (Coding), No Think | ✅ | ✅ |
| `Qwen-Qwen3.6-35B-A3B.json` | Qwen3.6-35B-A3B | Think (General), Think (Coding), No Think | ✅ | ✅ |
| `Qwen-Qwen3.8-27B.json` | Qwen3.8-27B ⚠️ draft | Think (Deep), Think (Balanced), No Think | ❓ | ✅ |
| `Qwen-Qwen3.8-Flash-Next.json` | Qwen3.8-Flash-Next | Think (Deep), Think (Balanced), No Think | ✅ | ✅ |
| `Poolside-Laguna-S-2.1.json` | Laguna-S-2.1 (Poolside) | Think, No Think | ❌ | ✅ |
| `Tencent-Hy3-config.json` | Hy3 (Tencent) | Think (Deep), Think (Light), No Think | ❌ | ✅ |
| `DeepSeek-V4-Flash.json` | DeepSeek V4 Flash | Think (Max), Think (High), No Think | ❌ | ✅ |
| `DeepSeek-V4-Pro.json` | DeepSeek V4 Pro | Think (Max), Think (High), No Think | ❌ | ✅ |
| `Kimi-K3.json` | Kimi K3 (Moonshot) | Think (Max), Think (High), Think (Low) | ✅ | ✅ (always on) |
| `MiniMax-M3.json` | MiniMax M3 | Think (Always), Think (Adaptive), No Think | ✅ | ✅ |
| `glm-5.2-config.json` | GLM-5.2 (Z-AI) | Think (Max), Think (High), No Think | ❌ | ✅ |
| `GLM-5.3.json` | GLM-5.3 (Z.ai, full) | Think (Max), Think (High), Think (Low) | ❌ | ✅ (always on) |
| `GLM-5.3-Flash.json` | GLM-5.3-Flash (Z.ai) | Think (Max), Think (High), Think (Low) | ✅ | ✅ (always on) |

To use a preset manually, copy the **`config`** object from the corresponding file into your `vllm-copilot.models` array (no reload needed) — the surrounding `presetVersion`/`match`/`meta` envelope is preset-format only, not user settings.

## Presets are served live

Beyond shipping inside the VSIX, the presets in this directory are served **live**: when you add a model, the extension checks [index.json](index.json) on GitHub and offers a matching preset — including brand-new ones — with provenance (what it does, source, verification date) before you confirm. A preset pushed to `main` reaches every user the same day, no VSIX release needed. Offline or blocked? Bundled presets, exactly as before.

For maintainers:

- Every preset uses the **v2 envelope**: `presetVersion` / `match` (match patterns) / `meta` (provenance, displayed) / `config` (the loadable ModelConfig minus identity & transport). Unknown `config` keys reject the whole file — server URLs and headers are structurally impossible.
- `index.json` is **generated — never hand-edit**. `npm run gen:presets` regenerates it; a GitHub Action does it automatically on push, and a Vitest drift guard makes the build fail on a stale list.

For the full configuration schema and copy-paste snippets for `bad_words`, `structured_outputs`, `repetition_detection`, `chat_template_kwargs`, and sampling presets, see the [vLLM-Copilot Manual](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/docs/manual.md) and the [Configuration Reference](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/docs/configuration-reference.md).
