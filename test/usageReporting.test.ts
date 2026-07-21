import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { createUsageDataPart } from '../src/usageReporting.js';

describe('createUsageDataPart', () => {
  it('produces a LanguageModelDataPart with MIME type "usage"', () => {
    const part = createUsageDataPart({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });

    expect(part).toBeInstanceOf(vscode.LanguageModelDataPart);
    expect((part as any).mimeType).toBe('usage');
  });

  it('uses snake_case keys (not camelCase)', () => {
    const part = createUsageDataPart({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });

    const payload = JSON.parse(new TextDecoder().decode(part.data));
    expect(payload).toHaveProperty('prompt_tokens', 100);
    expect(payload).toHaveProperty('completion_tokens', 50);
    expect(payload).toHaveProperty('total_tokens', 150);
    // Must NOT have camelCase keys
    expect(payload).not.toHaveProperty('promptTokens');
    expect(payload).not.toHaveProperty('completionTokens');
    expect(payload).not.toHaveProperty('totalTokens');
  });

  it('includes prompt_tokens_details with cached_tokens', () => {
    const part = createUsageDataPart({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });

    const payload = JSON.parse(new TextDecoder().decode(part.data));
    expect(payload.prompt_tokens_details).toEqual({ cached_tokens: 0 });
  });

  it('preserves zero values', () => {
    const part = createUsageDataPart({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });

    const payload = JSON.parse(new TextDecoder().decode(part.data));
    expect(payload.prompt_tokens).toBe(0);
    expect(payload.completion_tokens).toBe(0);
    expect(payload.total_tokens).toBe(0);
  });
});
