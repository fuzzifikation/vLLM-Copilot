import * as vscode from 'vscode';
import { replaceModelConfig, patchModelConfig, type IdentifiedModelConfig, type ModelIdentity } from '../src/configStore.js';
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

  // Always yields an identified config (id + vllmModelId + serverUrl). The cast is
  // the helper's contract: identity tests deliberately construct invalid objects.
  const baseConfig = (overrides: Partial<ModelConfig> = {}): IdentifiedModelConfig =>
    ({
      id: 'test-model',
      vllmModelId: 'test-model',
      serverUrl: 'http://localhost:8000',
      displayName: 'Test Model',
      ...overrides,
    } as IdentifiedModelConfig);

  // Vitest aliases `vscode` to the unit-test mock (test/__mocks__/vscode.ts),
  // whose `workspace` exposes `_mockConfig`. The editor may resolve `vscode` to
  // either the mock or the real @types/vscode (which lacks it), so access the
  // hook through a cast valid under both.
  const mockWorkspace = () => (vscode as any).workspace as { _mockConfig: any };

  beforeEach(() => {
    existingConfig = [];
    updateSpy = vi.fn().mockResolvedValue(undefined);
    mockWorkspace()._mockConfig = {
      // get('models') reads the live `existingConfig` variable; other keys undefined.
      get: (key: string) => (key === 'models' ? existingConfig : undefined),
      update: updateSpy,
      // chat.byokUtilityModelDefault not registered → ensureByokUtilityDefault bails.
      inspect: () => undefined,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockWorkspace()._mockConfig = {};
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
        modelModes: { balanced: { reasoningEffort: 'medium' } },
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
        modelModes: { fast: { reasoningEffort: 'low' } },
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

describe('patchModelConfig (configStore) — patch semantics', () => {
  let existingConfig: ModelConfig[];
  let updateSpy: ReturnType<typeof vi.fn>;

  const identity = (overrides: Partial<ModelIdentity> = {}): ModelIdentity => ({
    id: 'test-model',
    serverUrl: 'http://localhost:8000',
    ...overrides,
  });

  const patch = (model: ModelConfig) => {
    const { id, serverUrl, ...updates } = model;
    return patchModelConfig(identity({ id: id || 'test-model', serverUrl }), updates);
  };

  beforeEach(() => {
    existingConfig = [];
    updateSpy = vi.fn().mockResolvedValue(undefined);
    vscode.workspace._mockConfig = {
      get: (key: string) => (key === 'models' ? existingConfig : undefined),
      update: updateSpy,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vscode.workspace._mockConfig = {};
  });

  const storedModels = (): ModelConfig[] => updateSpy.mock.calls[0][1] as ModelConfig[];

  it('preserves headers, family, defaults, and transport settings when the patch omits them', async () => {
    existingConfig = [
      {
        id: 'test-model',
        vllmModelId: 'test-model',
        serverUrl: 'http://localhost:8000',
        displayName: 'Test Model',
        requestHeaders: { 'X-Auth': 'secret' },
        family: 'qwen3_5',
        defaultParams: { temperature: 0.7 },
        defaultMode: 'balanced',
        streamInactivityTimeout: 60000,
        autoContinueRetries: 2,
        maxOutputTokens: 4096,
        modelModes: { balanced: { temperature: 0.5 } },
      },
    ];

    await patch({ id: 'test-model', serverUrl: 'http://localhost:8000', displayName: 'Renamed' });

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(
      expect.objectContaining({
        displayName: 'Renamed',
        requestHeaders: { 'X-Auth': 'secret' },
        family: 'qwen3_5',
        defaultParams: { temperature: 0.7 },
        defaultMode: 'balanced',
        streamInactivityTimeout: 60000,
        autoContinueRetries: 2,
        maxOutputTokens: 4096,
        modelModes: { balanced: { temperature: 0.5 } },
      }),
    );
  });

  it('replaces (not merges) requestHeaders when the patch supplies them', async () => {
    existingConfig = [
      {
        id: 'test-model',
        vllmModelId: 'test-model',
        serverUrl: 'http://localhost:8000',
        requestHeaders: { 'X-Old': 'value', 'X-Share': 'both' },
      },
    ];

    await patch({
      id: 'test-model',
      serverUrl: 'http://localhost:8000',
      requestHeaders: { 'X-New': 'value', 'X-Share': 'updated' },
    });

    const stored = storedModels();
    expect(stored[0].requestHeaders).toEqual({ 'X-New': 'value', 'X-Share': 'updated' });
    expect('X-Old' in (stored[0].requestHeaders ?? {})).toBe(false);
  });

  it('derives the composite id from vllmModelId when id and wire id differ (new entry)', async () => {
    await patch({
      id: 'preset-a',
      vllmModelId: 'wire-model',
      serverUrl: 'http://a:8000',
      displayName: 'Preset A',
    });

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    // buildModelId(serverUrl, wireId) — the wire id wins, not updates.id.
    expect(stored[0].id).toBe('wire-model on a:8000');
    expect(stored[0].vllmModelId).toBe('wire-model');
  });

  it('falls back to identity.id as the wire id when the patch has no vllmModelId (new entry)', async () => {
    await patch({ id: 'legacy-model', serverUrl: 'http://b:8000', displayName: 'Legacy' });

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect(stored[0].vllmModelId).toBe('legacy-model');
    expect(stored[0].id).toBe('legacy-model on b:8000');
  });

  it('reports created:true for a new entry and created:false for an update', async () => {
    const first = await patch({ id: 'new-model', serverUrl: 'http://localhost:8000' });
    expect(first.created).toBe(true);
    // The webview keys by the composite id; a follow-up patch on that id updates.
    const storedId = first.model.id;

    existingConfig = [first.model];
    const second = await patch({ id: storedId, serverUrl: 'http://localhost:8000', displayName: 'Renamed' });
    expect(second.created).toBe(false);
    expect(second.model.displayName).toBe('Renamed');
  });

  it('does not mutate the caller updates object', async () => {
    const updates = { id: 'new-model', serverUrl: 'http://localhost:8000', displayName: 'New' };
    const snapshot = { ...updates };
    await patch(updates);
    expect(updates).toEqual(snapshot);
  });

  it('3c: strips undefined-valued keys so a { displayName: undefined } patch cannot wipe the stored value', async () => {
    existingConfig = [
      {
        id: 'test-model',
        vllmModelId: 'test-model',
        serverUrl: 'http://localhost:8000',
        displayName: 'Test Model',
      },
    ];

    // Type-legal (Partial allows undefined); a caller passing an explicit
    // undefined key must not overwrite the stored value with undefined.
    await patchModelConfig(identity(), { displayName: undefined });

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect(stored[0].displayName).toBe('Test Model');
  });

  it('3c: performs no user-visible side effects — the handler owns the toast', async () => {
    existingConfig = [
      { id: 'test-model', vllmModelId: 'test-model', serverUrl: 'http://localhost:8000', displayName: 'Test Model' },
    ];
    const toastSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    await patch({ id: 'test-model', serverUrl: 'http://localhost:8000', displayName: 'Renamed' });

    expect(toastSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1); // the only write
  });

  it('3c: does not mutate the configured array or the existing entry', async () => {
    const original: ModelConfig[] = [
      { id: 'test-model', vllmModelId: 'test-model', serverUrl: 'http://localhost:8000', displayName: 'Test Model', family: 'qwen' },
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    vscode.workspace._mockConfig = {
      get: () => original,
      update: updateSpy,
    };

    await patch({ id: 'test-model', serverUrl: 'http://localhost:8000', displayName: 'Renamed' });

    expect(original).toEqual(snapshot); // array reference and entry both unchanged
  });

  it('3c: ignores id/serverUrl smuggled into updates — identity is immutable at runtime', async () => {
    existingConfig = [
      { id: 'real-id', vllmModelId: 'real-model', serverUrl: 'http://localhost:8000', displayName: 'Original' },
    ];

    // The Omit type boundary forbids this; the runtime must ignore it too.
    await patchModelConfig(
      identity({ id: 'real-id' }),
      { id: 'hijack', serverUrl: 'http://evil:8000', displayName: 'Hijacked' } as any,
    );

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('real-id');
    expect(stored[0].serverUrl).toBe('http://localhost:8000');
    expect(stored[0].displayName).toBe('Hijacked'); // legit update still applied
  });

  it('rejects a blank/whitespace serverUrl without writing', async () => {
    await expect(
      patchModelConfig(identity({ serverUrl: '   ' }), { displayName: 'X' }),
    ).rejects.toThrow(/serverUrl/);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects a blank identity id without writing', async () => {
    await expect(
      patchModelConfig(identity({ id: '   ' }), { displayName: 'X' }),
    ).rejects.toThrow(/identity/);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
