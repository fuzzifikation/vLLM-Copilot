import * as vscode from 'vscode';
import type { ModelConfig } from './config.js';
import { buildEndpoint, buildAuthHeaders, resolveServerConfig, resolveVllmModelId, normalizeServerUrl, buildModelId, normalizeModelId } from './config.js';
import { describeError } from './messageConverter.js';
import { jsonrepair } from 'jsonrepair';

/**
 * VS Code setting key for BYOK utility model default (introduced in 1.128).
 * Full path: chat.byokUtilityModelDefault
 * Section-scoped key (for use with getConfiguration('chat')): byokUtilityModelDefault
 */
const BYOK_UTILITY_MODEL_DEFAULT_SECTION_KEY = 'byokUtilityModelDefault';

/**
 * When set to 'mainAgent', VS Code will use the currently selected BYOK model
 * for both main chat and utility tasks (titles, commit messages, etc.).
 */
const MAIN_AGENT_BYOK_UTILITY_MODEL_DEFAULT = 'mainAgent';

// ---- Local preset loading ----

/**
 * A preset loaded from model-configs/*.json, paired with the source filename.
 */
export interface ModelPreset {
  config: ModelConfig;
  /** Source filename (e.g. "DeepSeek-V4-Flash.json"). */
  sourceFile: string;
}

/**
 * Strip single-line `//` comments from a JSON string. Handles inline comments
 * but does not strip `//` inside string values (good enough for our preset files
 * which only have comments above the JSON object).
 * @internal Exported for testing.
 */
export function stripJsonComments(text: string): string {
  return text
    .split('\n')
    .map(line => {
      const inStringResult = findFirstUnquotedSlashSlash(line);
      if (inStringResult !== -1) {
        return line.substring(0, inStringResult);
      }
      return line;
    })
    .join('\n');
}

/**
 * Find the index of the first `//` that is NOT inside a quoted string.
 * Returns -1 if no such comment exists.
 */
function findFirstUnquotedSlashSlash(line: string): number {
  let inQuotes = false;
  let escapeNext = false;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === '/' && line[i + 1] === '/') {
      return i;
    }
  }
  return -1;
}

/**
 * Load all model presets from the model-configs/ directory in the extension.
 * Returns an array of presets with their source filenames.
 * @internal Exported for testing.
 */
export async function loadModelPresets(
  extensionUri: vscode.Uri
): Promise<ModelPreset[]> {
  const configsDir = vscode.Uri.joinPath(extensionUri, 'model-configs');
  const presets: ModelPreset[] = [];

  try {
    const entries = await vscode.workspace.fs.readDirectory(configsDir);
    for (const [name, type] of entries) {
      if (!name.endsWith('.json') || type !== vscode.FileType.File) {
        continue;
      }
      try {
        const fileUri = vscode.Uri.joinPath(configsDir, name);
        const raw = await vscode.workspace.fs.readFile(fileUri);
        const text = new TextDecoder().decode(raw);
        const config = parsePresetJson(text);
        if (config) presets.push({ config, sourceFile: name });
      } catch {
        // Skip malformed preset files — they won't match anything anyway.
      }
    }
  } catch {
    // model-configs/ directory may not exist in some installs.
  }

  return presets;
}

/**
 * Parse a preset JSON file forgivingly. Tries the comment-stripped text first,
 * then falls back to `jsonrepair` (which also tolerates comments, trailing commas,
 * single quotes, and missing commas) so a minor authoring slip doesn't silently
 * drop the whole preset. Returns null only if even the repaired text is unusable.
 * @internal Exported for testing.
 */
export function parsePresetJson(text: string): ModelConfig | null {
  const cleaned = stripJsonComments(text).trim();
  try {
    return JSON.parse(cleaned) as ModelConfig;
  } catch {
    // fall through to repair
  }
  try {
    const parsed = JSON.parse(jsonrepair(text));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ModelConfig;
    }
  } catch {
    // unrepairable
  }
  return null;
}

/**
 * Find a preset that matches the given model. Matches a preset's `id`/`vllmModelId`
 * against the model id, and — when provided — against the server model's `root`
 * (the underlying checkpoint). The `root` match lets any `--served-model-name`
 * alias (e.g. `zai-glm-52`) resolve to the preset authored for its real repo id
 * (e.g. `zai-org/GLM-5.2`).
 *
 * A preset's `id`/`vllmModelId` are used ONLY for this comparison; applying the
 * preset never overwrites the user's own id/vllmModelId (see mergePresetWithUserConfig).
 * @internal Exported for testing.
 */
export function findPresetForModel(
  presets: ModelPreset[],
  modelId: string,
  root?: string
): ModelPreset | undefined {
  const normalizedModel = normalizeModelId(modelId).toLowerCase();
  const normalizedRoot = root !== undefined ? normalizeModelId(root).toLowerCase() : undefined;

  return presets.find(p => {
    const presetIds = [p.config.id, p.config.vllmModelId].filter((v): v is string => !!v);
    // Exact match first (preserves case-sensitive matches)
    if (presetIds.includes(modelId)) return true;
    if (root !== undefined && presetIds.includes(root)) return true;
    // Fuzzy match: strip quantization suffixes, then case-insensitive comparison
    if (presetIds.some(pid => normalizeModelId(pid).toLowerCase() === normalizedModel)) return true;
    if (normalizedRoot !== undefined && presetIds.some(pid => normalizeModelId(pid).toLowerCase() === normalizedRoot)) return true;
    return false;
  });
}

