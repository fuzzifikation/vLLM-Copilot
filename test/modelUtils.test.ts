import { describe, it, expect } from 'vitest';
import { extractFamily } from '../src/modelUtils.js';

describe('extractFamily', () => {
  it('extracts llama from meta-llama path', () => {
    expect(extractFamily('meta-llama/Llama-3-70B-Instruct')).toBe('llama');
  });

  it('extracts qwen for Qwen models', () => {
    expect(extractFamily('Qwen/Qwen2.5-72B-Instruct')).toBe('qwen');
  });

  it('extracts mistral', () => {
    expect(extractFamily('mistralai/Mistral-7B-Instruct-v0.2')).toBe('mistral');
  });

  it('extracts phi', () => {
    expect(extractFamily('microsoft/phi-4')).toBe('phi');
  });

  it('extracts gemma', () => {
    expect(extractFamily('google/gemma-2-27b-it')).toBe('gemma');
  });

  it('extracts deepseek', () => {
    expect(extractFamily('deepseek-ai/DeepSeek-R1')).toBe('deepseek');
  });

  it('extracts codellama (more specific than llama)', () => {
    expect(extractFamily('codellama/CodeLlama-34b-Instruct-hf')).toBe('codellama');
  });

  it('falls back to org name for unknown models', () => {
    expect(extractFamily('some-org/SomeNewModel-7B')).toBe('some-org');
  });
});
