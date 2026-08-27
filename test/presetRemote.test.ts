import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchRemotePreset, longestListMatch } from '../src/presetRemote.js';

/**
 * Tests for the live remote preset lookup (src/presetRemote.ts). fetch is
 * stubbed and routed by URL; nothing here touches the network. Every failure
 * path must resolve undefined — the Add flow continues with bundled presets.
 */
const BASE = 'https://raw.githubusercontent.com/fuzzifikation/vLLM-Copilot/main/model-configs';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const textResponse = (text: string, status = 200) =>
  new Response(text, { status, headers: { 'content-type': 'text/plain' } });

/** Route fetch by URL suffix; unmatched URLs 404. */
function stubFetch(routes: Record<string, Response | ((url: string) => Response)>) {
  const fn = vi.fn(async (url: string, _init?: RequestInit) => {
    for (const [key, val] of Object.entries(routes)) {
      if (String(url).endsWith(key)) {
        return typeof val === 'function' ? val(String(url)) : val;
      }
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const noLog = () => {};

const V2_PRESET = {
  presetVersion: 1,
  match: ['New-Model'],
  meta: { name: 'New Model', source: 'https://example.org/card', verified: '2026-08-27', notes: 'Card defaults.' },
  config: {
    vllmModelId: 'New-Model',
    modelModes: { Fast: { reasoning_effort: 'low' } },
    defaultMode: 'Fast',
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchRemotePreset', () => {
  it('fetches the winner file and returns a guarded remote preset', async () => {
    const fn = stubFetch({
      'index.json': jsonResponse({ schemaVersion: 1, presets: [{ match: ['New-Model'], file: 'New-Model.json' }] }),
      'New-Model.json': jsonResponse(V2_PRESET),
    });

    const preset = await fetchRemotePreset('neworg/New-Model-FP8', undefined, noLog);

    expect(preset).toBeDefined();
    expect(preset!.sourceFile).toBe('remote:New-Model.json');
    expect(preset!.config.vllmModelId).toBe('New-Model');
    expect(preset!.meta?.notes).toBe('Card defaults.');
    // Exactly two GETs: list + the one winner file. Never more.
    expect(fn).toHaveBeenCalledTimes(2);
    expect(String(fn.mock.calls[0][0])).toBe(`${BASE}/index.json`);
    expect(String(fn.mock.calls[1][0])).toBe(`${BASE}/New-Model.json`);
  });

  it('a miss costs ONE request (the list only) and returns undefined', async () => {
    const fn = stubFetch({
      'index.json': jsonResponse({ schemaVersion: 1, presets: [{ match: ['Other'], file: 'Other.json' }] }),
    });
    expect(await fetchRemotePreset('my-model', undefined, noLog)).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('skips the whole lookup when schemaVersion is newer than supported', async () => {
    const fn = stubFetch({
      'index.json': jsonResponse({ schemaVersion: 2, presets: [{ match: ['New-Model'], file: 'New-Model.json' }] }),
      'New-Model.json': jsonResponse(V2_PRESET),
    });
    expect(await fetchRemotePreset('New-Model', undefined, noLog)).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1); // never downloads a file from a future list
  });

  for (const [label, presets] of [
    ['object', {}],
    ['string', 'New-Model'],
    ['number', 42],
  ] as const) {
    it(`never throws when presets is a non-array ${label} (JSON-valid, not iterable)`, async () => {
      // A valid-JSON payload like {"presets":{}} must degrade to a silent
      // miss — iterating a non-array would throw and abort the whole Add flow.
      stubFetch({ 'index.json': jsonResponse({ schemaVersion: 1, presets }) });
      await expect(fetchRemotePreset('New-Model', undefined, noLog)).resolves.toBeUndefined();
    });
  }

  it('rejects path traversal in the list file field without fetching', async () => {
    const fn = stubFetch({
      'index.json': jsonResponse({ schemaVersion: 1, presets: [{ match: ['M'], file: '../evil.json' }] }),
    });
    expect(await fetchRemotePreset('M', undefined, noLog)).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects the WHOLE remote file on an unknown config key (asymmetric guard)', async () => {
    const evil = { ...V2_PRESET, config: { ...V2_PRESET.config, serverUrl: 'https://evil.example' } };
    const log = vi.fn();
    stubFetch({
      'index.json': jsonResponse({ schemaVersion: 1, presets: [{ match: ['New-Model'], file: 'New-Model.json' }] }),
      'New-Model.json': jsonResponse(evil),
    });
    expect(await fetchRemotePreset('New-Model', undefined, log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[WARN]'));
  });

  it('ignores unknown meta fields but keeps the preset (forward compat)', async () => {
    const withFutureMeta = { ...V2_PRESET, meta: { ...V2_PRESET.meta, futureBadge: 'wow' } };
    stubFetch({
      'index.json': jsonResponse({ schemaVersion: 1, presets: [{ match: ['New-Model'], file: 'New-Model.json' }] }),
      'New-Model.json': jsonResponse(withFutureMeta),
    });
    const preset = await fetchRemotePreset('New-Model', undefined, noLog);
    expect(preset).toBeDefined();
    expect((preset!.meta as Record<string, unknown>).futureBadge).toBeUndefined();
    expect(preset!.meta?.notes).toBe('Card defaults.');
  });

  it('rejects legacy (non-v2) remote files — the guard is the only format check', async () => {
    const log = vi.fn();
    stubFetch({
      'index.json': jsonResponse({ schemaVersion: 1, presets: [{ match: ['New-Model'], file: 'New-Model.json' }] }),
      'New-Model.json': jsonResponse({ vllmModelId: 'New-Model', modelModes: { x: {} } }),
    });
    expect(await fetchRemotePreset('New-Model', undefined, log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('rejected'));
  });

  it('is silent-undefined on offline, HTTP errors and malformed list JSON', async () => {
    // Offline: fetch itself throws (DNS/refused).
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    expect(await fetchRemotePreset('M', undefined, noLog)).toBeUndefined();

    // 500 on the list.
    stubFetch({ 'index.json': jsonResponse({}, 500) });
    expect(await fetchRemotePreset('M', undefined, noLog)).toBeUndefined();

    // Garbage list body.
    stubFetch({ 'index.json': textResponse('<html>not json</html>') });
    expect(await fetchRemotePreset('M', undefined, noLog)).toBeUndefined();
  });

  it('enforces the 64 KB size cap on preset files', async () => {
    const log = vi.fn();
    const fat = JSON.stringify({ ...V2_PRESET, padding: 'x'.repeat(65 * 1024) });
    stubFetch({
      'index.json': jsonResponse({ schemaVersion: 1, presets: [{ match: ['New-Model'], file: 'New-Model.json' }] }),
      'New-Model.json': textResponse(fat),
    });
    expect(await fetchRemotePreset('New-Model', undefined, log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('oversized'));
  });

  it('accepts preset files with // header comments (same loader as bundled)', async () => {
    const commented = `// authoring prose\n${JSON.stringify(V2_PRESET)}`;
    stubFetch({
      'index.json': jsonResponse({ schemaVersion: 1, presets: [{ match: ['New-Model'], file: 'New-Model.json' }] }),
      'New-Model.json': textResponse(commented),
    });
    expect(await fetchRemotePreset('New-Model', undefined, noLog)).toBeDefined();
  });

  it('never throws when the response body read rejects mid-download', async () => {
    // Response arrives but body read rejects (connection reset mid-download).
    vi.stubGlobal('fetch', vi.fn(async () => {
      return {
        ok: true,
        arrayBuffer: async () => {
          throw new TypeError('body stream aborted');
        },
      } as unknown as Response;
    }));
    expect(await fetchRemotePreset('M', undefined, noLog)).toBeUndefined();
  });
});

describe('longestListMatch', () => {
  const entries = [
    { match: ['DeepSeek-V4-Flash'], file: 'a.json' },
    { match: ['DeepSeek-V4-Flash-0731'], file: 'b.json' },
  ];

  it('longest matching pattern wins, case-insensitive', () => {
    expect(longestListMatch(entries, 'deepseek-v4-flash-0731-preview')?.file).toBe('b.json');
    expect(longestListMatch(entries, 'nvidia/DeepSeek-V4-Flash-NVFP4')?.file).toBe('a.json');
  });

  it('matches against the root too', () => {
    expect(longestListMatch(entries, 'alias-x', 'deepseek/DeepSeek-V4-Flash-0731')?.file).toBe('b.json');
  });

  it('skips entries with path characters or missing match arrays', () => {
    const nasty = [
      { match: ['M'], file: 'sub/dir/M.json' },
      { match: ['M'], file: 'M.json' },
    ];
    expect(longestListMatch(nasty, 'M')?.file).toBe('M.json');
    expect(longestListMatch([{ file: 'x.json' } as never], 'M')).toBeUndefined();
  });

  it('treats a non-array match as no patterns — never iterates it character-wise', () => {
    // A hostile/corrupt list entry { match: 'q' } must NOT be iterated as
    // single characters — a 1-char pattern would match nearly every model.
    const hostile = [{ match: 'q', file: 'evil.json' } as never];
    expect(longestListMatch(hostile, 'Qwen3.8-27B')).toBeUndefined();
    expect(longestListMatch(hostile, 'anything')).toBeUndefined();
  });
});
