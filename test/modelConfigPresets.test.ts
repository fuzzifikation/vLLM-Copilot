import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePresetFile, parsePresetRawJson, PRESET_CONFIG_KEYS } from '../src/vscode/commands/presets.js';
import { describeModel } from '../src/core/catalog/describe.js';
import { buildModelInfo } from '../src/vscode/copilot/modelInfo.js';
import { buildRequest } from '../src/vscode/copilot/requestBuilder.js';

/**
 * Guards the shipped model-configs/ presets: every JSON must parse through the
 * real loader (parsePresetFile, incl. comment-stripping + jsonrepair), use the
 * v2 envelope format, and expose valid match/meta/config. These files are
 * packaged into the VSIX and applied by Auto-Configure, so a malformed preset
 * would silently break for end users.
 */
const configsDir = fileURLToPath(new URL('../model-configs/', import.meta.url));
// index.json is the generated remote preset list, not a preset — it is guarded
// separately below.
const INDEX_FILE = 'index.json';
const presetFiles = readdirSync(configsDir).filter(f => f.endsWith('.json') && f !== INDEX_FILE);

describe('shipped model-configs presets', () => {
  it('has at least one preset', () => {
    expect(presetFiles.length).toBeGreaterThan(0);
  });

  it('leaves Poolside sampling to the checkpoint instead of overriding its defaults', () => {
    const preset = parsePresetFile(
      readFileSync(configsDir + 'Poolside-Laguna-S-2.1.json', 'utf8'),
      'Poolside-Laguna-S-2.1.json',
    )!;
    expect(preset.config.defaultParams).toBeUndefined();
    for (const params of Object.values(preset.config.modelModes!)) {
      for (const key of ['temperature', 'top_p', 'top_k', 'min_p', 'repetition_penalty']) {
        expect(params).not.toHaveProperty(key);
      }
    }
  });

  it('explicitly disables DeepSeek Pro thinking instead of relying on the server default', () => {
    const preset = parsePresetFile(
      readFileSync(configsDir + 'DeepSeek-V4-Pro.json', 'utf8'), 'DeepSeek-V4-Pro.json',
    )!;
    expect(preset.config.modelModes!['No-Think']).toMatchObject({
      reasoning_effort: 'none',
      chat_template_kwargs: { thinking: false },
    });
    const override = {
      ...preset.config, id: 'm', server: 'srv',
      defaultParams: { reasoning_effort: 'max', chat_template_kwargs: { thinking: true } },
    };
    const model = buildModelInfo(describeModel({
      wireId: 'm', contextWindow: 1_048_576, serverType: 'vllm', override,
    }));
    const output = vscode.window.createOutputChannel('DeepSeek thinking off');
    try {
      const request = buildRequest(model, [], {
        modelOptions: {}, tools: [], modelConfiguration: { reasoningEffort: 'none' },
      }, {
        models: [override], servers: [{ id: 'srv', serverUrl: 'http://localhost:8000' }],
      }, output);
      expect(request.mergedOptions).toMatchObject({ reasoning_effort: 'none', chat_template_kwargs: { thinking: false } });
    } finally {
      output.dispose();
    }
  });

  it('does not send an unsupported preservation flag to the official Agents-A1 template', () => {
    const preset = parsePresetFile(
      readFileSync(configsDir + 'Agents-A1-config.json', 'utf8'), 'Agents-A1-config.json',
    )!;
    for (const params of Object.values(preset.config.modelModes!)) {
      expect(params.chat_template_kwargs ?? {}).not.toHaveProperty('preserve_thinking');
    }
  });

  for (const file of presetFiles) {
    describe(file, () => {
      const text = readFileSync(configsDir + file, 'utf8');

      it('is a v2 envelope (presetVersion 1 with match list)', () => {
        // Raw check — assert the version tag explicitly (parsePresetFile
        // rejects anything else, but a missing tag here means authoring drift).
        const raw = parsePresetRawJson(text)!;
        expect(raw.presetVersion, `${file} must declare presetVersion`).toBe(1);
        expect(Array.isArray(raw.match) && raw.match.length).toBeGreaterThan(0);
      });

      it('parses through the real loader with usable config', () => {
        const preset = parsePresetFile(text, file);
        expect(preset, `${file} failed to parse`).not.toBeNull();
        expect(preset!.match!.every(m => m.trim().length > 0)).toBe(true);
        expect(preset!.config).not.toHaveProperty('vllmModelId');
        // Presets exist to supply modes; each should define at least one.
        expect(Object.keys(preset!.config.modelModes ?? {}).length).toBeGreaterThan(0);
        // If a defaultMode is set it must reference a real mode.
        if (preset!.config.defaultMode) {
          expect(Object.keys(preset!.config.modelModes ?? {})).toContain(preset!.config.defaultMode);
        }
      });

      it('config only uses preset-allowed keys', () => {
        const raw = parsePresetRawJson(text)!;
        for (const key of Object.keys(raw.config as Record<string, unknown>)) {
          expect(PRESET_CONFIG_KEYS.has(key), `${file}: unknown config key "${key}"`).toBe(true);
        }
      });

      it('uses wire-safe mode identifiers', () => {
        const preset = parsePresetFile(text, file)!;
        for (const name of Object.keys(preset.config.modelModes!)) {
          expect(name).toMatch(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/);
        }
      });

      it('maps harness efforts to existing modes with the correct backend effort', () => {
        const preset = parsePresetFile(text, file)!;
        const modes = preset.config.modelModes!;
        const mapping = preset.config.copilotHarnessMapping;
        expect(mapping, `${file}: missing harness mapping`).toBeDefined();
        expect(Object.keys(mapping!)).not.toHaveLength(0);
        const defaultMode = preset.config.defaultMode ?? Object.keys(modes)[0];
        expect(Object.values(mapping!)).toContain(defaultMode);

        for (const [effort, name] of Object.entries(mapping!)) {
          expect(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).toContain(effort);
          expect(Object.hasOwn(modes, name), `${file}: missing mode "${name}"`).toBe(true);
          const params = modes[name];
          const kwargs = params.chat_template_kwargs;
          const templateEffort = kwargs && typeof kwargs === 'object' && 'reasoning_effort' in kwargs
            ? kwargs.reasoning_effort : undefined;
          const backendEffort = params.reasoning_effort ?? templateEffort;
          if (typeof backendEffort === 'string') {
            expect(effort).toBe(backendEffort === 'no_think' ? 'none' : backendEffort);
          } else if (effort !== 'none') {
            expect(effort).toBe('high');
            expect(name).toBe(defaultMode);
          }
        }
      });

      it('publishes every mapped harness choice and sends its original mode parameters', () => {
        const preset = parsePresetFile(text, file)!;
        const override = { ...preset.config, id: 'm', server: 'srv' };
        const model = buildModelInfo(describeModel({
          wireId: 'm', contextWindow: 1_048_576, serverType: 'vllm', override,
        }));
        const schema = (model as typeof model & {
          configurationSchema: { properties: { reasoningEffort: { enum: string[]; enumItemLabels: string[] } } };
        }).configurationSchema.properties.reasoningEffort;
        const output = vscode.window.createOutputChannel('preset harness test');
        try {
          for (const [effort, name] of Object.entries(preset.config.copilotHarnessMapping!)) {
            expect(schema.enum).toContain(effort);
            expect(schema.enumItemLabels[schema.enum.indexOf(effort)]).toBe(name);
            const request = buildRequest(model, [], {
              modelOptions: {}, tools: [], modelConfiguration: { reasoningEffort: effort, maxOutputTokens: 16384 },
            }, {
              models: [override], servers: [{ id: 'srv', serverUrl: 'http://localhost:8000' }],
            }, output);
            expect(request.mergedOptions).toMatchObject(preset.config.modelModes![name]);
            expect(request.mergedOptions).not.toHaveProperty('copilotHarnessMapping');
            expect(request.mergedOptions.max_tokens).toBe(16384);
          }
        } finally {
          output.dispose();
        }
      });

      it('carries user-facing provenance metadata', () => {
        const meta = parsePresetRawJson(text)!.meta as Record<string, string | undefined>;
        expect(meta).not.toHaveProperty('name');
        expect(typeof meta?.notes, `${file}: meta.notes must be a string`).toBe('string');
        expect(meta.notes!.trim().length).toBeGreaterThan(0);
        if (meta.source !== undefined) {
          expect(meta.source, `${file}: meta.source must be https`).toMatch(/^https:\/\//);
        }
        if (meta.verified !== undefined) {
          expect(meta.verified, `${file}: meta.verified must be YYYY-MM-DD`).toMatch(
            /^\d{4}-\d{2}-\d{2}$/,
          );
        }
      });
    });
  }
});

/**
 * Drift guard for the generated remote preset list (model-configs/index.json):
 * it must list exactly the preset files in this directory with identical match
 * arrays. Regenerate with `npm run gen:presets`, in the same commit as the
 * preset change — a stale index must never ship, and npm run build gates this.
 */
describe('model-configs/index.json (remote preset list)', () => {
  const indexRaw = JSON.parse(readFileSync(configsDir + INDEX_FILE, 'utf8'));

  it('has schemaVersion 1 and a bare object shape', () => {
    expect(indexRaw.schemaVersion).toBe(1);
    expect(typeof indexRaw.updated).toBe('string');
    expect(Array.isArray(indexRaw.presets)).toBe(true);
  });

  it('lists exactly the preset files in this directory', () => {
    const listed = indexRaw.presets.map((e: { file: string }) => e.file).sort();
    expect(listed).toEqual([...presetFiles].sort());
  });

  it('entry match arrays are identical to the preset file match arrays', () => {
    for (const entry of indexRaw.presets) {
      const raw = parsePresetRawJson(readFileSync(configsDir + entry.file, 'utf8'))!;
      expect(entry.match, `index match drift for ${entry.file}`).toEqual(raw.match);
    }
  });

  it('every file is a bare *.json name (no path traversal)', () => {
    for (const entry of indexRaw.presets) {
      expect(entry.file).toMatch(/^[^/\\]+\.json$/);
    }
  });
});
