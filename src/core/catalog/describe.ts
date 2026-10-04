/**
 * Neutral model descriptors and catalog discovery.
 *
 * All model FACTS - family, budgets, menu ceiling, advertised output,
 * surviving length-menu values, modes, capabilities, raw cost rates - are
 * computed here as pure functions of config + registry + probed limits.
 * Consumer adapters project the descriptor into their own model objects
 * (the Copilot host adds the `ThemeIcon`, the version-gated banner copy,
 * the formatted price and the picker configuration schema); a standalone
 * Node consumer uses the descriptor directly. No editor model object, no
 * picker cache, no vscode types cross this boundary.
 *
 * Discovery policy (unchanged since the live-inventory ruling): the picker
 * is a LIVE INVENTORY. A model is listed only when its server answers right
 * now and reports a real context window on the documented path for its
 * backend. An unreachable server, or a model the server does not currently
 * serve (swap, unload), drops the model entirely: settings remain the
 * configured inventory, the picker shows what actually works. Budgets are
 * never fabricated; the resolver's own message is preserved verbatim so the
 * user sees the backend-specific cause, not a vague rewrite.
 *
 * Output-budget contract: with a vector-form `maxOutputTokens`, the
 * advertised output IS the tracked pick (clamped to the ceiling) - VS Code
 * derives the prompt budget as window - output, so a shorter pick visibly
 * grows prompt headroom. Without a vector the advertised value is the legacy
 * chain (mode > defaultParams > vector head / scalar), clamped by
 * `deriveTokenBudget` to the window + the server-reported output ceiling.
 * Either way the REQUEST path (`resolveMaxTokensForRequest`) clamps the wire
 * to the SAME advertised value, so the two can never disagree. The static
 * ceiling (model budget + physical clamps - never a mode's `max_tokens`,
 * never the pick) is carried separately: the dropdown menu and clamp banners
 * scale against it, so picking 16K leaves 32K selectable, a deliberate pick
 * is not a clamp warning, and a legacy per-mode `max_tokens` can never shrink
 * the menu on a mode switch.
 */
import {
  resolveConfiguredMaxTokens,
  resolveConfigId,
  normalizePickerTokens,
  resolveModelSettings,
  resolveServerConfig,
  resolveServerType,
  resolveVllmModelId,
  type ModelConfig,
} from '../config/config.js';
import type { ServerType } from '../config/serverCore.js';
import type { ServerEntry } from '../config/serverRegistry.js';
import { describeError } from '../shared/errors.js';
import { deriveTokenBudget, resolveOutputLengthVector } from '../shared/tokenBudget.js';
import type { RequestLog } from '../shared/trace.js';
import type { RuntimeModelLimits } from '../types.js';

/**
 * Known-family list used by the heuristic in {@link extractFamilyWithSource}.
 *
 * NOT a complete list of model families - it only covers the families the old
 * hard-coded heuristic recognized. Anything not here (GLM, Cohere, Aya, Yi,
 * granite, ...) intentionally falls through to the org-prefix fallback. The
 * authoritative family comes from a preset or HuggingFace `config.model_type`;
 * this list is only the last-resort classifier when neither is available.
 */
const KNOWN_FAMILIES = ['codellama', 'llama', 'qwen', 'mistral', 'phi', 'gemma', 'deepseek', 'falcon'];

/**
 * Extract a short family name from a full model ID, with a flag indicating
 * whether the result came from the known-family list or from the org-prefix
 * fallback (a guess).
 *
 * e.g. "meta-llama/Llama-3-70B-Instruct" -> { family: "llama", fromFallback: false }
 *      "some-org/SomeNewModel-7B"        -> { family: "some-org", fromFallback: true }
 */
