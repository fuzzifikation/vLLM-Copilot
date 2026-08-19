import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { buildRequest } from '../src/provider/requestBuilder.js';

/**
 * Direct tests for the extracted request builder (`requestBuilder.ts`).
 * The auto-continue tests run this through the real provider path; these pin
 * the request-assembly contract itself (message conversion, param layering,
 * tools, identity/server resolution).
 */

const output = { appendLine: vi.fn() } as any;
const model = { id: 'm', maxOutputTokens: 100, maxInputTokens: 200 } as any;
const opts = (partial: any = {}) => ({ modelOptions: {}, tools: [], ...partial } as any);

describe('buildRequest', () => {
  it('converts VS Code messages to OpenAI format and resolves defaults', () => {
    const result = buildRequest(
      model,
      [
        { role: vscode.LanguageModelChatMessageRole.System, content: [new vscode.LanguageModelTextPart('sys')] },
        { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hi')] },
      ] as any,
      opts(),
      { models: [], enableFileLogging: false },
      output,
    );

    expect(result.openaiMessages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    // No override: wire id falls back to model id; serverUrl is empty (the
    // client layer normalizes '' to localhost, not the request builder).
    expect(result.vllmModelId).toBe('m');
    expect(result.serverConfig.serverUrl).toBe('');
    // Output budget re-asserted from the model's context-window-derived max.
    expect(result.mergedOptions.max_tokens).toBe(100);
    // Transport defaults apply when the override does not set them.
    expect(result.serverConfig.initialResponseTimeoutMs).toBe(600000);
  });

  it('resolves vllmModelId, serverConfig and transport from the override', () => {
    const result = buildRequest(
      model,
      [] as any,
      opts(),
      {
        models: [{
          id: 'm', vllmModelId: 'wire-model', serverUrl: 'http://host:8000',
          maxOutputTokens: 50, streamInactivityTimeout: 99, initialResponseTimeoutMs: 42,
        }],
        enableFileLogging: false,
      },
      output,
    );

    expect(result.vllmModelId).toBe('wire-model');
    expect(result.serverConfig.serverUrl).toBe('http://host:8000');
    expect(result.serverConfig.streamInactivityTimeout).toBe(99);
    expect(result.serverConfig.initialResponseTimeoutMs).toBe(42);
    // max_tokens always wins over a stray value in the override.
    expect(result.mergedOptions.max_tokens).toBe(100);
  });

  it('keeps the output budget authoritative over a Copilot max_tokens modelOption', () => {
    // Copilot's chat UI may send max_tokens in modelOptions; the output budget
    // is owned by maxOutputTokens and re-asserted after layering, so the UI
    // value never reaches the wire. Other modelOptions still flow through.
    const result = buildRequest(
      model,
      [] as any,
      opts({ modelOptions: { max_tokens: 999, temperature: 0.5 } }),
      { models: [], enableFileLogging: false },
      output,
    );
    expect(result.mergedOptions.max_tokens).toBe(100);
    expect(result.mergedOptions.temperature).toBe(0.5);
  });

  it('layers defaultParams then the selected model mode (highest wins)', () => {
    const result = buildRequest(
      model,
      [] as any,
      opts({ modelConfiguration: { reasoningEffort: 'deep' } }),
      {
        models: [{
          id: 'm', serverUrl: 'http://host:8000',
          defaultParams: { temperature: 0.5, top_p: 0.9 },
          modelModes: { deep: { temperature: 0.1 } },
        }],
        enableFileLogging: false,
      },
      output,
    );

    expect(result.mergedOptions.temperature).toBe(0.1); // mode wins over defaultParams
    expect(result.mergedOptions.top_p).toBe(0.9);       // defaultParams fills the rest
    expect(result.mergedOptions.max_tokens).toBe(100);
  });

  it('builds tools and enforces tool_choice required when Copilot requires a tool', () => {
    const result = buildRequest(
      model,
      [] as any,
      opts({
        tools: [{ name: 'f', description: 'does f', inputSchema: { type: 'object' } }],
        toolMode: vscode.LanguageModelChatToolMode.Required,
      }),
      { models: [], enableFileLogging: false },
      output,
    );

    expect(result.mergedOptions.tools).toEqual([{
      type: 'function',
      function: { name: 'f', description: 'does f', parameters: { type: 'object' } },
    }]);
    expect(result.mergedOptions.tool_choice).toBe('required');
  });

  it('omits tools and tool_choice when none are provided', () => {
    const result = buildRequest(model, [] as any, opts(), { models: [], enableFileLogging: false }, output);
    expect(result.mergedOptions.tools).toBeUndefined();
    expect(result.mergedOptions.tool_choice).toBeUndefined();
  });
});