/**
 * Merge a preset into an existing user config.
 *
 * Strategy:
 * - Preset fully replaces all top-level fields (id, displayName, family,
 *   maxOutputTokens, capabilities, defaultMode, modelModes, etc.).
 * - User's identity (`id`, `vllmModelId`) is preserved — preset must NOT
 *   rename or repoint the model.
 */
export function mergePresetWithUserConfig(
  preset: ModelConfig,
  userConfig: ModelConfig
): ModelConfig {
  // Start with the preset as the base (full replace)
  const merged: ModelConfig = { ...preset };

  // Identity is the user's — a preset must NEVER rename the model or repoint its
  // vLLM server model id.
  merged.id = userConfig.id;
  if (userConfig.vllmModelId !== undefined) {
    merged.vllmModelId = userConfig.vllmModelId;
  } else {
    delete merged.vllmModelId;
  }

  return merged;
}

/**
 * Auto-configure a model by fetching metadata from HuggingFace and the vLLM server.
 *
 * Discovers:
 * - modelModes from chat_template Jinja2 kwargs (enable_thinking, preserve_thinking)
 * - imageInput capability from pipeline_tag
 * - max_model_len from vLLM /v1/models
 * - generation defaults from generation_config.json on HuggingFace
 */

// ---- HuggingFace API types ----

interface HfModelInfo {
  id: string;
  pipeline_tag?: string;
  config?: {
    model_type?: string;
    tokenizer_config?: {
      chat_template?: string;
    };
  };
}

/** @internal Exported for testing. */
export interface HfGenerationConfig {
  max_new_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
  do_sample?: boolean;
}

// ---- vLLM model info ----

interface VllmModelInfo {
  id: string;
  max_model_len?: number;
  /** Underlying checkpoint id. vLLM sets this to the HF repo when the model is a
   *  `--served-model-name` alias, so it links aliases back to their real model. */
  root?: string;
}

// ---- Public API ----

/** Max tokens computed by auto-configure output factor. */
const OUTPUT_TOKEN_FACTOR = 0.1;
/** Hard cap on auto-configured output tokens (Qwen3.6 recommends 81920 for complex tasks). */
const OUTPUT_TOKEN_CAP = 81920;

export interface AutoConfigResult {
  modelConfig: ModelConfig;
  /** Human-readable summary of what was discovered. */
  summary: string[];
  /** Suggested max-output token count, derived from server context window. */
  suggestedMaxOutputTokens?: number;
}

/**
 * Run auto-configuration for a model. Fetches from HuggingFace + vLLM server.
 *
 * When a model is served under a quantized or aliased name (e.g. `qwen3.6-27b-fp8`),
 * `vllmInfo.root` points to the base HuggingFace repo (`Qwen/Qwen3.6-27B`). HF lookups
 * use this `root` so they resolve metadata for the actual model, not the served alias.
 */
