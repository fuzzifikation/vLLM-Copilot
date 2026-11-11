/**
 * Host-side configuration access — the VS Code boundary of the config layer.
 *
 * All policy (config data types, resolution, defaults, parameter layering,
 * output-budget precedence, supplied-data validation) lives in
 * core/config/config.ts. This module only touches what the editor owns:
 * reading settings, inspecting RAW settings shapes, Copilot's picker
 * selection, and workspace-root path resolution.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import {
  normalizePickerTokens,
  validateConfig as validateSuppliedConfig,
  type ModelConfig,
  type VllmConfig,
} from '../../core/config/config.js';
import type { ServerEntry } from '../../core/config/serverRegistry.js';

export const COPILOT_HARNESS_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type CopilotHarnessMapping = Partial<Record<typeof COPILOT_HARNESS_EFFORTS[number], string>>;

/** True when a mode identifier already IS the harness's own effort token. */
export function isCopilotHarnessEffort(name: string): boolean {
  return COPILOT_HARNESS_EFFORTS.some(effort => effort === name);
}

/**
 * Only extension-owned legacy names migrate; custom names stay untouched.
 *
 * The table is a rename CHAIN, followed transitively by the migration: the
 * space-form names (v1.37 and earlier) step to their hyphen form, and the
 * hyphen forms whose rung the Copilot harness names directly step again to the
 * harness token (`Think (High)` -> `Think-High` -> `high`), which is what makes
 * a mapping unnecessary for effort rungs. Deliberately absent: `Think-Deep`,
 * `Think-Balanced`, `Think-Light`, `Think-Always` and `Think-Adaptive`. Those
 * name a behavior, not a rung, and `Think-Deep` answers `xhigh` on Qwen3.8 but
 * `high` on Tencent Hy3 — a global rename would produce a name that lies about
 * the `reasoning_effort` its parameters send.
 */
export const LEGACY_MODEL_MODE_SLUGS: ReadonlyMap<string, string> = new Map([
  ['Think (General)', 'Think-General'],
  ['Think (Coding)', 'Think-Coding'],
  ['Think (Science)', 'Think-Science'],
  ['Think (Code)', 'Think-Code'],
  ['Think (Deep)', 'Think-Deep'],
  ['Think (Balanced)', 'Think-Balanced'],
  ['Think (Max)', 'Think-Max'],
  ['Think (XHigh)', 'Think-XHigh'],
  ['Think (High)', 'Think-High'],
  ['Think (Medium)', 'Think-Medium'],
  ['Think (Low)', 'Think-Low'],
  ['Think (Light)', 'Think-Light'],
  ['Think (Xhigh)', 'Think-XHigh'],
  ['Think (Minimal)', 'Think-Minimal'],
  ['Think (Ultra)', 'Think-Ultra'],
  ['Think (Always)', 'Think-Always'],
  ['Think (Adaptive)', 'Think-Adaptive'],
  ['No Think', 'No-Think'],
  ['Think-Max', 'max'],
  ['Think-XHigh', 'xhigh'],
  ['Think-High', 'high'],
  ['Think-Medium', 'medium'],
  ['Think-Low', 'low'],
  ['Think-Minimal', 'minimal'],
  ['Think-Ultra', 'ultra'],
  ['No-Think', 'none'],
]);

