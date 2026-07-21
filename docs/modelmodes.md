# Qwen3.6-27B — Official Inference Parameters

## Source

- **HuggingFace Model Card:** https://huggingface.co/Qwen/Qwen3.6-27B
- **Section:** "Best Practices" → "Sampling Parameters"
- **Retrieved:** 2026-06-05
- **Qwen Documentation:** https://qwen.readthedocs.io/en/latest/deployment/vllm.html
- **Section:** "API Service" → "Basic Usage" & "Thinking & Non-Thinking Modes"
- **Retrieved:** 2026-06-05

---

## Recommended Sampling Parameters

Qwen recommends the following sets of sampling parameters depending on mode and task type:

### Thinking Mode — General Tasks

| Parameter | Value |
|-----------|-------|
| `temperature` | 1.0 |
| `top_p` | 0.95 |
| `top_k` | 20 |
| `min_p` | 0.0 |
| `presence_penalty` | 0.0 |
| `repetition_penalty` | 1.0 |

Higher temperature gives more diverse reasoning paths.

### Thinking Mode — Precise Coding (e.g., WebDev)

| Parameter | Value |
|-----------|-------|
| `temperature` | 0.6 |
| `top_p` | 0.95 |
| `top_k` | 20 |
| `min_p` | 0.0 |
| `presence_penalty` | 0.0 |
| `repetition_penalty` | 1.0 |

Lower temperature for precise, deterministic outputs.

### Instruct Mode (Non-Thinking)

| Parameter | Value |
|-----------|-------|
| `temperature` | 0.7 |
| `top_p` | 0.80 |
| `top_k` | 20 |
| `min_p` | 0.0 |
| `presence_penalty` | 1.5 |
| `repetition_penalty` | 1.0 |

Direct response without thinking content.

---

## Additional Recommendations

### Output Length

- **Most queries:** `max_tokens = 32,768`
- **Complex problems (math, programming competitions):** `max_tokens = 81,920`

This provides the model with sufficient space to generate detailed and comprehensive responses.

### Presence Penalty

For supported frameworks, you can adjust `presence_penalty` between **0 and 2** to reduce endless repetitions. However, using a higher value may occasionally result in language mixing and a slight decrease in model performance.

### Thinking Mode Control

Qwen3.6 operates in **thinking mode by default**, generating thinking content signified by `<thinking>...</thinking>` before producing the final response.

**Disable thinking (Instruct mode):**
```json
{
  "chat_template_kwargs": { "enable_thinking": false }
}
```

**Enable thinking with preservation:**
```json
{
  "chat_template_kwargs": { "enable_thinking": true, "preserve_thinking": true }
}
```

`preserve_thinking` retains reasoning context from historical messages, which is particularly beneficial for agent scenarios where maintaining full reasoning context enhances decision consistency and can reduce overall token consumption.

### Context Length

- **Native:** 262,144 tokens
- **Extensible (with YaRN):** up to 1,010,000 tokens
- **Minimum recommended:** 128K tokens to preserve thinking capabilities

---

## vLLM Server Flags

Required flags for Qwen3.6 on vLLM:

```bash
vllm serve Qwen/Qwen3.6-27B \
  --port 8000 \
  --tensor-parallel-size 8 \
  --max-model-len 262144 \
  --reasoning-parser qwen3
```

With tool calling support:
```bash
vllm serve Qwen/Qwen3.6-27B \
  --port 8000 \
  --tensor-parallel-size 8 \
  --max-model-len 262144 \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder
```

---

## Model Modes Configuration (for vLLM-Copilot)

> **Note (2026-07-18):** This matches the shipped preset in `model-configs/Qwen-Qwen3.6-27B.json`. Mode names are "Think (General)", "Think (Coding)", "No Think".

```json
{
  "id": "Qwen/Qwen3.6-27B",
  "vllmModelId": "Qwen/Qwen3.6-27B",
  "displayName": "Qwen3.6-27B",
  "family": "qwen3_5",
  "maxOutputTokens": 32768,
  "capabilities": {
    "toolCalling": true,
    "imageInput": true
  },
  "modelModes": {
    "Think (General)": {
      "chat_template_kwargs": {
        "enable_thinking": true,
        "preserve_thinking": true
      },
      "temperature": 1.0,
      "top_p": 0.95,
      "top_k": 20,
      "min_p": 0.0,
      "presence_penalty": 0.0,
      "repetition_penalty": 1.0
    },
    "Think (Precise)": {
      "chat_template_kwargs": {
        "enable_thinking": true,
        "preserve_thinking": true
      },
      "temperature": 0.6,
      "top_p": 0.95,
      "top_k": 20,
      "min_p": 0.0,
      "presence_penalty": 0.0,
      "repetition_penalty": 1.0
    },
    "No Think": {
      "chat_template_kwargs": {
        "enable_thinking": false
      },
      "temperature": 0.7,
      "top_p": 0.80,
      "top_k": 20,
      "min_p": 0.0,
      "presence_penalty": 1.5,
      "repetition_penalty": 1.0
    }
  }
}
```
