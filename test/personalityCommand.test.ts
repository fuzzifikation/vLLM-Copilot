import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { personalityApplicableTo } from '../src/commands.js';
import { registerSetModelPersonalityCommand } from '../src/commands/personality.js';
import * as configStore from '../src/configStore.js';
import * as personalityStore from '../src/personalityStore.js';
import type { ModelConfig } from '../src/config.js';

/**
 * Server-less models must never reach saveModelConfig from the personality
 * command: the config matcher requires both id and serverUrl, so without a
 * serverUrl the store falls through to its append branch and writes a duplicate
 * entry into settings.json (verified bug, fixed as step 0a of the refactor plan).
 */
describe('personalityApplicableTo', () => {
  it('rejects a model without a serverUrl (prevents duplicate append)', () => {
    const result = personalityApplicableTo({ id: 'm', displayName: 'M' } as ModelConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no serverUrl');
  });

  it('rejects a blank/whitespace-only serverUrl', () => {
    expect(personalityApplicableTo({ id: 'm', serverUrl: '   ' } as ModelConfig).ok).toBe(false);
  });

  it('accepts a model with a serverUrl', () => {
    expect(personalityApplicableTo({ id: 'm', serverUrl: 'http://x:8000' } as ModelConfig).ok).toBe(true);
  });

  it('uses displayName then id in the warning label', () => {
    const byDisplay = personalityApplicableTo({ id: 'm', displayName: 'My Model' } as ModelConfig);
    if (!byDisplay.ok) expect(byDisplay.reason).toContain('My Model');
    const byId = personalityApplicableTo({ id: 'm' } as ModelConfig);
    if (!byId.ok) expect(byId.reason).toContain('"m"');
  });
});

describe('registerSetModelPersonalityCommand', () => {
  let provider: any;
  let output: any;
  let quickPickSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warningSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let discoverSpy: ReturnType<typeof vi.spyOn>;
  let resolveSpy: ReturnType<typeof vi.spyOn>;
  let ensureSpy: ReturnType<typeof vi.spyOn>;
  let replaceSpy: ReturnType<typeof vi.spyOn>;

  const MODEL = { id: 'm1', serverUrl: 'http://s:8000' };
  const PRESETS = [
    { name: 'Spartan', description: 'Terse', sourcePath: '/p/spartan.json', source: 'bundled' as const },
  ];

  function run() {
    registerSetModelPersonalityCommand({} as any, provider, output);
    return (vscode as any).commands._run('vllm-copilot.setModelPersonality');
  }

  beforeEach(() => {
    (vscode as any).commands._registrations = [];
    provider = { clearCache: vi.fn() };
    output = { appendLine: vi.fn() };
    quickPickSpy = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    warningSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    errorSpy = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    discoverSpy = vi.spyOn(personalityStore, 'discoverPersonalities').mockResolvedValue(PRESETS as any);
    resolveSpy = vi.spyOn(personalityStore, 'resolveActivePersonality').mockResolvedValue(null);
    ensureSpy = vi.spyOn(personalityStore, 'ensureGlobalPersonality').mockResolvedValue('/g/spartan.json');
    replaceSpy = vi.spyOn(configStore, 'replaceModelConfig').mockResolvedValue({ model: MODEL as any, created: true });
    vscode.workspace._mockConfig = { get: (key: string) => (key === 'models' ? [MODEL] : undefined) };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vscode.workspace._mockConfig = {};
  });

  it('informs when no models are configured', async () => {
    vscode.workspace._mockConfig = { get: (key: string) => (key === 'models' ? [] : undefined) };

    await run();

    expect(infoSpy).toHaveBeenCalledWith('No models are configured yet. Add a model first.');
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('returns without persisting when the model pick is cancelled', async () => {
    quickPickSpy.mockResolvedValueOnce(undefined); // cancel at step 1

    await run();

    expect(replaceSpy).not.toHaveBeenCalled();
    expect(provider.clearCache).not.toHaveBeenCalled();
  });

  it('warns and skips a server-less model instead of appending a duplicate', async () => {
    quickPickSpy.mockResolvedValueOnce({ label: 'm2', model: { id: 'm2' } } as any);

    await run();

    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('no serverUrl configured'));
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('returns without persisting when the personality pick is cancelled', async () => {
    quickPickSpy.mockResolvedValueOnce({ label: 'm1', model: MODEL } as any); // step 1
    quickPickSpy.mockResolvedValueOnce(undefined); // cancel at step 2

    await run();

    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('applies a preset and clears the provider cache', async () => {
    quickPickSpy.mockResolvedValueOnce({ label: 'm1', model: MODEL } as any); // step 1
    quickPickSpy.mockResolvedValueOnce({ label: 'Spartan', sourcePath: '/p/spartan.json' } as any); // step 2

    await run();

    expect(ensureSpy).toHaveBeenCalledWith(expect.anything(), '/p/spartan.json');
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'm1',
        serverUrl: 'http://s:8000',
        systemMessageReplacementsFile: '/g/spartan.json',
      })
    );
    expect(infoSpy).toHaveBeenCalledWith('Applied "Spartan" personality to "m1".');
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('clears the personality with an empty replacements file', async () => {
    quickPickSpy.mockResolvedValueOnce({ label: 'm1', model: MODEL } as any);
    quickPickSpy.mockResolvedValueOnce({ label: 'Default (no personality)', clear: true } as any);

    await run();

    expect(ensureSpy).not.toHaveBeenCalled();
    expect(replaceSpy).toHaveBeenCalledWith(expect.objectContaining({ systemMessageReplacementsFile: '' }));
    expect(infoSpy).toHaveBeenCalledWith('Cleared personality for "m1". Using Copilot\'s original system prompt.');
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('strips the current-marker prefix from the applied label', async () => {
    quickPickSpy.mockResolvedValueOnce({ label: 'm1', model: MODEL } as any);
    quickPickSpy.mockResolvedValueOnce({ label: '$(check) Spartan', sourcePath: '/p/spartan.json' } as any);

    await run();

    expect(infoSpy).toHaveBeenCalledWith('Applied "Spartan" personality to "m1".');
  });

  it('surfaces a persistence failure and does not clear the cache', async () => {
    quickPickSpy.mockResolvedValueOnce({ label: 'm1', model: MODEL } as any);
    quickPickSpy.mockResolvedValueOnce({ label: 'Spartan', sourcePath: '/p/spartan.json' } as any);
    replaceSpy.mockRejectedValueOnce(new Error('write failed'));

    await run();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to apply personality'));
    expect(provider.clearCache).not.toHaveBeenCalled();
  });

  it('returns without persisting when a separator is picked', async () => {
    quickPickSpy.mockResolvedValueOnce({ label: 'm1', model: MODEL } as any);
    quickPickSpy.mockResolvedValueOnce({ label: '', kind: vscode.QuickPickItemKind.Separator } as any);

    await run();

    expect(replaceSpy).not.toHaveBeenCalled();
  });
});
