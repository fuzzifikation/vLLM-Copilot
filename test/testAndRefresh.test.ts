import { describe, it, expect } from 'vitest';
import { selectMismatchesToPrompt } from '../src/commands.js';
import type { TestResult } from '../src/commands.js';
import type { ModelConfig } from '../src/config.js';

function ok(label: string): TestResult {
  return { label: `✓ ${label}`, description: '', detail: '' };
}

function missing(label: string, serverUrl: string): TestResult {
  return {
    label: `✗ ${label}`,
    description: 'not found on server',
    detail: `${serverUrl} — check vllmModelId`,
    mismatch: {
      model: { id: label, serverUrl } as ModelConfig,
      serverModels: [],
      serverUrl,
      vllmModelId: label,
    },
  };
}

function models(urls: string[]): ModelConfig[] {
  return urls.map(u => ({ id: `m-${u}`, serverUrl: u }) as ModelConfig);
}

describe('selectMismatchesToPrompt', () => {
  it('skips mismatches on a healthy server (parked-model case)', () => {
    // Laguna loaded; Qwen on the same server not loaded → Qwen stays parked.
    const m = models(['http://s:8000', 'http://s:8000']);
    const results = [ok('Laguna'), missing('Qwen', 'http://s:8000')];
    expect(selectMismatchesToPrompt(m, results)).toEqual([]);
  });

  it('prompts when no sibling on that server is OK', () => {
    const m = models(['http://s:8000']);
    const results = [missing('Laguna', 'http://s:8000')];
    expect(selectMismatchesToPrompt(m, results)).toHaveLength(1);
  });

  it('prompts only for missing models on unhealthy servers', () => {
    // A healthy (skip Qwen); B unhealthy (prompt both).
    const m = models([
      'http://a:8000', 'http://a:8000',
      'http://b:8000', 'http://b:8000',
    ]);
    const results = [
      ok('Laguna'),
      missing('Qwen', 'http://a:8000'),
      missing('Qwen2', 'http://b:8000'),
      missing('DeepSeek', 'http://b:8000'),
    ];
    const promptable = selectMismatchesToPrompt(m, results);
    expect(promptable).toEqual([results[2], results[3]]);
  });

  it('normalizes URL so trailing slash diffs do not defeat grouping', () => {
    const m: ModelConfig[] = [
      { id: 'a', serverUrl: 'http://s:8000' } as ModelConfig,
      { id: 'b', serverUrl: 'http://s:8000/' } as ModelConfig,
    ];
    const results = [ok('a'), missing('b', 'http://s:8000/')];
    expect(selectMismatchesToPrompt(m, results)).toEqual([]);
  });

  it('does not count a "no serverUrl" failure toward server health', () => {
    const m: ModelConfig[] = [
      { id: 'no-server' } as ModelConfig,
      { id: 'qwen', serverUrl: 'http://s:8000' } as ModelConfig,
    ];
    const results: TestResult[] = [
      { label: '✗ no-server', description: 'no serverUrl', detail: '' },
      missing('qwen', 'http://s:8000'),
    ];
    expect(selectMismatchesToPrompt(m, results)).toHaveLength(1);
  });
});
