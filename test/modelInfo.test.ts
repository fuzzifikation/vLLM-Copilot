import { describe, it, expect } from 'vitest';
import { buildModelInfo, extractFamilyWithSource } from '../src/provider/modelInfo.js';
import type { TokenBudget } from '../src/shared/tokenBudget.js';

describe('buildModelInfo picker id derivation', () => {
  it('uses an explicit id as the picker id', () => {
    const info = buildModelInfo(
      { id: 'Qwen/Qwen3-8B', max_model_len: 32768 },
      { id: 'my-preset', vllmModelId: 'Qwen/Qwen3-8B', server: 'srv' },
      { maxOutputTokens: 4096 },
      'vllm',
    );
    expect(info.id).toBe('my-preset');
  });

  it('falls back to the server model id when the override carries no id', () => {
    const info = buildModelInfo(
      { id: 'Qwen/Qwen3-8B', max_model_len: 32768 },
      { vllmModelId: 'Qwen/Qwen3-8B', server: 'srv' },
      { maxOutputTokens: 4096 },
      'vllm',
    );
    expect(info.id).toBe('Qwen/Qwen3-8B');
  });

  it('keys the same wire model apart by distinct config ids per server', () => {
    const a = buildModelInfo(
      { id: 'X', max_model_len: 1000 },
      { id: 'x-on-a', vllmModelId: 'X', server: 'a' },
      { maxOutputTokens: 512 },
      'vllm',
    );
    const b = buildModelInfo(
      { id: 'X', max_model_len: 1000 },
      { id: 'x-on-b', vllmModelId: 'X', server: 'b' },
      { maxOutputTokens: 512 },
      'vllm',
    );
    expect(a.id).toBe('x-on-a');
    expect(b.id).toBe('x-on-b');
    expect(a.id).not.toBe(b.id);
  });

  it('falls back to the picker id for the display name when no displayName', () => {
    const info = buildModelInfo(
      { id: 'X', max_model_len: 1000 },
      { id: 'cfg-x', vllmModelId: 'X', server: 'a' },
      { maxOutputTokens: 512 },
      'vllm',
    );
    expect(info.name).toBe('cfg-x');
  });

  it('keeps displayName as the picker label when set', () => {
    const info = buildModelInfo(
      { id: 'X', max_model_len: 1000 },
      { id: 'cfg-x', vllmModelId: 'X', displayName: 'My Model', server: 'a' },
      { maxOutputTokens: 512 },
      'vllm',
    );
    expect(info.name).toBe('My Model');
    expect(info.id).toBe('cfg-x');
  });

  it.each(['vllm', 'lmstudio', 'llamacpp', 'ollama', 'openrouter'] as const)('uses the vLLM icon for %s models', (serverType) => {
    const info = buildModelInfo(
      { id: 'X', max_model_len: 1000 },
      { id: 'cfg-x', vllmModelId: 'X', server: 'a' },
      { maxOutputTokens: 512 },
      serverType,
    );
    expect((info as unknown as { statusIcon?: { id: string } }).statusIcon?.id).toBe('vllm-copilot-model');
  });

});

describe('buildModelInfo outputMenuCeiling (pick-as-advertised scaling)', () => {
  // Discovery advertises the tracked pick via `effectiveOutputTokens` but keeps
  // the override RAW (its vector IS the menu) and passes the static PRE-pick
  // ceiling separately: the dropdown must keep offering lengths above the pick,
  // and a deliberate pick must not read as a clamp warning.
  const override = { id: 'X', vllmModelId: 'X', server: 'srv', maxOutputTokens: [65536, 32768, 16384] };
  const serverModel = { id: 'X', max_model_len: 262144 };
  // configurationSchema + warningText are chatProvider-proposal fields, absent from stable types.
  type CeilingInfo = { maxOutputTokens?: number; maxInputTokens?: number; warningText?: Record<string, string>; configurationSchema?: { properties?: Record<string, { enum?: number[] }> } };

  it('advertises the picked budget while the menu keeps bigger options and no clamp banner fires', () => {
    // User picked 16384 of a 65536 ceiling; configured output == ceiling, so
    // there is no clamp — only the pick shrank the advertised output.
    const info = buildModelInfo(
      serverModel,
      override, // RAW override — its vector is the menu; the clone would kill it
      { maxOutputTokens: 32768 },
      'vllm',
      undefined,
      undefined,
      16384, // effectiveOutputTokens — the tracked pick
      65536, // outputMenuCeiling
    ) as CeilingInfo;
    expect(info.maxOutputTokens).toBe(16384);
    expect(info.maxInputTokens).toBe(262144 - 16384); // freed tokens grew the prompt budget
    const enumVals = info.configurationSchema?.properties?.maxOutputTokens?.enum;
    expect(enumVals).toEqual([65536, 32768, 16384]); // bigger picks remain selectable
    expect(info.warningText?.output_limit).toBeUndefined();
  });

  it('without a ceiling, scales menu and banner against the advertised budget (fallback)', () => {
    // A server-reported output ceiling clamps the advertised budget below the
    // configured value. Without a separate outputMenuCeiling the menu shrinks
    // with it and the clamp warns — the legacy path for callers that pass no
    // ceiling (pre-pick behavior: menu and banner follow the advertised budget).
    const info = buildModelInfo(
      serverModel,
      override, // head 65536 configured, no pick → legacy path
      { maxOutputTokens: 32768 },
      'vllm',
      40000, // reportedMaxOutputTokens
    ) as CeilingInfo;
    expect(info.maxOutputTokens).toBe(40000);
    const enumVals = info.configurationSchema?.properties?.maxOutputTokens?.enum;
    expect(enumVals).toEqual([32768, 16384]); // 65536 pruned — menu follows the advertised budget
    expect(info.warningText?.output_limit).toBeDefined(); // 65536 configured > 40000 → warns
  });
});

// ── extractFamilyWithSource (folded from test/modelUtils.test.ts) ──────

describe('extractFamilyWithSource', () => {
  it('reports fromFallback=true for org-name fallback (GLM/ChatGLM not in list)', () => {
    // GLM — exactly the case the known-bugs doc flagged. Intentionally not in
    // KNOWN_FAMILIES; the authoritative family must come from a preset or HF.
    expect(extractFamilyWithSource('zai-org/GLM-5.2')).toEqual({
      family: 'zai-org',
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
