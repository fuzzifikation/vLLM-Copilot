import { describe, it, expect } from 'vitest';
import { buildConfigurationSchema } from '../src/modelInfo.js';

describe('buildConfigurationSchema', () => {
  it('returns user-defined model modes when modelModes is set', () => {
    const schema = buildConfigurationSchema({
      modelModes: {
        Think: { chat_template_kwargs: { enable_thinking: true } },
        'No Think': { chat_template_kwargs: { enable_thinking: false } },
      },
    });

    expect(schema).toBeDefined();
    const prop = schema!.properties.reasoningEffort as any;
    expect(prop.enum).toEqual(['Think', 'No Think']);
    expect(prop.default).toBe('Think');
  });

  it('returns undefined by default (no modelModes)', () => {
    expect(buildConfigurationSchema(undefined)).toBeUndefined();
    expect(buildConfigurationSchema({})).toBeUndefined();
  });

  it('returns undefined when modelModes is empty', () => {
    expect(buildConfigurationSchema({ modelModes: {} })).toBeUndefined();
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

      const schema = buildConfigurationSchema(modelOverride);

      expect(schema).toBeDefined();
      const prop = schema!.properties.reasoningEffort as any;
      expect(prop.enum).toEqual(['Think general', 'Think coding', 'No Think instruct']);
      expect(prop.default).toBe('Think general');
    });

    it('no modelModes means no schema (no generic fallback)', () => {
      const modelOverride = {
        id: 'some-model',
        capabilities: { toolCalling: true },
      };

      const schema = buildConfigurationSchema(modelOverride);
      expect(schema).toBeUndefined();
    });

    it('missing capabilities means no schema', () => {
      const modelOverride = {
        id: 'some-model',
        maxInputTokens: 8192,
      };

      const schema = buildConfigurationSchema(modelOverride);
      expect(schema).toBeUndefined();
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
      });

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
      });

      const prop = schema!.properties.reasoningEffort as any;
      expect(prop.default).toBe('No Think');
    });

    it('falls back to first mode when defaultMode is omitted', () => {
      const schema = buildConfigurationSchema({
        modelModes: {
          'No Think': { chat_template_kwargs: { enable_thinking: false } },
          Think: { chat_template_kwargs: { enable_thinking: true } },
        },
      });

      const prop = schema!.properties.reasoningEffort as any;
      expect(prop.default).toBe('No Think');
    });
  });
});
