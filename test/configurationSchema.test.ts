import { describe, it, expect } from 'vitest';
import { buildModelInfo } from '../src/vscode/copilot/modelInfo.js';
import { buildRequest } from '../src/vscode/copilot/requestBuilder.js';
import { readPickerSelection } from '../src/vscode/state/config.js';
import { describeModel } from '../src/core/catalog/describe.js';

// A generous ceiling so mode-only fixtures are never filtered — the length
// dropdown is emitted ONLY when a vector is declared, so these stay clean.
const CEIL = 65536;

/**
 * `buildConfigurationSchema` is module-private (U9 demotion): the schema is
 * exercised through its only production caller. Since the Phase-4 split the
 * menu ceiling is DERIVED by core `describeModel` from the facts (vector max
 * under the window + server-reported clamps), not injected — so a test that
 * wants a specific ceiling expresses it as the server-reported output
 * ceiling, which feeds the same derivation discovery runs. The context
 * window is huge so the budget derivation never interferes with the menu.
 */
function buildConfigurationSchema(
  override: Record<string, unknown>,
  reportedMaxOutputTokens?: number,
): { properties: Record<string, any> } | undefined {
  const id = String(override.id ?? 'test/model');
  const descriptor = describeModel({
    wireId: id,
    contextWindow: 1_000_000,
    serverType: 'vllm',
    override: { id, vllmModelId: id, server: 'srv', ...override } as any,
    reportedMaxOutputTokens,
  });
  return (buildModelInfo(descriptor) as {
    configurationSchema?: { properties: Record<string, any> };
  }).configurationSchema;
}

describe('buildConfigurationSchema', () => {
  it('returns user-defined model modes when modelModes is set', () => {
    const schema = buildConfigurationSchema({
      modelModes: {
        Think: { chat_template_kwargs: { enable_thinking: true } },
        'No Think': { chat_template_kwargs: { enable_thinking: false } },
      },
    }, CEIL);

    expect(schema).toBeDefined();
    const prop = schema!.properties.reasoningEffort as any;
    expect(prop.enum).toEqual(['high', 'none']);
    expect(prop.enumItemLabels).toEqual(['Think', 'No Think']);
    expect(prop.default).toBe('high');
    // A model with modes but a scalar budget gets NO length dropdown.
    expect(schema!.properties.maxOutputTokens).toBeUndefined();
  });

    it('modelModes produces correct picker schema', () => {
      const modelOverride = {
        id: 'Qwen/Qwen3.6-27B',
        modelModes: {
          'Think general': { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } },
          'Think coding': { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } },
          'No Think instruct': { chat_template_kwargs: { enable_thinking: false } },
        },
      };

      const schema = buildConfigurationSchema(modelOverride, CEIL);

      expect(schema).toBeDefined();
      const prop = schema!.properties.reasoningEffort as any;
      expect(prop.enum).toEqual(['high', 'medium', 'none']);
      expect(prop.enumItemLabels).toEqual(['Think general', 'Think coding', 'No Think instruct']);
      expect(prop.default).toBe('high');
    });

    it('a vector-form maxOutputTokens alone yields a length-only schema', () => {
      const modelOverride = {
        id: 'some-model',
        maxOutputTokens: [8192, 4096, 2048],
      } as any;

      const schema = buildConfigurationSchema(modelOverride, CEIL);
      expect(schema).toBeDefined();
      expect(schema!.properties.reasoningEffort).toBeUndefined();
      const prop = schema!.properties.maxOutputTokens as any;
      expect(prop.enum).toEqual([8192, 4096, 2048]);
      expect(prop.enumItemLabels).toEqual(['8K', '4K', '2K']);
      expect(prop.default).toBe(8192);
      // The length picker MUST be in 'tokens', not 'navigation' — VS Code
      // renders one property per group, so a second 'navigation' property is
      // silently dropped (the field bug this pins).
      expect(prop.group).toBe('tokens');
    });

    it('modes and lengths coexist in DISTINCT groups (renderer keeps one per group)', () => {
      const schema = buildConfigurationSchema({
        modelModes: { Think: {}, Fast: {} },
        maxOutputTokens: [32768, 16384, 8192],
      }, CEIL);

      expect(schema!.properties.reasoningEffort).toBeDefined();
      expect(schema!.properties.maxOutputTokens).toBeDefined();
      expect((schema!.properties.reasoningEffort as any).group).toBe('navigation');
      expect((schema!.properties.maxOutputTokens as any).group).toBe('tokens');
    });
  });