export async function autoConfigureModel(
  modelId: string,
  serverUrl: string,
  requestHeaders?: Record<string, string>
): Promise<AutoConfigResult> {
  const summary: string[] = [];
  const modelConfig: ModelConfig = { id: modelId, vllmModelId: modelId };

  // 1. Fetch from vLLM server.
  let vllmInfo: VllmModelInfo | null = null;
  try {
    vllmInfo = await fetchVllmModelInfo(modelId, serverUrl, requestHeaders);
  } catch (err) {
    summary.push(`⚠ Could not fetch model info from vLLM server: ${describeError(err)}`);
  }
  let suggestedMaxOutputTokens: number | undefined;
  if (vllmInfo) {
    if (vllmInfo.max_model_len) {
      // Context window comes from vLLM discovery — just inform the user here.
      summary.push(`vLLM context window: ${vllmInfo.max_model_len.toLocaleString()} tokens`);
      // Suggest output tokens as a factor of context window, capped at OUTPUT_TOKEN_CAP
      suggestedMaxOutputTokens = Math.min(
        Math.floor(vllmInfo.max_model_len * OUTPUT_TOKEN_FACTOR),
        OUTPUT_TOKEN_CAP
      );
      summary.push(`Suggested max output tokens: ${suggestedMaxOutputTokens.toLocaleString()}`);
    }
  }

  // Use the base HF repo (root) for HF lookups — quantized variants (e.g. `qwen3.6-27b-fp8`)
  // don't exist on HF; only the base model (`Qwen/Qwen3.6-27B`) does.
  const hfLookupId = vllmInfo?.root ?? modelId;

  // 2. Fetch generation_config.json and HuggingFace model info in parallel.
  // Use Promise.allSettled so a network error on one source doesn't crash the
  // entire auto-configure — both are supplementary data sources.
  const results = await Promise.allSettled([
    fetchGenerationConfig(hfLookupId),
    fetchHuggingFaceModel(hfLookupId),
  ]);

  const genConfig = results[0].status === 'fulfilled' ? results[0].value : null;
  const hfInfo = results[1].status === 'fulfilled' ? results[1].value : null;

  if (results[0].status === 'rejected') {
    summary.push(`⚠ Error fetching generation config: ${describeError(results[0].reason)}`);
  }
  if (results[1].status === 'rejected') {
    summary.push(`⚠ Error fetching HuggingFace model info: ${describeError(results[1].reason)}`);
  }

  if (genConfig) {
    const defaults: string[] = [];
    if (genConfig.temperature !== undefined) defaults.push(`temperature=${genConfig.temperature}`);
    if (genConfig.top_p !== undefined) defaults.push(`top_p=${genConfig.top_p}`);
    if (genConfig.top_k !== undefined) defaults.push(`top_k=${genConfig.top_k}`);
    if (genConfig.max_new_tokens !== undefined) defaults.push(`max_new_tokens=${genConfig.max_new_tokens}`);
    if (defaults.length > 0) {
      summary.push(`HF generation defaults: ${defaults.join(', ')}`);
    }

    // Apply HF generation_config as the model's defaultParams (shared baseline).
    // These are authoritative values from the model's own config, not invented params.
    // They can be overridden per-mode by a modelModes preset or user settings.
    // Only include fields that are actually present in genConfig.
    const defaultParams: Record<string, unknown> = {};
    if (genConfig.temperature !== undefined) defaultParams.temperature = genConfig.temperature;
    if (genConfig.top_p !== undefined) defaultParams.top_p = genConfig.top_p;
    if (genConfig.top_k !== undefined) defaultParams.top_k = genConfig.top_k;
    if (genConfig.repetition_penalty !== undefined) defaultParams.repetition_penalty = genConfig.repetition_penalty;
    if (Object.keys(defaultParams).length > 0) {
      modelConfig.defaultParams = defaultParams;
    }
  }

  // 3. Process HuggingFace model info
  if (hfInfo) {
    // Extract model family from config.model_type (e.g. "qwen3_5", "deepseek_v4")
    if (hfInfo.config?.model_type) {
      modelConfig.family = hfInfo.config.model_type;
      summary.push(`Model family: ${hfInfo.config.model_type}`);
    }

    // Detect image/vision support from pipeline_tag
    const visionPipelineTags = [
      'image-text-to-text',
      'visual-question-answering',
      'image-to-text',
      'video-text-to-text',
      'document-question-answering',
    ];

    // Also detect from model_type (e.g. "qwen2_5_vl", "llava", "video_llava")
    const modelType = hfInfo.config?.model_type || '';
    const visionModelTypes = ['vl', 'vision', 'video', 'llava', 'mllama', 'molmo', 'pixtral', 'internvl'];
    const isVisionModelType = visionModelTypes.some(t => modelType.toLowerCase().includes(t));

    if (visionPipelineTags.includes(hfInfo.pipeline_tag || '') || isVisionModelType) {
      modelConfig.capabilities = { toolCalling: true, imageInput: true };
      const detectedBy = hfInfo.pipeline_tag
        ? `pipeline: ${hfInfo.pipeline_tag}`
        : `model_type: ${modelType}`;
      summary.push(`Vision support detected (${detectedBy})`);
      summary.push('  ⚠ Requires vLLM launched WITHOUT --language-model-only');
    }

    // Detect tool calling support from chat template (the only thing reliably discoverable)
    const chatTemplate = hfInfo.config?.tokenizer_config?.chat_template;
    if (chatTemplate) {
      const hasToolSupport = /tools\s+is\s+iterable|tool_call|function_call/.test(chatTemplate);
      if (hasToolSupport) {
        modelConfig.capabilities ??= {};
        modelConfig.capabilities.toolCalling = true;
        summary.push('Tool calling support detected in chat template');
        summary.push('  ⚠ Requires vLLM launched with --enable-auto-tool-choice --tool-call-parser <parser>');
      }
      // NOTE: modelModes (Think/No Think) are NOT auto-detected from templates.
      // They require model-specific knowledge that isn't discoverable from Jinja conditionals.
      // Configure them in model-configs/ presets or directly in settings.
    } else {
      summary.push('⚠ No chat template found on HuggingFace');
    }
  } else {
    summary.push('⚠ Could not fetch model info from HuggingFace (model may be private or ID differs from HF repo)');
  }

  // 4. Ensure all capability fields are explicitly set (even defaults)
  // This way users see every option in their config and can change it
  modelConfig.capabilities ??= { toolCalling: true, imageInput: false };
  if (modelConfig.capabilities.toolCalling === undefined) {
    modelConfig.capabilities.toolCalling = true;
  }
  if (modelConfig.capabilities.imageInput === undefined) {
    modelConfig.capabilities.imageInput = false;
  }

  // 5. Add vLLM launch requirements summary
  summary.push('');
  summary.push('Note: These capabilities were detected from HuggingFace model metadata.');
  summary.push('They only work if vLLM is launched with the required flags.');
  summary.push('Sampling parameters in a selected modelMode override the model\'s defaultParams.');
  summary.push('If a feature does not work, check your vLLM server launch command.');

  return { modelConfig, summary, suggestedMaxOutputTokens };
}

