import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  loadModelPresets,
  mergePresetWithUserConfig,
  findPresetForModel,
  stripJsonComments,
  parsePresetFile,
  PRESET_CONFIG_KEYS,
  type PresetConfig,
} from '../src/commands/presets.js';
import { parseHeadersInput } from '../src/commands/serverAuth.js';
import type { ModelConfig } from '../src/config.js';

/**
 * Preset parsing and matching (commands/presets.ts) plus the header-input parser
 * shared by the add-server flows. Named for what it tests: autoConfig.ts is only
 * a re-export barrel.
 */

/** Test-only convenience: guard-validated config payload, or null. */
const parsePresetJson = (text: string): PresetConfig | null =>
  parsePresetFile(text, '')?.config ?? null;

describe('parsePresetFile — forgiving raw parse + envelope unwrap', () => {
  it('parses clean JSON with comments', () => {
    const cfg = parsePresetJson(
      '// a preset\n{ "presetVersion": 1, "match": ["m"], "config": { "vllmModelId": "m", "maxOutputTokens": 4096 } }',
    );
    expect(cfg).toEqual({ vllmModelId: 'm', maxOutputTokens: 4096 });
  });

  it('repairs a trailing comma', () => {
    const cfg = parsePresetJson(
      '{ "presetVersion": 1, "match": ["m"], "config": { "vllmModelId": "m", "maxOutputTokens": 4096, } }',
    );
    expect(cfg?.vllmModelId).toBe('m');
  });

  it('repairs single quotes and missing commas', () => {
    const cfg = parsePresetJson(
      "{ 'presetVersion': 1\n 'match': ['m']\n 'config': { 'vllmModelId': 'm', 'displayName': 'M' } }",
    );
    expect(cfg?.vllmModelId).toBe('m');
    expect(cfg?.displayName).toBe('M');
  });

  it('returns null for unrepairable garbage', () => {
    expect(parsePresetJson('not json at all @@@')).toBeNull();
  });

  it('unwraps a v2 envelope to its config', () => {
    const cfg = parsePresetJson(
      '{ "presetVersion": 1, "match": ["M"], "config": { "vllmModelId": "M", "modelModes": {} } }',
    );
    expect(cfg).toEqual({ vllmModelId: 'M', modelModes: {} });
  });
});

describe('parsePresetFile (format v2)', () => {
  const v2 = JSON.stringify({
    presetVersion: 1,
    match: ['GLM-5.3'],
    meta: {
      name: 'GLM-5.3',
      source: 'https://example.org/card',
      verified: '2026-08-27',
      notes: 'Thinking always on.',
    },
    config: { vllmModelId: 'GLM-5.3', modelModes: { deep: { reasoning_effort: 'max' } } },
  });

  it('parses a valid v2 envelope into match/meta/config', () => {
    const p = parsePresetFile(v2, 'glm.json');
    expect(p).not.toBeNull();
    expect(p!.sourceFile).toBe('glm.json');
    expect(p!.match).toEqual(['GLM-5.3']);
    expect(p!.meta).toEqual({
      name: 'GLM-5.3',
      source: 'https://example.org/card',
      verified: '2026-08-27',
      notes: 'Thinking always on.',
    });
    expect(p!.config.vllmModelId).toBe('GLM-5.3');
  });

  it('rejects an unknown presetVersion', () => {
    const text = v2.replace('"presetVersion":1', '"presetVersion":2');
    expect(text).not.toBe(v2); // guard against a no-op replace ever again
    expect(parsePresetFile(text, 'x.json')).toBeNull();
  });

  it('rejects missing or empty match', () => {
    expect(parsePresetFile('{ "presetVersion": 1, "config": {} }', 'x.json')).toBeNull();
    expect(parsePresetFile('{ "presetVersion": 1, "match": [], "config": {} }', 'x.json')).toBeNull();
  });

  it('rejects the whole file on an unknown config key (asymmetric guard)', () => {
    const text = JSON.stringify({
      presetVersion: 1,
      match: ['M'],
      config: { vllmModelId: 'M', serverUrl: 'https://evil.example' },
    });
    expect(parsePresetFile(text, 'x.json')).toBeNull();
  });

  it('tolerates unknown meta fields (forward compat) but keeps the file', () => {
    const text = JSON.stringify({
      presetVersion: 1,
      match: ['M'],
      meta: { name: 'M', authorBio: 'future field', verified: 42 },
      config: { vllmModelId: 'M' },
    });
    const p = parsePresetFile(text, 'x.json');
    expect(p).not.toBeNull();
    expect(p!.meta).toEqual({ name: 'M' }); // unknown + ill-typed fields dropped
  });

  it('rejects legacy bare configs — the v2 envelope is the only format', () => {
    // The legacy shim was removed before shipping its first release: it
    // accepted unvalidated configs WITHOUT the PRESET_CONFIG_KEYS allow-list
    // check — a smuggle path for transport fields, not a compatibility feature.
    expect(parsePresetFile('// old style\n{ "vllmModelId": "Legacy-M", "modelModes": {} }', 'l.json')).toBeNull();
  });

  it('PRESET_CONFIG_KEYS excludes identity and transport fields', () => {
    for (const forbidden of ['id', 'server', 'serverUrl', 'requestHeaders', 'serverType', 'provider']) {
      expect(PRESET_CONFIG_KEYS.has(forbidden)).toBe(false);
    }
    for (const allowed of ['vllmModelId', 'modelModes', 'defaultParams', 'estimateCharsPerToken']) {
      expect(PRESET_CONFIG_KEYS.has(allowed)).toBe(true);
    }
  });
});

