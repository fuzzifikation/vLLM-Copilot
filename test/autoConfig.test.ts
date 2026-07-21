import { describe, it, expect } from 'vitest';
import { mergePresetWithUserConfig, findPresetForModel, stripJsonComments, parseHeadersInput, parsePresetJson } from '../src/autoConfig.js';
import type { ModelConfig } from '../src/config.js';

describe('parsePresetJson', () => {
  it('parses clean JSON with comments', () => {
    const cfg = parsePresetJson('// a preset\n{ "id": "m", "maxOutputTokens": 4096 }');
    expect(cfg).toEqual({ id: 'm', maxOutputTokens: 4096 });
  });

  it('repairs a trailing comma', () => {
    const cfg = parsePresetJson('{ "id": "m", "maxOutputTokens": 4096, }');
    expect(cfg?.id).toBe('m');
  });

  it('repairs single quotes and missing commas', () => {
    const cfg = parsePresetJson("{ 'id': 'm'\n 'displayName': 'M' }");
    expect(cfg?.id).toBe('m');
    expect(cfg?.displayName).toBe('M');
  });

  it('returns null for unrepairable garbage', () => {
    expect(parsePresetJson('not json at all @@@')).toBeNull();
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
  const presetConfig: ModelConfig = {
    id: 'test/model',
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
    const userConfig: ModelConfig = { id: 'test/model' };
    const merged = mergePresetWithUserConfig(presetConfig, userConfig);

    expect(merged.id).toBe('test/model');
    expect(merged.displayName).toBe('Test Model');
    expect(merged.maxOutputTokens).toBe(32768);
    expect(merged.modelModes).toEqual(presetConfig.modelModes);
  });

  it('preset replaces all user modelModes (no preservation of old modes)', () => {
    const userConfig: ModelConfig = {
      id: 'test/model',
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
    const presetWithoutModes: ModelConfig = {
      id: 'test/model',
      maxOutputTokens: 1000,
    };
    const userConfig: ModelConfig = {
      id: 'test/model',
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
    const emptyPreset: ModelConfig = { id: 'test/model' };
    const emptyUser: ModelConfig = { id: 'test/model' };
    const merged = mergePresetWithUserConfig(emptyPreset, emptyUser);

    expect(merged.modelModes).toBeUndefined();
  });

  it('preserves the user id/vllmModelId instead of the preset\'s', () => {
    const preset: ModelConfig = {
      id: 'zai-org/GLM-5.2',
      vllmModelId: 'zai-org/GLM-5.2',
      displayName: 'GLM-5.2',
      maxOutputTokens: 32768,
    };
    // The user configured the model under a short server alias.
    const userConfig: ModelConfig = { id: 'zai-glm-52', vllmModelId: 'zai-glm-52' };
    const merged = mergePresetWithUserConfig(preset, userConfig);

    // Identity stays the user's; preset only contributes the other fields.
    expect(merged.id).toBe('zai-glm-52');
    expect(merged.vllmModelId).toBe('zai-glm-52');
    expect(merged.displayName).toBe('GLM-5.2');
    expect(merged.maxOutputTokens).toBe(32768);
  });

  it('drops vllmModelId when the user config has none', () => {
    const preset: ModelConfig = { id: 'repo/Model', vllmModelId: 'repo/Model', maxOutputTokens: 100 };
    const userConfig: ModelConfig = { id: 'my-model' }; // no vllmModelId
    const merged = mergePresetWithUserConfig(preset, userConfig);

    expect(merged.id).toBe('my-model');
    expect(merged.vllmModelId).toBeUndefined();
  });
});

describe('findPresetForModel', () => {
  const preset = {
    config: { id: 'zai-org/GLM-5.2', vllmModelId: 'zai-org/GLM-5.2' } as ModelConfig,
    sourceFile: 'glm-5.2-config.json',
  };
  const presets = [preset];

  it('matches on exact model id', () => {
    expect(findPresetForModel(presets, 'zai-org/GLM-5.2')).toBe(preset);
  });

  it('does not match a different id without a root', () => {
    expect(findPresetForModel(presets, 'zai-glm-52')).toBeUndefined();
  });

  it('matches an alias via its server root', () => {
    // The user configured the short alias; the server reports its real checkpoint as root.
    expect(findPresetForModel(presets, 'zai-glm-52', 'zai-org/GLM-5.2')).toBe(preset);
  });

  it('returns undefined when neither id nor root matches', () => {
    expect(findPresetForModel(presets, 'other-model', 'other-root')).toBeUndefined();
  });
});

describe('stripJsonComments', () => {
  it('strips full-line comments above the JSON object', () => {
    const input = `// Model config\n// Source: docs\n{\n  "id": "test/model"\n}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ id: 'test/model' });
  });

  it('strips inline comments after a value', () => {
    const input = `{\n  "id": "test/model", // the model id\n  "maxOutputTokens": 100\n}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ id: 'test/model', maxOutputTokens: 100 });
  });

  it('does NOT strip // inside string values (e.g. URLs)', () => {
    const input = `{\n  "url": "https://huggingface.co/model"\n}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ url: 'https://huggingface.co/model' });
  });

  it('strips a comment that follows a string value containing //', () => {
    const input = `{\n  "url": "https://example.com", // trailing comment\n  "id": "x"\n}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ url: 'https://example.com', id: 'x' });
  });

  it('handles escaped quotes inside string values', () => {
    const input = `{\n  "text": "a \\"quoted // slash\\" value"\n}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ text: 'a "quoted // slash" value' });
  });

  it('handles escaped backslash immediately before a quote', () => {
    // "path": "C:\\" — the string ends after the escaped backslash; the // is a real comment
    const input = `{\n  "path": "C:\\\\", // windows path\n  "id": "x"\n}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ path: 'C:\\', id: 'x' });
  });

  it('leaves comment-free JSON unchanged', () => {
    const input = `{\n  "id": "test/model",\n  "maxOutputTokens": 100\n}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ id: 'test/model', maxOutputTokens: 100 });
  });

  it('preserves a single slash that is not part of a comment', () => {
    const input = `{\n  "ratio": "1/2"\n}`;
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ ratio: '1/2' });
  });
});
