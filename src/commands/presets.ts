import * as vscode from 'vscode';
import type { ModelConfig } from '../config.js';
import { normalizeModelId, modelMatchKey } from '../config.js';
import { jsonrepair } from 'jsonrepair';

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
 * Find a preset that matches the given model. Matches a preset's `vllmModelId`
 * against the model id, and — when provided — against the server model's `root`
 * (the underlying checkpoint). The `root` match lets any `--served-model-name`
 * alias (e.g. `zai-glm-52`) resolve to the preset authored for its real repo id
 * (e.g. `zai-org/GLM-5.2`).
 *
 * Presets only set `vllmModelId` (they never set `id` — that's the user's own
 * identifier in settings). Using `vllmModelId` for matching avoids any risk of
 * the preset's `id` leaking into the user's model config.
 *
 * Matching tiers (in order):
 * 1. Exact (case-sensitive) match on vllmModelId.
 * 2. Quantization-agnostic (org-aware): strip -FP8/-AWQ/-GGUF/etc., compare
 *    case-insensitively. "Qwen/Qwen3.6-27B" matches "Qwen/Qwen3.6-27B-FP8".
 * 3. Cross-org + quantization-agnostic: additionally drop the company prefix,
 *    so "deepseek-ai/DeepSeek-V4-Flash" matches "nvidia/DeepSeek-V4-Flash-NVFP4".
 *    Quantization only affects weight precision, not inference parameters, and
 *    the serving org is irrelevant to sampling config — we match on model name.
 *
 * @internal Exported for testing.
 */
export function findPresetForModel(
  presets: ModelPreset[],
  modelId: string,
  root?: string
): ModelPreset | undefined {
  const normalizedModel = normalizeModelId(modelId).toLowerCase();
  const normalizedRoot = root !== undefined ? normalizeModelId(root).toLowerCase() : undefined;
  const modelKey = modelMatchKey(modelId);
  const rootKey = root !== undefined ? modelMatchKey(root) : undefined;

  return presets.find(p => {
    if (!p.config.vllmModelId) return false;
    const pid = p.config.vllmModelId;
    // Exact match first (preserves case-sensitive matches)
    if (pid === modelId) return true;
    if (root !== undefined && pid === root) return true;
    // Fuzzy match: strip quantization suffixes, then case-insensitive comparison
    if (normalizeModelId(pid).toLowerCase() === normalizedModel) return true;
    if (normalizedRoot !== undefined && normalizeModelId(pid).toLowerCase() === normalizedRoot) return true;
    // Fuzzy match: cross-org + quantization-agnostic (model name only)
    if (modelMatchKey(pid) === modelKey) return true;
    if (rootKey !== undefined && modelMatchKey(pid) === rootKey) return true;
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
