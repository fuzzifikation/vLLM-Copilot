/**
 * Tripwires for the companion-facing core API added in 1.37.1 — the code the
 * dsh bridge consumes from the staged core. Named for the breakage each catches:
 * a healthy catalog pruned because an empty probe answer was read as "serves
 * nothing" (the 0.0.12 bridge accident), a probe failure silently becoming a
 * verdict, and two models sharing one display key.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveServedModels } from '../src/core/catalog/served.js';
import { buildDisplayKeys } from '../src/core/config/config.js';
import type { ModelConfig, ServerEntry } from '../src/core/index.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Failure',
    json: async () => payload,
  } as unknown as Response;
}

function vllmServer(id = 'srv', url = 'http://127.0.0.1:8123/v1'): ServerEntry {
  return { id, serverUrl: url, serverType: 'vllm' };
}

function model(id: string, server: string, vllmModelId?: string): ModelConfig {
  return { id, server, ...(vllmModelId ? { vllmModelId } : {}) };
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveServedModels', () => {
  it('answers served/absent by exact wire-id membership, keyed by config id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: 'wire-a' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const verdicts = await resolveServedModels(
      [model('a', 'srv', 'wire-a'), model('b', 'srv', 'wire-b')],
      [vllmServer()],
    );
    expect(verdicts.get('a')?.state).toBe('served');
    expect(verdicts.get('b')?.state).toBe('absent');
    expect(verdicts.get('b')?.reason).toContain('wire-b');
    // One probe for the whole group, not one per model.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats an EMPTY list as unknown, never as "serves nothing"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [] })));
    // Distinct URL per test: listServerModels' 5 s server-list memo would
    // otherwise hand this test the previous test's settled answer.
    const verdicts = await resolveServedModels([model('a', 'srv', 'wire-a')], [vllmServer('srv', 'http://127.0.0.1:8124/v1')]);
    expect(verdicts.get('a')?.state).toBe('unknown');
  });

  it('treats a failed probe as unknown and keeps the cause readable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)));
    const verdicts = await resolveServedModels([model('a', 'srv', 'wire-a')], [vllmServer('srv', 'http://127.0.0.1:8125/v1')]);
    expect(verdicts.get('a')?.state).toBe('unknown');
    expect(verdicts.get('a')?.reason).toContain('500');
  });

  it('calls a dangling server ref absent without probing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const verdicts = await resolveServedModels([model('a', 'nope', 'wire-a')], [vllmServer()]);
    expect(verdicts.get('a')?.state).toBe('absent');
    expect(verdicts.get('a')?.reason).toContain('nope');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('probes each server separately when the same wire id lives on two', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      jsonResponse({ data: url.includes('8126') ? [{ id: 'shared' }] : [{ id: 'other-model' }] }),
    ));
    const verdicts = await resolveServedModels(
      [model('here', 'srv-a', 'shared'), model('there', 'srv-b', 'shared')],
      [vllmServer('srv-a', 'http://127.0.0.1:8126/v1'), vllmServer('srv-b', 'http://127.0.0.1:8127/v1')],
    );
    expect(verdicts.get('here')?.state).toBe('served');
    expect(verdicts.get('there')?.state).toBe('absent');
  });
});

describe('buildDisplayKeys', () => {
  it('uniquifies display names and falls back to the wire id, never the registry id', () => {
    const keys = buildDisplayKeys([
      { id: 'm1 on host-8000', displayName: 'Workhorse', server: 'srv' },
      { id: 'm2 on host-8000', displayName: 'Workhorse', server: 'srv' },
      { id: 'm3 on host-8000', vllmModelId: 'deepseek/v4', server: 'srv' },
    ]);
    expect(keys.get('m1 on host-8000')).toBe('Workhorse');
    expect(keys.get('m2 on host-8000')).toBe('Workhorse (2)');
    // The hostname-embedding registry id must not leak into the key.
    expect(keys.get('m3 on host-8000')).toBe('deepseek/v4');
  });
});
