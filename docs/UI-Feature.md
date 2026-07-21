# UI Feature Plan: Server Status & Dashboard

> **Goal:** Give users real-time visibility into their vLLM server(s) with actionable insights — not just raw metrics.
> **Target UX:** User goes "Huh, this is useful for me."

---

## 1. Data Sources

### vLLM Prometheus `/metrics`
Scrape interval: configurable, default 5s.

| Metric | What it tells the user |
|---|---|
| `vllm:gpu_memory_usage_bytes` | GPU memory consumed (weights + KV cache) |
| `vllm:gpu_cache_usage_perc` | KV cache utilization % — how full is the context budget |
| `vllm:num_requests_running` | Requests actively being processed |
| `vllm:num_requests_swapped` | Requests in swap (slowed down) |
| `vllm:num_requests_waiting` | Requests queued but not yet started |
| `vllm:time_to_first_token_seconds` | Latency — how fast does the first token arrive |
| `vllm:inter_token_latency_seconds` | Streaming speed after first token |
| `vllm:mean_generated_tokens_per_second` | Output throughput |
| `vllm:mean_prompt_tokens_per_second` | Input throughput |
| `vllm:request_success_total` | Completed requests |
| `vllm:request_eviction_total` | Failed due to OOM/pressure |
| `vllm:prefix_cache_hit_rate` | Prefix cache efficiency |

### vLLM REST API

| Endpoint | Data |
|---|---|
| `/v1/models` | Loaded models, context lengths, capabilities |
| `/health` | Server health status |

### Extension Internal

| Source | Data |
|---|---|
| `tokenBudget.ts` | Current context window usage (system + history + request) |
| `sessionManager.ts` | Chat history token counts per session |
| `vllmClient.ts` config cache | Active server URL, model, capabilities |
| `usageReporting.ts` | Token usage tracking |

## 2. UI Architecture And Layout

The UI has two intentionally different surfaces: a compact sidebar for quick server awareness and actions, and full editor-area webviews for work that needs space.

```
Activity Bar: vLLM
└── Sidebar: vLLM Dashboard
  ├── Server selector
  ├── Online/offline state and essential metrics
  ├── Open Dashboard
  └── Configure Server

Editor Area
├── vLLM Dashboard tab
│   └── Full metrics dashboard, trends, queue, models, and actions
└── Configure Server tab
  └── Form-based server and per-model configuration editor
```

### Sidebar: Immediate Server Overview

The Activity Bar view remains narrow and deliberately focused. It selects the server and answers the immediate operational questions: is it online, how much KV cache is in use, how many requests are running or waiting, and whether latency or queue pressure needs attention. It is not a place for charts, raw Prometheus output, or a complex configuration form.

The sidebar has two explicit actions:

- **Open Dashboard** opens the selected server in the full vLLM Dashboard editor tab.
- **Configure Server** opens the selected server in the full Configure Server editor tab.

### Full Dashboard Editor

The detailed dashboard is a `WebviewPanel` opened in VS Code's main editor area, rather than a browser page or sidebar view. This keeps the experience native to VS Code: users can resize it, split it beside code, and keep it open while working. The extension supplies data through the webview message channel; it does not start an HTTP server or expose a listening port.

The full dashboard is the home for queue detail, TTFT and throughput trends, GPU/KV-cache visuals, loaded-model information, alerts, and future integrations with an external dashboard. The raw `/metrics` endpoint is not opened in a browser because Prometheus text is not a useful user-facing view.

### Configure Server Editor

Configuration is a separate `WebviewPanel`, launched from the sidebar. It is not part of the model picker: the picker should stay fast and focused on selecting a model. The editor presents the existing per-model configuration as a form and persists changes through `vscode.workspace.getConfiguration().update()`, preserving the current settings and cache-invalidation behavior.

The first configuration scope is server URL and request headers, followed by per-model identity, token budgets, sampling, thinking, capabilities, and modes as described in F9.

---

## 3. Feature List

### F1: Status Bar — At-a-Glance Health (Priority: High)

**Current state:** Shows server connection status.

**Proposal:**
```
🟢 vLLM: 78% KV | 12ms TTFT | Qwen3-27B
```

- Color-coded dot: 🟢 healthy / 🟡 warning / 🔴 offline
- KV cache utilization % — primary health indicator
- TTFT (time-to-first-token) — latency indicator
- Active model name
- Click → opens full dashboard webview

**Multi-server:** Dropdown on click:
```
⚡ vLLM ▾
  ● localhost:8000  → Qwen3-27B (active)
    localhost:8001  → DeepSeek-V4
    10.0.0.42       → GPU-Box-2
```

**UX win:** User sees health without leaving their workflow. Color change catches problems peripherally.

---

### F2: Server Dashboard View (Priority: High)

A full VS Code editor-area webview panel with modular widgets. It is resizable, splittable, and distinct from the compact sidebar overview.

