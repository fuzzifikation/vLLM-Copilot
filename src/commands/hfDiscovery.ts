import * as vscode from 'vscode';
import type { ModelConfig, ServerType } from '../state/config.js';
import { buildEndpoint } from '../state/config.js';
import { describeError } from '../provider/messageConverter.js';
import { resolveRuntimeLimits } from '../backends/runtimeLimits.js';
import { autoConfigureOpenRouterModel } from '../backends/openRouter.js';
import { fetchRemotePreset } from './presetRemote.js';
import { loadModelPresets, findPresetForModel, mergePresetWithUserConfig, presetBlobUrl } from './presets.js';

/**
 * Auto-configure a model by fetching metadata from HuggingFace and the server.
 *
 * Discovers:
 * - modelModes from chat_template Jinja2 kwargs (enable_thinking, preserve_thinking)
 * - imageInput capability from pipeline_tag
 * - context window from the shared backend-aware resolver (resolveRuntimeLimits)
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
  /**
   * Set only when the config came from the "Use Preset" branch (bundled or
   * remote preset file name). The Add/Auto-configure flows use it to skip the
   * redundant second confirm modal — the preset dialog already captured
   * informed consent (modes + notes + provenance), so saving straight to a
   * toast is proportionate. Absent for HuggingFace/OpenRouter discovery, which
   * keep the review-before-save modal because their config is guesswork.
   */
  presetFile?: string;
}

/**
 * Run auto-configuration for a model. Fetches from HuggingFace + the server.
 *
 * The context window comes from the SHARED backend-aware resolver
 * (`resolveRuntimeLimits`) — no independent context parsing here. `/v1/models` is
 * read only for `root` (used to resolve the real HF repo when the served id is a
 * quantized/aliased variant).
 *
 * When a model is served under a quantized or aliased name (e.g. `qwen3.6-27b-fp8`),
 * `vllmInfo.root` points to the base HuggingFace repo (`Qwen/Qwen3.6-27B`). HF lookups
 * use this `root` so they resolve metadata for the actual model, not the served alias.
 */
