import * as vscode from 'vscode';
import type { ModelConfig } from '../config.js';
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
 * Find a preset whose `vllmModelId` appears as a substring of the given model id
 * (or of its server-reported `root`), case-insensitively.
 *
 * Deliberately simple — no normalization, no org-stripping, no quantization-suffix
 * parsing. Preset authors curate `vllmModelId` so it is a distinctive substring of
 * whatever the server actually serves, e.g. `Qwen3.8-27B` matches a llama.cpp full
 * path `/srv/data/models/Qwen3.8-27B-Q6_K.gguf`, an HF repo `Qwen/Qwen3.8-27B`,
 * or a quantized served id `nvidia/DeepSeek-V4-Flash-NVFP4`. If the string shows
 * up, the preset applies.
 *
 * When several presets match, the one with the LONGEST `vllmModelId` wins — an
 * exact match is always the longest possible substring, and a specific id like
 * `DeepSeek-V4-Flash-0731` beats the generic `DeepSeek-V4-Flash`. This keeps
 * selection independent of `readDirectory()` ordering. Ties keep the first preset in
 * array order (deterministic given a fixed array).
 *
 * Presets only set `vllmModelId` (never `id` — the user's own identifier in
 * settings), so matching never leaks the preset's id into the user's config.
 *
 * @internal Exported for testing.
 */
export function findPresetForModel(
  presets: ModelPreset[],
  modelId: string,
  root?: string
): ModelPreset | undefined {
  const modelL = modelId.toLowerCase();
  const rootL = root !== undefined ? root.toLowerCase() : undefined;
  let best: ModelPreset | undefined;
  let bestLen = -1;
  for (const p of presets) {
    const pid = p.config.vllmModelId;
    if (!pid) continue;
    const pidL = pid.toLowerCase();
    const matched = modelL.includes(pidL) || (rootL !== undefined && rootL.includes(pidL));
    if (matched && pidL.length > bestLen) {
      best = p;
      bestLen = pidL.length;
    }
  }
  return best;
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