function extractFamilyWithSource(modelId: string): { family: string; fromFallback: boolean } {
  // Check for known family names. Match only when the family name is a distinct
  // token - i.e. preceded by start-of-string or one of the separators '/', '-',
  // '_', '.'. This prevents matching a family name embedded mid-word (e.g.
  // "ballama" should not match "llama"). Note that '-' IS a separator, so
  // hyphenated compounds like "anti-llama-detector" WILL match "llama" - that
  // is the intended behavior for token-based family names like
  // "meta-llama/Llama-3".
  const lower = modelId.toLowerCase();
  for (const family of KNOWN_FAMILIES) {
    const idx = lower.indexOf(family);
    if (idx === -1) continue;
    // Check character before match (if any) - should be a separator or start of string
    const before = idx === 0 ? '' : lower[idx - 1];
    if (before === '/' || before === '-' || before === '_' || before === '.' || before === '') {
      return { family, fromFallback: false };
    }
  }
  // Fallback: org name (everything before '/'), or full model ID if no '/'
  const slashIndex = modelId.indexOf('/');
  const fallback = slashIndex > 0 ? modelId.slice(0, slashIndex).toLowerCase() : modelId.toLowerCase();
  return { family: fallback, fromFallback: true };
}

/**
 * Everything a consumer needs to describe one served model - facts and raw
 * configured values only, never editor objects or formatted picker copy.
 * The raw `override` rides along because the host builds the picker schema
 * from it: a vector-form `maxOutputTokens` inside it IS the Output length
 * menu, so it must never be scalar-cloned away.
 */
export interface ModelDescriptor {
  /** Picker/config id - the override's required `id` (the unique extension key). */
  readonly configId: string;
  /** Wire id sent to the server (`vllmModelId` or the config id). */
  readonly wireId: string;
  /** Display name - `displayName` or the config id. */
  readonly name: string;
  readonly family: string;
  /** True when the family was guessed from the org prefix (no preset/HF family). */
  readonly familyFromFallback: boolean;
  readonly capabilities: { toolCalling: boolean; imageInput: boolean };
  readonly serverType: ServerType;
  /** The RESOLVED context window - required, the probe throws without one. */
  readonly contextWindow: number;
  /** Advertised input budget (window - advertised output, floor 1). */
  readonly maxInputTokens: number;
  /** Advertised output budget - the value the request path clamps against. */
  readonly maxOutputTokens: number;
  /** Server-reported output ceiling (e.g. OpenRouter per-request limit). */
  readonly reportedMaxOutputTokens?: number;
  /** Static menu/banner ceiling: model budget under the physical clamps only. */
  readonly outputMenuCeiling: number;
  /** The output budget actually advertised (tracked pick, or the legacy chain). */
  readonly effectiveOutputTokens: number;
  /** Resolved model-wide output budget (scalar/vector-head or default). */
  readonly configuredMaxOutputTokens: number;
  readonly modeNames?: string[];
  readonly defaultMode?: string;
  /** Length-menu values surviving the static ceiling (< 2 => no menu). */
  readonly outputLengthValues?: number[];
  /** Raw configured cost rates (per-1M semantics belong to the consumer). */
  readonly cost?: ModelConfig['cost'];
  /** The RAW config entry - schema/banner input for the host projection. */
  readonly override?: ModelConfig;
}

/** Inputs to {@link describeModel} - plain data, no editor objects. */
export interface DescribeModelInput {
  /** The vLLM wire model id (what the server actually serves). */
  wireId: string;
  /** RESOLVED context window (`resolveRuntimeLimits` output) - never guessed. */
  contextWindow: number;
  serverType: ServerType;
  override?: ModelConfig;
  /** Server-reported output ceiling; undefined leaves the budget unchanged. */
  reportedMaxOutputTokens?: number;
  /** Currently selected model MODE (consumer-tracked). */
  selectedMode?: string;
  /** Currently selected OUTPUT LENGTH pick (consumer-tracked); wins over the legacy chain. */
  selectedLength?: number;
}

/** Resolve one model's runtime limits, switching strictly on its backend. */
export interface ModelLimitsResolver {
  /**
   * THROWS when the server is unreachable OR the documented path for that
   * backend reports no window - callers skip the model on throw, we never
   * fabricate metadata. Backends that report no output ceiling leave
   * `maxOutputTokens` undefined.
   */
  getModelContextWindow(
    serverType: ServerType,
    serverUrl: string,
    requestHeaders?: Record<string, string>,
    vllmModelId?: string,
    /** Manual fallback for metadata-stripping gateways (`ModelConfig.contextWindow`). */
    configuredContextWindow?: number,
  ): Promise<RuntimeModelLimits>;
}

/**
 * Compute the neutral descriptor for one served model. Deterministic over
 * (override, probed limits, selections) - no settings reads, no I/O.
 */