#### F2.1: Connection Status
- Server URL, response latency, connection state
- Last successful scrape time

#### F2.2: GPU Memory
- Bar chart: weights vs KV cache vs free memory
- Source: `vllm:gpu_memory_usage_bytes`

#### F2.3: KV Cache Utilization
- Gauge/progress bar: % used
- Trend arrow: ↑↓ vs 5 minutes ago
- Threshold colors: green <80%, yellow 80-90%, red >90%

#### F2.4: Request Queue
- Pending / Running / Swapped counts
- "Your request is #3 in queue" when pending

#### F2.5: Latency (TTFT)
- Current value
- 5-minute trend sparkline
- "Getting worse" indicator if trending up

#### F2.6: Throughput
- Tokens/sec: input and output
- Per-model breakdown if multiple models

#### F2.7: Models Loaded
- List of loaded models with context limits
- Active model highlighted

#### F2.8: Errors & Evictions
- Recent evictions count with timestamps
- OOM events — actionable insight: "Clear context"

---

### F3: Customizable Dashboard (Priority: Medium)

User controls which widgets are visible.

**Approach:**
- VS Code setting: `"vllm2copilot.dashboard.widgets"` — array of widget IDs
- Toggle in dashboard UI: eye icon per widget section
- Widget order is user-configurable

```jsonc
"vllm2copilot.dashboard.widgets": [
    "gpuMemory",
    "kvCacheUtilization",
    "requestQueue",
    "latency",
    "throughput",
    "models",
    "errors"
]
```

---

### F4: Multi-Server Support (Priority: High)

**Config model:** Each server is an entry in the config with its own URL and models.

**UI implications:**
- Status bar: dropdown to switch active server
- Dashboard: tab per server, or sidebar list
- Config resolution: `resolveServerConfig()` handles per-server model configs
- Each server has independent metrics and health state

**Server list format:**
```
Servers:
  ● localhost:8000  → Qwen3-27B (active) 🟢
    localhost:8001  → DeepSeek-V4 🟡
    10.0.0.42       → GPU-Box-2 🔴
```

---

### F5: Smart Alerts (Priority: Medium)

Sparse, actionable notifications. Not polling noise.

| Alert | Trigger | Notification |
|---|---|---|
| Server down | Health check fails | 🔴 Once, retry indicator in status bar |
| KV cache high | >90% utilization | 🟡 Subtle status bar color change |
| Model loaded | New model available | 🟢 Transient notification |
| Evictions spike | >N evictions in 60s | ⚠️ "Server under pressure — consider clearing context" |

**Configurable:**
```jsonc
"vllm2copilot.alerts.kvCacheThreshold": 90,
"vllm2copilot.alerts.evictionThreshold": 5
```

---

### F6: Context Budget Widget (Priority: Medium)

**Unique insight:** Connects the extension's token budget with server KV cache state.

```
Context Window: ████░░░░░░  42% (17k/40k tokens)
│── System prompt: 2.1k
│── Chat history: 14.8k
│── Current request: 1.2k
```

**Why it's valuable:** User understands *why* responses are slow — their chat history is eating all the KV cache. This correlation doesn't exist in any standalone vLLM dashboard.

**Actionable:** "Clear chat history" button when KV cache is high.

---

### F7: Model Switch Cost Estimation (Priority: Low)

When user switches to a model not currently loaded on a server:

> "Switching to DeepSeek-V4 will take ~30s while it loads into GPU memory. Continue?"

- Estimated from model size and available VRAM
- Managed expectations — no surprise 30-second hang

---

### F8: One-Click Actions (Priority: Medium)

Context-aware actions in the dashboard:

| Action | When available | What it does |
|---|---|---|
| Clear chat history | KV cache >80% | Clears session, frees KV cache |
| Test connection | Server unresponsive | Ping server, show diagnostic |
| Switch model | Multiple models loaded | Change active model in status bar |
| Open server metrics | Always | Open `/metrics` in browser |
| Restart server | Server crashed | Run restart command (configurable) |

---

### F9: Model Configuration UI (Priority: High)

> **Why this matters:** every vLLM-specific feature (`bad_words`, `structured_outputs`, `repetition_detection`, `chat_template_kwargs`, `top_k`, `min_p`, `repetition_penalty`, …) is currently set by hand-editing `settings.json`. That's a power-user workflow. Without this UI, the extension's headline capabilities are undiscoverable for most colleagues. This is the **primary UX gap**, not a nice-to-have.

A webview form per model entry, opened from the model picker or the status bar.

**Sections:**

