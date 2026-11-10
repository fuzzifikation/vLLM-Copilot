import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePresetFile, parsePresetRawJson, PRESET_CONFIG_KEYS } from '../src/vscode/commands/presets.js';
import { describeModel } from '../src/core/catalog/describe.js';
import { buildModelInfo } from '../src/vscode/copilot/modelInfo.js';
import { buildRequest } from '../src/vscode/copilot/requestBuilder.js';
import { COPILOT_HARNESS_EFFORTS, isCopilotHarnessEffort } from '../src/vscode/state/config.js';

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
    expect(preset.config.modelModes!.none).toMatchObject({
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

      it('names every mode with the effort it actually sends', () => {
        // The mode identifier is what the harness shows the user. A mode named
        // "high" that sends reasoning_effort "xhigh" is a lie, so a mode that
        // sends an explicit effort must be named exactly that effort.
        const preset = parsePresetFile(text, file)!;
        const baseline = preset.config.defaultParams ?? {};
        for (const [name, params] of Object.entries(preset.config.modelModes!)) {
          const merged: Record<string, unknown> = { ...baseline, ...params };
          const kwargs = merged.chat_template_kwargs;
          const kwargEffort = kwargs && typeof kwargs === 'object' && !Array.isArray(kwargs)
            ? (kwargs as Record<string, unknown>).reasoning_effort
            : undefined;
          const sent = typeof merged.reasoning_effort === 'string'
            ? merged.reasoning_effort
            : typeof kwargEffort === 'string' ? kwargEffort : undefined;
          if (sent === undefined) continue;
          expect(name, `${file}: mode "${name}" sends reasoning_effort "${sent}"`)
            .toBe(sent === 'no_think' ? 'none' : sent);
        }
      });

      it('keeps harness mappings meaningful', () => {
        // A mapping exists only to point an effort at a descriptively named
        // mode. Identity entries are dead config: a mode already named after
        // the effort resolves to itself without any mapping.
        const preset = parsePresetFile(text, file)!;
        const modes = preset.config.modelModes!;
        const mapping = preset.config.copilotHarnessMapping ?? {};
        for (const [effort, name] of Object.entries(mapping)) {
          expect(COPILOT_HARNESS_EFFORTS, `${file}: unknown effort "${effort}"`).toContain(effort);
          expect(Object.hasOwn(modes, name), `${file}: mapping points at missing mode "${name}"`).toBe(true);
          expect(effort, `${file}: identity mapping "${effort}" is dead config`).not.toBe(name);
        }
        const defaultMode = preset.config.defaultMode;
        if (Object.keys(mapping).length > 0 && defaultMode) {
          expect(Object.values(mapping), `${file}: no effort selects the default mode`)
            .toContain(defaultMode);
        }
      });

      it('sends no baseline parameter that a mode already repeats', () => {
        // defaultParams is the shared baseline; a value present in every mode
        // belongs there instead of being repeated per mode.
        const preset = parsePresetFile(text, file)!;
        const modes = Object.values(preset.config.modelModes!);
        if (modes.length < 2) return;
        for (const key of Object.keys(preset.config.defaultParams ?? {})) {
          expect(modes.some(params => !Object.hasOwn(params, key)),
            `${file}: "${key}" is identical in every mode — move it to defaultParams`).toBe(true);
        }
        for (const key of ['temperature', 'top_p']) {
          const values = modes.map(params => JSON.stringify(params[key]));
          if (values.every(v => v === values[0]) && values[0] !== undefined) {
            expect(preset.config.defaultParams, `${file}: every mode repeats "${key}"`)
              .toHaveProperty(key);
          }
        }
      });

      it('publishes every mode to the harness and sends its original parameters', () => {
        const preset = parsePresetFile(text, file)!;
        const modes = preset.config.modelModes!;
        const mapping = preset.config.copilotHarnessMapping ?? {};
        const override = { ...preset.config, id: 'm', server: 'srv' };
        const model = buildModelInfo(describeModel({
          wireId: 'm', contextWindow: 1_048_576, serverType: 'vllm', override,
        }));
        const schema = (model as typeof model & {
          configurationSchema: { properties: { reasoningEffort: { enum: string[]; enumItemLabels: string[] } } };
        }).configurationSchema.properties.reasoningEffort;
        const output = vscode.window.createOutputChannel('preset harness test');
        try {
          for (const [name, params] of Object.entries(modes)) {
            // Effort-token modes publish themselves; a descriptively named mode
            // publishes under the effort its mapping points at it with.
            const published = Object.entries(mapping).find(([, modeName]) => modeName === name)?.[0] ?? name;
            expect(schema.enum, `${file}: mode "${name}" is not selectable`).toContain(published);
            const label = schema.enumItemLabels[schema.enum.indexOf(published)];
            expect(label.trim().length, `${file}: empty label for "${published}"`).toBeGreaterThan(0);
            if (!isCopilotHarnessEffort(name)) {
              expect(label, `${file}: descriptive mode "${name}" must keep its own name`).toBe(name);
            }
            const request = buildRequest(model, [], {
              modelOptions: {}, tools: [], modelConfiguration: { reasoningEffort: published, maxOutputTokens: 16384 },
            }, {
              models: [override], servers: [{ id: 'srv', serverUrl: 'http://localhost:8000' }],
            }, output);
            expect(request.mergedOptions).toMatchObject(params);
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
