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

  it('honors the selected mode max_tokens within the advertised budget', () => {
    // Coherent state: metadata re-registered to the mode's budget (advertised 250).
    const advModel = (mo: number, mi: number) => ({ id: 'm', maxOutputTokens: mo, maxInputTokens: mi }) as any;
    const result = buildRequest(
      advModel(250, 200), [] as any,
      opts({ modelConfiguration: { reasoningEffort: 'deep' } }),
      {
        models: [{
          id: 'm', serverUrl: 'http://host:8000',
          modelModes: { deep: { max_tokens: 250, temperature: 0.1 } },
        }],
        enableFileLogging: false,
      },
      output,
    );
    expect(result.mergedOptions.max_tokens).toBe(250);
    expect(result.mergedOptions.temperature).toBe(0.1);
  });

  it('clamps a mode max_tokens to the advertised budget (ceiling-safe, Option A)', () => {
    // Mode wants 99999 but Copilot was told 250 (re-registration not yet landed,
    // or a server ceiling). The wire must never exceed what was advertised.
    const advModel = (mo: number, mi: number) => ({ id: 'm', maxOutputTokens: mo, maxInputTokens: mi }) as any;
    const result = buildRequest(
      advModel(250, 200), [] as any,
      opts({ modelConfiguration: { reasoningEffort: 'deep' } }),
      {
        models: [{
          id: 'm', serverUrl: 'http://host:8000',
          modelModes: { deep: { max_tokens: 99999 } },
        }],
        enableFileLogging: false,
      },
      output,
    );
    expect(result.mergedOptions.max_tokens).toBe(250);
  });

  it('honors a smaller configured max_tokens immediately (down-switch instant)', () => {
    // Down-switch: configured 200 < advertised 250 → honored right away, no lag.
    const advModel = (mo: number, mi: number) => ({ id: 'm', maxOutputTokens: mo, maxInputTokens: mi }) as any;
    const result = buildRequest(
      advModel(250, 200), [] as any,
      opts({ modelConfiguration: { reasoningEffort: 'deep' } }),
      {
        models: [{
          id: 'm', serverUrl: 'http://host:8000',
          modelModes: { deep: { max_tokens: 200 } },
        }],
        enableFileLogging: false,
      },
      output,
    );
    expect(result.mergedOptions.max_tokens).toBe(200);
  });

  it('clamps to the context window as a defense when the advertised budget is incoherent', () => {
    // A 0 input allowance makes window = advertised, so window-1 must cap it.
    // Only reachable with an incoherent model object — deriveTokenBudget never
    // produces this — kept as defense-in-depth.
    const advModel = (mo: number, mi: number) => ({ id: 'm', maxOutputTokens: mo, maxInputTokens: mi }) as any;
    const result = buildRequest(
      advModel(100, 0), [] as any,
      opts({ modelConfiguration: { reasoningEffort: 'deep' } }),
      {
        models: [{
          id: 'm', serverUrl: 'http://host:8000',
          modelModes: { deep: { max_tokens: 99999 } },
        }],
        enableFileLogging: false,
      },
      output,
    );
    expect(result.mergedOptions.max_tokens).toBe(99);
  });

  it('ignores Copilot modelOptions.max_tokens even when a mode is selected', () => {
    const result = buildRequest(
      model,
      [] as any,
      opts({ modelConfiguration: { reasoningEffort: 'deep' }, modelOptions: { max_tokens: 999 } }),
      {
        models: [{
          id: 'm', serverUrl: 'http://host:8000',
          modelModes: { deep: { temperature: 0.1 } },
        }],
        enableFileLogging: false,
      },
      output,
    );
    // Mode has no max_tokens → model ceiling (100) wins, not Copilot's 999.
    expect(result.mergedOptions.max_tokens).toBe(100);
    expect(result.mergedOptions.temperature).toBe(0.1);
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

  it('injects provider.only with the exact tag for an OpenRouter model with a pinned provider', () => {
    const result = buildRequest(
      model,
      [] as any,
      opts(),
      {
        models: [{
          id: 'm', vllmModelId: 'wire-model', serverUrl: 'https://openrouter.ai/api',
          serverType: 'openrouter', provider: 'gmicloud/fp8',
        }],
        enableFileLogging: false,
      },
      output,
    );

    // The tag is used VERBATIM — no derivation, no suffix appended to the id.
    expect(result.mergedOptions.provider).toEqual({ only: ['gmicloud/fp8'] });
    expect(result.vllmModelId).toBe('wire-model'); // wire id stays canonical
  });

  it('does not inject provider for an OpenRouter model without a pinned provider (Auto)', () => {
    const result = buildRequest(
      model,
      [] as any,
      opts(),
      {
        models: [{ id: 'm', serverUrl: 'https://openrouter.ai/api', serverType: 'openrouter' }],
        enableFileLogging: false,
      },
      output,
    );
    expect(result.mergedOptions.provider).toBeUndefined();
  });

  it('does not inject provider for non-OpenRouter backends even if provider is set', () => {
    // provider is an OpenRouter-only field — it must never leak into a vLLM body.
    const result = buildRequest(
      model,
      [] as any,
      opts(),
      {
        models: [{ id: 'm', serverUrl: 'http://host:8000', provider: 'together' }],
        enableFileLogging: false,
      },
      output,
    );
    expect(result.mergedOptions.provider).toBeUndefined();
  });

  it('appends the routing-mode suffix to the wire id for OpenRouter Auto routing (nitro/exacto)', () => {
    // Routing mode is a per-model OpenRouter setting that sorts providers when
    // routing is Auto. The suffix goes on the WIRE id only — the base id stays
    // canonical for metadata resolution.
    const result = buildRequest(
      model,
      [] as any,
      opts(),
      {
        models: [{ id: 'm', vllmModelId: 'deepseek/deepseek-v4-pro-0813', serverUrl: 'https://openrouter.ai/api', serverType: 'openrouter', routingMode: 'nitro' }],
        enableFileLogging: false,
      },
      output,
    );
    expect(result.vllmModelId).toBe('deepseek/deepseek-v4-pro-0813:nitro');
    // The tracking/canonical id stays BASE — usage/cost must not fragment on the suffix.
    expect(result.wireModelId).toBe('deepseek/deepseek-v4-pro-0813');
    expect(result.mergedOptions.provider).toBeUndefined(); // Auto routing, no pin
  });

  it('does not append a routing suffix when a provider is pinned (sorting one provider is meaningless)', () => {
    const result = buildRequest(
      model,
      [] as any,
      opts(),
      {
        models: [{
          id: 'm', vllmModelId: 'deepseek/deepseek-v4-pro-0813', serverUrl: 'https://openrouter.ai/api',
          serverType: 'openrouter', provider: 'deepseek', routingMode: 'exacto',
        }],
        enableFileLogging: false,
      },
      output,
    );
    // Pinned provider → provider.only is set, no routing suffix on the id.
    expect(result.mergedOptions.provider).toEqual({ only: ['deepseek'] });
    expect(result.vllmModelId).toBe('deepseek/deepseek-v4-pro-0813');
    expect(result.wireModelId).toBe('deepseek/deepseek-v4-pro-0813');
  });

  it('does not append a routing suffix for standard mode or non-OpenRouter backends', () => {
    // Standard (default) → no suffix.
    const standard = buildRequest(
      model,
      [] as any,
      opts(),
      {
        models: [{ id: 'm', vllmModelId: 'deepseek/deepseek-v4-pro-0813', serverUrl: 'https://openrouter.ai/api', serverType: 'openrouter', routingMode: 'standard' }],
        enableFileLogging: false,
      },
      output,
    );
    expect(standard.vllmModelId).toBe('deepseek/deepseek-v4-pro-0813');
    expect(standard.wireModelId).toBe('deepseek/deepseek-v4-pro-0813');

    // Non-OpenRouter → routingMode must never leak into the wire id.
    const vllm = buildRequest(
      model,
      [] as any,
      opts(),
      {
        models: [{ id: 'm', vllmModelId: 'deepseek/deepseek-v4-pro-0813', serverUrl: 'http://host:8000', routingMode: 'nitro' }],
        enableFileLogging: false,
      },
      output,
    );
    expect(vllm.vllmModelId).toBe('deepseek/deepseek-v4-pro-0813');
    expect(vllm.wireModelId).toBe('deepseek/deepseek-v4-pro-0813');
  });
});