/** Validate host-only aliases and invert them for schema publication. */
export function readCopilotHarnessMapping(model?: ModelConfig): {
  effortByMode: ReadonlyMap<string, string>;
  warning?: string;
} {
  const effortByMode = new Map<string, string>();
  const supplied = (model as (ModelConfig & { copilotHarnessMapping?: unknown }) | undefined)
    ?.copilotHarnessMapping;
  if (supplied === undefined) return { effortByMode };

  const modes = model?.modelModes ?? {};
  let error: string | undefined;
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
    error = 'must be an object mapping harness efforts to mode names';
  } else {
    for (const [effort, mode] of Object.entries(supplied)) {
      if (!COPILOT_HARNESS_EFFORTS.some(value => value === effort)) {
        error = `contains unsupported effort "${effort}"`;
      } else if (typeof mode !== 'string' || !Object.hasOwn(modes, mode)) {
        error = `effort "${effort}" must name an existing model mode`;
      } else if (effortByMode.has(mode)) {
        error = `maps more than one effort to mode "${mode}"`;
      } else if (effort !== mode && Object.hasOwn(modes, effort)) {
        error = `effort "${effort}" conflicts with an existing mode of that name`;
      } else {
        effortByMode.set(mode, effort);
      }
      if (error) break;
    }
    const defaultMode = model?.defaultMode && Object.hasOwn(modes, model.defaultMode)
      ? model.defaultMode : Object.keys(modes)[0];
    // The default mode has to be reachable in the harness's own vocabulary: the
    // Agents window renders effort values, so a mapping that leaves a
    // descriptively named default unaliased would publish a default it cannot
    // label. A mode already NAMED as an effort token publishes itself and needs
    // no alias - demanding one would force exactly the `{"high": "high"}`
    // identity entry the schema and the migration forbid.
    if (!error && effortByMode.size > 0 && defaultMode
      && !effortByMode.has(defaultMode) && !isCopilotHarnessEffort(defaultMode)) {
      error = `must include the default mode "${defaultMode}"`;
    }
  }
  if (error) effortByMode.clear();
  return {
    effortByMode,
    warning: error
      ? `Model "${model?.displayName || model?.id}": copilotHarnessMapping ${error}. Mapping ignored; Local modes are unchanged.`
      : undefined,
  };
}

/**
 * Read configuration from VS Code settings.
 *
 * Only genuine globals are the `models` array and the `servers` registry. All
 * server, auth, generation, token, and transport settings live on models and
 * their registry entries, resolved at request time via `resolveServerConfig` /
 * `resolveRequestParams` / `resolveModelSettings`. (The `enableFileLogging`
 * setting is read directly by the logger wiring in extension.ts — it never
 * travels through this type.)
 */
export async function getConfig(): Promise<VllmConfig> {
  const section = vscode.workspace.getConfiguration('vllm-copilot');

  // Shape guards mirror configStore's readModels/readServers: a hand-edited
  // non-array section or a `null` element must not detonate every consumer
  // (this read feeds validateConfig and getConfig directly, bypassing
  // configStore to dodge the import cycle).
  const rawModels = section.get<unknown>('models');
  const rawServers = section.get<unknown>('servers');
  return {
    models: Array.isArray(rawModels)
      ? rawModels.filter((e): e is ModelConfig => !!e && typeof e === 'object')
      : [],
    servers: Array.isArray(rawServers)
      ? rawServers.filter((e): e is ServerEntry => !!e && typeof e === 'object')
      : [],
  };
}

/**
 * Malformed-shape report against the RAW settings sections (CR-88). Every
 * in-process reader (`getConfig`, `readModels`, `readServers`) shape-filters
 * non-object elements before `validateConfig` can see them, so hand-edited
 * garbage must be checked at the source: a warning that inspects the filtered
 * array can only ever be silent about exactly what the filters shredded.
 */
function rawShapeWarnings(warnings: string[]): void {
  const section = vscode.workspace.getConfiguration('vllm-copilot');
  for (const key of ['servers', 'models'] as const) {
    const label = key === 'servers' ? 'Server registry' : 'Model settings';
    const raw = section.get<unknown>(key);
    if (raw === undefined) continue; // section absent — nothing hand-edited yet
    if (!Array.isArray(raw)) {
      warnings.push(`${label}: "vllm-copilot.${key}" is not an array. The whole section is ignored until it is fixed to a JSON array.`);
      continue;
    }
    const garbage = raw.filter(e => !e || typeof e !== 'object').length;
    if (garbage > 0) {
      warnings.push(
        garbage === 1
          ? `${label}: 1 malformed element in "vllm-copilot.${key}" is not an object and is ignored - remove it.`
          : `${label}: ${garbage} malformed elements in "vllm-copilot.${key}" are not objects and are ignored - remove them.`
      );
    }
  }
}

/**
 * Validate config and return warnings for clearly invalid settings —
 * non-blocking, informational. Raw settings-section garbage (CR-88) is
 * reported first (it can only be seen at the settings source), then the
 * core's supplied-data warnings, preserving the user-visible order.
 */
