import * as vscode from 'vscode';
import { saveModelConfig } from '../src/autoConfig.js';
import { ModelConfig } from '../src/config.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Tests for the `saveModelConfig` personality merge semantics:
 * - `systemMessageReplacementsFile: undefined` preserves the previous value
 *   (auto-configure must not wipe a user's personality).
 * - empty string is an explicit clear (Set Model Personality → Default),
 *   which removes the property from the stored entry.
 * - a new value replaces the previous one.
 * - a brand-new entry drops empty-string replacements WITHOUT mutating the
 *   caller's object in place.
 */
describe('saveModelConfig (autoConfig) — personality merge semantics', () => {
  let existingConfig: ModelConfig[];
  let updateSpy: ReturnType<typeof vi.fn>;

  const baseConfig = (overrides: Partial<ModelConfig> = {}): ModelConfig => ({
    id: 'test-model',
    vllmModelId: 'test-model',
    serverUrl: 'http://localhost:8000',
    displayName: 'Test Model',
    ...overrides,
  });

  beforeEach(() => {
    existingConfig = [];
    updateSpy = vi.fn().mockResolvedValue(undefined);
    vscode.workspace._mockConfig = {
      // get('models') reads the live `existingConfig` variable; other keys undefined.
      get: (key: string) => (key === 'models' ? existingConfig : undefined),
      update: updateSpy,
      // chat.byokUtilityModelDefault not registered → ensureByokUtilityDefault bails.
      inspect: () => undefined,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vscode.workspace._mockConfig = {};
  });

  const storedModels = (): ModelConfig[] => updateSpy.mock.calls[0][1] as ModelConfig[];

  it('preserves the previous replacements file when the new value is undefined', async () => {
    existingConfig = [
      baseConfig({ systemMessageReplacementsFile: '.vllm/prompt-replacements-tough-love.json' }),
    ];

    // No systemMessageReplacementsFile key → undefined → preserve.
    await saveModelConfig(baseConfig({ displayName: 'Renamed' }));

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect(stored[0].displayName).toBe('Renamed');
    expect(stored[0].systemMessageReplacementsFile).toBe(
      '.vllm/prompt-replacements-tough-love.json',
    );
  });

  it('clears the replacements file when the new value is an empty string', async () => {
    existingConfig = [
      baseConfig({ systemMessageReplacementsFile: '.vllm/prompt-replacements-tough-love.json' }),
    ];

    await saveModelConfig(baseConfig({ systemMessageReplacementsFile: '' }));

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect('systemMessageReplacementsFile' in stored[0]).toBe(false);
  });

  it('replaces the replacements file when a new value is set', async () => {
    existingConfig = [
      baseConfig({ systemMessageReplacementsFile: '.vllm/prompt-replacements-tough-love.json' }),
    ];

    await saveModelConfig(
      baseConfig({ systemMessageReplacementsFile: '.vllm/prompt-replacements-sarcastic-robot.json' }),
    );

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect(stored[0].systemMessageReplacementsFile).toBe(
      '.vllm/prompt-replacements-sarcastic-robot.json',
    );
  });

  it('adds a new entry, drops empty-string replacements, and does not mutate the caller object', async () => {
    const newModel = baseConfig({
      id: 'brand-new',
      vllmModelId: 'brand-new',
      systemMessageReplacementsFile: '',
    });
    const snapshot = { ...newModel };

    await saveModelConfig(newModel);

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect('systemMessageReplacementsFile' in stored[0]).toBe(false);
    // Caller's object must not be mutated in place.
    expect(newModel.systemMessageReplacementsFile).toBe('');
    expect(newModel).toEqual(snapshot);
  });

  it('matches a legacy entry by id fallback and preserves its personality', async () => {
    // Legacy hand-written entry: no vllmModelId, matched by exact `id`.
    existingConfig = [
      {
        id: 'legacy-model',
        serverUrl: 'http://localhost:8000',
        displayName: 'Legacy',
        systemMessageReplacementsFile: '.vllm/prompt-replacements-spartan.json',
      },
    ];

    await saveModelConfig({
      id: 'legacy-model',
      serverUrl: 'http://localhost:8000',
      displayName: 'Legacy Updated',
    });

    const stored = storedModels();
    expect(stored).toHaveLength(1); // updated, not duplicated
    expect(stored[0].displayName).toBe('Legacy Updated');
    expect(stored[0].systemMessageReplacementsFile).toBe(
      '.vllm/prompt-replacements-spartan.json',
    );
  });
});