// ---- Shared fetch helpers ----

/**
 * Centralized fetch with timeout and optional request headers.
 * Replaces duplicated fetch/timeout logic scattered across autoConfig functions.
 * `requestHeaders` carry this server's isolated per-model auth (e.g. X-API-Key,
 * Authorization) — there is no global auth layer.
 */
async function fetchWithTimeout(
  url: string,
  options: { timeoutMs: number; requestHeaders?: Record<string, string> } = { timeoutMs: 10000 }
): Promise<Response> {
  return fetch(url, {
    headers: { ...(options.requestHeaders ?? {}) },
    signal: AbortSignal.timeout(options.timeoutMs),
  });
}

// Supplementary fetch failures are reported via the summary array,
// not as pop-up modals — they would interrupt the auto-configure progress flow.

// ---- HuggingFace fetchers ----

async function fetchHuggingFaceModel(modelId: string): Promise<HfModelInfo | null> {
  try {
    const url = `https://huggingface.co/api/models/${modelId}`;
    const resp = await fetchWithTimeout(url, { timeoutMs: 15000 });
    if (!resp.ok) {
      return null;
    }
    return await resp.json() as HfModelInfo;
  } catch {
    return null;
  }
}

async function fetchGenerationConfig(modelId: string): Promise<HfGenerationConfig | null> {
  try {
    const url = `https://huggingface.co/${modelId}/raw/main/generation_config.json`;
    const resp = await fetchWithTimeout(url);
    if (!resp.ok) {
      return null;
    }
    return await resp.json() as HfGenerationConfig;
  } catch {
    return null;
  }
}

// ---- vLLM fetcher ----

