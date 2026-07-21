import { describe, it, expect } from 'vitest';
import { computeCompositeIdMigration } from '../src/migration.js';
import type { ModelConfig } from '../src/config.js';

describe('computeCompositeIdMigration', () => {
  it('rewrites a bare-id model to the composite "<model> on <host>" form', () => {
    const input: ModelConfig[] = [{ id: 'zai-glm-52', serverUrl: 'https://host.example.com' }];
    const { models, changed } = computeCompositeIdMigration(input);
    expect(changed).toBe(true);
    expect(models[0].id).toBe('zai-glm-52 on host.example.com');
    expect(models[0].vllmModelId).toBe('zai-glm-52'); // wire identity preserved
  });

  it('preserves an existing vllmModelId as the wire identity', () => {
    const input: ModelConfig[] = [
      { id: 'my-custom-id', vllmModelId: 'Qwen/Qwen3-8B', serverUrl: 'http://host:8000' },
    ];
    const { models } = computeCompositeIdMigration(input);
    expect(models[0].id).toBe('Qwen/Qwen3-8B on host:8000');
    expect(models[0].vllmModelId).toBe('Qwen/Qwen3-8B');
  });

  it('keeps the port in the host', () => {
    const input: ModelConfig[] = [{ id: 'm', serverUrl: 'http://10.0.0.5:8000' }];
    const { models } = computeCompositeIdMigration(input);
    expect(models[0].id).toBe('m on 10.0.0.5:8000');
  });

  it('skips models without a serverUrl (unreachable — no host)', () => {
    const input: ModelConfig[] = [{ id: 'orphan' }];
    const { models, changed } = computeCompositeIdMigration(input);
    expect(changed).toBe(false);
    expect(models[0]).toEqual({ id: 'orphan' });
  });

  it('is idempotent: a model already in composite form is unchanged', () => {
    const input: ModelConfig[] = [
      { id: 'm on host:8000', vllmModelId: 'm', serverUrl: 'http://host:8000' },
    ];
    const { models, changed } = computeCompositeIdMigration(input);
    expect(changed).toBe(false);
    expect(models[0].id).toBe('m on host:8000');
  });

  it('gives the same model on two servers two distinct composite ids', () => {
    const input: ModelConfig[] = [
      { id: 'glm', serverUrl: 'http://a.example.com:8000' },
      { id: 'glm', serverUrl: 'http://b.example.com:8000' },
    ];
    const { models } = computeCompositeIdMigration(input);
    expect(models[0].id).toBe('glm on a.example.com:8000');
    expect(models[1].id).toBe('glm on b.example.com:8000');
    expect(models[0].id).not.toBe(models[1].id);
  });
});