describe('findPresetForModel with v2 match patterns', () => {
  const mk = (sourceFile: string, match: string[], vllmModelId: string) => ({
    config: { vllmModelId },
    sourceFile,
    match,
  });

  it('matches any pattern from the match list, case-insensitively', () => {
    const p = mk('x.json', ['GLM-5.3', 'glm5'], 'GLM-5.3');
    expect(findPresetForModel([p], 'zai-org/GLM-5.3-FP8')).toBe(p);
    expect(findPresetForModel([p], 'some-glm5-quant')).toBe(p);
    expect(findPresetForModel([p], 'other', 'server/GLM-5.3-root')).toBe(p);
  });

  it('longest matching pattern wins across presets', () => {
    const generic = mk('generic.json', ['DeepSeek-V4-Flash'], 'DeepSeek-V4-Flash');
    const specific = mk('specific.json', ['DeepSeek-V4-Flash-0731'], 'DeepSeek-V4-Flash-0731');
    expect(findPresetForModel([generic, specific], 'DeepSeek-V4-Flash-0731')).toBe(specific);
    expect(findPresetForModel([specific, generic], 'deepseek-v4-flash-0731-preview')).toBe(specific);
    expect(findPresetForModel([generic, specific], 'DeepSeek-V4-Flash-NVFP4')).toBe(generic);
  });

  it('ties keep array order — [remote, ...bundled] gives remote priority for free', () => {
    const remote = mk('remote:f.json', ['GLM-5.3'], 'GLM-5.3');
    const bundled = mk('GLM-5.3.json', ['GLM-5.3'], 'GLM-5.3');
    expect(findPresetForModel([remote, bundled], 'GLM-5.3-FP8')).toBe(remote);
    expect(findPresetForModel([bundled, remote], 'GLM-5.3-FP8')).toBe(bundled);
  });
});

describe('parseHeadersInput', () => {
  const ok = (r: ReturnType<typeof parseHeadersInput>) => {
    if ('error' in r) throw new Error(`expected headers, got error: ${r.error}`);
    return r.headers;
  };

  it('returns empty headers for blank input', () => {
    expect(ok(parseHeadersInput(''))).toEqual({});
    expect(ok(parseHeadersInput('   '))).toEqual({});
  });

  it('parses strict JSON', () => {
    expect(ok(parseHeadersInput('{"X-API-Key": "abc123"}'))).toEqual({ 'X-API-Key': 'abc123' });
  });

  it('repairs JSON missing the outer braces', () => {
    expect(ok(parseHeadersInput('"X-API-Key": "abc123"'))).toEqual({ 'X-API-Key': 'abc123' });
  });

  it('repairs unquoted key and value (Name: value shorthand)', () => {
    expect(ok(parseHeadersInput('X-API-Key: abc123'))).toEqual({ 'X-API-Key': 'abc123' });
  });

  it('repairs single quotes', () => {
    expect(ok(parseHeadersInput("{'X-API-Key': 'abc123'}"))).toEqual({ 'X-API-Key': 'abc123' });
  });

  it('repairs trailing commas', () => {
    expect(ok(parseHeadersInput('{"A": "1", "B": "2",}'))).toEqual({ A: '1', B: '2' });
  });

  it('parses multiple newline-separated pairs (missing commas)', () => {
    expect(ok(parseHeadersInput('A: 1\nB: 2'))).toEqual({ A: '1', B: '2' });
  });

  it('coerces numeric values to strings', () => {
    expect(ok(parseHeadersInput('{"X-Count": 42}'))).toEqual({ 'X-Count': '42' });
  });

  it('rejects a bare token with no key', () => {
    const r = parseHeadersInput('just-a-value');
    expect('error' in r).toBe(true);
  });
});

