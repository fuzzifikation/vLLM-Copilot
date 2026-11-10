import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelConfig } from '../src/core/config/config.js';
import type { ServerEntry } from '../src/core/config/serverRegistry.js';
import type { ModelPreset } from '../src/vscode/commands/presets.js';
import { parsePresetFile } from '../src/vscode/commands/presets.js';
import type { CopilotHarnessMapping } from '../src/vscode/state/config.js';
import { COPILOT_HARNESS_EFFORTS } from '../src/vscode/state/config.js';
import { maybeRunModelModeMigration } from '../src/vscode/migrations/modelModeMigration.js';

const bundled = { presets: [] as ModelPreset[] };

describe('existing model mode migration', () => {
  let models: Array<ModelConfig & { copilotHarnessMapping?: CopilotHarnessMapping }>;
  let servers: ServerEntry[];
  let marker: unknown;
  let workspaceMarker: unknown;
  let writeTarget: vscode.ConfigurationTarget;
  let globalFlags: Map<string, unknown>;
  let workspaceFlags: Map<string, unknown>;
  let context: Pick<vscode.ExtensionContext, 'extensionUri' | 'globalState' | 'workspaceState'>;
  let output: vscode.OutputChannel;
  let update: ReturnType<typeof vi.fn>;
  let info: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const general = { chat_template_kwargs: { enable_thinking: true }, temperature: 1 };
    const coding = { chat_template_kwargs: { enable_thinking: true }, temperature: 0.6 };
    const off = { chat_template_kwargs: { enable_thinking: false }, temperature: 0.7 };
    bundled.presets = [{
      sourceFile: 'Qwen.json',
      match: ['Qwen3.6-27B'],
      config: {
        modelModes: { 'Think-General': general, 'Think-Coding': coding, none: off },
        defaultMode: 'Think-General',
        copilotHarnessMapping: { high: 'Think-General' },
      },
    }];
    models = [{
      id: 'my-model', vllmModelId: 'Qwen/Qwen3.6-27B', server: 'srv',
      modelModes: structuredClone({ 'Think (General)': general, 'Think (Coding)': coding, 'No Think': off }),
      defaultMode: 'Think (General)', maxOutputTokens: [8192, 4096],
      maxInputTokens: 32768, personality: 'Spartan', autoContinueRetries: 2,
    }];
    servers = [{ id: 'srv', serverUrl: 'http://localhost:8000' }];
    marker = undefined;
    workspaceMarker = undefined;
    writeTarget = vscode.ConfigurationTarget.Global;
    globalFlags = new Map();
    workspaceFlags = new Map();
    update = vi.fn(async (key: string, value: unknown) => {
      if (key === 'models') models = value as typeof models;
    });
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get<T>(key: string): T | undefined {
        return (key === 'models' ? models : key === 'servers' ? servers : undefined) as T | undefined;
      },
      update, has: () => false,
      inspect: () => writeTarget === vscode.ConfigurationTarget.WorkspaceFolder
        ? { workspaceFolderValue: [], workspaceValue: [] }
        : writeTarget === vscode.ConfigurationTarget.Workspace ? { workspaceValue: [] } : undefined,
    } as vscode.WorkspaceConfiguration);
    context = {
      extensionUri: vscode.Uri.file('extension'),
      globalState: {
        get<T>(key: string): T | undefined { return globalFlags.get(key) as T | undefined; },
        async update(key: string, value: unknown) { globalFlags.set(key, value); marker = value; },
      },
      workspaceState: {
        get<T>(key: string): T | undefined { return workspaceFlags.get(key) as T | undefined; },
        async update(key: string, value: unknown) { workspaceFlags.set(key, value); workspaceMarker = value; },
      },
    };
    vi.spyOn(vscode.workspace.fs, 'readDirectory').mockImplementation(async () =>
      bundled.presets.map(preset => [preset.sourceFile, vscode.FileType.File]));
    vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(async uri => {
      const preset = bundled.presets.find(item => String(uri).endsWith(item.sourceFile));
      if (!preset) throw new Error('Unexpected preset file');
      return new TextEncoder().encode(JSON.stringify({
        presetVersion: 1, match: preset.match, config: preset.config, meta: preset.meta,
      }));
    });
    output = vscode.window.createOutputChannel('mode migration');
    log = vi.spyOn(output, 'appendLine');
    info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Migration must stay offline'); }));
  });

  afterEach(() => {
    output.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const run = () => maybeRunModelModeMigration(context as vscode.ExtensionContext, output);

  it('migrates the legacy names and missing mappings for every bundled preset', async () => {
    const directory = join(import.meta.dirname, '..', 'model-configs');
    for (const file of readdirSync(directory).filter(name => name.endsWith('.json') && name !== 'index.json')) {
      const preset = parsePresetFile(readFileSync(join(directory, file), 'utf8'), file)!;
      bundled.presets = [preset];
      marker = undefined;
      globalFlags.clear();
      const legacyName = (name: string) => name === 'none' ? 'No Think'
        : COPILOT_HARNESS_EFFORTS.includes(name as typeof COPILOT_HARNESS_EFFORTS[number])
          ? `Think (${name[0].toUpperCase()}${name.slice(1)})` : name;
      models = [{
        id: file, server: 'srv', vllmModelId: preset.match[0],
        // The Add flow saves the preset's config whole, so a real user entry
        // carries the shared baseline too. Omitting it here would fake a user
        // whose thinking controls vanished and make the migration's honest
        // "custom reasoning controls" refusal look like a bug.
        ...(preset.config.defaultParams ? { defaultParams: structuredClone(preset.config.defaultParams) } : {}),
        modelModes: Object.fromEntries(Object.entries(preset.config.modelModes!).map(([name, params]) =>
          [legacyName(name), structuredClone(params)])),
        ...(preset.config.defaultMode ? { defaultMode: legacyName(preset.config.defaultMode) } : {}),
      }];
      await run();
      expect(models[0].modelModes, file).toEqual(preset.config.modelModes);
      expect(models[0].copilotHarnessMapping, file).toEqual(preset.config.copilotHarnessMapping);
    }
  });

  it('keeps a mode name that would lie about the effort it sends', async () => {
    // DeepSeek-V4.1-Flash's old "Think-High" asks vLLM for "xhigh" (its "high"
    // is DeepSeek's 75-tier). The generic rename would publish "high" for a
    // request that still thinks at xhigh, so the name stays.
    const file = 'DeepSeek-V4.1-Flash.json';
    const preset = parsePresetFile(readFileSync(join(import.meta.dirname, '..', 'model-configs', file), 'utf8'), file)!;
    expect(preset.config.modelModes!.xhigh).toMatchObject({ reasoning_effort: 'xhigh' });
    bundled.presets = [preset];
    models = [{
      id: file, server: 'srv', vllmModelId: preset.match[0],
      modelModes: structuredClone({
        'Think (Max)': preset.config.modelModes!.max,
        'Think (High)': preset.config.modelModes!.xhigh,
        'No Think': preset.config.modelModes!.none,
      }),
      defaultMode: 'Think (High)',
    }];
    await run();
    expect(models[0].modelModes).toEqual({
      max: preset.config.modelModes!.max,
      'Think (High)': preset.config.modelModes!.xhigh,
      none: preset.config.modelModes!.none,
    });
    expect(models[0].defaultMode).toBe('Think (High)');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('it sends reasoning_effort "xhigh"'));
  });

  it('renames known modes, preserves customization and identity, and informs the user', async () => {
    writeTarget = vscode.ConfigurationTarget.Workspace;
    models[0].modelModes!['Think (General)'].temperature = 0.42;
    models[0].modelModes!['My Custom Mode'] = { temperature: 0.1 };
    const before = structuredClone(models[0]);
    await run();
    expect(models[0]).toEqual({
      ...before,
      modelModes: {
        'Think-General': before.modelModes!['Think (General)'],
        'Think-Coding': before.modelModes!['Think (Coding)'],
        none: before.modelModes!['No Think'],
        'My Custom Mode': before.modelModes!['My Custom Mode'],
      },
      defaultMode: 'Think-General',
      copilotHarnessMapping: { high: 'Think-General' },
    });
    expect(update).toHaveBeenCalledWith('models', models, vscode.ConfigurationTarget.Workspace);
    expect(workspaceMarker).toBe('done');
    expect(marker).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Your parameters were kept'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rewrites an existing user mapping instead of replacing its chosen aliases', async () => {
    models[0].copilotHarnessMapping = { max: 'Think (General)', none: 'No Think' };
    await run();
    // "No Think" becomes the effort token itself, so its alias is dead config
    // and goes away; the alias the user actually chose for "max" is kept.
    expect(models[0].copilotHarnessMapping).toEqual({ max: 'Think-General' });
  });

  it('does not let a completed global migration suppress a workspace override', async () => {
    const legacy = structuredClone(models);
    await run();
    expect(marker).toBe('done');
    writeTarget = vscode.ConfigurationTarget.Workspace;
    models = legacy;
    await run();
    expect(models[0].defaultMode).toBe('Think-General');
    expect(workspaceMarker).toBe('done');
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('leaves a colliding model unchanged while migrating other models', async () => {
    const collision = structuredClone(models[0]);
    collision.id = 'collision';
    collision.modelModes!['Think-General'] = { temperature: 0.25 };
    models.push(collision);
    await run();
    expect(models[0].defaultMode).toBe('Think-General');
    expect(models[1]).toEqual(collision);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('slug collision'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('manual review'));
  });

  it('migrates a workspace value exposed after removing an already-migrated folder override', async () => {
    const legacy = structuredClone(models);
    writeTarget = vscode.ConfigurationTarget.WorkspaceFolder;
    await run();
    expect(models[0].defaultMode).toBe('Think-General');
    models = legacy;
    writeTarget = vscode.ConfigurationTarget.Workspace;
    await run();
    expect(models[0].defaultMode).toBe('Think-General');
    expect(update).toHaveBeenCalledTimes(2);
  });

  it.each(['directory', 'file', 'empty', 'invalid'])('retries an incomplete preset catalogue (%s) instead of recording completion', async kind => {
    if (kind === 'directory') {
      vi.mocked(vscode.workspace.fs.readDirectory).mockRejectedValueOnce(new Error('temporary catalogue failure'));
    } else if (kind === 'file') {
      vi.mocked(vscode.workspace.fs.readFile).mockRejectedValueOnce(new Error('temporary preset failure'));
    } else if (kind === 'empty') {
      vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValueOnce([]);
    } else {
      vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(new TextEncoder().encode('{}'));
    }
    await run();
    expect(marker).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    await run();
    expect(models[0].copilotHarnessMapping).toEqual({ high: 'Think-General' });
    expect(marker).toBe('done');
  });

  it('repairs only exact old DeepSeek off-mode definitions, preserving custom variants', async () => {
    bundled.presets = [{
      sourceFile: 'DeepSeek-V4-Pro.json', match: ['DeepSeek-V4-Pro'],
      config: {
        modelModes: {
          none: { reasoning_effort: 'none', chat_template_kwargs: { thinking: false }, temperature: 1, top_p: 1 },
        },
        defaultMode: 'none',
      },
    }];
    models = [
      { id: 'exact', server: 'srv', vllmModelId: 'DeepSeek-V4-Pro', modelModes: { 'No Think': { temperature: 1, top_p: 1 } }, defaultMode: 'No Think' },
      { id: 'custom', server: 'srv', vllmModelId: 'DeepSeek-V4-Pro', modelModes: { 'No Think': { temperature: 0.4, top_p: 1 } }, defaultMode: 'No Think' },
      {
        id: 'custom-defaults', server: 'srv', vllmModelId: 'DeepSeek-V4-Pro',
        modelModes: { 'No Think': { temperature: 1, top_p: 1 } }, defaultMode: 'No Think',
        defaultParams: { chat_template_kwargs: { custom_option: 'keep' } },
      },
    ];
    await run();
    expect(models[0].modelModes!.none).toMatchObject({
      reasoning_effort: 'none', chat_template_kwargs: { thinking: false },
    });
    expect(models[0].copilotHarnessMapping).toBeUndefined();
    expect(models[1].modelModes!.none).toEqual({ temperature: 0.4, top_p: 1 });
    expect(models[1].copilotHarnessMapping).toBeUndefined();
    expect(models[2].modelModes!.none).toEqual({ temperature: 1, top_p: 1 });
    expect(models[2].defaultParams).toEqual({ chat_template_kwargs: { custom_option: 'keep' } });
    expect(models[2].copilotHarnessMapping).toBeUndefined();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('preset-control repairs'));
  });

  it('removes the ignored Agents-A1 flag from exact old modes even when aliases already exist', async () => {
    const file = 'Agents-A1-config.json';
    const preset = parsePresetFile(
      readFileSync(join(import.meta.dirname, '..', 'model-configs', file), 'utf8'), file,
    )!;
    bundled.presets = [preset];
    const modes = structuredClone(preset.config.modelModes!);
    for (const [name, params] of Object.entries(modes)) {
      if (name !== 'none') {
        const kwargs = params.chat_template_kwargs;
        if (!kwargs || typeof kwargs !== 'object') throw new Error('Expected preset template controls');
        params.chat_template_kwargs = { ...kwargs, preserve_thinking: true };
      }
    }
    models = [{ ...preset.config, id: 'agents', server: 'srv', vllmModelId: 'Agents-A1', modelModes: modes }];
    await run();
    expect(models[0].modelModes).toEqual(preset.config.modelModes);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('preset-control repairs'));
  });

  it('does not assign a misleading default harness choice to custom reasoning controls', async () => {
    models[0].modelModes!['Think (General)'].chat_template_kwargs = { enable_thinking: false };
    const params = structuredClone(models[0].modelModes!['Think (General)']);
    await run();
    expect(models[0].modelModes!['Think-General']).toEqual(params);
    expect(models[0].copilotHarnessMapping).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('custom reasoning controls'));
  });

  it('does not use bundled HF presets to invent OpenRouter mappings', async () => {
    servers[0].serverType = 'openrouter';
    // Without an effort-token mode of its own, this model has nothing to
    // publish, so the migration reports it instead of inventing aliases.
    delete models[0].modelModes!['No Think'];
    await run();
    expect(models[0].defaultMode).toBe('Think-General');
    expect(models[0].copilotHarnessMapping).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no matching bundled harness mapping'));
  });

  it('retries a failed write and does not repeat a successful migration', async () => {
    update.mockRejectedValueOnce(new Error('settings are not writable'));
    await run();
    expect(marker).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('retry next start'));
    await run();
    expect(marker).toBe('done');
    expect(update).toHaveBeenCalledTimes(2);
    await run();
    expect(update).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('does not mark an empty or temporarily unreadable model list as migrated', async () => {
    models = [];
    await run();
    expect(marker).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
