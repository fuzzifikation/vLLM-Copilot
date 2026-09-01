import * as vscode from 'vscode';

/**
 * Language Model Tool: exposes the vllm-copilot model-entry schema and
 * configuration guide to Copilot Chat, on demand.
 *
 * The bundled `schemas/vllm-copilot-models.schema.json` (and any README prose)
 * live in the extension install dir — invisible to the user's chat AI. This
 * tool is the bridge: when the user asks to create/configure a model or its
 * modes in `vllm-copilot.models`, Copilot calls this tool and gets the
 * machine-readable schema plus a condensed guide (resolution chain, valid
 * params, gotchas, a working example). No `.vllm/` scaffold forced on the
 * workspace, no schema/guide copy in every project.
 *
 * Registered via `contributes.languageModelTools` + `vscode.lm.registerTool`
 * (stable since VS Code 1.90 — no proposal needed).
 */

export const CONFIG_SCHEMA_TOOL_NAME = 'vllm-copilot_model_schema';

/** Relative (to extension root) path of the bundled model-entry schema. */
const SCHEMA_PATH = ['schemas', 'vllm-copilot-models.schema.json'];

/** Optional tool input. */
export interface ConfigSchemaToolInput {
  /** What to return: everything (default), only the JSON schema, or only the prose guide. */
  section?: 'all' | 'schema' | 'guide';
}

const GUIDE = `# vLLM-Copilot Model Configuration Guide

You are editing the \`vllm-copilot.models\` array in the user's VS Code \`settings.json\`. Server connection facts live in a SEPARATE \`vllm-copilot.servers\` registry — models reference a server by id.

## Core rules
- Two arrays: \`vllm-copilot.servers\` is the server registry — every server lives exactly once with \`id\`, \`serverUrl\`, and optional \`serverType\`, \`displayName\`, \`requestHeaders\`. \`vllm-copilot.models\` holds model entries that reference a server through its \`server\` id. There is NO global server and no global API key.
- Required on a model: \`id\` (unique entry key) and \`server\` (a registered server entry id). Server facts (\`serverUrl\`, \`requestHeaders\`, \`serverType\`, \`displayName\`) belong ONLY on the registry entry — never on a model.
- Required on a server entry: \`id\` (unique, human-readable — e.g. \`localhost-8000\`) and \`serverUrl\` (OpenAI-compatible endpoint). \`serverType\` defaults to \`vllm\`; set it on the ENTRY for \`lmstudio\`, \`llamacpp\`, \`ollama\`, or \`openrouter\`.
- Auth goes on the server entry's \`requestHeaders\`, e.g. \`{ "Authorization": "Bearer <api-key>" }\`. Models never carry credentials.
- A model whose \`server\` id is not registered is skipped with a warning — never guess or hand-invent ids; add the entry to \`vllm-copilot.servers\` first.

## Parameter resolution (highest wins)
server defaults (unset params omitted) → entry.\`defaultParams\` → the selected entry.\`modelModes[<selected mode>]\`

So a mode overrides \`defaultParams\`, and \`defaultParams\` overrides the server's default. Any parameter you do not set anywhere is omitted from the request — the server decides.\nException: when \`maxOutputTokens\` is an ARRAY, the user's **Output Length** picker selection outranks *every* \`max_tokens\` layer (mode, defaultParams, scalar budget) — see below.

## Model modes (\`modelModes\`)
- An object whose keys are user-visible mode labels ("Think", "No Think", ...) and whose values are param objects merged into the request body when that mode is active.
- Toggle reasoning with \`chat_template_kwargs: { "enable_thinking": true|false }\` (vLLM), or use \`reasoning_effort\` ("high"/"max"/"none") which vLLM maps to \`enable_thinking\` automatically.
- \`defaultMode\` must match one of the \`modelModes\` keys; if omitted or invalid, the first key is used.
- Keep mode labels short and consistent with the model's actual capabilities (does it support thinking? vision?).

## Gotchas\n- \`max_tokens\` inside \`defaultParams\`/\`modelModes\` sets the OUTPUT BUDGET for that scope — it overrides \`maxOutputTokens\` and is clamped to the model's context window AND the server-reported output ceiling. Prefer an ARRAY \`maxOutputTokens\` (next bullet) over per-mode \`max_tokens\` for length control — modes should describe *behavior* (thinking, sampling), not output length.\n- \`maxOutputTokens\`: number OR ordered array of token counts. A number is a plain cap. An array is shown as a second model-picker dropdown ("Output Length"), independent of \`modelModes\`: FIRST element = default AND desired output budget, entries above the model's clamped ceiling are dropped, fewer than 2 usable values = no dropdown at all. When the dropdown exists, the user's pick OWNS the request's \`max_tokens\` AND is the advertised output budget — a shorter pick grows the prompt budget (context − output). Example: \`"maxOutputTokens": [65536, 32768, 16384]\`. Never combine it with \`max_tokens\` in modes or \`defaultParams\`: VS Code delivers the dropdown's default even when the user never touches it, so the mode-level values are completely dead config — the picker replaces that layer, it does not merely outrank it.
- \`model\`, \`messages\`, \`stream\`, \`stream_options\` are FORBIDDEN — the runtime owns them (the extension sets model/messages/stream/stream_options itself); never add them to params.
- \`maxInputTokens\` is auto-computed from the server's context window minus the output budget; only set it lower.
- Sampling params are model-specific. When unsure, start from the model's HF card; common safe defaults: \`temperature: 0.7\`, \`top_p: 0.95\` for coding; \`temperature: 1.0\` for general reasoning.

## Valid request params (vLLM body keys, snake_case)
temperature, top_p, top_k, min_p, presence_penalty, frequency_penalty, repetition_penalty, length_penalty, seed, stop, stop_token_ids, include_stop_str_in_output, min_tokens, ignore_eos, skip_special_tokens, spaces_between_special_tokens, truncate_prompt_tokens, thinking_token_budget, bad_words, repetition_detection, structured_outputs, chat_template_kwargs, reasoning_effort, allowed_token_ids, max_tokens.

This is the KNOWN vLLM vocabulary — other keys are also accepted and passed through verbatim, so newer or backend-specific parameters still work. Only stick to this list unless the user/backend explicitly needs something else. The ONLY keys that are rejected: \`model\`, \`messages\`, \`stream\`, \`stream_options\` (see Gotchas).

vLLM-only (NOT accepted by OpenAI-compatible cloud backends such as OpenRouter): top_k, min_p, repetition_penalty, length_penalty, stop_token_ids, include_stop_str_in_output, ignore_eos, skip_special_tokens, spaces_between_special_tokens, truncate_prompt_tokens, thinking_token_budget, bad_words, repetition_detection, structured_outputs, chat_template_kwargs, allowed_token_ids.

## Example (reasoning model, per-mode sampling)
One server entry in the registry, one model referencing it by id:
\`\`\`json
"vllm-copilot.servers": [
  {
    "id": "localhost-8000",
    "serverUrl": "http://localhost:8000/v1",
    "serverType": "vllm",
    "displayName": "Home box",
    "requestHeaders": { "Authorization": "Bearer <api-key>" }
  }
],
"vllm-copilot.models": [
  {
    "id": "MyModel on localhost:8000",
    "server": "localhost-8000",
    "vllmModelId": "org/MyModel",
    "displayName": "MyModel",
    "maxOutputTokens": 32768,
    "defaultParams": { "temperature": 0.7, "top_p": 0.95 },
    "modelModes": {
      "Think": { "chat_template_kwargs": { "enable_thinking": true, "preserve_thinking": true }, "temperature": 1.0, "top_p": 0.95 },
      "No Think": { "chat_template_kwargs": { "enable_thinking": false }, "temperature": 0.7, "top_p": 0.8 }
    },
    "defaultMode": "Think"
  }
]
\`\`\`
`;