describe('mergePresetWithUserConfig', () => {
  const presetConfig: PresetConfig = {
    vllmModelId: 'test/model',
    displayName: 'Test Model',
    family: 'test_family',
    maxOutputTokens: 32768,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    modelModes: {
      'Think': { enable_thinking: true, temperature: 1.0 },
      'No Think': { enable_thinking: false, temperature: 0.7 },
    },
    defaultMode: 'Think',
  };

  it('returns preset unchanged when no user config exists', () => {
    const userConfig: ModelConfig = { id: 'test/model', server: 'test-server' };
    const merged = mergePresetWithUserConfig(presetConfig, userConfig);

    expect(merged.id).toBe('test/model');
    expect(merged.displayName).toBe('Test Model');
    expect(merged.maxOutputTokens).toBe(32768);
    expect(merged.modelModes).toEqual(presetConfig.modelModes);
  });

  it('preset replaces all user modelModes (no preservation of old modes)', () => {
    const userConfig: ModelConfig = {
      id: 'test/model',
      server: 'test-server',
      modelModes: {
        'Custom Mode': { temperature: 0.1, top_p: 0.5 },
      },
    };
    const merged = mergePresetWithUserConfig(presetConfig, userConfig);

    // Only preset modes survive — user modes are fully replaced
    expect(merged.modelModes).toEqual(presetConfig.modelModes);
    expect(merged.modelModes).toHaveProperty('Think');
    expect(merged.modelModes).toHaveProperty('No Think');
    expect(merged.modelModes).not.toHaveProperty('Custom Mode');
  });

  it('preset wins over all overlapping user modelModes', () => {
    const userConfig: ModelConfig = {
      id: 'test/model',
      server: 'test-server',
      modelModes: {
        'Think': { enable_thinking: true, temperature: 0.01 },
        'Custom Mode': { temperature: 0.1 },
      },
    };
    const merged = mergePresetWithUserConfig(presetConfig, userConfig);

    // All modes come from preset — user modes are fully replaced
    expect(merged.modelModes).toEqual(presetConfig.modelModes);
    expect(merged.modelModes).not.toHaveProperty('Custom Mode');
  });

  it('preset fully replaces top-level fields regardless of user values', () => {
    const userConfig: ModelConfig = {
      id: 'test/model',
      server: 'test-server',
      displayName: 'My Custom Name',
      maxOutputTokens: 999,
      capabilities: {
        toolCalling: false,
        imageInput: true,
      },
      modelModes: {
        'My Mode': { temperature: 0.5 },
      },
    };
    const merged = mergePresetWithUserConfig(presetConfig, userConfig);

    expect(merged.displayName).toBe('Test Model');
    expect(merged.maxOutputTokens).toBe(32768);
    expect(merged.capabilities).toEqual(presetConfig.capabilities);
    // All preset modes, user modes fully replaced
    expect(merged.modelModes).toEqual(presetConfig.modelModes);
    expect(merged.modelModes).not.toHaveProperty('My Mode');
  });

  it('handles preset with no modelModes (result has none)', () => {
    const presetWithoutModes: PresetConfig = {
      vllmModelId: 'test/model',
      maxOutputTokens: 1000,
    };
    const userConfig: ModelConfig = {
      id: 'test/model',
      server: 'test-server',
      modelModes: {
        'User Mode': { temperature: 0.5 },
      },
    };
    const merged = mergePresetWithUserConfig(presetWithoutModes, userConfig);

    expect(merged.maxOutputTokens).toBe(1000);
    // User modes are replaced — preset has none, so result has none
    expect(merged.modelModes).toBeUndefined();
  });

  it('handles both preset and user having no modelModes', () => {
    const emptyPreset: PresetConfig = { vllmModelId: 'test/model' };
    const emptyUser: ModelConfig = { id: 'test/model', server: 'test-server' };
    const merged = mergePresetWithUserConfig(emptyPreset, emptyUser);

    expect(merged.modelModes).toBeUndefined();
  });

  it('preserves the user id/vllmModelId instead of the preset\'s', () => {
    const preset: PresetConfig = {
      vllmModelId: 'zai-org/GLM-5.2',
      displayName: 'GLM-5.2',
      maxOutputTokens: 32768,
    };
    // The user configured the model under a short server alias.
    const userConfig: ModelConfig = { id: 'zai-glm-52', server: 'user-server', vllmModelId: 'zai-glm-52' };
    const merged = mergePresetWithUserConfig(preset, userConfig);

    // Identity stays the user's; preset only contributes the other fields.
    expect(merged.id).toBe('zai-glm-52');
    expect(merged.server).toBe('user-server');
    expect(merged.vllmModelId).toBe('zai-glm-52');
    expect(merged.displayName).toBe('GLM-5.2');
    expect(merged.maxOutputTokens).toBe(32768);
  });

  it('drops vllmModelId when the user config has none', () => {
    const preset: PresetConfig = { vllmModelId: 'repo/Model', maxOutputTokens: 100 };
    const userConfig: ModelConfig = { id: 'my-model', server: 'test-server' }; // no vllmModelId
    const merged = mergePresetWithUserConfig(preset, userConfig);

    expect(merged.id).toBe('my-model');
    expect(merged.vllmModelId).toBeUndefined();
  });
});

