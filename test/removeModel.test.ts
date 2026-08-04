import { describe, it, expect } from 'vitest';
import { removeModelFromConfig } from '../src/commands.js';
import type { ModelConfig } from '../src/config.js';

describe('removeModelFromConfig', () => {
  const models: ModelConfig[] = [
    { id: 'a on host', vllmModelId: 'model-a', serverUrl: 'http://host:8000', displayName: 'A' },
    { id: 'b on host', vllmModelId: 'model-b', serverUrl: 'http://host:8000', displayName: 'B' },
    { id: 'a on other', vllmModelId: 'model-a', serverUrl: 'http://other:8000', displayName: 'A2' },
  ];

  it('removes only the selected model, keeping siblings on the same server', () => {
    const { filtered, removed } = removeModelFromConfig(models, 'http://host:8000', 'model-a');
    expect(removed).toBe(1);
    expect(filtered).toHaveLength(2);
    // The host:8000 model-a is gone
    expect(filtered.find(m => m.serverUrl === 'http://host:8000' && m.vllmModelId === 'model-a')).toBeUndefined();
    // Sibling model-b on host:8000 survives
    expect(filtered.find(m => m.serverUrl === 'http://host:8000')?.vllmModelId).toBe('model-b');
    // Same vllmModelId on a different server is untouched
    expect(filtered.find(m => m.serverUrl === 'http://other:8000')?.vllmModelId).toBe('model-a');
  });

  it('removes by vllmModelId even when the extension id differs', () => {
    const { filtered, removed } = removeModelFromConfig(
      [{ id: 'custom-id', vllmModelId: 'served-name', serverUrl: 'http://h:8000' }],
      'http://h:8000',
      'served-name',
    );
    expect(removed).toBe(1);
    expect(filtered).toHaveLength(0);
  });

  it('falls back to id when vllmModelId is absent', () => {
    const legacy: ModelConfig[] = [
      { id: 'plain-model', serverUrl: 'http://h:8000' },
      { id: 'other', serverUrl: 'http://h:8000' },
    ];
    const { filtered, removed } = removeModelFromConfig(legacy, 'http://h:8000', 'plain-model');
    expect(removed).toBe(1);
    expect(filtered.map(m => m.id)).toEqual(['other']);
  });

  it('normalises URL differences (trailing slash)', () => {
    const { filtered, removed } = removeModelFromConfig(models, 'http://host:8000/', 'model-b');
    expect(removed).toBe(1);
    expect(filtered.map(m => m.vllmModelId)).not.toContain('model-b');
  });

  it('returns removed=0 and an unchanged list when there is no match', () => {
    const { filtered, removed } = removeModelFromConfig(models, 'http://host:8000', 'model-nope');
    expect(removed).toBe(0);
    expect(filtered).toEqual(models);
  });

  it('does not remove a model on a different server', () => {
    const { filtered, removed } = removeModelFromConfig(models, 'http://host:8000', 'model-a');
    const otherServer = filtered.filter(m => m.serverUrl === 'http://other:8000');
    expect(removed).toBe(1);
    expect(otherServer).toHaveLength(1);
  });
});
