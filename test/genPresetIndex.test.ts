import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRESET_CONFIG_KEYS as RUNTIME_KEYS } from '../src/commands/presets.js';
import { buildIndex, PRESET_CONFIG_KEYS as GEN_KEYS } from '../scripts/gen-preset-index.mjs';

/**
 * Guards the dependency-free index generator (scripts/gen-preset-index.mjs),
 * which runs standalone WITHOUT the strict suite — so it must refuse
 * presets the runtime guard would reject, and its mirrored allow-list must
 * never drift from the real one in src/commands/presets.ts.
 */
const tmp = mkdtempSync(join(tmpdir(), 'preset-index-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function dirWith(name: string, file: string, content: unknown): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(content));
  return dir;
}

const VALID = {
  presetVersion: 1,
  match: ['Test-Model'],
  config: { vllmModelId: 'org/Test-Model', modelModes: { balanced: {} } },
};

describe('gen-preset-index buildIndex', () => {
  it('mirrors the runtime PRESET_CONFIG_KEYS exactly (no drift)', () => {
    expect([...GEN_KEYS].sort()).toEqual([...RUNTIME_KEYS].sort());
  });

  it('accepts a valid v2 preset and emits { match, file }', () => {
    const dir = dirWith('valid', 'A.json', VALID);
    const index = buildIndex(dir);
    expect(index.schemaVersion).toBe(1);
    expect(index.presets).toEqual([{ match: ['Test-Model'], file: 'A.json' }]);
  });

  const rejects = (name: string, envelope: unknown, msg: RegExp) => {
    it(`rejects ${name}`, () => {
      const dir = dirWith(`rej-${name.replace(/\W+/g, '-')}`, 'B.json', envelope);
      expect(() => buildIndex(dir)).toThrow(msg);
    });
  };

  rejects('legacy envelope', { vllmModelId: 'x' }, /presetVersion/);
  rejects('empty match', { ...VALID, match: [] }, /non-empty match/);
  rejects('non-string match entry', { ...VALID, match: ['ok', 123] }, /non-empty strings/);
  rejects('missing config', { presetVersion: 1, match: ['x'] }, /config object/);
  rejects('forbidden config key', {
    ...VALID,
    config: { ...VALID.config, serverUrl: 'https://evil.example' },
  }, /unknown config key "serverUrl"/);
});
