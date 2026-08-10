import * as vscode from 'vscode';
import { replaceModelConfig } from '../src/configStore.js';
import { ModelConfig } from '../src/config.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Tests for the `replaceModelConfig` (configStore) personality merge semantics:
 * - `systemMessageReplacementsFile: undefined` preserves the previous value
 *   (auto-configure must not wipe a user's personality).
 * - empty string is an explicit clear (Set Model Personality → Default),
 *   which removes the property from the stored entry.
 * - a new value replaces the previous one.
 * - a brand-new entry drops empty-string replacements WITHOUT mutating the
 *   caller's object in place.
 */
describe('replaceModelConfig (configStore) — replace semantics', () => {
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
    await replaceModelConfig(baseConfig({ displayName: 'Renamed' }));

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

    await replaceModelConfig(baseConfig({ systemMessageReplacementsFile: '' }));

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect('systemMessageReplacementsFile' in stored[0]).toBe(false);
  });

  it('replaces the replacements file when a new value is set', async () => {
    existingConfig = [
      baseConfig({ systemMessageReplacementsFile: '.vllm/prompt-replacements-tough-love.json' }),
    ];

    await replaceModelConfig(
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

    await replaceModelConfig(newModel);

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

    await replaceModelConfig({
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

  it('P1: updates the correct preset when two share the same vllmModelId + server (keyed by id)', async () => {
    // Two distinct presets pointing at the same wire model on the same server —
    // this is the multi-preset scenario that previously collapsed to the first match.
    existingConfig = [
      { id: 'preset-a', vllmModelId: 'shared-model', serverUrl: 'http://localhost:8000', displayName: 'Preset A' },
      { id: 'preset-b', vllmModelId: 'shared-model', serverUrl: 'http://localhost:8000', displayName: 'Preset B' },
    ];

    await replaceModelConfig({
      id: 'preset-b',
      vllmModelId: 'shared-model',
      serverUrl: 'http://localhost:8000',
      displayName: 'Preset B (renamed)',
      systemMessageReplacementsFile: '.vllm/prompt-replacements-sarcastic-robot.json',
    });

    const stored = storedModels();
    expect(stored).toHaveLength(2); // not duplicated
    expect(stored.find(m => m.id === 'preset-a')).toEqual(
      expect.objectContaining({ displayName: 'Preset A' }),
    );
    expect(stored.find(m => m.id === 'preset-b')).toEqual(
      expect.objectContaining({
        displayName: 'Preset B (renamed)',
        systemMessageReplacementsFile: '.vllm/prompt-replacements-sarcastic-robot.json',
      }),
    );
  });

  it('P1: adding a preset whose id collides with nothing creates a new entry even if the wire id exists', async () => {
    existingConfig = [
      { id: 'preset-a', vllmModelId: 'shared-model', serverUrl: 'http://localhost:8000', displayName: 'Preset A' },
    ];

    await replaceModelConfig({
      id: 'preset-b',
      vllmModelId: 'shared-model',
      serverUrl: 'http://localhost:8000',
      displayName: 'Preset B',
    });

    const stored = storedModels();
    expect(stored).toHaveLength(2); // distinct id → new entry, not a merge into preset-a
    expect(stored.map(m => m.id)).toEqual(['preset-a', 'preset-b']);
  });

  // ── Step 1: replace-mode characterization (refactor-plan §4.1 #1/#2/#4) ──
  // These pin the CURRENT replace contract of replaceModelConfig (configStore) so the
  // configStore unification (step 3b) cannot silently change behavior.

  it('preserves requestHeaders when the new config omits them', async () => {
    existingConfig = [
      baseConfig({ requestHeaders: { 'X-Existing': 'keep-me' } }),
    ];

    await replaceModelConfig(baseConfig({ displayName: 'Renamed' }));

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect(stored[0].requestHeaders).toEqual({ 'X-Existing': 'keep-me' });
  });

  it('replaces (not merges) requestHeaders when the new config supplies them', async () => {
    existingConfig = [
      baseConfig({ requestHeaders: { 'X-Old': 'value', 'X-Share': 'both' } }),
    ];

    await replaceModelConfig(
      baseConfig({ requestHeaders: { 'X-New': 'value', 'X-Share': 'updated' } }),
    );

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    // Supplied headers replace the previous object wholesale — no key merging.
    expect(stored[0].requestHeaders).toEqual({ 'X-New': 'value', 'X-Share': 'updated' });
    expect('X-Old' in (stored[0].requestHeaders ?? {})).toBe(false);
  });

  it('drops stale model-specific fields absent from the replacement config', async () => {
    existingConfig = [
      baseConfig({
        modelModes: [{ id: 'balanced', reasoningEffort: 'medium' }],
        family: 'qwen',
        maxOutputTokens: 8192,
      }),
    ];

    // Replacement carries only infra/personal fields — no modelModes/family.
    await replaceModelConfig(baseConfig({ displayName: 'Reconfigured' }));

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect(stored[0].displayName).toBe('Reconfigured');
    expect('modelModes' in stored[0]).toBe(false);
    expect('family' in stored[0]).toBe(false);
    expect('maxOutputTokens' in stored[0]).toBe(false);
  });

  it('preserves infra/personal fields (serverUrl, requestHeaders, replacements) while dropping stale model fields', async () => {
    existingConfig = [
      baseConfig({
        serverUrl: 'http://localhost:8000',
        requestHeaders: { 'X-Auth': 'secret' },
        systemMessageReplacementsFile: '.vllm/prompt-replacements-spartan.json',
        family: 'llama',
        modelModes: [{ id: 'fast', reasoningEffort: 'low' }],
      }),
    ];

    // Replacement is the preset path: infra/personal survive, model fields drop.
    await replaceModelConfig(baseConfig({ displayName: 'Preset Applied' }));

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect(stored[0].serverUrl).toBe('http://localhost:8000');
    expect(stored[0].requestHeaders).toEqual({ 'X-Auth': 'secret' });
    expect(stored[0].systemMessageReplacementsFile).toBe(
      '.vllm/prompt-replacements-spartan.json',
    );
    expect('family' in stored[0]).toBe(false);
    expect('modelModes' in stored[0]).toBe(false);
  });

  it('uses the id as passed when creating a new entry (no composite-id derivation)', async () => {
    const newModel = baseConfig({
      id: 'caller-supplied-id',
      vllmModelId: 'wire-model',
      serverUrl: 'http://localhost:8000',
    });

    await replaceModelConfig(newModel);

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    // The caller's explicit id is preserved verbatim; the store must not
    // derive a composite "<model> on <host>" id on the replace path.
    expect(stored[0].id).toBe('caller-supplied-id');
  });

  it('rejects a blank/whitespace serverUrl instead of writing a malformed entry', async () => {
    await expect(
      replaceModelConfig(baseConfig({ serverUrl: '   ' })),
    ).rejects.toThrow(/serverUrl/);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects an entry with no id and no vllmModelId', async () => {
    // Destructure out both identity fields — what remains cannot satisfy
    // IdentifiedModelConfig, so the runtime guard (not the type) is under test.
    const { id: _id, vllmModelId: _vllmId, ...noIdentity } = baseConfig();
    await expect(
      replaceModelConfig({ ...noIdentity, serverUrl: 'http://localhost:8000' } as any),
    ).rejects.toThrow(/identity/);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
