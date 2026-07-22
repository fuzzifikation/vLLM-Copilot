import { describe, it, expect } from 'vitest';
import { extractFamily, extractFamilyWithSource } from '../src/modelUtils.js';

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

describe('extractFamilyWithSource', () => {
  it('reports fromFallback=false for known families', () => {
    expect(extractFamilyWithSource('meta-llama/Llama-3-70B-Instruct')).toEqual({
      family: 'llama',
      fromFallback: false,
    });
    expect(extractFamilyWithSource('Qwen/Qwen2.5-72B-Instruct')).toEqual({
      family: 'qwen',
      fromFallback: false,
    });
  });

  it('reports fromFallback=true for org-name fallback (GLM/ChatGLM not in list)', () => {
    // GLM — exactly the case the known-bugs doc flagged. Intentionally not in
    // KNOWN_FAMILIES; the authoritative family must come from a preset or HF.
    expect(extractFamilyWithSource('zai-org/GLM-5.2')).toEqual({
      family: 'zai-org',
      fromFallback: true,
    });
  });

  it('reports fromFallback=true for unknown org/model', () => {
    expect(extractFamilyWithSource('some-org/SomeNewModel-7B')).toEqual({
      family: 'some-org',
      fromFallback: true,
    });
  });

  it('falls back to full id lowercased when no org separator', () => {
    expect(extractFamilyWithSource('standalone-model')).toEqual({
      family: 'standalone-model',
      fromFallback: true,
    });
  });

  it('matches codellama before llama (longer family wins via iteration order)', () => {
    // codellama is checked first; the substring "llama" appears inside it but
    // the loop returns the codellama match, not llama.
    expect(extractFamilyWithSource('codellama/CodeLlama-34b')).toEqual({
      family: 'codellama',
      fromFallback: false,
    });
  });
});
