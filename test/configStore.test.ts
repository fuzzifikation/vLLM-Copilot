import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import { replaceModelConfig, patchModelConfig, readModels, writeModels, type IdentifiedModelConfig, type ModelIdentity } from '../src/state/configStore.js';
import { ModelConfig } from '../src/state/config.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** A ModelConfig with the required fields filled in (models reference registry entries by `server` id). */
function makeModelConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  const { id = 'test-model', vllmModelId = id, server = 'test-server', ...rest } = overrides;
  return { id, vllmModelId, server, ...rest };
}

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

  // Always yields an identified config (id + vllmModelId + server). The cast is
  // the helper's contract: identity tests deliberately construct invalid objects.
  const baseConfig = (overrides: Partial<ModelConfig> = {}): IdentifiedModelConfig =>
    makeModelConfig({ displayName: 'Test Model', ...overrides }) as IdentifiedModelConfig;

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

  it('a different server ref is a different identity — appends instead of updating', async () => {
    // Post-registry, identity is (id, server). Replacing an entry under a
    // different server reference must not silently retarget the stored model.
    existingConfig = [makeModelConfig({ server: 'srv-old', displayName: 'Old' })];

    await replaceModelConfig({ id: 'test-model', vllmModelId: 'test-model', server: 'srv-new', displayName: 'Retargeted' });

    const stored = storedModels();
    expect(stored).toHaveLength(2); // appended, not updated
    expect(stored[0]).toEqual(expect.objectContaining({ server: 'srv-old', displayName: 'Old' }));
    expect(stored[1]).toEqual(expect.objectContaining({ server: 'srv-new', displayName: 'Retargeted' }));
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

  it('replace-mode clears every clearable scalar field via an empty-string signal', async () => {
    existingConfig = [
      baseConfig({
        displayName: 'Test Model',
        maxOutputTokens: 8192,
        defaultMode: 'Think',
        defaultParams: { temperature: 0.7 },
        systemMessageReplacementsFile: '.vllm/prompt-replacements-tough-love.json',
      }),
    ];

    await replaceModelConfig(baseConfig({ displayName: '', maxOutputTokens: '', defaultMode: '', defaultParams: '' } as any));

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    // systemMessageReplacementsFile is covered by its own dedicated test above.
    for (const k of ['displayName', 'maxOutputTokens', 'defaultMode', 'defaultParams']) {
      expect(k in stored[0]).toBe(false);
    }
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
        server: 'test-server',
        displayName: 'Legacy',
        systemMessageReplacementsFile: '.vllm/prompt-replacements-spartan.json',
      },
    ];

    await replaceModelConfig({
      id: 'legacy-model',
      server: 'test-server',
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
      makeModelConfig({ id: 'preset-a', vllmModelId: 'shared-model', displayName: 'Preset A' }),
      makeModelConfig({ id: 'preset-b', vllmModelId: 'shared-model', displayName: 'Preset B' }),
    ];

    await replaceModelConfig({
      id: 'preset-b',
      vllmModelId: 'shared-model',
      server: 'test-server',
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
      makeModelConfig({ id: 'preset-a', vllmModelId: 'shared-model', displayName: 'Preset A' }),
    ];

    await replaceModelConfig({
      id: 'preset-b',
      vllmModelId: 'shared-model',
      server: 'test-server',
      displayName: 'Preset B',
    });

    const stored = storedModels();
    expect(stored).toHaveLength(2); // distinct id → new entry, not a merge into preset-a
    expect(stored.map(m => m.id)).toEqual(['preset-a', 'preset-b']);
  });

  // ── Step 1: replace-mode characterization (refactor-plan §4.1 #1/#2/#4) ──
  // These pin the CURRENT replace contract of replaceModelConfig (configStore) so the
  // configStore unification (step 3b) cannot silently change behavior.

  it('drops legacy server-fact keys that linger on the stored entry', async () => {
    // Pre-registry entries carried serverUrl/requestHeaders. The replacement is
    // written whole, so those stale keys must not survive a replace.
    existingConfig = [
      { ...baseConfig(), serverUrl: 'http://localhost:8000', requestHeaders: { 'X-Existing': 'keep-me' } } as unknown as ModelConfig,
    ];

    await replaceModelConfig(baseConfig({ displayName: 'Renamed' }));

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect('serverUrl' in stored[0]).toBe(false);
    expect('requestHeaders' in stored[0]).toBe(false);
  });

  it('replace-mode replaces (not merges) every model field', async () => {
    existingConfig = [
      baseConfig({ defaultParams: { 'X-Old': 'value' as never } }),
    ];

    await replaceModelConfig(
      baseConfig({ defaultParams: { 'X-New': 'value' as never } }),
    );

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect(stored[0].defaultParams).toEqual({ 'X-New': 'value' });
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

  it('preserves the replacements file while dropping stale model fields and legacy server facts', async () => {
    existingConfig = [
      {
        ...baseConfig({
          systemMessageReplacementsFile: '.vllm/prompt-replacements-spartan.json',
          family: 'llama',
          modelModes: { fast: { reasoningEffort: 'low' } },
        }),
        serverUrl: 'http://localhost:8000',
        requestHeaders: { 'X-Auth': 'secret' },
      } as unknown as ModelConfig,
    ];

    // Replacement is the preset path: the replacements file survives, model fields
    // drop, and legacy server facts do not resurrect (they live on the entry now).
    await replaceModelConfig(baseConfig({ displayName: 'Preset Applied' }));

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect(stored[0].systemMessageReplacementsFile).toBe(
      '.vllm/prompt-replacements-spartan.json',
    );
    expect('serverUrl' in stored[0]).toBe(false);
    expect('requestHeaders' in stored[0]).toBe(false);
    expect('family' in stored[0]).toBe(false);
    expect('modelModes' in stored[0]).toBe(false);
  });

  it('uses the id as passed when creating a new entry (no composite-id derivation)', async () => {
    const newModel = baseConfig({
      id: 'caller-supplied-id',
      vllmModelId: 'wire-model',
      server: 'test-server',
    });

    await replaceModelConfig(newModel);

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    // The caller's explicit id is preserved verbatim; the store must not
    // derive a composite "<model> on <host>" id on the replace path.
    expect(stored[0].id).toBe('caller-supplied-id');
  });

  it('rejects a blank/whitespace server ref instead of writing a malformed entry', async () => {
    await expect(
      replaceModelConfig(baseConfig({ server: '   ' })),
    ).rejects.toThrow(/server/);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects an entry with no id and no vllmModelId', async () => {
    // Destructure out both identity fields — what remains cannot satisfy
    // IdentifiedModelConfig, so the runtime guard (not the type) is under test.
    const { id: _id, vllmModelId: _vllmId, ...noIdentity } = baseConfig();
    await expect(
      replaceModelConfig({ ...noIdentity, server: 'test-server' } as any),
    ).rejects.toThrow(/identity/);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('3d: never persists undefined-valued fields on the replace path (no undefined displayName key)', async () => {
    existingConfig = [baseConfig({ displayName: 'Stored Name' })];

    // Replace mode replaces displayName wholesale — unlike patch it does NOT
    // preserve the previous value. The invariant under test is the narrower,
    // correct one: undefined is never written to config. The key must be
    // absent, not present-with-undefined.
    await replaceModelConfig(baseConfig({ displayName: undefined }));

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect('displayName' in stored[0]).toBe(false);
  });

  it('3d: strips undefined-valued fields on the append path too (brand-new entry)', async () => {
    await replaceModelConfig(
      baseConfig({ id: 'brand-new', vllmModelId: 'brand-new', displayName: undefined }),
    );

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect('displayName' in stored[0]).toBe(false);
  });

  it('3d: leaves nested undefined values inside nested objects untouched (top-level strip only)', async () => {
    await replaceModelConfig(
      baseConfig({
        id: 'nested',
        vllmModelId: 'nested',
        defaultParams: { temperature: undefined, top_p: 0.9 },
      }),
    );

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    // The narrowed contract: stripUndefined removes only top-level keys. A
    // nested undefined is left as-is; it is inert (reads and JSON serialization
    // treat absent and undefined identically). If this is ever made recursive,
    // the change must be deliberate and the doc updated to match.
    expect(stored[0].defaultParams).toEqual({ temperature: undefined, top_p: 0.9 });
  });
});

describe('patchModelConfig (configStore) — patch semantics', () => {
  let existingConfig: ModelConfig[];
  let updateSpy: ReturnType<typeof vi.fn>;

  const identity = (overrides: Partial<ModelIdentity> = {}): ModelIdentity => ({
    id: 'test-model',
    server: 'test-server',
    ...overrides,
  });

  const patch = (model: Partial<ModelConfig> & { id?: string }) => {
    const { id, server, ...updates } = model;
    return patchModelConfig(identity({ id: id || 'test-model', server: server || 'test-server' }), updates);
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

  it('preserves family, defaults, and transport settings when the patch omits them', async () => {
    existingConfig = [
      {
        id: 'test-model',
        vllmModelId: 'test-model',
        server: 'test-server',
        displayName: 'Test Model',
        family: 'qwen3_5',
        defaultParams: { temperature: 0.7 },
        defaultMode: 'balanced',
        streamInactivityTimeout: 60000,
        autoContinueRetries: 2,
        maxOutputTokens: 4096,
        modelModes: { balanced: { temperature: 0.5 } },
      },
    ];

    await patch({ id: 'test-model', displayName: 'Renamed' });

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(
      expect.objectContaining({
        displayName: 'Renamed',
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

  it('applies legit updates when server facts are smuggled into patch updates', async () => {
    // The webview never sends these; serverUrl/requestHeaders on a model entry
    // are inert extras now (no reader). patchModelConfig only guards identity
    // keys (id/server), so smuggled legacy keys ride the shallow merge —
    // pinned here so a future strict-mode strip is a deliberate choice.
    existingConfig = [
      makeModelConfig({ displayName: 'Clean' }),
    ];

    await patchModelConfig(identity(), {
      displayName: 'Sneaky',
      requestHeaders: { 'X-New': 'value' },
      serverUrl: 'http://evil:8000',
    } as any);

    const stored = storedModels();
    expect(stored[0].displayName).toBe('Sneaky'); // legit update applied
    expect((stored[0] as any).requestHeaders).toEqual({ 'X-New': 'value' });
  });

  it('creates a new entry with the identity verbatim (no composite-id derivation)', async () => {
    await patch({
      id: 'preset-a',
      server: 'a-server',
      vllmModelId: 'wire-model',
      displayName: 'Preset A',
    });

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    // Identity is written exactly as passed — no "<model> on <host>" derivation.
    expect(stored[0].id).toBe('preset-a');
    expect(stored[0].server).toBe('a-server');
    expect(stored[0].vllmModelId).toBe('wire-model');
  });

  it('falls back to identity.id as the wire id when the patch has no vllmModelId (new entry)', async () => {
    await patch({ id: 'legacy-model', server: 'b-server', displayName: 'Legacy' });

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect(stored[0].vllmModelId).toBe('legacy-model');
    expect(stored[0].id).toBe('legacy-model');
  });

  it('reports created:true for a new entry and created:false for an update', async () => {
    const first = await patch({ id: 'new-model', server: 'test-server' });
    expect(first.created).toBe(true);
    const storedId = first.model.id;

    existingConfig = [first.model];
    const second = await patch({ id: storedId, server: 'test-server', displayName: 'Renamed' });
    expect(second.created).toBe(false);
    expect(second.model.displayName).toBe('Renamed');
  });

  it('does not mutate the caller updates object', async () => {
    const updates = { id: 'new-model', server: 'test-server', displayName: 'New' };
    const snapshot = { ...updates };
    await patch(updates);
    expect(updates).toEqual(snapshot);
  });

  it('3c: strips undefined-valued keys so a { displayName: undefined } patch cannot wipe the stored value', async () => {
    existingConfig = [
      {
        id: 'test-model',
        vllmModelId: 'test-model',
        server: 'test-server',
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

  it("4a: patch-mode '' on clearable scalar fields deletes them (Save All clear semantics)", async () => {
    existingConfig = [
      makeModelConfig({
        displayName: 'Test Model', maxOutputTokens: 8192, maxInputTokens: 4096,
        estimateCharsPerToken: 4, streamInactivityTimeout: 30000, autoContinueRetries: 3,
        defaultMode: 'Think', defaultParams: { temperature: 0.7 },
      }),
    ];

    // The webview's save() sends '' for every empty [data-f] field and for an
    // emptied defaultParams. The store must map '' → delete so the clear sticks
    // (absent keys are otherwise preserved by the shallow merge).
    await patchModelConfig(identity(), {
      displayName: '', maxOutputTokens: '', maxInputTokens: '', estimateCharsPerToken: '',
      streamInactivityTimeout: '', initialResponseTimeoutMs: '', autoContinueRetries: '', defaultMode: '', defaultParams: '',
    } as any);

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    for (const k of ['displayName', 'maxOutputTokens', 'maxInputTokens', 'estimateCharsPerToken',
      'streamInactivityTimeout', 'initialResponseTimeoutMs', 'autoContinueRetries', 'defaultMode', 'defaultParams']) {
      expect(k in stored[0]).toBe(false);
    }
  });

  it("4a2: patch-mode '' clears the OpenRouter provider back to Auto (regression)", async () => {
    existingConfig = [
      {
        id: 'test-model', vllmModelId: 'test-model', server: 'or-server',
        provider: 'gmicloud/fp8',
      },
    ];

    // Selecting "Auto" in the Provider dropdown sends '' — the store must map
    // '' → delete so the key is REMOVED (undefined/omitted = Auto), not
    // persisted as `provider: ""`.
    await patchModelConfig(identity({ server: 'or-server' }), { provider: '' });

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect('provider' in stored[0]).toBe(false);
    expect((stored[0] as any).provider).toBeUndefined();
  });

  it('4b: a legitimate 0 is NOT cleared (streamInactivityTimeout 0 = infinite)', async () => {
    existingConfig = [
      makeModelConfig({ streamInactivityTimeout: 30000, autoContinueRetries: 1 }),
    ];

    // The clear check must be `=== ''`, not truthiness: 0 is a real value.
    await patchModelConfig(identity(), { streamInactivityTimeout: 0, autoContinueRetries: 0 } as any);

    const stored = storedModels();
    expect(stored[0].streamInactivityTimeout).toBe(0);
    expect(stored[0].autoContinueRetries).toBe(0);
  });

  it('3c: performs no user-visible side effects — the handler owns the toast', async () => {
    existingConfig = [
      makeModelConfig({ displayName: 'Test Model' }),
    ];
    const toastSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    await patch({ id: 'test-model', server: 'test-server', displayName: 'Renamed' });

    expect(toastSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1); // the only write
  });

  it('3c: does not mutate the configured array or the existing entry', async () => {
    const original: ModelConfig[] = [
      makeModelConfig({ displayName: 'Test Model', family: 'qwen' }),
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    vscode.workspace._mockConfig = {
      get: () => original,
      update: updateSpy,
    };

    await patch({ id: 'test-model', server: 'test-server', displayName: 'Renamed' });

    expect(original).toEqual(snapshot); // array reference and entry both unchanged
  });

  it('3c: ignores id/server smuggled into updates — identity is immutable at runtime', async () => {
    existingConfig = [
      makeModelConfig({ id: 'real-id', vllmModelId: 'real-model', displayName: 'Original' }),
    ];

    // The Omit type boundary forbids this; the runtime must ignore it too.
    await patchModelConfig(
      identity({ id: 'real-id' }),
      { id: 'hijack', server: 'evil-server', displayName: 'Hijacked' } as any,
    );

    const stored = storedModels();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('real-id');
    expect(stored[0].server).toBe('test-server');
    expect(stored[0].displayName).toBe('Hijacked'); // legit update still applied
  });

  it('rejects a blank/whitespace server ref without writing', async () => {
    await expect(
      patchModelConfig(identity({ server: '   ' }), { displayName: 'X' }),
    ).rejects.toThrow(/server/);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects a blank identity id without writing', async () => {
    await expect(
      patchModelConfig(identity({ id: '   ' }), { displayName: 'X' }),
    ).rejects.toThrow(/identity/);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

/**
 * `readModels` / `writeModels` are the only door to the `vllm-copilot.models`
 * setting, so the rules the server-registry migration depends on are pinned here:
 * whole-array write to the Global target, and a failed write that rejects instead
 * of silently reporting success.
 */
describe('readModels / writeModels (single settings access path)', () => {
  let existingConfig: ModelConfig[];
  let updateSpy: ReturnType<typeof vi.fn>;

  const mockWorkspace = () => (vscode as any).workspace as { _mockConfig: any };

  beforeEach(() => {
    existingConfig = [];
    updateSpy = vi.fn().mockResolvedValue(undefined);
    mockWorkspace()._mockConfig = {
      get: (key: string) => (key === 'models' ? existingConfig : undefined),
      update: updateSpy,
      inspect: () => undefined,
    };
  });

  afterEach(() => {
    mockWorkspace()._mockConfig = {};
  });

  it('writes the complete array to the Global target', async () => {
    const models = [
      makeModelConfig({ id: 'a', server: 'srv-a' }),
      makeModelConfig({ id: 'b', server: 'srv-b' }),
    ];
    await writeModels(models);
    expect(updateSpy).toHaveBeenCalledWith('models', models, vscode.ConfigurationTarget.Global);
  });

  it('rejects when the settings write fails, so a caller cannot report success', async () => {
    updateSpy.mockRejectedValueOnce(new Error('Settings file is read-only'));
    await expect(writeModels([])).rejects.toThrow('read-only');
  });

  it('reads an unset setting as an empty array', () => {
    mockWorkspace()._mockConfig = { get: () => undefined, update: updateSpy, inspect: () => undefined };
    expect(readModels()).toEqual([]);
  });

  it('reads the stored array without normalizing entries', () => {
    expect(readModels()).toBe(existingConfig);
  });
});

describe('settings contribution — scope contract', () => {
  // configStore ALWAYS writes ConfigurationTarget.Global. Without
  // "scope": "application" these settings are window-scoped, so a workspace
  // layer could shadow every read while every write landed in user settings —
  // the migration would then mark itself done over still-effective legacy
  // values, and add/edit/auth commands would write where nobody reads.
  // Pinning the scope in package.json is what makes read/write see one layer.
  it('models and servers are application-scoped', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((section: any) => section.properties),
    );
    expect(props['vllm-copilot.models'].scope).toBe('application');
    expect(props['vllm-copilot.servers'].scope).toBe('application');
  });
});
