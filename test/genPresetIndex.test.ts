import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRESET_CONFIG_KEYS as RUNTIME_KEYS, parsePresetRawJson } from '../src/commands/presets.js';
import { buildIndex, stripComments as genStrip, PRESET_CONFIG_KEYS as GEN_KEYS } from '../scripts/gen-preset-index.mjs';

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

/**
 * PRESET-1: the two comment strippers must never disagree. The generator ran
 * standalone without the strict suite, so a divergence meant a preset the
 * extension accepted could fail the release build (or vice versa). Both
 * parsers are driven here over the same text — the public boundaries
 * (parsePresetRawJson / buildIndex), not the private strippers.
 */
describe('generator and runtime comment parsing agree', () => {
  /** A preset whose strings contain "//" and a trailing comment after a value. */
  const CORPUS = [
    {
      name: 'trailing comment after a string value',
      text: JSON.stringify({ ...VALID, meta: { source: 'https://example.test' } }, null, 2)
        .replace('"https://example.test"', '"https://example.test" // provenance link'),
    },
    {
      name: 'a bare URL in a string value (no comment at all)',
      text: JSON.stringify({ ...VALID, meta: { source: 'https://example.test/a//b' } }, null, 2),
    },
    {
      name: 'full-line comments above the envelope',
      text: '// authoring prose\n// second line\n' + JSON.stringify(VALID, null, 2),
    },
    {
      name: 'indented full-line comment inside the object',
      text: '{\n  // why this preset exists\n  "presetVersion": 1,\n  "match": ["Test-Model"],\n'
        + '  "config": { "vllmModelId": "org/Test-Model" }\n}\n',
    },
    {
      name: 'escaped quote before a comment',
      text: '{\n  "presetVersion": 1,\n  "match": ["a\\"//b"],\n'
        + '  "config": { "vllmModelId": "org/Test-Model" } // trailing\n}\n',
    },
  ];

  for (const { name, text } of CORPUS) {
    it(`runtime and generator both parse: ${name}`, () => {
      // Runtime boundary: must yield the envelope, not null.
      const runtime = parsePresetRawJson(text);
      expect(runtime, 'runtime parser rejected the file').not.toBeNull();

      // Generator boundary: must build an index, not throw.
      const dir = join(tmp, 'agree-' + name.replace(/\W+/g, '-'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'A.json'), text);
      expect(() => buildIndex(dir)).not.toThrow();

      // And both must yield the SAME envelope, so neither silently rewrites a
      // value the other keeps.
      expect(JSON.parse(genStrip(text))).toEqual(runtime);
    });
  }

  it('the generator stripper leaves URL values intact (regression guard)', () => {
    expect(JSON.parse(genStrip('{"a":"https://x.test//y"}'))).toEqual({ a: 'https://x.test//y' });
  });
});