| Section | UI element | Maps to |
|---|---|---|
| Identity | Text fields | `id`, `vllmModelId`, `displayName`, `family` |
| Server & auth | Text field + key/value editor | `serverUrl`, `requestHeaders` |
| Token budgets | Number fields | `maxOutputTokens`, `maxInputTokens`, `estimateCharsPerToken` |
| Sampling | Sliders + number fields | `defaultParams.temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`, `presence_penalty`, `frequency_penalty` |
| Thinking toggle | Checkbox + extras | `chat_template_kwargs.enable_thinking`, `preserve_thinking`, `thinking_token_budget` |
| Bad words | List editor (add/remove chips) | `defaultParams.bad_words` |
| Structured output | Dropdown (none/json/regex/choice/grammar) + schema editor | `defaultParams.structured_outputs` |
| Repetition detection | Toggle + slider for `max_pattern_size`, `min_count` | `defaultParams.repetition_detection` |
| Modes | "Add mode" button → list of mode editors, each reusing the sections above | `modelModes` |
| Capabilities | Checkboxes | `capabilities.toolCalling`, `capabilities.imageInput` |
| Stream & retry | Number fields | `streamInactivityTimeout`, `autoContinueRetries` |

**Mode editor:** each named mode (Think, No Think, Strict JSON, Precise, …) reuses the Sampling/Thinking/Bad-words/Structured-output editors — so users build param bundles visually without knowing the JSON schema. The "active mode" is `defaultMode`.

**Persistence:** writes back to the user's `settings.json` via `vscode.workspace.getConfiguration().update()`. No reload — same `onDidChangeConfiguration` cache-invalidation path the settings UI uses today.

**Why not a QuickInput:** the QuickInput API is single-flow only. A form editor with a list editor for `bad_words`, a schema editor for structured outputs, and per-mode sections needs a webview. The existing `Add vLLM Server & Model` flow stays as-is — it's a quick onboarding wizard, not an editor.

**Dependency:** none — reuses `ModelConfig` types and `VllmClient` (no second source of truth). The form is pure config-shape editing; the resolution chain (`resolveRequestParams`) is unchanged.

---

## 4. Architecture Considerations

### Metrics Scraper Service
- New file: `src/metricsScraper.ts`
- Polls `/metrics` at configurable interval (default 5s)
- Parses Prometheus text format
- Maintains rolling buffer for trend calculations (e.g., 5-min TTFT history)
- Per-server: each server gets its own scraper instance
- Disposable: clean up intervals on dispose

### Webview Panels
- `src/dashboardView.ts` — `vscode.WebviewPanel` provider for the full dashboard
- `src/serverConfigView.ts` — `vscode.WebviewPanel` provider for the configuration editor
- State management: server list, selected server, widget config
- IPC: metrics data pushed to webview via `postMessage`
- Security: content security policy for webview resources

### Status Bar Integration
- Extend existing `StatusBarItem` in `src/extension.ts` or new provider
- Click handler: opens dashboard or shows server pick list
- Text updates from metrics scraper

### Settings
New settings to add to `package.json`:
```jsonc
{
    "vllm2copilot.dashboard.pollInterval": { "default": 5000 },
    "vllm2copilot.dashboard.widgets": { "default": ["gpuMemory", "kvCacheUtilization", "requestQueue", "latency", "throughput"] },
    "vllm2copilot.dashboard.widgetOrder": { "default": [] },
    "vllm2copilot.alerts.kvCacheThreshold": { "default": 90 },
    "vllm2copilot.alerts.evictionThreshold": { "default": 5 },
    "vllm2copilot.servers": { "default": [] }  // multi-server config
}
```

---

## 5. Implementation Phases

### Phase 1: Foundation
- [ ] `metricsScraper.ts` — Prometheus scraper with rolling buffer
- [ ] Extend config to support multiple servers
- [ ] Status bar: enhanced text with KV% + TTFT + model name
- [ ] Basic webview dashboard: connection status + KV cache gauge + models list

### Phase 2: Dashboard Widgets
- [ ] GPU memory bar chart
- [ ] Request queue display
- [ ] Latency with sparkline trend
- [ ] Throughput display
- [ ] Error/eviction display
- [ ] Context budget widget (F6)

### Phase 3: Polish
- [ ] Widget customization (F3)
- [ ] Smart alerts (F5)
- [ ] One-click actions (F8)
- [ ] Multi-server dropdown in status bar (F4)
- [ ] Dashboard tabs per server (F4)
- [ ] Model switch cost estimation (F7)

---

## 5. Open Questions

1. **Prometheus format parsing:** Build a lightweight parser or use a library? The format is line-based key/value with labels — probably simple enough to parse inline.
2. **Webview tech stack:** Plain HTML/JS/CSS or a framework (React/Vue)? Plain is lighter but harder to maintain. For VS Code webviews, plain is common and avoids bundling complexity.
3. **Server discovery:** Should the extension auto-discover vLLM instances on the network, or rely on explicit config? Explicit config is safer and matches current pattern.
4. **Trend data retention:** How much history to keep? 5-min sparkline = 60 data points at 5s intervals. 1-hour = 720 points. Balance memory vs useful trend window.
5. **Battery-gauge widget:** Would a visual GPU memory "battery" (like a vertical battery icon showing VRAM fill) be useful? Or is a bar chart sufficient?