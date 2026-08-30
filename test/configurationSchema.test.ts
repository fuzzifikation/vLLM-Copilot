import { describe, it, expect } from 'vitest';
import {
  buildConfigurationSchema,
  resolveOutputLengthOptions,
  formatTokenLabel,
} from '../src/modelInfo.js';

// A generous ceiling so mode-only fixtures are never filtered — the length
// dropdown is emitted ONLY when a vector is declared, so these stay clean.
const CEIL = 65536;

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

  it('returns undefined by default (no modelModes, no length vector)', () => {
    expect(buildConfigurationSchema(undefined, CEIL)).toBeUndefined();
    expect(buildConfigurationSchema({}, CEIL)).toBeUndefined();
  });

  it('returns undefined when modelModes is empty', () => {
    expect(buildConfigurationSchema({ modelModes: {} }, CEIL)).toBeUndefined();
  });

  describe('full config flow (regression: v0.7.2)', () => {
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

    it('no modelModes and no length vector means no schema (no generic fallback)', () => {
      const modelOverride = {
        id: 'some-model',
        capabilities: { toolCalling: true },
      } as any;

      const schema = buildConfigurationSchema(modelOverride, CEIL);
      expect(schema).toBeUndefined();
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

  describe('defaultMode', () => {
    it('uses explicit defaultMode when present and valid', () => {
      const schema = buildConfigurationSchema({
        modelModes: {
          'No Think': { chat_template_kwargs: { enable_thinking: false } },
          Think: { chat_template_kwargs: { enable_thinking: true } },
        },
        defaultMode: 'Think',
      }, CEIL);

      const prop = schema!.properties.reasoningEffort as any;
      expect(prop.enum).toEqual(['No Think', 'Think']);
      expect(prop.default).toBe('Think');
    });

    it('falls back to first mode when defaultMode is invalid', () => {
      const schema = buildConfigurationSchema({
        modelModes: {
          'No Think': { chat_template_kwargs: { enable_thinking: false } },
          Think: { chat_template_kwargs: { enable_thinking: true } },
        },
        defaultMode: 'Invalid',
      }, CEIL);

      const prop = schema!.properties.reasoningEffort as any;
      expect(prop.default).toBe('No Think');
    });

    it('falls back to first mode when defaultMode is omitted', () => {
      const schema = buildConfigurationSchema({
        modelModes: {
          'No Think': { chat_template_kwargs: { enable_thinking: false } },
          Think: { chat_template_kwargs: { enable_thinking: true } },
        },
      }, CEIL);

      const prop = schema!.properties.reasoningEffort as any;
      expect(prop.default).toBe('No Think');
    });
  });
});

describe('formatTokenLabel', () => {
  it('renders exact K multiples without a decimal', () => {
    expect(formatTokenLabel(1024)).toBe('1K');
    expect(formatTokenLabel(16384)).toBe('16K');
    expect(formatTokenLabel(65536)).toBe('64K');
  });

  it('renders fractional K with one decimal', () => {
    expect(formatTokenLabel(1536)).toBe('1.5K');
    expect(formatTokenLabel(24576)).toBe('24K'); // exact multiple, no decimal
  });

  it('renders sub-1024 counts verbatim', () => {
    expect(formatTokenLabel(512)).toBe('512');
    expect(formatTokenLabel(1)).toBe('1');
  });
});

describe('resolveOutputLengthOptions', () => {
  it('returns undefined without an explicit vector (no derived ladder)', () => {
    expect(resolveOutputLengthOptions(undefined, CEIL)).toBeUndefined();
    expect(resolveOutputLengthOptions([], CEIL)).toBeUndefined();
  });

  it('passes through a clean descending vector with formatted labels', () => {
    const r = resolveOutputLengthOptions([65536, 32768, 16384], CEIL);
    expect(r).toEqual({
      values: [65536, 32768, 16384],
      labels: ['64K', '32K', '16K'],
    });
  });

  it('drops entries above the ceiling, promoting the next survivor to default', () => {
    // Head (131072) exceeds a 65536 ceiling → dropped, 65536 becomes default.
    const r = resolveOutputLengthOptions([131072, 65536, 32768], 65536);
    expect(r!.values).toEqual([65536, 32768]);
    expect(r!.values[0]).toBe(65536);
  });

  it('drops non-integer and non-positive entries', () => {
    const r = resolveOutputLengthOptions([8192, 4096.5, 0, -5, 2048], CEIL);
    expect(r!.values).toEqual([8192, 2048]);
  });

  it('dedupes repeated values preserving order', () => {
    const r = resolveOutputLengthOptions([32768, 32768, 16384], CEIL);
    expect(r!.values).toEqual([32768, 16384]);
  });

  it('returns undefined when fewer than two options survive', () => {
    expect(resolveOutputLengthOptions([65536], CEIL)).toBeUndefined();
    expect(resolveOutputLengthOptions([131072, 262144], 65536)).toBeUndefined();
  });

  it('caps the menu at 8 entries', () => {
    const nine = [9, 8, 7, 6, 5, 4, 3, 2, 1].map(n => n * 1024);
    const r = resolveOutputLengthOptions(nine, 100 * 1024);
    expect(r!.values).toHaveLength(8);
    expect(r!.labels).toHaveLength(8);
  });

  it('returns undefined for a non-finite ceiling', () => {
    expect(resolveOutputLengthOptions([8192, 4096], Number.NaN)).toBeUndefined();
  });
});