async function fetchVllmModelInfo(
  modelId: string,
  serverUrl: string,
  requestHeaders?: Record<string, string>
): Promise<VllmModelInfo | null> {
  const url = buildEndpoint(serverUrl, 'v1/models');
  const resp = await fetchWithTimeout(url, { timeoutMs: 10000, requestHeaders });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} from ${url}`);
  }
  const data: any = await resp.json();
  const models: any[] = data.data || [];
  return models.find((m: any) => m.id === modelId) || null;
}

/**
 * Minimal shape required from a `GET /v1/models` entry to feed the picker.
 * Both `addServerModel` and `testAndRefreshModels` consume `GET /v1/models`
 * and present the same quick-pick UI; this shared helper is the single
 * source for that UX so the two flows cannot drift.
 */
export interface ServerModelChoice {
  id: string;
  root?: string;
  max_model_len?: number;
}

/**
 * Show a QuickPick of models returned by a vLLM server and return the user's
 * chosen `id`, or `undefined` if they cancel. Shared by the "Add Server &
 * Model" command (initial selection) and the "Test & Refresh Models" command
 * (corrective selection when a configured `vllmModelId` is not on the server).
 *
 * Item layout mirrors the prior inline picker: model id as label, max_model_len
 * as description, and root (when present) as detail so an alias served under
 * `--served-model-name` shows the checkpoint it points at.
 */
export async function pickModelFromServer(
  models: ServerModelChoice[],
  host: string,
  title?: string
): Promise<string | undefined> {
  const items: vscode.QuickPickItem[] = models.map(m => ({
    label: m.id,
    description: m.max_model_len ? `${m.max_model_len.toLocaleString()} ctx` : '',
    detail: m.root ? `root: ${m.root}` : '',
  }));
  const selected = await vscode.window.showQuickPick(items, {
    ...(title ? { title } : {}),
    placeHolder: `Select a model on ${host}`,
  });
  return selected?.label;
}

/**
 * Save the auto-configured model config into the user's vllm-copilot.models setting.
 * Replaces the entire entry for this model (user is prompted before overwriting).
 * Exported so `testAndRefreshModels` can reuse the same dedup + persistence
 * path when correcting a mismatched `vllmModelId` in place.
 */
export async function saveModelConfig(newConfig: ModelConfig): Promise<void> {
  const config = vscode.workspace.getConfiguration('vllm-copilot');
  const existing: ModelConfig[] = config.get<ModelConfig[]>('models') || [];

  // Match by the true identity: same server URL AND same vLLM model id. This lets
  // the same model served from two different servers coexist as separate entries
  // (manual load balancing) while re-adding the same (server, model) replaces in
  // place. Fall back to an exact `id` match for hand-written entries that predate
  // the composite-id scheme.
  const newVllmId = resolveVllmModelId(newConfig);
  const newServer = newConfig.serverUrl ? normalizeServerUrl(newConfig.serverUrl) : undefined;
  const idx = existing.findIndex(m => {
    const sameIdentity =
      newServer !== undefined &&
      m.serverUrl !== undefined &&
      normalizeServerUrl(m.serverUrl) === newServer &&
      resolveVllmModelId(m) === newVllmId;
    const sameId = m.id !== undefined && m.id === newConfig.id;
    return sameIdentity || sameId;
  });
  if (idx >= 0) {
    // Preserve ONLY infrastructure/personal fields that the preset cannot know.
    // Everything model-specific (modelModes, family, capabilities, defaultParams,
    // token budgets, transport settings) is overwritten by the preset — that's the
    // whole point: the preset configures the model as an "expert" would, and the
    // user keeps their server URL, auth headers, and personal replacements file.
    const prev = existing[idx];
    existing[idx] = {
      ...newConfig,
      serverUrl: newConfig.serverUrl ?? prev.serverUrl,
      requestHeaders: newConfig.requestHeaders ?? prev.requestHeaders,
      systemMessageReplacementsFile: newConfig.systemMessageReplacementsFile ?? prev.systemMessageReplacementsFile,
    };
  } else {
    existing.push(newConfig);
  }

  await config.update('models', existing, vscode.ConfigurationTarget.Global);

  // Ensure BYOK utility model default is set — idempotent, safe to call on every save.
  ensureByokUtilityDefault();
}

/**
 * Ensure that `chat.byokUtilityModelDefault` is set to `'mainAgent'` so that
 * VS Code uses the selected BYOK model for utility flows (titles, commit
 * messages, intent detection). Without this, agent mode with MCP servers
 * (which triggers utility model resolution) fails with:
 * "No utility model is configured for 'copilot-utility-small' while the
 * selected main agent model is BYOK."
 *
 * This is idempotent — if already set, it does nothing.
 * @internal Exported for testing.
 */
export async function ensureByokUtilityDefault(): Promise<void> {
  const chatConfig = vscode.workspace.getConfiguration('chat');
  const inspected = chatConfig.inspect(BYOK_UTILITY_MODEL_DEFAULT_SECTION_KEY);
  // The setting was introduced in VS Code 1.128. On older versions it is not a
  // registered configuration, so writing it throws "not a registered
  // configuration". A registered setting always reports a defaultValue; its
  // absence means this VS Code build doesn't know the setting — bail out.
  if (inspected?.defaultValue === undefined) return;
  // Only set if the user hasn't explicitly written it to settings.json.
  const hasExplicitValue =
    inspected.globalValue !== undefined ||
    inspected.workspaceValue !== undefined;
  if (!hasExplicitValue) {
    try {
      await chatConfig.update(
        BYOK_UTILITY_MODEL_DEFAULT_SECTION_KEY,
        MAIN_AGENT_BYOK_UTILITY_MODEL_DEFAULT,
        vscode.ConfigurationTarget.Global
      );
    } catch {
      // Not writable on this VS Code build — ignore (older versions).
    }
  }
}

/**
 * Configure the BYOK utility model default setting. Lets the user choose
 * between using the main agent model, GitHub Copilot, or none for utility
 * flows. This is the manual counterpart to the auto-configuration above.
 */
export async function configureByokUtilityModel(output: vscode.OutputChannel): Promise<void> {
  const chatConfig = vscode.workspace.getConfiguration('chat');
  const current = chatConfig.get<string>(BYOK_UTILITY_MODEL_DEFAULT_SECTION_KEY);

  const pick = await vscode.window.showQuickPick(
    [
      {
        label: 'Main Agent Model',
        description: `Use the selected BYOK model for utility tasks (recommended)${current === MAIN_AGENT_BYOK_UTILITY_MODEL_DEFAULT ? ' ● Current' : ''}`,
        value: MAIN_AGENT_BYOK_UTILITY_MODEL_DEFAULT,
      },
      {
        label: 'GitHub Copilot',
        description: `Use Copilot's built-in utility models${current === 'copilot' ? ' ● Current' : ''}`,
        value: 'copilot',
      },
      {
        label: 'None',
        description: `No utility model (utility flows will fail with BYOK)${current === 'none' || !current ? ' ● Current' : ''}`,
        value: 'none',
      },
    ],
    {
      placeHolder: 'Select utility model behavior for BYOK models',
    }
  );

  if (!pick) return;

  await chatConfig.update(
    BYOK_UTILITY_MODEL_DEFAULT_SECTION_KEY,
    pick.value,
    vscode.ConfigurationTarget.Global
  );

  output.appendLine(`[INFO] BYOK utility model default set to '${pick.value}'`);
  vscode.window.showInformationMessage(
    `Utility model default: ${pick.label}`
  );
}

/**
 * Show the final confirm dialog for a newly added model, then save it (or copy
 * its JSON) and offer a window reload. Shared by the preset and HuggingFace
 * branches of the Add flow so both end the same way.
 */
async function confirmAndSaveAddedModel(
  finalConfig: ModelConfig,
  modelId: string,
  serverUrl: string,
  detail: string,
  output: vscode.OutputChannel,
  onSaved?: () => void
): Promise<boolean> {
  output.appendLine(`[INFO] Add server ${serverUrl} → ${modelId}:`);
  output.appendLine(detail);
  output.appendLine(`Config: ${JSON.stringify(finalConfig, null, 2)}`);

  const action = await vscode.window.showInformationMessage(
    `Add "${modelId}" from ${serverUrl}?\n\n${detail}`,
    { modal: true },
    'Save to Settings',
    'Copy JSON'
  );

  if (action === 'Save to Settings') {
    await saveModelConfig(finalConfig);
    onSaved?.();
    vscode.window.showInformationMessage(`Model "${modelId}" added.`);
    return true;
  } else if (action === 'Copy JSON') {
    await vscode.env.clipboard.writeText(JSON.stringify(finalConfig, null, 2));
    vscode.window.showInformationMessage('Model config copied to clipboard.');
  }
  return false;
}

