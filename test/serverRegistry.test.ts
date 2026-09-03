import { describe, it, expect } from 'vitest';
import {
  resolveServer,
  generateServerId,
  entryMatchesConnection,
  dedupeServerIds,
  type ServerEntry,
} from '../src/state/serverRegistry.js';
import { resolveServerConfig, type ModelConfig } from '../src/state/config.js';

// ── resolveServer ───────────────────────────────────────────────────────

describe('resolveServer', () => {
  const servers: ServerEntry[] = [
    {
      id: 'main',
      displayName: 'Main Server',
      serverType: 'lmstudio',
      serverUrl: 'http://localhost:1234/',
      requestHeaders: { Authorization: 'Bearer test-key' },
    },
    { id: 'plain', serverUrl: 'http://other-host:8000' },
  ];

  it('resolves a found entry to an EffectiveServer', () => {
    const eff = resolveServer('main', servers);
    expect(eff).toEqual({
      serverUrl: 'http://localhost:1234',
      requestHeaders: { Authorization: 'Bearer test-key' },
      serverType: 'lmstudio',
      displayName: 'Main Server',
    });
  });

  it('returns undefined for an unknown id', () => {
    expect(resolveServer('nope', servers)).toBeUndefined();
  });

  it('defaults serverType to vllm when omitted', () => {
    const eff = resolveServer('plain', servers);
    expect(eff?.serverType).toBe('vllm');
    expect(eff?.requestHeaders).toEqual({});
    expect(eff?.displayName).toBeUndefined();
  });

  it('sanitizes headers (blocked names stripped)', () => {
    const entry: ServerEntry = {
      id: 's',
      serverUrl: 'http://h:8000',
      requestHeaders: {
        Authorization: 'Bearer test-key',
        Host: 'evil.example',
        Cookie: 'session=abc',
        'Content-Length': '999',
        'bad header': 'x',
        'X-Custom': 'ok',
      },
    };
    const eff = resolveServer('s', [entry]);
    expect(eff?.requestHeaders).toEqual({
      Authorization: 'Bearer test-key',
      'X-Custom': 'ok',
    });
  });

  it('normalizes the URL (scheme, trailing slash, /v1)', () => {
    const eff = resolveServer('s', [{ id: 's', serverUrl: 'example.com:8000/v1/' }]);
    expect(eff?.serverUrl).toBe('http://example.com:8000');
  });
});

// ── generateServerId ────────────────────────────────────────────────────

describe('generateServerId', () => {
  it('slugs a simple host with port', () => {
    expect(generateServerId('http://localhost:8000', new Set())).toBe('localhost-8000');
  });

  it('slugs host plus path tail', () => {
    expect(
      generateServerId('https://gw.example-corp.com/team-a/inference/gw-shared', new Set()),
    ).toBe('gw-example-corp-com-gw-shared');
  });

  it('appends -2 on collision with an existing id', () => {
    const existing = new Set(['localhost-8000']);
    expect(generateServerId('http://localhost:8000', existing)).toBe('localhost-8000-2');
  });

  it('keeps incrementing past taken suffixes', () => {
    const existing = new Set(['localhost-8000', 'localhost-8000-2']);
    expect(generateServerId('http://localhost:8000', existing)).toBe('localhost-8000-3');
  });

  it('slugs openrouter.ai URLs to openrouter', () => {
    expect(generateServerId('https://openrouter.ai/api', new Set())).toBe('openrouter');
  });

  it('slugs openrouter.ai subdomains to openrouter', () => {
    expect(generateServerId('https://gateway.openrouter.ai/api', new Set())).toBe('openrouter');
  });

  it('slugs a bare host with empty path', () => {
    expect(generateServerId('https://myserver.com', new Set())).toBe('myserver-com');
  });
});

// ── entryMatchesConnection ───────────────────────────────────────────────

