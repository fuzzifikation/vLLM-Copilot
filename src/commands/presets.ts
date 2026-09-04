import * as vscode from 'vscode';
import type { ModelConfig } from '../state/config.js';
import { jsonrepair } from 'jsonrepair';

// ---- Local preset loading ----

/**
 * The part of a `ModelConfig` a preset is allowed to provide: everything
 * except identity and transport. A preset must never carry `id`, `server`
 * (the registry ref) or `provider` — those belong to the user's own
 * settings, and merging them in would let a preset repoint or rename a
 * model. Also excludes runtime-behaviour knobs (timeouts, auto-continue,
 * prompt replacements) and `cost`, which are user decisions, not model facts.
 */
export type PresetConfig = Omit<
  ModelConfig,
  | 'id'
  | 'server'
  | 'provider'
  | 'routingMode'
  | 'systemMessageReplacementsFile'
  | 'streamInactivityTimeout'
  | 'initialResponseTimeoutMs'
  | 'autoContinueRetries'
  | 'cost'
>;

/**
 * Allow-list of keys permitted inside a v2 preset's `config` object.
 * Unknown key → the whole file is rejected (asymmetric guard: unknown *meta*
 * keys are tolerated so older extension versions can read newer presets).
 */
export const PRESET_CONFIG_KEYS: ReadonlySet<string> = new Set<keyof PresetConfig & string>([
  'vllmModelId',
  'displayName',
  'family',
  'maxInputTokens',
  'maxOutputTokens',
  'capabilities',
  'modelModes',
  'defaultMode',
  'defaultParams',
  'estimateCharsPerToken',
]);

/**
 * Public GitHub blob base for viewing preset files in the browser — the
 * clickable/copyable link shown to users. Mirrors the raw fetch base in
 * `src/commands/presetRemote.ts` (raw content vs. rendered blob, same repo+branch+dir).
 */
const PRESET_BLOB_BASE = 'https://github.com/fuzzifikation/vLLM-Copilot/blob/main/model-configs';

/**
 * Public URL to view a preset file on GitHub. Strips the internal `remote:`
 * tag — a fetched preset is the same file that lives in the repo.
 */
export function presetBlobUrl(sourceFile: string): string {
  return `${PRESET_BLOB_BASE}/${sourceFile.replace(/^remote:/, '')}`;
}

/** Provenance metadata shown to the user when a preset is offered. All optional. */
export interface PresetMeta {
  /** Human-readable model name (e.g. "DeepSeek V4 Pro"). */
  name?: string;
  /** Upstream URL the parameters were sourced from (https). */
  source?: string;
  /** ISO date (YYYY-MM-DD) the parameters were last verified against sources. */
  verified?: string;
  /** One-to-two-line user-facing summary of what the preset configures. */
  notes?: string;
}

/**
 * A preset loaded from model-configs/*.json (or fetched remotely), paired with
 * the source filename. Produced ONLY by {@link parsePresetFile}, so the
 * allow-list guard has already vetted every `config` key — the type is a
 * real boundary, not a suggestion.
 */
export interface ModelPreset {
  /** Guard-validated payload — structurally cannot carry identity or transport fields. */
  config: PresetConfig;
  /** Source filename (e.g. "DeepSeek-V4-Flash.json"), or "remote:<file>" for fetched presets. */
  sourceFile: string;
  /** Match patterns — non-empty, enforced by the v2 envelope guard. */
  match: string[];
  /** Provenance metadata, if the preset declares any. */
  meta?: PresetMeta;
}

/**
 * Strip single-line `//` comments from a JSON string. Handles inline comments
 * but does not strip `//` inside string values (good enough for our preset files
 * which only have comments above the JSON object). Private detail of
 * {@link parsePresetRawJson} (audit P19-3: tests drive the parse boundary, not
 * this step).
 */