/**
 * Parse a user-entered headers string into a validated `Record<string, string>`.
 * Accepts either JSON (`{"X-API-Key":"..."}`) or blank (no headers).
 * Returns `undefined` on parse/type error (caller shows the message).
 *
 * Forgiving: accepts strict JSON (`{"X-API-Key":"..."}`) and, via `jsonrepair`,
 * common shorthand — missing outer braces (`"X-API-Key":"..."`), unquoted
 * keys/values (`X-API-Key: abc`), single quotes, trailing/missing commas, and
 * one-pair-per-line input. Blank input means no headers.
 * @internal Exported for testing.
 */
export function parseHeadersInput(raw: string): { headers: Record<string, string> } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { headers: {} };

  const headerNameRe = /^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/;

  // Validate + normalize a parsed value into a Record<string,string>.
  // Coerce numeric/boolean values to strings — header values are always strings.
  const fromObject = (parsed: unknown): { headers: Record<string, string> } | { error: string } | null => {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const name = k.trim();
      if (!headerNameRe.test(name)) return { error: `Invalid header name "${name}".` };
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        headers[name] = String(v);
      } else {
        return { error: `Header "${name}" must be a string value.` };
      }
    }
    return { headers };
  };

  // Candidate strings to try parsing/repairing, in order of preference.
  // The brace-wrapped variant handles input that omits the outer { }.
  const candidates = trimmed.startsWith('{') ? [trimmed] : [trimmed, `{${trimmed}}`];

  for (const candidate of candidates) {
    // Strict parse first, then jsonrepair as a fallback (same pattern as tool-call args).
    for (const text of [candidate, tryRepair(candidate)]) {
      if (text === undefined) continue;
      try {
        const result = fromObject(JSON.parse(text));
        if (result) return result;
      } catch { /* try next candidate */ }
    }
  }

  return { error: 'Headers must be JSON like {"X-API-Key":"..."} or lines like X-API-Key: value' };
}

/** Repair a malformed JSON string; returns undefined if repair itself throws. */
function tryRepair(text: string): string | undefined {
  try {
    return jsonrepair(text);
  } catch {
    return undefined;
  }
}

/**
 * Guided command: add a vLLM server (URL + optional headers), discover its models,
 * auto-configure the chosen one, and save it as a per-model entry. This is the
 * end-to-end flow for onboarding a second server without hand-editing settings.json.
 */
