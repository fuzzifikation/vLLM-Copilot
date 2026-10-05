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
  return warnings;
}

/**
 * Read Copilot's model-picker state — the `modelConfiguration` field of the
 * `chatProvider` proposal, absent from stable `@types/vscode` (pairs with
 * `configurationSchema` in modelInfo.ts): the selected model mode plus the
 * normalized output-length pick. ONE reader for both consumers (audit P1-1):
 * the provider tracks the selection for metadata re-registration, the request
 * builder uses it for params and the output budget; their private parses had
 * already drifted apart. The `any` read here means a future proposal drop
 * compiles clean and the mode picker fails silently — known, accepted coupling.
 * Copilot-shape knowledge: this is why it lives at the host boundary, while
 * the numeric floor rule (`normalizePickerTokens`) stays in the core.
 */
export function readPickerSelection(options: unknown): { selectedMode?: string; pickerTokens?: number } {
  const modelConfiguration = (options as { modelConfiguration?: Record<string, unknown> })
    .modelConfiguration;
  const mode = modelConfiguration?.reasoningEffort;
  return {
    selectedMode: typeof mode === 'string' ? mode : undefined,
    pickerTokens: normalizePickerTokens(modelConfiguration?.maxOutputTokens),
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
