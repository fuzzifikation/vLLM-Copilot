# Using OpenRouter

OpenRouter is a **managed remote**. There is no server to run and nothing to install. You add one fixed endpoint, then pick from **~415 cloud models**. You pay per use, and many models have **free** routes. The Add flow detects any `openrouter.ai` URL and routes you into the OpenRouter branch (server → key → model pick, like every backend).

## What server URL do I enter?

**Paste the normal website URL: `https://openrouter.ai`.** The extension recognizes all of these and normalizes them to the same fixed endpoint `https://openrouter.ai/api`:

| You paste | What happens |
|---|---|
| `https://openrouter.ai` | The website URL (what you see in your browser tab). Works as-is. |
| `https://openrouter.ai/api` | The API base, also fine. |
| A model page like `https://openrouter.ai/nvidia/nemotron-3.5-lightning:free` | Works, and pre-fills the model picker with that model. |

If you have OpenRouter open in a browser tab, copy the URL from the address bar. The web URL works as-is.

## Setup

1. **Server URL:** paste `https://openrouter.ai` (or any model page from the table above).
2. **API key:** enter your key from [openrouter.ai/keys](https://openrouter.ai/keys). It is stored in the model's `requestHeaders` as `Authorization: Bearer <key>` and never leaves the extension.
3. **Pick the model:** choose from the ~415-model catalog (filter-as-you-type). The extension resolves each model's metadata from OpenRouter's **public model catalog** (`/api/v1/models`) by matching the id exactly: real context window, output ceiling, tool calling, pricing, and reasoning modes.

## Free routes and the `:free` suffix

The `:free` suffix on a model ID is a **routing variant** and its own catalog entry. It is preserved for both chat and metadata resolution, so a `:free` pick always stays on the free model. Free routes are rate-limited. If a request feels dead, that is the free tier. Your OpenRouter **credits** show on the dashboard as an account row per server.

## Manual config

Manual config works the same way. Each entry is self-contained:

```json
{
  "serverType": "openrouter",
  "serverUrl": "https://openrouter.ai/api",
  "vllmModelId": "nvidia/nemotron-3.5-lightning:free",
  "displayName": "Nemotron 3.5 Lightning (free)",
  "requestHeaders": {
    "Authorization": "Bearer sk-or-v1-YOUR_KEY"
  }
}
```

## Attribution headers (optional)

OpenRouter's public [rankings](https://openrouter.ai/rankings) attribute traffic to a site/app via two headers. The extension never sends them automatically, but you can add them to the model's `requestHeaders` (the Add flow also prompts for optional custom headers):

```json
"requestHeaders": {
  "Authorization": "Bearer sk-or-v1-YOUR_KEY",
  "HTTP-Referer": "https://your-app.example.com",
  "X-OpenRouter-Title": "Your App Name"
}
```

These are only for attribution and rankings. Chat works fine without them, and most users can ignore this.

## Architecture notes

For how the integration is built (data flow, provider handling, per-provider limits), see [openrouter-integration.md](../openrouter-integration.md).