function stripJsonComments(text: string): string {
  // Index of the first `//` NOT inside a quoted string, or -1. Quote/escape
  // state machine - kept named inside its only caller, it is not a one-liner.
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
 * Load all model presets from the model-configs/ directory in the extension.
 * Returns an array of presets with their source filenames.
 */
export async function loadModelPresets(
  extensionUri: vscode.Uri
): Promise<ModelPreset[]> {
  const configsDir = vscode.Uri.joinPath(extensionUri, 'model-configs');
  const presets: ModelPreset[] = [];

  try {
    const entries = await vscode.workspace.fs.readDirectory(configsDir);
    for (const [name, type] of entries) {
      // index.json is the generated remote preset LIST, not a preset. It lives
      // in this directory (served from the repo); skip it without reading —
      // the v2 guard would reject it anyway.
      if (!name.endsWith('.json') || type !== vscode.FileType.File || name === 'index.json') {
        continue;
      }
      try {
        const fileUri = vscode.Uri.joinPath(configsDir, name);
        const raw = await vscode.workspace.fs.readFile(fileUri);
        const text = new TextDecoder().decode(raw);
        const preset = parsePresetFile(text, name);
        if (preset) presets.push(preset);
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
 * Parse preset file text into a `ModelPreset`. The ONLY accepted format is
 * the v2 envelope (`presetVersion: 1`), validated strictly: unknown
 * `presetVersion`, missing/empty `match`, missing `config` object, or any
 * `config` key outside {@link PRESET_CONFIG_KEYS} rejects the whole file.
 * `meta` is sanitized leniently (unknown/ill-typed fields are dropped, the
 * file survives) so future metadata additions never break old builds.
 *
 * There is deliberately NO legacy bare-config compatibility: every bundled
 * preset and every remote fetch is a v2 envelope, and the old shim accepted
 * unvalidated configs without the allow-list check — a smuggle path, not a
 * feature. The underlying JSON parse stays forgiving (comment stripping +
 * `jsonrepair`) so an authoring slip doesn't silently drop a whole preset.
 * Returns null when the file is unusable (unparseable or fails validation).
 */
export function parsePresetFile(text: string, sourceFile: string): ModelPreset | null {
  const raw = parsePresetRawJson(text);
  if (!raw) {
    return null;
  }
  return parsePresetEnvelope(raw, sourceFile);
}

/** Validate and convert a v2 envelope object. Returns null to reject the file. */
function parsePresetEnvelope(raw: Record<string, unknown>, sourceFile: string): ModelPreset | null {
  if (raw.presetVersion !== 1) {
    return null; // Unknown format version — ignore rather than misapply.
  }

  const match = Array.isArray(raw.match) ? raw.match : null;
  if (
    !match ||
    match.length === 0 ||
    !match.every(m => typeof m === 'string' && m.trim().length > 0)
  ) {
    return null;
  }

  const config = raw.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return null;
  }
  const configKeys = Object.keys(config);
  if (configKeys.some(k => !PRESET_CONFIG_KEYS.has(k))) {
    return null; // Unknown config key → the whole file is untrusted.
  }

  // Lenient meta sanitization (absorbed here from its own one-caller function,
  // audit P19-2): keep only known non-empty string fields; unknown or
  // ill-typed fields are dropped and the file survives, so future metadata
  // additions never break old builds.
  let meta: PresetMeta | undefined;
  if (raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)) {
    const src = raw.meta as Record<string, unknown>;
    const kept: PresetMeta = {};
    for (const key of ['name', 'source', 'verified', 'notes'] as const) {
      const v = src[key];
      if (typeof v === 'string' && v.trim().length > 0) {
        kept[key] = v;
      }
    }
    if (Object.keys(kept).length > 0) {
      meta = kept;
    }
  }

  return {
    // Validation above proved every key is in PRESET_CONFIG_KEYS — the type
    // now says exactly what the guard verified (no widening to ModelConfig).
    config: config as PresetConfig,
    sourceFile,
    match: match as string[],
    meta,
  };
}

/**
 * Parse preset file text forgivingly into a plain object. Tries the
 * comment-stripped text first, then falls back to `jsonrepair` (which also
 * tolerates comments, trailing commas, single quotes, and missing commas).
 * Returns null only if even the repaired text is not a JSON object.
 * @internal Exported for testing (the preset-canary tests re-read shipped
 * files through this boundary; the comment-stripper stays private).
 */
export function parsePresetRawJson(text: string): Record<string, unknown> | null {
  const cleaned = stripJsonComments(text).trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    // fall through to repair
  }
  try {
    const parsed = JSON.parse(jsonrepair(text));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // unrepairable
  }
  return null;
}

/**
 * Find a preset whose match patterns appear as a substring of the given model
 * id (or of its server-reported `root`), case-insensitively.
 *
 * Every preset carries a non-empty `match[]` (the v2 envelope guard enforces
 * this), so matching never consults `config.vllmModelId` — patterns are the
 * curated, deliberately distinctive substrings of whatever the server actually
 * serves, e.g. `Qwen3.8-27B` matches a llama.cpp full path
 * `/srv/data/models/Qwen3.8-27B-Q6_K.gguf`, an HF repo `Qwen/Qwen3.8-27B`,
 * or a quantized served id `nvidia/DeepSeek-V4-Flash-NVFP4`. If the string
 * shows up, the preset applies.
 *
 * When several patterns/presets match, the LONGEST matching pattern wins — an
 * exact match is always the longest possible substring, and a specific id like
 * `DeepSeek-V4-Flash-0731` beats the generic `DeepSeek-V4-Flash`. This keeps
 * selection independent of `readDirectory()` ordering. Ties keep the first preset in
 * array order (deterministic given a fixed array — which is how remote presets get
 * priority for free: `[remote, ...bundled]`).
 *
 * Presets only set `vllmModelId`/`match` (never `id` — the user's own identifier
 * in settings), so matching never leaks the preset's id into the user's config.
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
    for (const pattern of p.match) {
      const patternL = pattern.toLowerCase();
      const matched =
        modelL.includes(patternL) || (rootL !== undefined && rootL.includes(patternL));
      if (matched && patternL.length > bestLen) {
        best = p;
        bestLen = patternL.length;
      }
    }
  }
  return best;
}

/**
 * Merge a preset into an existing user config.
 *
 * Strategy:
 * - Preset fully replaces all top-level fields (displayName, family,
 *   maxOutputTokens, capabilities, defaultMode, modelModes, etc.).
 * - User's identity (`id`, `vllmModelId`, `server` ref) is preserved — the
 *   preset must NOT rename or repoint the model.
 */
export function mergePresetWithUserConfig(
  preset: PresetConfig,
  userConfig: ModelConfig
): ModelConfig {
  // Start with the guard-validated preset as the base (full replace). The
  // guard-allowed keys structurally exclude transport and identity — a preset
  // contributes modes/limits, never server refs.
  const merged = { ...preset } as ModelConfig;

  // Identity is the user's — a preset must NEVER rename the model, repoint its
  // vLLM server model id, or retarget its server entry.
  merged.id = userConfig.id;
  merged.server = userConfig.server;
  if (userConfig.vllmModelId !== undefined) {
    merged.vllmModelId = userConfig.vllmModelId;
  } else {
    delete merged.vllmModelId;
  }

  return merged;
}