async function autoConfigureModel(
  modelId: string,
  serverUrl: string,
  requestHeaders?: Record<string, string>,
  serverType: ServerType = 'vllm',
  serverRoot?: string,
): Promise<AutoConfigResult> {
  const summary: string[] = [];
  // `server: ''` is a placeholder — the caller (Add/Auto-configure flow) resolves
  // the real registry entry and overwrites the reference before persisting.
  const modelConfig: ModelConfig = { id: modelId, vllmModelId: modelId, server: '' };

  // 1. Fetch served-model info for `root` (HF-repo link only — the context
  //    window itself comes from the shared resolver below).
  // When the caller already holds the served model's `root` (the Add flow
  // probed /v1/models for its picker), reuse it instead of fetching the same
  // answer a second time (audit P8-7); the standalone re-configure path still
  // probes here.
  let hfBase: string | undefined = serverRoot;
  if (hfBase === undefined) {
    let vllmInfo: VllmModelInfo | null = null;
    try {
      vllmInfo = await fetchVllmModelInfo(modelId, serverUrl, requestHeaders);
    } catch (err) {
      summary.push(`⚠ Could not fetch model info from server: ${describeError(err)}`);
    }
    hfBase = vllmInfo?.root ?? undefined;
  }
  let suggestedMaxOutputTokens: number | undefined;
  // Context resolution is MANDATORY — no context, no model (strict policy).
  // The resolver THROWS a backend-specific message (endpoint, field, fix) when the
  // model can't be served; propagating it prevents saving an unusable model.
  const limits = await resolveRuntimeLimits(serverType, serverUrl, requestHeaders ?? {}, modelId);
  summary.push(`Context window (${serverType}): ${limits.contextWindow.toLocaleString('en-US')} tokens`);
  suggestedMaxOutputTokens = Math.min(
    Math.floor(limits.contextWindow * OUTPUT_TOKEN_FACTOR),
    OUTPUT_TOKEN_CAP
  );
  summary.push(`Suggested max output tokens: ${suggestedMaxOutputTokens.toLocaleString('en-US')}`);

  // Use the base HF repo (root) for HF lookups — quantized variants (e.g. `qwen3.6-27b-fp8`)
  // don't exist on HF; only the base model (`Qwen/Qwen3.6-27B`) does.
  const hfLookupId = hfBase ?? modelId;

  // 2. Fetch generation_config.json and HuggingFace model info in parallel.
  // Both fetchers swallow every failure into `null` themselves, so a dead
  // supplementary source degrades to "no extra data" and never rejects —
  // plain Promise.all is the honest shape here (audit P8-6 deleted the
  // unreachable allSettled rejection branches).
  const [genConfig, hfInfo] = await Promise.all([
    fetchGenerationConfig(hfLookupId),
    fetchHuggingFaceModel(hfLookupId),
  ]);

  if (genConfig) {
    const defaults: string[] = [];
    if (genConfig.temperature !== undefined) defaults.push(`temperature=${genConfig.temperature}`);
    if (genConfig.top_p !== undefined) defaults.push(`top_p=${genConfig.top_p}`);
    if (genConfig.top_k !== undefined) defaults.push(`top_k=${genConfig.top_k}`);
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
      // Vision proves imageInput and NOTHING else. toolCalling belongs to the
      // chat-template check below: claiming it here made the template's
      // detected-absence branch (guarded on `=== undefined`) structurally
      // unreachable, so a vision model whose template has no tool markers was
      // saved with toolCalling: true while the summary printed "No tool
      // calling markers in chat template" — config contradicting its own report.
      modelConfig.capabilities ??= {};
      modelConfig.capabilities.imageInput = true;
      const detectedBy = hfInfo.pipeline_tag
        ? `pipeline: ${hfInfo.pipeline_tag}`
        : `model_type: ${modelType}`;
      summary.push(`Vision support detected (${detectedBy})`);
      if (serverType === 'vllm') {
        summary.push('  ⚠ Requires vLLM launched WITHOUT --language-model-only');
      }
    }

    // Detect tool calling support from chat template (the only thing reliably discoverable)
    const chatTemplate = hfInfo.config?.tokenizer_config?.chat_template;
    if (chatTemplate) {
      const hasToolSupport = /tools\s+is\s+iterable|tool_call|function_call/.test(chatTemplate);
      if (hasToolSupport) {
        modelConfig.capabilities ??= {};
        modelConfig.capabilities.toolCalling = true;
        summary.push('Tool calling support detected in chat template');
        if (serverType === 'vllm') {
          summary.push('  ⚠ Requires vLLM launched with --enable-auto-tool-choice --tool-call-parser <parser>');
        }
      } else {
        // The template is present but declares no tool support. Record the
        // detected absence explicitly — the step-4 fallback must NOT re-claim
        // tool calling for a model whose own template proves it lacks it.
        modelConfig.capabilities ??= {};
        if (modelConfig.capabilities.toolCalling === undefined) {
          modelConfig.capabilities.toolCalling = false;
        }
        summary.push('No tool calling markers in chat template');
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

  // 5. Add launch requirements summary (vLLM-specific advice only for vLLM servers)
  summary.push('');
  summary.push('Note: These capabilities were detected from HuggingFace model metadata.');
  if (serverType === 'vllm') {
    summary.push('They only work if vLLM is launched with the required flags.');
  }
  summary.push('Sampling parameters in a selected modelMode override the model\'s defaultParams.');
  if (serverType === 'vllm') {
    summary.push('If a feature does not work, check your vLLM server launch command.');
  }

  return { modelConfig, summary, suggestedMaxOutputTokens };
}

// ---- Shared fetch helpers ----

/**
 * Centralized fetch with timeout and optional request headers.
 * Replaces duplicated fetch/timeout logic scattered across the Add-server flow.
 * `requestHeaders` carry this server's isolated per-model auth (e.g. X-API-Key,
 * Authorization) — there is no global auth layer.
 * @internal Exported for the add-server flow, which fetches /v1/models directly.
 */
export async function fetchWithTimeout(
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
  const data = await resp.json() as { data?: VllmModelInfo[] };
  const models: VllmModelInfo[] = data.data || [];
  return models.find((m) => m.id === modelId) || null;
}

/**
 * Shared resolution: check for a curated preset, show dialog (Use Preset / Auto-Discover),
 * then either return the preset-merged config or fall through to HuggingFace discovery.
 * Returns `{ modelConfig, summary, suggestedMaxOutputTokens }` or `null` if cancelled.
 *
 * Shared by the Add-server and Auto-configure flows (a preset-match dialog is the
 * only UI dependency), so it lives here rather than in either flow module — keeping
 * the flow modules acyclic.
 *
 * @param baseConfig - The user's existing config (for auto-configure) or a minimal identity
 *   config (for add-server). The `server` reference is set by the caller.
 * @param serverRoot - Optional `root` from vLLM server model info (used for preset matching).
 * @param log - Optional output-channel logger (remote preset lookup diagnostics).
 */
export async function resolveModelConfigForAdd(
  context: vscode.ExtensionContext,
  modelId: string,
  serverUrl: string,
  requestHeaders?: Record<string, string>,
  serverRoot?: string,
  baseConfig?: ModelConfig,
  serverType: ServerType = 'vllm',
  log?: (msg: string) => void,
): Promise<AutoConfigResult | null> {
  // OpenRouter: exact-model metadata is the ONLY discovery source. HF chat-
  // template sniffing cannot express its reasoning object or
  // supported_parameters, and would append a misleading "detected from
  // HuggingFace" summary. Route before the preset/HF machinery so OpenRouter
  // never mixes in HuggingFace (the Add flow's dedicated branch and this shared
  // resolver stay in sync).
  if (serverType === 'openrouter') {
    // Catalog metadata is public/unauthenticated — no per-model headers sent.
    return autoConfigureOpenRouterModel(modelId);
  }

  // Bundled presets (local fs) and the live remote lookup run IN PARALLEL —
  // the lookup is bounded (2 s timeout) and every failure resolves undefined,
  // so offline/air-gapped behaves exactly like the bundled-only flow.
  const bundledPromise = loadModelPresets(context.extensionUri);
  const remotePromise = fetchRemotePreset(modelId, serverRoot, log ?? (() => {}));
  const bundled = await bundledPromise;
  const remote = await remotePromise;
  // Array order IS the priority rule: findPresetForModel breaks longest-match
  // ties by first-wins, so [remote, ...bundled] makes a remote preset win over
  // a same-pattern bundled one, while a longer (more specific) bundled pattern
  // still wins. Zero new selection logic.
  const presets = remote ? [remote, ...bundled] : bundled;
  const preset = findPresetForModel(presets, modelId, serverRoot);

  if (preset) {
    const modeNames = Object.keys(preset.config.modelModes ?? {}).join(', ') || 'none';
    // Provenance: what the preset configures (notes), when it was verified,
    // and where the numbers came from — the informed-consent block, shown for
    // bundled and remote alike (uniform UI, no "remote = scary" asymmetry).
    // Long source URLs get their own line so they never wrap mid-URL.
    const isRemote = preset.sourceFile.startsWith('remote:');
    const fileName = isRemote ? preset.sourceFile.slice('remote:'.length) : preset.sourceFile;
    const detail = [
      preset.meta?.notes,
      preset.meta?.verified ? `verified ${preset.meta.verified}` : undefined,
      preset.meta?.source,
    ]
      .filter((s): s is string => s !== undefined && s !== '')
      .join('\n');
    // Modal text is inert chrome — no links, no selection; buttons are the
    // only interactive affordance and appear left-to-right in argument
    // order, the first as the Enter-default. This dialog IS the save consent
    // (there is no second confirm), so the message states the consequence
    // instead of asking a question the buttons already answer. The preset
    // file is one icon-button away; viewing is decision-neutral and re-asks.
    const origin = isRemote ? ' (from vLLM-Copilot/main)' : '';
    const message =
      `Preset "${fileName}"${origin} matches "${modelId}".\n\n` +
      `Modes: ${modeNames}.${detail ? `\n\n${detail}` : ''}\n\n` +
      `Using it saves the model to Settings right away — adjust it later in Model Settings.`;
    let picked: string | undefined;
    for (;;) {
      const choice = await vscode.window.showInformationMessage(
        message,
        { modal: true },
        { title: 'Use Preset', icon: new vscode.ThemeIcon('check') },
        { title: 'Auto-Discover from HuggingFace', icon: new vscode.ThemeIcon('search') },
        { title: 'View Preset File', icon: new vscode.ThemeIcon('link-external') },
      );
      // Real VS Code resolves the chosen MessageItem; test mocks may resolve
      // the bare title string. Accept both shapes.
      const chosen = choice as string | { title?: string } | undefined;
      picked = typeof chosen === 'string' ? chosen : chosen?.title;
      if (picked !== 'View Preset File') break;
      await vscode.env.openExternal(vscode.Uri.parse(presetBlobUrl(preset.sourceFile)));
    }
    if (picked === undefined) return null; // cancelled
    if (picked === 'Use Preset') {
      // `server: ''` is a placeholder like in autoConfigureModel — the calling
      // flow overwrites it with the resolved registry entry id before saving.
      const userConfig = baseConfig ?? { id: modelId, vllmModelId: modelId, server: '' };
      // Strict policy: a preset config is only usable when the server reports a real
      // context window. Resolve it HERE so the preset path cannot bypass the check —
      // a failed resolution THROWS and the model is not saved.
      const limits = await resolveRuntimeLimits(serverType, serverUrl, requestHeaders ?? {}, modelId);
      return {
        modelConfig: mergePresetWithUserConfig(preset.config, userConfig),
        summary: [
          `Using preset ${preset.sourceFile}. Modes: ${modeNames}.`,
          `Context window (${serverType}): ${limits.contextWindow.toLocaleString('en-US')} tokens`,
        ],
        presetFile: preset.sourceFile,
      };
    }
  }

  // HuggingFace auto-discovery. The caller-supplied `serverRoot` (or, if the
  // caller has none, a `root` probe inside) drives HF lookups when `modelId`
  // is a quantized/aliased variant.
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Auto-configuring ${modelId}...`,
      cancellable: false,
    },
    async () => autoConfigureModel(modelId, serverUrl, requestHeaders, serverType, serverRoot)
  );
}

/**
 * Command-level boundary around {@link resolveModelConfigForAdd}. The resolver's strict
 * checks THROW on purpose (e.g. a third-party entry with no resolvable context window —
 * the model will not be served). Unwrapped, those throws surface as VS Code's generic
 * contributed-command failure with nothing backend-specific in the output. This wrapper
 * logs the actionable detail to the output channel and shows a real error message, then
 * returns null (the caller treats null as "cancelled/not saved").
 */
export async function resolveModelConfigForAddSafely(
  output: vscode.OutputChannel,
  context: vscode.ExtensionContext,
  modelId: string,
  serverUrl: string,
  requestHeaders?: Record<string, string>,
  serverRoot?: string,
  baseConfig?: ModelConfig,
  serverType: ServerType = 'vllm',
): Promise<AutoConfigResult | null> {
  try {
    return await resolveModelConfigForAdd(
      context, modelId, serverUrl, requestHeaders, serverRoot, baseConfig, serverType,
      msg => output.appendLine(msg),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.appendLine(`[ERROR] Auto-configure failed for "${modelId}" on ${serverUrl}: ${detail}`);
    output.show(true);
    // Popup so the user KNOWS it failed; the output channel carries the full detail.
    vscode.window.showErrorMessage(`Auto-configure failed for "${modelId}": ${detail}`);
    return null;
  }
}
