import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { maybeOfferOutputLengthMigration } from '../src/migrations/outputLengthMigration.js';
import type { ModelConfig } from '../src/state/config.js';
import type { ModelPreset } from '../src/commands/presets.js';

/**
 * Tests for the one-time Output length menu migration
 * (outputLengthMigration.ts).
 *
 * Round-10 reroute (P A-1): the planner and its proposal type went
 * module-private because the ONLY production customer is the offer below.
 * Every former planner case now drives maybeOfferOutputLengthMigration -
 * the function activation actually calls - and asserts what reaches the
 * settings writer. That pins strictly more than the old planner calls did:
 * the offer's skip conditions, the apply loop, and the store's `''` CLEAR
 * merge semantics are now covered where the tests previously stopped at the
 * proposal payload. Presets are served through a module seam so the preset
 * arm runs without the extension bundle; `findPresetForModel` stays real.
 */

const presetStub = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock('../src/commands/presets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/commands/presets.js')>();
  return { ...real, loadModelPresets: () => Promise.resolve(presetStub.list as never) };
});

function preset(file: string, match: string[], config: Record<string, unknown>): ModelPreset {
  return { sourceFile: file, match, config: config as ModelPreset['config'] };
}

const base = { id: 'm1', server: 'h' };

describe('maybeOfferOutputLengthMigration', () => {
  let context: any;
  let output: { appendLine: ReturnType<typeof vi.fn> };
  let models: ModelConfig[];
  let update: ReturnType<typeof vi.fn>;
  let info: ReturnType<typeof vi.fn>;
  let error: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    presetStub.list = [];
    models = [{
      id: 'synth', server: 'h', maxOutputTokens: 8192,
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
      globalState: { _v: undefined as string | undefined, get(k: string) { return k === 'vllmCopilot.outputLengthMigration.v1' ? this._v : undefined; }, async update(_k: string, v: string) { this._v = v; } },
    };
    output = { appendLine: vi.fn() };
  });

  /** Press a named button on every modal the flow raises. */
  const press = (title: string) =>
    info.mockImplementation(async (_m: string, ...items: any[]) =>
      items.find((i: any) => i.title === title));
  const pressUpdate = () => press('Update output length menus');
  /** Review first, then confirm the preview modal. */
  const pressReviewThenConfirm = () => {
    const openDoc = vi.fn(async (_options: unknown) => ({}));
    vi.mocked(vscode.workspace).openTextDocument = openDoc as never;
    info
      .mockImplementationOnce(async (_m: string, ...items: any[]) => items.find((i: any) => i.title === 'Review first'))
      .mockImplementationOnce(async (_m: string, ...items: any[]) => items.find((i: any) => i.title === 'Update output length menus'));
    return openDoc;
  };
  async function run() {
    await maybeOfferOutputLengthMigration(context, output as never);
  }
  /** The single model written to settings by the apply loop. */
  function written(): ModelConfig {
    expect(update).toHaveBeenCalledTimes(1);
    const [key, value] = update.mock.calls[0];
    expect(key).toBe('models');
    return (value as ModelConfig[])[0];
  }
  const expectSilent = () => {
    expect(info).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(context.globalState._v).toBeUndefined(); // no flag — future models still get an offer
  };

  // --- the offer flow itself ---

  it('does nothing once the user decided (done or declined)', async () => {
    context.globalState._v = 'done';
    await run();
    expect(info).not.toHaveBeenCalled();
    context.globalState._v = 'declined';
    await run();
    expect(info).not.toHaveBeenCalled();
  });

  it('stays silent when no model can get an honest menu', async () => {
    models = [{ id: 'x', server: 'h', maxOutputTokens: 100 } as ModelConfig];
    await run();
    expectSilent();
  });

  it('applies the proposals on Update, sets done, confirms with a toast', async () => {
    pressUpdate();
    await run();
    expect(written().maxOutputTokens).toEqual([8192, 2048]);
    expect(context.globalState._v).toBe('done');
    const toasts = info.mock.calls.map(c => String(c[0]));
    expect(toasts.some(t => t.includes('added an Output Length menu'))).toBe(true);
  });

  it('records declined without writing', async () => {
    press('Not now');
    await run();
    expect(context.globalState._v).toBe('declined');
    expect(update).not.toHaveBeenCalled();
  });

  it('dismissal (undefined) leaves no flag and no write — asks again next activation', async () => {
    await run(); // default mock → undefined
    expect(context.globalState._v).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('review path previews the document and only applies after confirm', async () => {
    const openDoc = pressReviewThenConfirm();
    await run();
    expect(openDoc).toHaveBeenCalledTimes(1);
    const preview = (openDoc.mock.calls[0][0] as { content: string }).content;
    expect(preview).toContain('synth');
    expect(preview).toContain('[8192,2048]');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('review + cancel applies nothing and sets no flag', async () => {
    info.mockImplementationOnce(async (_m: string, ...items: any[]) => items.find((i: any) => i.title === 'Review first'));
    vi.mocked(vscode.workspace).openTextDocument = vi.fn(async () => ({})) as never;
    await run();
    expect(update).not.toHaveBeenCalled();
    expect(context.globalState._v).toBeUndefined();
  });

  it('a blocked settings write surfaces an error and keeps the offer for later', async () => {
    update.mockRejectedValue(new Error('Unable to write into user settings'));
    pressUpdate();
    await run();
    expect(error).toHaveBeenCalled();
    expect(context.globalState._v).toBeUndefined(); // NOT done — offer returns once settings.json is valid
  });

  it('builds the offer from settings and presets alone, with no fetch installed', async () => {
    // Models come from the settings mock, presets from the local module seam;
    // no fetch is installed at all and the offer still appears.
    press('Not now');
    await run();
    expect(info).toHaveBeenCalled();
  });

  // --- proposal rules, rerouted through the offer (Round 10 P A-1) ---

  it('adopts a preset-declared vector verbatim: declared order kept, preset wins over a higher scalar', async () => {
    models = [{ ...base, vllmModelId: 'deepseek/deepseek-v4-pro-0813', maxOutputTokens: 81920 } as ModelConfig];
    presetStub.list = [preset('DeepSeek-V4-Pro.json', ['DeepSeek-V4-Pro'], { maxOutputTokens: [65536, 32768, 16384] })];
    const openDoc = pressReviewThenConfirm();
    await run();
    const preview = (openDoc.mock.calls[0][0] as { content: string }).content;
    expect(preview).toContain('preset DeepSeek-V4-Pro.json');
    expect(preview).toContain('81920'); // the before-value the user reviews is pinned too
    expect(written().maxOutputTokens).toEqual([65536, 32768, 16384]); // declared order, NOT re-sorted
  });

  it('skips models that already carry a vector menu', async () => {
    models = [{ ...base, maxOutputTokens: [1024, 512] } as unknown as ModelConfig];
    await run();
    expectSilent();
  });

  it("synthesizes a descending menu from the user's own ladder and strips the dead layers", async () => {
    models = [{
      ...base,
      maxOutputTokens: 32768,
      defaultParams: { max_tokens: 4096, temperature: 0.5 },
      modelModes: {
        A: { max_tokens: 8192, temperature: 1 } as never,
        B: { max_tokens: 2048 } as never, // stripped to empty → dropped entirely
        C: { temperature: 0.2 } as never, // untouched
      },
    } as ModelConfig];
    pressUpdate();
    await run();
    expect(written().maxOutputTokens).toEqual([32768, 8192, 4096, 2048]); // descending, deduped
    expect(written().modelModes).toEqual({ A: { temperature: 1 }, C: { temperature: 0.2 } });
    expect(written().defaultParams).toEqual({ temperature: 0.5 });
  });

  it('needs at least two distinct values to propose anything: lone scalar stays alone', async () => {
    models = [{ ...base, maxOutputTokens: 32768 } as ModelConfig];
    await run();
    expectSilent();
  });

  it('untouched default model (no maxOutputTokens, no ladder) is skipped', async () => {
    models = [{ ...base } as ModelConfig];
    await run();
    expectSilent();
  });

  it('clears modelModes via the store (CLEAR signal) when every mode held only max_tokens', async () => {
    // stripModeMaxTokens went file-private in the U8 absorb wave; its
    // user-visible contract is what reaches settings: the `''` patch payload
    // must land as an ABSENT modelModes (normalizeModelEntry CLEARABLE_ON_EMPTY),
    // never as the empty string the schema forbids.
    models = [{ ...base, maxOutputTokens: 8192, modelModes: { A: { max_tokens: 2048 } } } as ModelConfig];
    pressUpdate();
    await run();
    expect(written().modelModes).toBeUndefined();
    expect(written().maxOutputTokens).toEqual([8192, 2048]);
  });

  it('leaves modelModes untouched when nothing had max_tokens, and clears only the dead defaultParams', async () => {
    models = [{
      ...base,
      maxOutputTokens: 8192,
      defaultParams: { max_tokens: 2048 },
      modelModes: { A: { temperature: 1 } },
    } as ModelConfig];
    pressUpdate();
    await run();
    expect(written().modelModes).toEqual({ A: { temperature: 1 } });
    expect(written().defaultParams).toBeUndefined(); // '' cleared max_tokens-only defaultParams
  });

  it('skips malformed entries without id or server', async () => {
    // First has no id (resolveConfigId falls back to vllmModelId but no
    // server), second has no server ref → both refused by the store, so
    // never proposed.
    models = [
      { vllmModelId: 'x', maxOutputTokens: 100 } as unknown as ModelConfig,
      { id: 'nosrv', maxOutputTokens: 100 } as ModelConfig,
    ];
    await run();
    expectSilent();
  });

  it('preset vector degrades to synthesis when it has fewer than two usable entries', async () => {
    models = [{
      ...base, vllmModelId: 'GLM-9', maxOutputTokens: 8192,
      modelModes: { X: { max_tokens: 1024 } } as never,
    } as ModelConfig];
    presetStub.list = [preset('glm9.json', ['GLM-9'], { maxOutputTokens: [4096] })];
    pressUpdate();
    await run();
    expect(written().maxOutputTokens).toEqual([8192, 1024]);
    expect(written().modelModes).toBeUndefined(); // mode X held only max_tokens → cleared
  });
});