export function describeModel(input: DescribeModelInput): ModelDescriptor {
  const { wireId, contextWindow, serverType, override, reportedMaxOutputTokens } = input;
  const settings = resolveModelSettings(override);
  // Legacy output-budget chain (mode > defaultParams > vector head / scalar).
  // Used as the advertised budget ONLY while no length pick exists; once a
  // pick exists the pick wins - even over a per-mode `max_tokens`.
  const legacyMaxOutput = resolveConfiguredMaxTokens(override, input.selectedMode) ?? settings.maxOutputTokens;

  // Menu/banner ceiling: the model's OWN budget with the physical clamps
  // (window + server-reported) applied - what the model can promise,
  // independent of any pick. For a VECTOR-form `maxOutputTokens` the menu
  // scales with the vector's MAX, not its head: the head is only the
  // default/advertised budget, and every higher rung must stay selectable.
  // Deliberately NOT the legacy chain: a selected mode's `max_tokens` must
  // not shrink the menu (it would flicker or vanish on mode switches) and
  // must not silently cap a deliberate pick.
  const menuVector = resolveOutputLengthVector(override?.maxOutputTokens);
  const outputMenuCeiling = deriveTokenBudget(
    contextWindow,
    menuVector ? Math.max(...menuVector) : settings.maxOutputTokens,
    override ? { ...override, maxOutputTokens: undefined } : undefined,
    reportedMaxOutputTokens,
  ).maxOutputTokens;

  // The output-length pick IS the advertised output budget: VS Code derives
  // the prompt budget as window - output, so a shorter pick genuinely grows
  // prompt headroom. min() keeps a persisted pick above a since-shrunken
  // ceiling clamped to what the model can promise. The pick goes through the
  // SAME normalizePickerTokens the request path uses (the one output-length
  // floor): a fractional pick means the same integer here and on the wire,
  // and a non-finite one means "no pick" here exactly as resolveMaxTokensForRequest
  // treats it — a standalone consumer can never mint a descriptor the wire
  // would contradict.
  const pickedLength = normalizePickerTokens(input.selectedLength);
  const effectiveOutputTokens = pickedLength !== undefined
    ? Math.min(pickedLength, outputMenuCeiling)
    : legacyMaxOutput;
  const budget = deriveTokenBudget(
    contextWindow,
    settings.maxOutputTokens,
    { ...override, maxOutputTokens: effectiveOutputTokens },
    reportedMaxOutputTokens,
  );

  // Preset-declared family is authoritative; otherwise the heuristic. When
  // the heuristic falls through to the org-name guess, the flag surfaces it -
  // `describeModels` logs the warning, other consumers decide.
  const extracted = override?.family
    ? { family: override.family, fromFallback: false }
    : extractFamilyWithSource(wireId);

  const modeNames = override?.modelModes ? Object.keys(override.modelModes) : undefined;
  const modes = modeNames && modeNames.length > 0 ? modeNames : undefined;
  const defaultMode = modes
    ? (override!.defaultMode && modes.includes(override!.defaultMode) ? override!.defaultMode : modes[0])
    : undefined;

  // Values only - labels are picker copy and belong to the host projection.
  const survivors = menuVector?.filter((n) => n <= outputMenuCeiling);

  const configId = override?.id || wireId;
  return {
    configId,
    wireId,
    name: override?.displayName || configId,
    family: extracted.family,
    familyFromFallback: extracted.fromFallback,
    capabilities: {
      toolCalling: override?.capabilities?.toolCalling ?? true,
      imageInput: override?.capabilities?.imageInput ?? false,
    },
    serverType,
    contextWindow,
    maxInputTokens: budget.maxInputTokens,
    maxOutputTokens: budget.maxOutputTokens,
    reportedMaxOutputTokens,
    outputMenuCeiling,
    effectiveOutputTokens,
    configuredMaxOutputTokens: settings.maxOutputTokens,
    modeNames: modes,
    defaultMode,
    outputLengthValues: survivors && survivors.length >= 2 ? survivors : undefined,
    cost: override?.cost,
    override,
  };
}