describe('findPresetForModel — substring matching on curated patterns', () => {
  const preset = {
    config: { vllmModelId: 'GLM-5.2' },
    sourceFile: 'glm-5.2-config.json',
    match: ['GLM-5.2'],
  };
  const presets = [preset];

  it('matches when the preset id is a case-insensitive substring of the served id', () => {
    expect(findPresetForModel(presets, 'zai-org/GLM-5.2')).toBe(preset);
    expect(findPresetForModel(presets, 'glm-5.2-fp8')).toBe(preset);
  });

  it('matches a llama.cpp full-path gguf served id by basename', () => {
    // /srv/data/models/Qwen3.8-27B-Q6_K.gguf → preset "Qwen3.8-27B"
    const pathPreset = {
      config: { vllmModelId: 'Qwen3.8-27B' },
      sourceFile: 'Qwen-Qwen3.8-27B.json',
      match: ['Qwen3.8-27B'],
    };
    expect(findPresetForModel([pathPreset], '/srv/data/models/Qwen3.8-27B-Q6_K.gguf')).toBe(pathPreset);
  });

  it('matches an alias via its server root', () => {
    // The user configured the short alias; the server reports its real checkpoint as root.
    expect(findPresetForModel(presets, 'zai-glm-52', 'zai-org/GLM-5.2')).toBe(preset);
  });

  it('does not match when the preset id is not a substring', () => {
    expect(findPresetForModel(presets, 'zai-glm-52')).toBeUndefined();
    expect(findPresetForModel(presets, 'other-model', 'other-root')).toBeUndefined();
  });

  it('matches a cross-org quantized variant when the id is a substring', () => {
    // "DeepSeek-V4-Flash" appears inside "nvidia/DeepSeek-V4-Flash-NVFP4".
    const dsPreset = {
      config: { vllmModelId: 'DeepSeek-V4-Flash' },
      sourceFile: 'DeepSeek-V4-Flash.json',
      match: ['DeepSeek-V4-Flash'],
    };
    expect(findPresetForModel([dsPreset], 'nvidia/DeepSeek-V4-Flash-NVFP4')).toBe(dsPreset);
  });

  it('does not cross-match a different model that shares a name token', () => {
    const chatPreset = {
      config: { vllmModelId: 'DeepSeek-V4-Chat' },
      sourceFile: 'DeepSeek-V4-Chat.json',
      match: ['DeepSeek-V4-Chat'],
    };
    expect(findPresetForModel([chatPreset], 'nvidia/DeepSeek-V4-Flash-NVFP4')).toBeUndefined();
  });

  it('prefers the most specific preset regardless of directory order (ambiguity regression)', () => {
    // `DeepSeek-V4-Flash` is a substring of `DeepSeek-V4-Flash-0731`, so the
    // generic and specific presets both match the 0731 served id. The longest
    // vllmModelId must win — independent of readDirectory() ordering.
    const generic = {
      config: { vllmModelId: 'DeepSeek-V4-Flash' },
      sourceFile: 'DeepSeek-V4-Flash.json',
      match: ['DeepSeek-V4-Flash'],
    };
    const specific = {
      config: { vllmModelId: 'DeepSeek-V4-Flash-0731' },
      sourceFile: 'DeepSeek-V4-Flash-0731.json',
      match: ['DeepSeek-V4-Flash-0731'],
    };
    expect(findPresetForModel([generic, specific], 'DeepSeek-V4-Flash-0731')).toBe(specific);
    expect(findPresetForModel([specific, generic], 'DeepSeek-V4-Flash-0731')).toBe(specific);
  });

  it('never matches a preset with an empty match list', () => {
    const noPatterns = { config: { vllmModelId: 'x' }, sourceFile: 'x.json', match: [] };
    expect(findPresetForModel([noPatterns], 'anything')).toBeUndefined();
  });
});