describe('output-length menu (resolveOutputLengthOptions, via the schema)', () => {
  // Menu shape is read off the rendered property: enum = values,
  // enumItemLabels = labels, default = first surviving value. The second
  // argument is the server-reported output ceiling — the derivation input
  // that prunes the menu (see the helper doc above).
  const menu = (maxOutputTokens: unknown, reportedCeiling?: number) =>
    buildConfigurationSchema({ id: 'some/model', maxOutputTokens }, reportedCeiling)
      ?.properties?.maxOutputTokens as { enum: number[]; enumItemLabels: string[]; default: number } | undefined;

  it('returns undefined without an explicit vector (no derived ladder)', () => {
    expect(menu(undefined)).toBeUndefined();
    expect(menu([])).toBeUndefined();
  });

  it('passes through a clean descending vector with formatted labels', () => {
    const r = menu([65536, 32768, 16384]);
    expect(r!.enum).toEqual([65536, 32768, 16384]);
    expect(r!.enumItemLabels).toEqual(['64K', '32K', '16K']);
    expect(r!.default).toBe(65536);
  });

  it('drops entries above the ceiling, promoting the next survivor to default', () => {
    // Head (131072) exceeds the 65536 ceiling (server-reported) → dropped,
    // 65536 becomes default.
    const r = menu([131072, 65536, 32768], 65536);
    expect(r!.enum).toEqual([65536, 32768]);
    expect(r!.default).toBe(65536);
  });

  it('drops non-integer and non-positive entries', () => {
    const r = menu([8192, 4096.5, 0, -5, 2048]);
    expect(r!.enum).toEqual([8192, 2048]);
  });

  it('dedupes repeated values preserving order', () => {
    const r = menu([32768, 32768, 16384]);
    expect(r!.enum).toEqual([32768, 16384]);
  });

  it('returns undefined when fewer than two options survive', () => {
    expect(menu([65536])).toBeUndefined();
    expect(menu([131072, 262144], 65536)).toBeUndefined();
  });

  it('caps the menu at 8 entries', () => {
    const nine = [9, 8, 7, 6, 5, 4, 3, 2, 1].map(n => n * 1024);
    const r = menu(nine);
    expect(r!.enum).toHaveLength(8);
    expect(r!.enumItemLabels).toHaveLength(8);
  });
});


describe('Copilot SDK reasoning effort bridge', () => {
  const allowed = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  const modelModes = {
    'Think (Deep)': { reasoning_effort: 'xhigh', temperature: 1, max_tokens: 80 },
    'Think (Balanced)': { reasoning_effort: 'medium', temperature: 1, max_tokens: 60 },
    'No Think': { chat_template_kwargs: { enable_thinking: false }, temperature: 0.7, max_tokens: 40 },
  };
  const override = { id: 'qwen', vllmModelId: 'Qwen3.8-Flash-Next', server: 'srv', modelModes, defaultMode: 'Think (Deep)' };
  const model = buildModelInfo(describeModel({
    wireId: 'qwen', contextWindow: 1_000_000, serverType: 'vllm', override,
  }));
  const schema = (model as any).configurationSchema.properties.reasoningEffort;

  it('keeps every Qwen preset through the SDK standard-effort filter', () => {
    expect(schema.enum.filter((value: string) => allowed.has(value))).toEqual(['xhigh', 'medium', 'none']);
    expect(schema.enumItemLabels).toEqual(Object.keys(modelModes));
    expect(schema.default).toBe('xhigh');
  });

  for (const [index, [name, params]] of Object.entries(modelModes).entries()) {
    it(`round-trips ${name} into request parameters, token budgets and provider tracking`, () => {
      const effort = ['xhigh', 'medium', 'none'][index];
      for (const selection of [effort, name]) {
        const options = { modelOptions: {}, tools: [], modelConfiguration: { reasoningEffort: selection } };
        expect(readPickerSelection(options, model).selectedMode).toBe(name);
        const request = buildRequest(model, [], options as any, {
          models: [override], servers: [{ id: 'srv', serverUrl: 'http://localhost:8000' }],
        }, { appendLine() {} } as any);
        expect(request.mergedOptions).toMatchObject(params);
      }
    });
  }

  it('keeps colliding names and arbitrary custom modes distinct', () => {
    const names = ['high', 'Think', 'Think general', 'Custom A', 'Custom B', 'Custom C', 'Custom D', 'Custom E', 'Extra'];
    const schema = buildConfigurationSchema({ modelModes: Object.fromEntries(names.map(name => [name, {}])) })!;
    const prop = schema.properties.reasoningEffort;
    expect(new Set(prop.enum).size).toBe(names.length);
    expect(prop.enum.slice(0, 8).every((value: string) => allowed.has(value))).toBe(true);
    // More modes than standard SDK slots remain available in Local chat.
    expect(prop.enum[8]).toBe('Extra');
    const info = { configurationSchema: schema };
    for (const [index, name] of names.entries()) {
      expect(readPickerSelection({ modelConfiguration: { reasoningEffort: prop.enum[index] } }, info).selectedMode).toBe(name);
      expect(readPickerSelection({ modelConfiguration: { reasoningEffort: name } }, info).selectedMode).toBe(name);
    }
  });
});


describe('OpenRouter SDK effort semantics', () => {
  it('uses nested backend efforts even when display names disagree', () => {
    const modelModes = {
      'Think (Max)': { reasoning: { enabled: true, effort: 'max' } },
      'Think (Minimal)': { reasoning: { enabled: true, effort: 'minimal' } },
      'Think (High)': { reasoning: { enabled: true, effort: 'low' } },
      Disabled: { reasoning: { enabled: false } },
    };
    const prop = buildConfigurationSchema({ modelModes })!.properties.reasoningEffort;
    expect(prop.enum).toEqual(['max', 'minimal', 'low', 'none']);
    const info = { configurationSchema: { properties: { reasoningEffort: prop } } };
    for (const [index, name] of Object.keys(modelModes).entries()) {
      expect(readPickerSelection({ modelConfiguration: { reasoningEffort: prop.enum[index] } }, info).selectedMode).toBe(name);
    }
  });

  it('explains the SDK alias for provider-controlled reasoning without adding an effort', () => {
    const prop = buildConfigurationSchema({ modelModes: {
      Think: { reasoning: { enabled: true } },
      'No Think': { reasoning: { enabled: false } },
    } })!.properties.reasoningEffort;
    expect(prop.enum).toEqual(['high', 'none']);
    expect(prop.enumDescriptions[0]).toContain('backend defaults');
    expect(prop.enumDescriptions[0]).toContain('does not select High effort');
  });
});