describe('entryMatchesConnection', () => {
  it('matches an entry by URL + headers, ignoring id, order, and URL spelling', () => {
    const a: ServerEntry = {
      id: 'a',
      serverUrl: 'http://h:8000',
      requestHeaders: { Authorization: 'Bearer test-key', 'X-A': '1' },
    };
    // Same facts, different id is irrelevant, different header order,
    // un-normalized URL, different header-name spelling — one connection.
    expect(entryMatchesConnection(a, 'http://h:8000', { 'x-a': '1', authorization: 'Bearer test-key' }))
      .toBe(true);
  });

  it('rejects a different header value (credential isolation)', () => {
    const a: ServerEntry = { id: 'a', serverUrl: 'http://h:8000', requestHeaders: { 'X-A': '1' } };
    expect(entryMatchesConnection(a, 'http://h:8000', { 'X-A': '2' })).toBe(false);
    expect(entryMatchesConnection(a, 'http://h:8000', {})).toBe(false);
  });

  it('rejects a different URL', () => {
    const a: ServerEntry = { id: 'a', serverUrl: 'http://h:8000' };
    expect(entryMatchesConnection(a, 'http://h:8001', {})).toBe(false);
  });
});

// ── dedupeServerIds ──────────────────────────────────────────────────────

describe('dedupeServerIds', () => {
  it('first occurrence keeps its id, later duplicates get counter suffixes with all fields intact', () => {
    const servers: ServerEntry[] = [
      { id: 'box', serverUrl: 'http://a:8000' },
      { id: 'box', serverUrl: 'http://b:8000', serverType: 'ollama', displayName: 'Other', requestHeaders: { Authorization: 'Bearer x' } },
    ];
    const { servers: out, renames } = dedupeServerIds(servers);
    expect(renames).toEqual([{ from: 'box', to: 'box-2' }]);
    expect(out[0]).toBe(servers[0]); // untouched by reference — no needless write churn
    expect(out[1]).toEqual({ id: 'box-2', serverUrl: 'http://b:8000', serverType: 'ollama', displayName: 'Other', requestHeaders: { Authorization: 'Bearer x' } });
    // A model or command addressing box-2 now reaches THIS entry, not the first.
    expect(resolveServer('box-2', out)?.serverUrl).toBe('http://b:8000');
  });

  it('counter skips ids already taken elsewhere in the registry', () => {
    const servers: ServerEntry[] = [
      { id: 'box', serverUrl: 'http://a:8000' },
      { id: 'box-2', serverUrl: 'http://c:8000' },
      { id: 'box', serverUrl: 'http://b:8000' },
    ];
    const { servers: out, renames } = dedupeServerIds(servers);
    expect(renames).toEqual([{ from: 'box', to: 'box-3' }]);
    expect(new Set(out.map(s => s.id)).size).toBe(3);
  });

  it('unique ids pass through untouched with zero renames', () => {
    const servers: ServerEntry[] = [
      { id: 'a', serverUrl: 'http://a:8000' },
      { id: 'b', serverUrl: 'http://b:8000' },
    ];
    const { servers: out, renames } = dedupeServerIds(servers);
    expect(renames).toEqual([]);
    expect(out).toEqual(servers);
    expect(out[0]).toBe(servers[0]);
  });

  it('entries with a missing id are left to validateConfig, not renamed into fake-addressable ids', () => {
    const servers: ServerEntry[] = [
      { id: '', serverUrl: 'http://a:8000' },
      { id: '', serverUrl: 'http://b:8000' },
    ];
    const { servers: out, renames } = dedupeServerIds(servers);
    expect(renames).toEqual([]);
    expect(out).toEqual(servers);
  });
});

// ── resolveServerConfig (model-ref wrapper, folded from its old suite) ─
// The wrapper is a pass-through over resolveServer; normalization and
// sanitization are pinned above through resolveServer itself. What the
// wrapper exists for is the per-model view: exactly its own entry's
// credentials, never a sibling's.

describe('resolveServerConfig (model ref → registry entry)', () => {
  it('hands a model only its own entry request headers (isolated per server ref)', () => {
    const model: ModelConfig = { id: 'test', server: 'srv' };
    const withAuth: ServerEntry[] = [
      { id: 'srv', serverUrl: 'http://remote-server:9000', requestHeaders: { 'X-Key': 'a' } },
      { id: 'other', serverUrl: 'http://elsewhere:9000', requestHeaders: { 'X-Key': 'b' } },
    ];
    expect(resolveServerConfig(model, withAuth)?.requestHeaders).toEqual({ 'X-Key': 'a' });
  });
});
