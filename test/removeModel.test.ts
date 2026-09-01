import { describe, it, expect } from 'vitest';
import { removeModelFromConfig } from '../src/commands.js';
import type { ModelConfig } from '../src/config.js';

describe('removeModelFromConfig', () => {
  const models: ModelConfig[] = [
    { id: 'a', vllmModelId: 'model-a', server: 'host', displayName: 'A' },
    { id: 'b', vllmModelId: 'model-b', server: 'host', displayName: 'B' },
    { id: 'a-other', vllmModelId: 'model-a', server: 'other', displayName: 'A2' },
  ];

  it('removes only the selected model (by server + config id), keeping siblings on the same server', () => {
    const { filtered, removed } = removeModelFromConfig(models, 'host', 'a');
    expect(removed).toBe(1);
    expect(filtered).toHaveLength(2);
    expect(filtered.find(m => m.id === 'a')).toBeUndefined();
    // Sibling model-b on the same server survives
    expect(filtered.find(m => m.server === 'host')?.vllmModelId).toBe('model-b');
    // Same vllmModelId on a different server is untouched
    expect(filtered.find(m => m.server === 'other')?.vllmModelId).toBe('model-a');
  });

  it('removes by extension id even when the vllmModelId differs', () => {
    const { filtered, removed } = removeModelFromConfig(
      [{ id: 'custom-id', vllmModelId: 'served-name', server: 'h' }],
      'h',
      'custom-id',
    );
    expect(removed).toBe(1);
    expect(filtered).toHaveLength(0);
  });

  it('P1: two presets sharing a vllmModelId on the same server are removed independently by id', () => {
    const twins: ModelConfig[] = [
      { id: 'qwen-think', vllmModelId: 'qwen-7b', server: 'host' },
      { id: 'qwen-instruct', vllmModelId: 'qwen-7b', server: 'host' },
    ];
    const { filtered, removed } = removeModelFromConfig(twins, 'host', 'qwen-think');
    expect(removed).toBe(1);
    expect(filtered.map(m => m.id)).toEqual(['qwen-instruct']);
  });

  it('does NOT remove by vllmModelId alone when the entry has a distinct id', () => {
    const { filtered, removed } = removeModelFromConfig(models, 'host', 'model-a');
    expect(removed).toBe(0);
    expect(filtered).toEqual(models);
  });

  it('falls back to id when vllmModelId is absent (legacy entries)', () => {
    const legacy: ModelConfig[] = [
      { id: 'plain-model', server: 'h' },
      { id: 'other', server: 'h' },
    ];
    const { filtered, removed } = removeModelFromConfig(legacy, 'h', 'plain-model');
    expect(removed).toBe(1);
    expect(filtered.map(m => m.id)).toEqual(['other']);
  });

  it('returns removed=0 and an unchanged list when there is no match', () => {
    const { filtered, removed } = removeModelFromConfig(models, 'host', 'nope');
    expect(removed).toBe(0);
    expect(filtered).toEqual(models);
  });

  it('does not remove a model referencing a different server', () => {
    const { filtered, removed } = removeModelFromConfig(models, 'host', 'a');
    const otherServer = filtered.filter(m => m.server === 'other');
    expect(removed).toBe(1);
    expect(otherServer).toHaveLength(1);
  });
});
