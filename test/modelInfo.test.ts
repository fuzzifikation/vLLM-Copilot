import { describe, it, expect } from 'vitest';
import { buildModelInfo, buildPickerBanners, isVersionAtLeast } from '../src/modelInfo.js';
import type { TokenBudget } from '../src/tokenBudget.js';

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

describe('isVersionAtLeast', () => {
  it.each([
    ['1.135', '1.135.0', true],
    ['1.135', '1.136.0-insider', true],
    ['1.135', '2.0.0', true],
    ['1.135', '1.134.1', false],
    ['1.135', '1.135', true],
    ['1.135', '1.13', false],
    ['1.135', 'test', false],
    ['nonsense', '1.135.0', false],
  ])('"%s" vs "%s" → %s', (min, current, expected) => {
    expect(isVersionAtLeast(min, current)).toBe(expected);
  });
});

describe('buildPickerBanners', () => {
  const budget = (maxModelLen: number, maxOutputTokens: number): TokenBudget => ({
    maxModelLen,
    maxOutputTokens,
    maxInputTokens: maxModelLen - maxOutputTokens,
  });

  it('warns when tool calling is explicitly disabled', () => {
    const { warningText } = buildPickerBanners(
      { capabilities: { toolCalling: false } },
      { maxOutputTokens: 4096 },
      budget(32768, 4096),
      undefined,
      true,
    );
    expect(warningText?.tool_calling).toContain('Agent mode');
  });

  it('does not warn when tool calling is enabled or unset', () => {
    for (const override of [undefined, {}, { capabilities: { toolCalling: true } }]) {
      const { warningText } = buildPickerBanners(
        override,
        { maxOutputTokens: 4096 },
        budget(32768, 4096),
        undefined,
        true,
      );
      expect(warningText?.tool_calling).toBeUndefined();
    }
  });

  it('warns when the context window clamps output well below the configured budget', () => {
    const { warningText } = buildPickerBanners(
      undefined,
      { maxOutputTokens: 4096 },
      budget(2048, 2047),
      undefined,
      true,
    );
    expect(warningText?.output_limit).toContain('context window');
    expect(warningText?.output_limit).toContain('2047');
  });

  it('attributes the clamp to the provider when a reported ceiling caused it', () => {
    const { warningText } = buildPickerBanners(
      undefined,
      { maxOutputTokens: 4096 },
      budget(32768, 1024),
      1024,
      true,
    );
    expect(warningText?.output_limit).toContain('provider');
    expect(warningText?.output_limit).not.toContain('context window');
  });

  it('points at the Output Length dropdown when the model offers one', () => {
    const { warningText } = buildPickerBanners(
      // Head 2048 = configured budget, clamped to 1024 by the window/provider;
      // entries ≤ ceiling survive → [1024, 512] renders the menu to point at.
      { maxOutputTokens: [2048, 1024, 512] },
      { maxOutputTokens: 4096 },
      budget(32768, 1024),
      undefined,
      true,
    );
    expect(warningText?.output_limit).toContain('Output Length dropdown');
  });

  it('does not advertise a dropdown the model does not render', () => {
    // Same clamp, no declared vector → no menu exists to point at.
    const { warningText } = buildPickerBanners(
      undefined,
      { maxOutputTokens: 4096 },
      budget(32768, 1024),
      undefined,
      true,
    );
    expect(warningText?.output_limit).toBeDefined();
    expect(warningText?.output_limit).not.toContain('Output Length');
  });

  it('stays silent for the token-or-two the budget derivation always shaves', () => {
    const { warningText } = buildPickerBanners(
      undefined,
      { maxOutputTokens: 4096 },
      budget(32768, 4095),
      undefined,
      true,
    );
    expect(warningText?.output_limit).toBeUndefined();
  });

  it('reports non-default OpenRouter routing as info', () => {
    const { infoText } = buildPickerBanners(
      { provider: 'DeepInfra', routingMode: 'nitro' },
      { maxOutputTokens: 4096 },
      budget(32768, 4096),
      undefined,
      true,
      undefined,
      'openrouter',
    );
    expect(infoText?.openrouter_routing).toContain('DeepInfra');
    expect(infoText?.openrouter_routing).toContain('nitro');
  });

  it('omits info banners entirely when the host predates infoText', () => {
    const { infoText, warningText } = buildPickerBanners(
      { routingMode: 'exacto', capabilities: { toolCalling: false } },
      { maxOutputTokens: 4096 },
      budget(32768, 4096),
      undefined,
      false,
      undefined,
      'openrouter',
    );
    expect(infoText).toBeUndefined();
    expect(warningText?.tool_calling).toBeDefined();
  });

  it('stays silent for default OpenRouter routing', () => {
    const { infoText } = buildPickerBanners(
      { routingMode: 'standard' },
      { maxOutputTokens: 4096 },
      budget(32768, 4096),
      undefined,
      true,
      undefined,
      'openrouter',
    );
    expect(infoText).toBeUndefined();
  });
});

describe('buildModelInfo banner wiring', () => {
  type BannerInfo = { warningText?: Record<string, string>; infoText?: Record<string, string> };

  it('emits warningText for a disabled-toolCalling model', () => {
    const info = buildModelInfo(
      { id: 'X', max_model_len: 32768 },
      { id: 'X', vllmModelId: 'X', server: 'a', capabilities: { toolCalling: false } },
      { maxOutputTokens: 4096 },
      'vllm',
    ) as BannerInfo;
    expect(info.warningText?.tool_calling).toBeDefined();
  });

  it('never emits infoText on hosts below 1.135 (mock version "test")', () => {
    const info = buildModelInfo(
      { id: 'X', max_model_len: 32768 },
      { id: 'X', vllmModelId: 'X', server: 'or', provider: 'DeepInfra' },
      { maxOutputTokens: 4096 },
      'openrouter',
    ) as BannerInfo;
    expect(info.infoText).toBeUndefined();
  });

  it('emits no banner fields for an unremarkable model', () => {
    const info = buildModelInfo(
      { id: 'X', max_model_len: 32768 },
      { id: 'X', vllmModelId: 'X', server: 'a' },
      { maxOutputTokens: 4096 },
      'vllm',
    ) as BannerInfo;
    expect(info.warningText).toBeUndefined();
    expect(info.infoText).toBeUndefined();
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
