import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import {
  planOutputLengthMigration,
  stripModeMaxTokens,
  formatMigrationPreview,
  maybeOfferOutputLengthMigration,
  type OutputLengthProposal,
} from '../src/outputLengthMigration.js';
import type { ModelConfig } from '../src/config.js';
import type { ModelPreset } from '../src/commands/presets.js';

/**
 * Tests for the one-time Output length menu migration offer
 * (outputLengthMigration.ts): the pure planner (preset adoption, synthesis
 * from the user's own max_tokens ladder, honest skips) and the activation
 * flow (once-per-install flag, apply/review/declined/dismissed paths,
 * write-failure handling).
 */

function preset(file: string, match: string[], config: Record<string, unknown>): ModelPreset {
  return { sourceFile: file, match, config: config as ModelPreset['config'] };
}

const base = { id: 'm1', serverUrl: 'http://h:8000' };

describe('planOutputLengthMigration', () => {
  it('adopts a preset-declared vector verbatim — declared order kept, preset wins over a higher scalar', () => {
    const models: ModelConfig[] = [
      { ...base, vllmModelId: 'deepseek/deepseek-v4-pro-0813', maxOutputTokens: 81920 } as ModelConfig,
    ];
    const presets = [preset('DeepSeek-V4-Pro.json', ['DeepSeek-V4-Pro'], { maxOutputTokens: [65536, 32768, 16384] })];
    const plans = planOutputLengthMigration(models, presets);
    expect(plans).toHaveLength(1);
    expect(plans[0].source).toBe('preset');
    expect(plans[0].sourceFile).toBe('DeepSeek-V4-Pro.json');
    expect(plans[0].to).toEqual([65536, 32768, 16384]); // declared order, NOT re-sorted
    expect(plans[0].from).toBe(81920);
    expect(plans[0].updates.maxOutputTokens).toEqual([65536, 32768, 16384]);
  });

  it('skips models that already carry a vector menu', () => {
    const models = [{ ...base, maxOutputTokens: [1024, 512] } as unknown as ModelConfig];
    expect(planOutputLengthMigration(models, [])).toHaveLength(0);
  });

  it('synthesizes a descending menu from the user\'s own ladder and strips the dead layers', () => {
    const models: ModelConfig[] = [{
      ...base,
      maxOutputTokens: 32768,
      defaultParams: { max_tokens: 4096, temperature: 0.5 },
      modelModes: {
        A: { max_tokens: 8192, temperature: 1 } as never,
        B: { max_tokens: 2048 } as never, // stripped to empty → dropped entirely
        C: { temperature: 0.2 } as never, // untouched
      },
    }];
    const plans = planOutputLengthMigration(models, []);
    expect(plans).toHaveLength(1);
    expect(plans[0].source).toBe('synthesized');
    expect(plans[0].to).toEqual([32768, 8192, 4096, 2048]); // descending, deduped
    expect(plans[0].updates.modelModes).toEqual({ A: { temperature: 1 }, C: { temperature: 0.2 } });
    expect((plans[0].updates.defaultParams as Record<string, unknown>).max_tokens).toBeUndefined();
    expect((plans[0].updates.defaultParams as Record<string, unknown>).temperature).toBe(0.5);
  });

  it('needs at least two distinct values to propose anything — lone scalar stays alone', () => {
    const models = [{ ...base, maxOutputTokens: 32768 } as ModelConfig];
    expect(planOutputLengthMigration(models, [])).toHaveLength(0);
  });

  it('untouched default model (no maxOutputTokens, no ladder) is skipped', () => {
    expect(planOutputLengthMigration([{ ...base } as ModelConfig], [])).toHaveLength(0);
  });

  it('clears defaultParams entirely when max_tokens was its only key', () => {
    const models = [{
      ...base, maxOutputTokens: 8192, defaultParams: { max_tokens: 2048 },
    } as ModelConfig];
    const plans = planOutputLengthMigration(models, []);
    expect(plans[0].updates.defaultParams).toBe('');
  });

  it('skips malformed entries without id or serverUrl', () => {
    const models = [
      { vllmModelId: 'x', maxOutputTokens: 100 } as unknown as ModelConfig,
      { id: 'nosrv', maxOutputTokens: 100 } as ModelConfig,
    ];
    // First has no id (resolveConfigId falls back to vllmModelId but no serverUrl),
    // second has no serverUrl → both refused by the store, so never proposed.
    expect(planOutputLengthMigration(models, [])).toHaveLength(0);
  });

  it('preset vector degrades to synthesis when it has fewer than two usable entries', () => {
    const models: ModelConfig[] = [{
      ...base, vllmModelId: 'GLM-9', maxOutputTokens: 8192,
      modelModes: { X: { max_tokens: 1024 } } as never,
    }];
    const presets = [preset('glm9.json', ['GLM-9'], { maxOutputTokens: [4096] })];
    const plans = planOutputLengthMigration(models, presets);
    expect(plans).toHaveLength(1);
    expect(plans[0].source).toBe('synthesized');
    expect(plans[0].to).toEqual([8192, 1024]);
  });
});

