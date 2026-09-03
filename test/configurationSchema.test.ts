import { describe, it, expect } from 'vitest';
import { buildModelInfo } from '../src/modelInfo.js';

// A generous ceiling so mode-only fixtures are never filtered — the length
// dropdown is emitted ONLY when a vector is declared, so these stay clean.
const CEIL = 65536;

/**
 * `buildConfigurationSchema` and `resolveOutputLengthOptions` are
 * module-private (U9 demotion): the schema is exercised through its only
 * production caller. The ceiling rides in as `outputMenuCeiling` — the same
 * pre-pick ceiling discovery passes — and the context window is huge so the
 * budget derivation never interferes with the menu under test.
 */
function buildConfigurationSchema(
  override: Record<string, unknown>,
  ceiling: number = CEIL,
): { properties: Record<string, any> } | undefined {
  const id = String(override.id ?? 'test/model');
  const info = buildModelInfo(
    { id, max_model_len: 1_000_000 },
    { id, vllmModelId: id, server: 'srv', ...override } as any,
    { maxOutputTokens: 4096 },
    'vllm',
    undefined,
    undefined,
    undefined,
    ceiling,
  ) as { configurationSchema?: { properties: Record<string, any> } };
  return info.configurationSchema;
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
  });

describe('output-length menu (resolveOutputLengthOptions, via the schema)', () => {
  // Menu shape is read off the rendered property: enum = values,
  // enumItemLabels = labels, default = first surviving value.
  const menu = (maxOutputTokens: unknown, ceiling?: number) =>
    buildConfigurationSchema({ id: 'some/model', maxOutputTokens }, ceiling)
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
    // Head (131072) exceeds a 65536 ceiling → dropped, 65536 becomes default.
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
    const r = menu(nine, 100 * 1024);
    expect(r!.enum).toHaveLength(8);
    expect(r!.enumItemLabels).toHaveLength(8);
  });

  it('returns undefined for a non-finite ceiling', () => {
    expect(menu([8192, 4096], Number.NaN)).toBeUndefined();
  });
});