export function registerAddServerModelCommand(
  context: vscode.ExtensionContext,
  provider: any, // VllmChatModelProvider — avoids circular import
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.addServerModel', async () => {
    // 1. Server URL
    const urlInput = await vscode.window.showInputBox({
      title: 'Add vLLM Server & Model (1/4)',
      prompt: 'Enter the vLLM server URL',
      placeHolder: 'https://your-server.example.com',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Server URL is required'),
    });
    if (!urlInput) return;
    const serverUrl = normalizeServerUrl(urlInput);

    // Check if this server already exists
    const existingModels: ModelConfig[] = vscode.workspace.getConfiguration('vllm-copilot').get('models') || [];
    const existingServerModels = existingModels.filter(
      m => m.serverUrl && normalizeServerUrl(m.serverUrl) === serverUrl
    );

    if (existingServerModels.length > 0) {
      const modelNames = existingServerModels.map(m => m.displayName || m.vllmModelId || m.id).join(', ');
      const pick = await vscode.window.showInformationMessage(
        `Server already configured with: ${modelNames}`,
        { modal: true },
        'Add Different Model',
        'Update Auth',
      );
      if (pick === 'Update Auth') {
        // Delegate to update auth command
        return vscode.commands.executeCommand('vllm-copilot.updateServerAuth', serverUrl);
      }
      if (pick !== 'Add Different Model') return; // cancelled
    }

    // 2. API key (optional). Folded into headers as Authorization: Bearer.
    const apiKeyInput = await vscode.window.showInputBox({
      title: 'Add vLLM Server & Model (2/4)',
      prompt: 'API key for this server (optional). Sent as "Authorization: Bearer <key>". For other schemes (e.g. x-api-key), use custom headers next.',
      placeHolder: 'Leave empty if the server needs no key, or use custom headers next.',
      ignoreFocusOut: true,
      password: true,
    });
    if (apiKeyInput === undefined) return; // cancelled
    const apiKey = apiKeyInput.trim();

    // 3. Custom headers (optional). Accepts JSON or forgiving shorthand.
    //    Merged on top of the key-derived auth headers, so a custom header wins.
    const headersInput = await vscode.window.showInputBox({
      title: 'Add vLLM Server & Model (3/4)',
      prompt: 'Additional request headers for this server. JSON or "Name: value" — leave empty for none.',
      placeHolder: '{"CF-Access-Client-Id": "..."}  or  X-Tenant: abc123',
      ignoreFocusOut: true,
      validateInput: (v) => {
        const r = parseHeadersInput(v);
        return 'error' in r ? r.error : undefined;
      },
    });
    if (headersInput === undefined) return; // cancelled
    const parsedHeaders = parseHeadersInput(headersInput);
    if ('error' in parsedHeaders) {
      vscode.window.showErrorMessage(parsedHeaders.error);
      return;
    }
    // Combine: API-key-derived auth first, then custom headers (custom wins).
    const requestHeaders = { ...buildAuthHeaders(apiKey), ...parsedHeaders.headers };
    const hasHeaders = Object.keys(requestHeaders).length > 0;

    // 4. Discover models on that server, using its headers
    let models: any[];
    try {
      const url = buildEndpoint(serverUrl, 'v1/models');
      const resp = await fetchWithTimeout(url, { timeoutMs: 10000, requestHeaders });
      if (!resp.ok) {
        vscode.window.showErrorMessage(
          resp.status === 401 || resp.status === 403
            ? `Authentication failed (status ${resp.status}). Check the API key or request headers for ${serverUrl}.`
            : `Cannot reach ${serverUrl} (status ${resp.status}).`
        );
        return;
      }
      const data: any = await resp.json();
      models = data.data || [];
    } catch (err) {
      output.appendLine(`[ERROR] Add server: cannot connect to ${serverUrl}: ${describeError(err)}`);
      // Offer a deep diagnostic using the in-memory values the user just typed
      // (not from settings.json — the server isn't saved yet). This tests the
      // exact request that failed: same URL, same headers.
      const runDiag = await vscode.window.showWarningMessage(
        `Cannot connect to ${serverUrl}: ${describeError(err)}`,
        'Run Diagnostic',
        'Cancel'
      );
      if (runDiag === 'Run Diagnostic') {
        const { runDiagnostics, formatReport } = await import('./diagnostics.js');
        const report = await runDiagnostics(buildEndpoint(serverUrl, 'v1/models'), requestHeaders);
        output.show(true);
        output.appendLine(formatReport(report));
        output.appendLine('');
        output.appendLine(
          'Copy this report (right-click → Copy) and share it when reporting issues.'
        );
      }
      return;
    }

    if (models.length === 0) {
      vscode.window.showInformationMessage(`No models found on ${serverUrl}.`);
      return;
    }

    const modelId = await pickModelFromServer(models, serverUrl, 'Add vLLM Server & Model (4/4)');
    if (!modelId) return;

    // Check if this model already exists on this server
    const newVllmId = modelId;
    const existingSameModel = existingServerModels.find(m => resolveVllmModelId(m) === newVllmId);

    if (existingSameModel) {
      const pick = await vscode.window.showInformationMessage(
        `"${modelId}" already exists on this server. Update auth only, or replace entire config?`,
        { modal: true },
        'Update Auth',
        'Replace Config',
      );
      if (pick === 'Update Auth') {
        // Update auth for all models on this server (reuses updateServerAuth)
        return vscode.commands.executeCommand('vllm-copilot.updateServerAuth', serverUrl);
      }
      if (pick !== 'Replace Config') return; // cancelled
    }

    const discoveryResult = await resolveModelConfigForAdd(
      context, modelId, serverUrl, hasHeaders ? requestHeaders : undefined,
      models.find((m: any) => m.id === modelId)?.root
    );
    if (!discoveryResult) return;

    // Attach the server + headers. `id` is composite ("<model> on <host>") so the
    // same model on two servers stays distinct; `vllmModelId` remains the raw wire identity.
    const finalConfig: ModelConfig = {
      ...discoveryResult.modelConfig,
      id: buildModelId(serverUrl, modelId),
      vllmModelId: modelId,
      serverUrl,
      ...(hasHeaders ? { requestHeaders } : {}),
    };
    if (discoveryResult.suggestedMaxOutputTokens !== undefined && finalConfig.maxOutputTokens === undefined) {
      finalConfig.maxOutputTokens = discoveryResult.suggestedMaxOutputTokens;
    }

    await confirmAndSaveAddedModel(finalConfig, modelId, serverUrl, discoveryResult.summary.join('\n'), output, () => provider.clearCache());
  });
}

/**
 * Shared resolution: check for a curated preset, show dialog (Use Preset / Auto-Discover),
 * then either return the preset-merged config or fall through to HuggingFace discovery.
 * Returns `{ modelConfig, summary, suggestedMaxOutputTokens }` or `null` if cancelled.
 *
 * @param baseConfig - The user's existing config (for auto-configure) or a minimal identity
 *   config (for add-server). Fields like `serverUrl` are added by the caller.
 * @param serverRoot - Optional `root` from vLLM server model info (used for preset matching).
 */