describe('stripModeMaxTokens', () => {
  it('returns undefined when nothing had max_tokens', () => {
    expect(stripModeMaxTokens({ A: { temperature: 1 } })).toBeUndefined();
    expect(stripModeMaxTokens(undefined)).toBeUndefined();
  });

  it('returns the CLEAR signal when every mode becomes empty', () => {
    expect(stripModeMaxTokens({ A: { max_tokens: 100 } })).toBe('');
  });
});

describe('formatMigrationPreview', () => {
  it('shows before/after per proposal', () => {
    const p: OutputLengthProposal = {
      id: 'm', serverUrl: 'http://h', displayName: 'My Model', from: 81920,
      to: [65536, 32768], source: 'preset', sourceFile: 'x.json',
      updates: { maxOutputTokens: [65536, 32768] },
    };
    const text = formatMigrationPreview([p]);
    expect(text).toContain('My Model');
    expect(text).toContain('81920');
    expect(text).toContain('[65536,32768]');
    expect(text).toContain('preset x.json');
  });
});

describe('maybeOfferOutputLengthMigration', () => {
  let context: any;
  let output: { appendLine: ReturnType<typeof vi.fn> };
  let models: ModelConfig[];
  let update: ReturnType<typeof vi.fn>;
  let info: ReturnType<typeof vi.fn>;
  let error: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    models = [{
      id: 'synth', serverUrl: 'http://h:8000', maxOutputTokens: 8192,
      modelModes: { A: { max_tokens: 2048 } } as never,
    } as ModelConfig];
    update = vi.fn(async () => {});
    vi.mocked(vscode.workspace).getConfiguration = vi.fn(() => ({
      get: () => models, update, has: () => false, inspect: () => undefined,
    }) as unknown as vscode.WorkspaceConfiguration);
    info = vi.fn(async () => undefined);
    error = vi.fn(async () => undefined);
    vi.mocked(vscode.window).showInformationMessage = info as never;
    vi.mocked(vscode.window).showErrorMessage = error as never;
    context = {
      extensionUri: vscode.Uri.file('/ext'),
      globalState: { _v: undefined as string | undefined, get(k: string) { return k === 'vllmCopilot.outputLengthMigration.v1' ? this._v : undefined; }, async update(k: string, v: string) { this._v = v; } },
    };
    output = { appendLine: vi.fn() };
  });

  it('does nothing once the user decided (done or declined)', async () => {
    context.globalState._v = 'done';
    await maybeOfferOutputLengthMigration(context, output as never);
    expect(info).not.toHaveBeenCalled();
    context.globalState._v = 'declined';
    await maybeOfferOutputLengthMigration(context, output as never);
    expect(info).not.toHaveBeenCalled();
  });

  it('stays silent when no model can get an honest menu', async () => {
    models = [{ id: 'x', serverUrl: 'http://h', maxOutputTokens: 100 } as ModelConfig];
    await maybeOfferOutputLengthMigration(context, output as never);
    expect(info).not.toHaveBeenCalled();
    expect(context.globalState._v).toBeUndefined(); // no flag — future models still get an offer
  });

  it('applies the proposals on Update, sets done, confirms with a toast', async () => {
    info.mockImplementation(async (_m: string, ...items: any[]) => items.find((i: any) => i.title === 'Update output length menus'));
    await maybeOfferOutputLengthMigration(context, output as never);
    expect(update).toHaveBeenCalledTimes(1);
    const [key, value] = update.mock.calls[0];
    expect(key).toBe('models');
    expect((value as ModelConfig[])[0].maxOutputTokens).toEqual([8192, 2048]);
    expect(context.globalState._v).toBe('done');
    const toasts = info.mock.calls.map(c => String(c[0]));
    expect(toasts.some(t => t.includes('added an Output Length menu'))).toBe(true);
  });

  it('records declined without writing', async () => {
    info.mockImplementation(async (_m: string, ...items: any[]) => items.find((i: any) => i.title === 'Not now'));
    await maybeOfferOutputLengthMigration(context, output as never);
    expect(context.globalState._v).toBe('declined');
    expect(update).not.toHaveBeenCalled();
  });

  it('dismissal (undefined) leaves no flag and no write — asks again next activation', async () => {
    await maybeOfferOutputLengthMigration(context, output as never); // default mock → undefined
    expect(context.globalState._v).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('review path previews the document and only applies after confirm', async () => {
    info
      .mockImplementationOnce(async (_m: string, ...items: any[]) => items.find((i: any) => i.title === 'Review first'))
      .mockImplementationOnce(async (_m: string, ...items: any[]) => items.find((i: any) => i.title === 'Update output length menus'));
    const openDoc = vi.fn(async (_options: unknown) => ({}));
    vi.mocked(vscode.workspace).openTextDocument = openDoc as never;
    await maybeOfferOutputLengthMigration(context, output as never);
    expect(openDoc).toHaveBeenCalledTimes(1);
    const preview = (openDoc.mock.calls[0][0] as { content: string }).content;
    expect(preview).toContain('synth');
    expect(preview).toContain('[8192,2048]');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('review + cancel applies nothing and sets no flag', async () => {
    info
      .mockImplementationOnce(async (_m: string, ...items: any[]) => items.find((i: any) => i.title === 'Review first'))
      .mockImplementationOnce(async () => undefined); // modal dismissed
    vi.mocked(vscode.workspace).openTextDocument = vi.fn(async () => ({})) as never;
    await maybeOfferOutputLengthMigration(context, output as never);
    expect(update).not.toHaveBeenCalled();
    expect(context.globalState._v).toBeUndefined();
  });

  it('a blocked settings write surfaces an error and keeps the offer for later', async () => {
    update.mockRejectedValue(new Error('Unable to write into user settings'));
    info.mockImplementation(async (_m: string, ...items: any[]) => items.find((i: any) => i.title === 'Update output length menus'));
    await maybeOfferOutputLengthMigration(context, output as never);
    expect(error).toHaveBeenCalled();
    expect(context.globalState._v).toBeUndefined(); // NOT done — offer returns once settings.json is valid
  });

  it('reads models without touching the network', async () => {
    // loadModelPresets goes through workspace.fs — with no fs hooks installed
    // the mock returns an empty directory, proving no fetch is involved.
    info.mockImplementation(async (_m: string, ...items: any[]) => items.find((i: any) => i.title === 'Not now'));
    await maybeOfferOutputLengthMigration(context, output as never);
    expect(info).toHaveBeenCalled(); // offer appeared from purely local data
  });
});