/**
 * Discover descriptors for the configured models: probe each model's server
 * in parallel (discovery time = max(latencies), not sum), compute its
 * descriptor, and log the skip/duplicate/summary lines through the sink.
 * Every per-model failure is absorbed into a skip with a verbatim reason -
 * one dead server never takes the picker down.
 *
 * `onModel` fires per surviving model, in result order, before the
 * duplicate/summary lines (the provider's cache-fill callback relies on
 * that ordering).
 */
export async function describeModels(
  modelOverrides: ModelConfig[],
  servers: ServerEntry[],
  probe: ModelLimitsResolver,
  log: RequestLog,
  onModel?: (configId: string, contextWindow: number) => void,
  selectedModeByModel?: ReadonlyMap<string, string>,
  selectedLengthByModel?: ReadonlyMap<string, number>,
): Promise<ModelDescriptor[]> {
  const tasks = modelOverrides.map(async (override) => {
    const vllmModelId = resolveVllmModelId(override) ?? '';
    const serverConfig = resolveServerConfig(override, servers);
    const serverType = resolveServerType(override, servers);

    // A model whose server ref does not resolve is unreachable - drop it from
    // the picker (settings remain the configured inventory) and say why.
    if (!serverConfig) {
      const id = resolveConfigId(override) || '(unnamed model)';
      return {
        ok: false as const,
        error: `[WARN] Model "${id}" references unknown server "${override.server}" and will be skipped. Fix the reference or re-add the server.`,
      };
    }

    const presetId = override.id;
    try {
      // Connection/auth/5xx failures and a missing window all THROW from the
      // resolver with a backend-specific message - no fabricated budget. The
      // error message below preserves that detail.
      const limits = await probe.getModelContextWindow(
        serverType,
        serverConfig.serverUrl,
        serverConfig.requestHeaders,
        vllmModelId,
        override.contextWindow
      );
      const descriptor = describeModel({
        wireId: vllmModelId,
        contextWindow: limits.contextWindow,
        serverType,
        override,
        reportedMaxOutputTokens: limits.maxOutputTokens,
        selectedMode: selectedModeByModel?.get(presetId),
        selectedLength: selectedLengthByModel?.get(presetId),
      });
      if (descriptor.familyFromFallback) {
        // Fires only when no preset-declared family was available AND
        // HuggingFace auto-discovery did not provide one. The family is just a
        // sort key in the picker, so this is non-fatal, but the user should
        // know the discovery path didn't reach HuggingFace.
        log.appendLine(
          `[WARN] Model "${vllmModelId}" - family estimated as "${descriptor.family}" from org-name fallback (no preset/HuggingFace family available). Family is informational only; use a preset or run auto-discovery for authoritative values.`
        );
      }
      return { ok: true as const, descriptor };
    } catch (err) {
      // Server did not answer (unreachable) or does not currently serve this
      // model (swap, unload): the model drops out of the picker until its
      // server serves it again. The reason is logged verbatim.
      return { ok: false as const, error: `[WARN] Model "${presetId}" unavailable: ${describeError(err)}` };
    }
  });

  const results = await Promise.all(tasks);
  const descriptors: ModelDescriptor[] = [];

  // Every task self-catches and resolves with its discriminated `ok` result -
  // no task can reject (a rejection here would be a programming error inside
  // the map callback, not a model-skipping condition).
  for (const result of results) {
    if (result.ok) {
      descriptors.push(result.descriptor);
      onModel?.(result.descriptor.configId, result.descriptor.contextWindow);
    } else {
      log.appendLine(result.error);
    }
  }

  // The picker id IS the config `id` (required, exact-match resolution), so
  // the only collision source is a duplicate `id` in settings - surface it so
  // a silent collapse in the picker is never a mystery.
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const d of descriptors) {
    if (seenIds.has(d.configId)) duplicateIds.add(d.configId);
    seenIds.add(d.configId);
  }
  for (const dup of duplicateIds) {
    log.appendLine(
      `[WARN] Duplicate model id "${dup}" - multiple configs share this id and collapse to one picker entry. Give each model a unique "id".`
    );
  }

  if (descriptors.length > 0) {
    const summary = descriptors.map(d => {
      const ctx = (d.maxInputTokens + d.maxOutputTokens).toLocaleString('en-US');
      return `${d.configId} (${ctx} ctx)`;
    }).join(', ');
    log.appendLine(`[INFO] Loaded ${descriptors.length} model(s): ${summary}`);
  }

  return descriptors;
}