describe('loadModelPresets', () => {
  const encode = (s: string) => new TextEncoder().encode(s);
  let savedDir: any;
  let savedFile: any;

  beforeEach(() => {
    const ws = (vscode as any).workspace;
    savedDir = ws._mockFsReadDirectory;
    savedFile = ws._mockFsReadFile;
  });

  afterEach(() => {
    const ws = (vscode as any).workspace;
    ws._mockFsReadDirectory = savedDir;
    ws._mockFsReadFile = savedFile;
  });

  it('loads valid preset JSON and skips non-JSON and malformed entries', async () => {
    (vscode as any).workspace._mockFsReadDirectory = () =>
      Promise.resolve([
        ['Good-Preset.json', vscode.FileType.File],
        ['notes.txt', vscode.FileType.File],
        ['subdir', vscode.FileType.Directory],
        ['Broken-Preset.json', vscode.FileType.File],
      ]);
    (vscode as any).workspace._mockFsReadFile = (uri: string) => {
      if (String(uri).endsWith('Good-Preset.json')) {
        return Promise.resolve(
          encode('{ "presetVersion": 1, "match": ["org/Model"], "config": { "vllmModelId": "org/Model", "modelModes": { "balanced": {} } } }'),
        );
      }
      if (String(uri).endsWith('Broken-Preset.json')) {
        return Promise.resolve(encode('not json @@@'));
      }
      return Promise.resolve(new Uint8Array());
    };

    const presets = await loadModelPresets(vscode.Uri.file('/ext'));

    expect(presets).toHaveLength(1);
    expect(presets[0].sourceFile).toBe('Good-Preset.json');
    expect(presets[0].config.vllmModelId).toBe('org/Model');
  });

  it('returns [] when the model-configs directory cannot be read', async () => {
    (vscode as any).workspace._mockFsReadDirectory = () =>
      Promise.reject(new Error('ENOENT'));

    const presets = await loadModelPresets(vscode.Uri.file('/ext'));
    expect(presets).toEqual([]);
  });

  it('skips a preset whose file read fails', async () => {
    (vscode as any).workspace._mockFsReadDirectory = () =>
      Promise.resolve([['Good-Preset.json', vscode.FileType.File]]);
    (vscode as any).workspace._mockFsReadFile = () =>
      Promise.reject(new Error('EACCES'));

    const presets = await loadModelPresets(vscode.Uri.file('/ext'));
    expect(presets).toEqual([]);
  });

  it('skips the generated index.json — it is the remote list, not a preset', async () => {
    // index.json ships inside model-configs/ (served from the repo). It is
    // valid JSON; without the explicit skip it would be read and parsed on
    // every load only for the v2 guard to reject it.
    (vscode as any).workspace._mockFsReadDirectory = () =>
      Promise.resolve([
        ['index.json', vscode.FileType.File],
        ['Good-Preset.json', vscode.FileType.File],
      ]);
    (vscode as any).workspace._mockFsReadFile = () =>
      Promise.resolve(encode('{ "presetVersion": 1, "match": ["org/Model"], "config": { "vllmModelId": "org/Model", "modelModes": { "balanced": {} } } }'));

    const presets = await loadModelPresets(vscode.Uri.file('/ext'));

    expect(presets).toHaveLength(1);
    expect(presets[0].sourceFile).toBe('Good-Preset.json');
  });
});

// ── shipped preset regression ──────────────────────────────────────────────

const PRESET_PATH = path.resolve(__dirname, '../model-configs/Poolside-Laguna-S-2.1.json');
