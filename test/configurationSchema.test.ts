import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { buildModelInfo } from '../src/vscode/copilot/modelInfo.js';
import { describeModel } from '../src/core/catalog/describe.js';
import { buildRequest } from '../src/vscode/copilot/requestBuilder.js';
import { readPickerSelection } from '../src/vscode/state/config.js';

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
    expect(prop.enum).toEqual(['Think', 'No Think']);
    expect(prop.default).toBe('Think');
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
      expect(prop.enum).toEqual(['Think general', 'Think coding', 'No Think instruct']);
      expect(prop.default).toBe('Think general');
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

  it('effort-token modes publish VS Code labels without any mapping', () => {
    const run = (extra: Record<string, unknown> = {}) => buildConfigurationSchema({
      id: 'deep/thinker',
      modelModes: {
        max: { reasoning_effort: 'max' },
        xhigh: { reasoning_effort: 'xhigh' },
        none: { reasoning_effort: 'none' },
        ...extra,
      },
      defaultMode: 'xhigh',
    }, CEIL)!.properties.reasoningEffort as any;

    const tokens = run();
    expect(tokens.enum).toEqual(['max', 'xhigh', 'none']);
    expect(tokens.enumItemLabels).toEqual(['Max', 'Extra High', 'None']);
    expect(tokens.enumDescriptions).toEqual([
      'Absolute maximum capability with no constraints',
      'Highest reasoning depth but slowest',
      'No reasoning applied',
    ]);
    expect(tokens.default).toBe('xhigh');

    // A behavior mode keeps its own name, and a half-filled hover list is
    // dropped rather than leaving that picker row with an empty tooltip.
    const mixed = run({ 'Think-Coding': { temperature: 0.6 } });
    expect(mixed.enum).toEqual(['max', 'xhigh', 'none', 'Think-Coding']);
    expect(mixed.enumItemLabels).toEqual(['Max', 'Extra High', 'None', 'Think-Coding']);
    expect(mixed.enumDescriptions).toBeUndefined();
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

describe('Copilot harness mode mapping', () => {
  it('uses current mode definitions when published metadata still contains legacy names', () => {
    const off = { chat_template_kwargs: { enable_thinking: false }, temperature: 0.7 };
    const legacy = { id: 'm', server: 'srv', modelModes: { 'No Think': off }, defaultMode: 'No Think' };
    const current = {
      ...legacy, modelModes: { 'No-Think': off }, defaultMode: 'No-Think',
      copilotHarnessMapping: { none: 'No-Think' },
    };
    const published = buildModelInfo(describeModel({
      wireId: 'm', contextWindow: 65536, serverType: 'vllm', override: legacy,
    }));
    const output = vscode.window.createOutputChannel('stale mode metadata');
    try {
      const request = buildRequest(published, [], {
        modelOptions: {}, tools: [], modelConfiguration: { reasoningEffort: 'No Think' },
      }, {
        models: [current], servers: [{ id: 'srv', serverUrl: 'http://localhost:8000' }],
      }, output);
      expect(request.mergedOptions).toMatchObject(off);
    } finally {
      output.dispose();
    }
  });

  it('follows the whole rename chain so an old chat selection finds its mode', () => {
    const high = { reasoning_effort: 'high', temperature: 1 };
    const off = { chat_template_kwargs: { enable_thinking: false }, temperature: 0.7 };
    const override = {
      id: 'm', server: 'srv', modelModes: { high, none: off }, defaultMode: 'high',
    };
    const model = buildModelInfo(describeModel({
      wireId: 'm', contextWindow: 65536, serverType: 'vllm', override,
    }));
    const output = vscode.window.createOutputChannel('chained mode selection');
    try {
      // Two hops: 'Think (High)' -> 'Think-High' -> 'high', and
      // 'No Think' -> 'No-Think' -> 'none'. One hop would land on a name this
      // model no longer has and silently drop the user's choice.
      for (const [saved, expected] of [['Think (High)', high], ['No Think', off]] as const) {
        const request = buildRequest(model, [], {
          modelOptions: {}, tools: [], modelConfiguration: { reasoningEffort: saved },
        }, {
          models: [override], servers: [{ id: 'srv', serverUrl: 'http://localhost:8000' }],
        }, output);
        expect(request.mergedOptions, saved).toMatchObject(expected);
      }
    } finally {
      output.dispose();
    }
  });

  it('resolves saved legacy labels to slugs without confusing a collision with another mode', () => {
    const output = vscode.window.createOutputChannel('legacy mode selection');
    try {
      for (const collision of [false, true]) {
        const modelModes: Record<string, Record<string, unknown>> = {
          'Think-Coding': { temperature: 0.6 },
        };
        if (collision) modelModes['Think (Coding)'] = { temperature: 0.2 };
        const override = { id: 'm', server: 'srv', modelModes };
        const model = buildModelInfo(describeModel({
          wireId: 'm', contextWindow: 65536, serverType: 'vllm', override,
        }));
        const options = { modelOptions: {}, tools: [], modelConfiguration: { reasoningEffort: 'Think (Coding)' } };
        const request = buildRequest(model, [], options, {
          models: [override], servers: [{ id: 'srv', serverUrl: 'http://localhost:8000' }],
        }, output);
        expect(request.mergedOptions.temperature).toBe(collision ? 0.2 : 0.6);
      }
    } finally {
      output.dispose();
    }
  });

  it('keeps explicit aliases stable across reordering while preserving Local selections', () => {
    const deep = { reasoning_effort: 'high', temperature: 1, max_tokens: 8000 };
    const precise = { reasoning_effort: 'high', temperature: 0.2, max_tokens: 4000 };
    const original = {
      id: 'm', server: 'srv', maxOutputTokens: 8192, modelModes: { Deep: deep, Precise: precise },
      copilotHarnessMapping: { high: 'Deep' }, defaultMode: 'Deep',
    };
    const reordered = { ...original, modelModes: { Precise: precise, Deep: deep } };
    const output = vscode.window.createOutputChannel('harness mapping test');
    try {
      for (const override of [original, reordered]) {
        const model = buildModelInfo(describeModel({
          wireId: 'm', contextWindow: 65536, serverType: 'vllm', override,
        }));
        const schema = buildConfigurationSchema(override)!.properties.reasoningEffort;
        expect(schema.enum[schema.enumItemLabels.indexOf('Deep')]).toBe('high');
        expect(schema.enum[schema.enumItemLabels.indexOf('Precise')]).toBe('Precise');
        expect(schema.default).toBe('high');

        for (const [selection, expected] of [['high', deep], ['Deep', deep], ['Precise', precise]] as const) {
          const options = { modelOptions: {}, tools: [], modelConfiguration: { reasoningEffort: selection } };
          expect(readPickerSelection(options, model, override).selectedMode).toBe(selection === 'high' ? 'Deep' : selection);
          const request = buildRequest(model, [], options, {
            models: [override], servers: [{ id: 'srv', serverUrl: 'http://localhost:8000' }],
          }, output);
          expect(request.mergedOptions).toMatchObject(expected);
          expect(request.mergedOptions).not.toHaveProperty('copilotHarnessMapping');
        }
      }
    } finally {
      output.dispose();
    }
  });

  it('decodes an effort-token selection as the mode name, not the picker label', () => {
    // "xhigh" is the identifier the harness round-trips; VS Code renders it as
    // "Extra High" in enumItemLabels. A reader that decodes through those labels
    // hands the request a name no mode owns, and the mode's parameters vanish
    // with nothing but a warning line in Output.
    const override = {
      id: 'm', server: 'srv', maxOutputTokens: 8192, defaultMode: 'xhigh',
      modelModes: {
        xhigh: { reasoning_effort: 'xhigh', temperature: 1 },
        'Think-Coding': { temperature: 0.6 },
      },
    };
    const model = buildModelInfo(describeModel({
      wireId: 'm', contextWindow: 65536, serverType: 'vllm', override: override as any,
    }));
    expect(buildConfigurationSchema(override)!.properties.reasoningEffort.enumItemLabels)
      .toEqual(['Extra High', 'Think-Coding']);

    for (const selection of ['xhigh', 'Think-Coding']) {
      const options = { modelOptions: {}, tools: [], modelConfiguration: { reasoningEffort: selection } };
      expect(readPickerSelection(options, model, override).selectedMode).toBe(selection);
      // Same answer with no entry at hand: the schema enum is the identifier
      // space, so it must never be read as if it were the label space.
      expect(readPickerSelection(options, model).selectedMode).toBe(selection);
    }
  });

  it.each([
    { mapping: null },
    { mapping: [] },
    { mapping: { extreme: 'Deep' } },
    { mapping: { high: 'Missing' } },
    { mapping: { high: 1 } },
    { mapping: { high: 'Deep', max: 'Deep' } },
    { mapping: { low: 'Precise' } },
    { mapping: { high: 'Deep' }, collision: true },
  ])('surfaces an unusable mapping without removing Local modes: %j', testCase => {
    const modes: Record<string, Record<string, unknown>> = { Deep: {}, Precise: {} };
    if ('collision' in testCase) modes.high = {};
    const override = {
      id: 'm', server: 'srv', modelModes: modes,
      defaultMode: 'Deep', copilotHarnessMapping: testCase.mapping,
    };
    const schema = buildConfigurationSchema(override)!;
    expect(schema.properties.reasoningEffort.enum).toEqual(Object.keys(modes));
    const info = buildModelInfo(describeModel({
      wireId: 'm', contextWindow: 65536, serverType: 'vllm', override,
    })) as ReturnType<typeof buildModelInfo> & { warningText?: Record<string, string> };
    expect(info.warningText?.copilot_harness_mapping).toContain('copilotHarnessMapping');
  });
});