/**
 * Register the config-schema LM tool. Returns a Disposable (pushed to
 * context.subscriptions by activate()).
 */
export function registerConfigSchemaTool(
  extensionUri: vscode.Uri,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  const tool: vscode.LanguageModelTool<ConfigSchemaToolInput> = {
    async invoke(options, token) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      // The model may pass an arbitrary `section` (no inputSchema validation is
      // enforced at runtime) — treat anything unknown as the full default so a
      // hallucinated value can never produce an empty result.
      const requested = options.input?.section;
      const section: 'all' | 'schema' | 'guide' =
        requested === 'schema' || requested === 'guide' ? requested : 'all';

      let schemaText = '';
      try {
        const schemaUri = vscode.Uri.joinPath(extensionUri, ...SCHEMA_PATH);
        const raw = await vscode.workspace.fs.readFile(schemaUri);
        // Re-check cancellation AFTER the await — the read is async and the
        // token may have been cancelled while I/O was in flight. Don't return a
        // full result for a request the caller has abandoned.
        if (token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }
        schemaText = JSON.stringify(JSON.parse(new TextDecoder().decode(raw)), null, 2);
      } catch (err) {
        // Never fail the tool — fall back to the guide alone. (A re-thrown
        // CancellationError from the check above is NOT swallowed here.)
        if (err instanceof vscode.CancellationError) {
          throw err;
        }
        outputChannel.appendLine(
          `[ERROR] Config schema tool: cannot read bundled schema: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const parts: string[] = [];
      if (section === 'all' || section === 'schema') {
        parts.push(schemaText || '# Schema unavailable.');
      }
      if (section === 'all' || section === 'guide') {
        parts.push(GUIDE);
      }
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(parts.join('\n\n'))]);
    },
  };

  return vscode.lm.registerTool(CONFIG_SCHEMA_TOOL_NAME, tool);
}
