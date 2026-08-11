import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { loadModelPresets } from '../src/commands/presets.js';

/**
 * Direct tests for the presets module's fs-backed loader (loadModelPresets),
 * using the unit-test vscode mock's workspace.fs hooks (_mockFsReadDirectory /
 * _mockFsReadFile). This pins the loader so the extracted module is measured
 * and the directory/filter/parse behavior cannot regress silently.
 */
describe('loadModelPresets', () => {
  const encode = (s: string) => new TextEncoder().encode(s);
  let savedDir: any;
  let savedFile: any;

  beforeEach(() => {
    const ws = (vscode as any).workspace;
    savedDir = ws._mockFsReadDirectory;
    savedFile = ws._mockFsReadFile;
  });

  afterEach(() => {
    const ws = (vscode as any).workspace;
    ws._mockFsReadDirectory = savedDir;
    ws._mockFsReadFile = savedFile;
  });

  it('loads valid preset JSON and skips non-JSON and malformed entries', async () => {
    (vscode as any).workspace._mockFsReadDirectory = () =>
      Promise.resolve([
        ['Good-Preset.json', vscode.FileType.File],
        ['notes.txt', vscode.FileType.File],
        ['subdir', vscode.FileType.Directory],
        ['Broken-Preset.json', vscode.FileType.File],
      ]);
    (vscode as any).workspace._mockFsReadFile = (uri: string) => {
      if (String(uri).endsWith('Good-Preset.json')) {
        return Promise.resolve(
          encode('{ "vllmModelId": "org/Model", "modelModes": { "balanced": {} } }'),
        );
      }
      if (String(uri).endsWith('Broken-Preset.json')) {
        return Promise.resolve(encode('not json @@@'));
      }
      return Promise.resolve(new Uint8Array());
    };

    const presets = await loadModelPresets(vscode.Uri.file('/ext'));

    expect(presets).toHaveLength(1);
    expect(presets[0].sourceFile).toBe('Good-Preset.json');
    expect(presets[0].config.vllmModelId).toBe('org/Model');
  });

  it('returns [] when the model-configs directory cannot be read', async () => {
    (vscode as any).workspace._mockFsReadDirectory = () =>
      Promise.reject(new Error('ENOENT'));

    const presets = await loadModelPresets(vscode.Uri.file('/ext'));
    expect(presets).toEqual([]);
  });

  it('skips a preset whose file read fails', async () => {
    (vscode as any).workspace._mockFsReadDirectory = () =>
      Promise.resolve([['Good-Preset.json', vscode.FileType.File]]);
    (vscode as any).workspace._mockFsReadFile = () =>
      Promise.reject(new Error('EACCES'));

    const presets = await loadModelPresets(vscode.Uri.file('/ext'));
    expect(presets).toEqual([]);
  });
});
