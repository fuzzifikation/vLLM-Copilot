import { describe, it, expect } from 'vitest';
import { buildModelInfo } from '../src/modelInfo.js';

describe('buildModelInfo picker id derivation', () => {
  it('uses an explicit id as the picker id', () => {
    const info = buildModelInfo(
      { id: 'Qwen/Qwen3-8B', max_model_len: 32768 },
      { id: 'my-preset', vllmModelId: 'Qwen/Qwen3-8B', serverUrl: 'http://h:8000' },
      { maxOutputTokens: 4096 },
      'http://h:8000',
    );
    expect(info.id).toBe('my-preset');
  });

  it('derives a unique composite id when id is absent', () => {
    const info = buildModelInfo(
      { id: 'Qwen/Qwen3-8B', max_model_len: 32768 },
      { vllmModelId: 'Qwen/Qwen3-8B', serverUrl: 'http://h:8000' },
      { maxOutputTokens: 4096 },
      'http://h:8000',
    );
    expect(info.id).toBe('Qwen/Qwen3-8B on h:8000');
  });

  it('derives distinct ids for the same vllmModelId on two servers', () => {
    const a = buildModelInfo(
      { id: 'X', max_model_len: 1000 },
      { vllmModelId: 'X', serverUrl: 'http://a:8000' },
      { maxOutputTokens: 512 },
      'http://a:8000',
    );
    const b = buildModelInfo(
      { id: 'X', max_model_len: 1000 },
      { vllmModelId: 'X', serverUrl: 'http://b:9000' },
      { maxOutputTokens: 512 },
      'http://b:9000',
    );
    expect(a.id).toBe('X on a:8000');
    expect(b.id).toBe('X on b:9000');
    expect(a.id).not.toBe(b.id);
  });

  it('falls back to the composite id for the display name when no displayName', () => {
    const info = buildModelInfo(
      { id: 'X', max_model_len: 1000 },
      { vllmModelId: 'X', serverUrl: 'http://a:8000' },
      { maxOutputTokens: 512 },
      'http://a:8000',
    );
    expect(info.name).toBe('X on a:8000');
  });

  it('keeps displayName as the picker label when set', () => {
    const info = buildModelInfo(
      { id: 'X', max_model_len: 1000 },
      { vllmModelId: 'X', displayName: 'My Model', serverUrl: 'http://a:8000' },
      { maxOutputTokens: 512 },
      'http://a:8000',
    );
    expect(info.name).toBe('My Model');
    expect(info.id).toBe('X on a:8000');
  });

  it.each(['vllm', 'lmstudio', 'llamacpp', 'ollama', 'openrouter'] as const)('uses the vLLM icon for %s models', (serverType) => {
    const info = buildModelInfo(
      { id: 'X', max_model_len: 1000 },
      { vllmModelId: 'X', serverUrl: 'http://a:8000', serverType },
      { maxOutputTokens: 512 },
      'http://a:8000',
    );
    expect((info as unknown as { statusIcon?: { id: string } }).statusIcon?.id).toBe('vllm-copilot-model');
  });

});
