import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { reportTokenUsage } from '../src/vscode/state/usageReporting.js';
import type { WireUsage } from '../src/core/types.js';

// Drive the wire shape through its only real consumer: a fake Copilot progress
// sink. (The standalone part-builder was absorbed into reportTokenUsage.)
function report(usage: WireUsage): vscode.LanguageModelDataPart {
  const parts: vscode.LanguageModelDataPart[] = [];
  reportTokenUsage({ report: part => parts.push(part as vscode.LanguageModelDataPart) }, usage);
  expect(parts).toHaveLength(1);
  return parts[0];
}

describe('reportTokenUsage', () => {
  it('produces a LanguageModelDataPart with MIME type "usage"', () => {
    const part = report({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });

    expect(part).toBeInstanceOf(vscode.LanguageModelDataPart);
    expect((part as any).mimeType).toBe('usage');
  });

  it('uses snake_case keys (not camelCase)', () => {
    const part = report({
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
    const part = report({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });

    const payload = JSON.parse(new TextDecoder().decode(part.data));
    expect(payload.prompt_tokens_details).toEqual({ cached_tokens: 0 });
  });

  it('preserves zero values', () => {
    const part = report({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });

    const payload = JSON.parse(new TextDecoder().decode(part.data));
    expect(payload.prompt_tokens).toBe(0);
    expect(payload.completion_tokens).toBe(0);
    expect(payload.total_tokens).toBe(0);
  });

  // The agent-host BYOK bridge reads completion_tokens_details.reasoning_tokens
  // for reasoning-token accounting. Drop the key and the Sessions view goes
  // silently blind on every thinking model.
  it('forwards reasoning_tokens when the server reports them', () => {
    const part = report({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      completion_tokens_details: { reasoning_tokens: 42, accepted_prediction_tokens: 7 },
    });

    const payload = JSON.parse(new TextDecoder().decode(part.data));
    expect(payload.completion_tokens_details).toEqual({ reasoning_tokens: 42 });
  });

  it('omits completion_tokens_details when no reasoning_tokens reported', () => {
    const part = report({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      completion_tokens_details: { accepted_prediction_tokens: 7 },
    });

    const payload = JSON.parse(new TextDecoder().decode(part.data));
    expect(payload).not.toHaveProperty('completion_tokens_details');
  });
});