export function validateConfig(config: VllmConfig): string[] {
  const warnings: string[] = [];
  rawShapeWarnings(warnings);
  warnings.push(...validateSuppliedConfig(config));
  for (const model of config.models) {
    const { warning } = readCopilotHarnessMapping(model);
    if (warning) warnings.push(warning);
  }
  return warnings;
}

/**
 * Read Copilot's model-picker state — the `modelConfiguration` field of the
 * `chatProvider` proposal, absent from stable `@types/vscode` (pairs with
 * `configurationSchema` in modelInfo.ts): the selected model mode plus the
 * normalized output-length pick. ONE reader for both consumers (audit P1-1):
 * the provider tracks the selection for metadata re-registration, the request
 * builder uses it for params and the output budget; their private parses had
 * already drifted apart. The value the harness hands back is the schema's
 * `enum` entry, which under the effort-token doctrine IS the Local mode name —
 * except where a harness mapping aliased a descriptively named mode, and that
 * alias is inverted through the entry's own mapping, never through
 * `enumItemLabels`: those hold VS Code's display strings (`xhigh` becomes
 * "Extra High"), so decoding through them turns a selection into a name no
 * mode has. Current configured modes and aliases take precedence over cached
 * metadata; legacy names resolve only when the old name is absent.
 * Copilot-shape knowledge: this is why it lives at the host boundary, while
 * the numeric floor rule (`normalizePickerTokens`) stays in the core.
 */
export function readPickerSelection(
  options: unknown,
  model?: vscode.LanguageModelChatInformation,
  override?: ModelConfig,
): { selectedMode?: string; pickerTokens?: number; warning?: string } {
  const modelConfiguration = (options as { modelConfiguration?: Record<string, unknown> })
    .modelConfiguration;
  const mode = modelConfiguration?.reasoningEffort;
  const property = (model as (vscode.LanguageModelChatInformation & {
    configurationSchema?: { properties: Record<string, { enum?: unknown[] }> };
  }) | undefined)?.configurationSchema?.properties.reasoningEffort;
  let selected = mode;
  const configuredNames = override?.modelModes ? Object.keys(override.modelModes) : undefined;
  const mapping = override ? readCopilotHarnessMapping(override) : undefined;
  if (typeof mode === 'string' && configuredNames?.includes(mode)) {
    selected = mode;
  } else if (mapping) {
    for (const [name, effort] of mapping.effortByMode) {
      if (effort === mode) {
        selected = name;
        break;
      }
    }
  }
  if (typeof selected === 'string') {
    const availableNames = configuredNames ?? property?.enum;
    if (availableNames && !availableNames.includes(selected)) {
      // A stale chat value follows the rename chain to the first step this
      // model actually offers (`Think (High)` -> `Think-High` -> `high`), the
      // same walk the activation migration performs on settings.
      let current = selected;
      const seen = new Set([current]);
      for (;;) {
        const next = LEGACY_MODEL_MODE_SLUGS.get(current);
        if (!next || seen.has(next)) break;
        seen.add(next);
        current = next;
        if (availableNames.includes(current)) {
          selected = current;
          break;
        }
      }
    }
  }
  return {
    selectedMode: typeof selected === 'string' ? selected : undefined,
    pickerTokens: normalizePickerTokens(modelConfiguration?.maxOutputTokens),
    warning: mapping?.warning,
  };
}

/**
 * Resolve a (possibly relative) file path against the first workspace folder.
 *
 * Single shared implementation for `systemMessageReplacementsFile` resolution
 * (used by `personalityStore.resolveModelReplacements`, the one resolver behind
 * the request pipeline and Model Settings). `path.resolve` handles every
 * case in one call:
 * - absolute path → returned normalized
 * - relative path + open workspace → joined against the first workspace root
 * - relative path + no workspace → resolved against the process cwd (Node default)
 *
 * Keeping this in one place means the two call sites can never drift.
 * Editor-owned: "the workspace" is a VS Code concept — the core receives the
 * root as an explicit parameter instead (see core personality resolution).
 */
export function resolveWorkspaceRelativePath(value: string): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return path.resolve(root, value);
}