export async function resolveModelConfigForAdd(
  context: vscode.ExtensionContext,
  modelId: string,
  serverUrl: string,
  requestHeaders?: Record<string, string>,
  serverRoot?: string,
  baseConfig?: ModelConfig
): Promise<AutoConfigResult | null> {
  const presets = await loadModelPresets(context.extensionUri);
  const preset = findPresetForModel(presets, modelId, serverRoot);

  if (preset) {
    const modeNames = Object.keys(preset.config.modelModes ?? {}).join(', ') || 'none';
    const choice = await vscode.window.showInformationMessage(
      `A curated preset is available for "${modelId}" (${preset.sourceFile}).\n\nModes: ${modeNames}.\n\nUse the preset, or auto-discover settings from HuggingFace instead?`,
      { modal: true },
      'Use Preset',
      'Auto-Discover'
    );
    if (choice === undefined) return null; // cancelled
    if (choice === 'Use Preset') {
      const userConfig = baseConfig ?? { id: modelId, vllmModelId: modelId };
      return {
        modelConfig: mergePresetWithUserConfig(preset.config, userConfig),
        summary: [`Using preset ${preset.sourceFile}. Modes: ${modeNames}.`],
      };
    }
  }

  // HuggingFace auto-discovery. `autoConfigureModel` will fetch `root` from the
  // vLLM server and use it for HF lookups when `modelId` is a quantized variant.
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Auto-configuring ${modelId}...`,
      cancellable: false,
    },
    async () => autoConfigureModel(modelId, serverUrl, requestHeaders)
  );
}

/**
 * Standalone command: re-run auto-configuration (HuggingFace + vLLM server discovery)
 * for an already-configured model. Lets the user update modelModes, capabilities,
 * family, token budgets, etc. without deleting and re-adding the model.
 */
export function registerAutoConfigureModelCommand(
  context: vscode.ExtensionContext,
  provider: any, // VllmChatModelProvider — avoids circular import
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.autoConfigureModel', async () => {
    // 1. Pick an existing model
    const config = vscode.workspace.getConfiguration('vllm-copilot');
    const existing: ModelConfig[] = config.get<ModelConfig[]>('models') || [];
    if (existing.length === 0) {
      vscode.window.showInformationMessage('No models configured. Use "Add vLLM Server & Model" first.');
      return;
    }

    const items = existing.map((m, idx) => {
      const label = m.displayName || resolveVllmModelId(m);
      const server = m.serverUrl ? ` (${normalizeServerUrl(m.serverUrl)})` : '';
      return {
        label,
        description: `#${idx + 1}`,
        detail: m.serverUrl || '(no server)',
      } as vscode.QuickPickItem;
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a model to re-configure',
    });
    if (!selected) return;

    // Find the matching config entry
    const idx = items.indexOf(selected);
    const modelConfig = existing[idx];
    if (!modelConfig) return;

    const vllmId = resolveVllmModelId(modelConfig);
    if (!vllmId) {
      vscode.window.showErrorMessage('Selected model has no identifiable vLLM model id.');
      return;
    }
    const serverUrl = modelConfig.serverUrl;

    if (!serverUrl) {
      vscode.window.showErrorMessage(`Model "${vllmId}" has no serverUrl configured.`);
      return;
    }

    // 2. Shared resolution (preset check → dialog → preset or HuggingFace)
    const discoveryResult = await resolveModelConfigForAdd(
      context, vllmId, normalizeServerUrl(serverUrl), modelConfig.requestHeaders,
      undefined, // no server root for existing models
      modelConfig // preserve identity
    );
    if (!discoveryResult) return;

    // 3. Merge: discovery result is the base (full model-specific replace).
    //    Only infrastructure/personal fields survive from the user's old config.
    const newConfig: ModelConfig = {
      ...discoveryResult.modelConfig,
      id: modelConfig.id,
      vllmModelId: modelConfig.vllmModelId,
      serverUrl: modelConfig.serverUrl,
      requestHeaders: modelConfig.requestHeaders,
      systemMessageReplacementsFile: modelConfig.systemMessageReplacementsFile,
      autoContinueRetries: modelConfig.autoContinueRetries,
      streamInactivityTimeout: modelConfig.streamInactivityTimeout,
    };
    if (discoveryResult.suggestedMaxOutputTokens !== undefined && newConfig.maxOutputTokens === undefined) {
      newConfig.maxOutputTokens = discoveryResult.suggestedMaxOutputTokens;
    }

    await applyAutoConfigUpdate(newConfig, vllmId, discoveryResult.summary.join('\n'), output, () => provider.clearCache());
  });
}

/**
 * Show the final confirm dialog for an auto-configured model update, then save it
 * or copy its JSON. Shared by the preset and HuggingFace branches so both end
 * the same way.
 */
async function applyAutoConfigUpdate(
  newConfig: ModelConfig,
  vllmId: string,
  detail: string,
  output: vscode.OutputChannel,
  onSaved?: () => void
): Promise<void> {
  output.appendLine(`[INFO] Auto-configure ${vllmId}:`);
  output.appendLine(detail);

  const action = await vscode.window.showInformationMessage(
    `Update configuration for "${vllmId}"?`,
    { modal: true },
    'Save',
    'Copy JSON'
  );

  if (action === 'Save') {
    await saveModelConfig(newConfig);
    onSaved?.();
    vscode.window.showInformationMessage(`Model "${vllmId}" updated.`);
  } else if (action === 'Copy JSON') {
    await vscode.env.clipboard.writeText(JSON.stringify(newConfig, null, 2));
    vscode.window.showInformationMessage('Model config copied to clipboard.');
  }
}

/**
 * Register the "Configure Utility Model" command.
 */
export function registerConfigureUtilityModelCommand(
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.configureUtilityModel', async () => {
    await configureByokUtilityModel(output);
  });
}
