import { describe, it, expect } from 'vitest';
import {
  resolveServer,
  indexServers,
  generateServerId,
  toPublicServerEntry,
  serverEntryFingerprint,
  type ServerEntry,
} from '../src/serverRegistry.js';

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

// ── indexServers ────────────────────────────────────────────────────────

describe('indexServers', () => {
  it('builds a map from id to entry', () => {
    const a: ServerEntry = { id: 'a', serverUrl: 'http://a:1' };
    const b: ServerEntry = { id: 'b', serverUrl: 'http://b:2' };
    const map = indexServers([a, b]);
    expect(map.size).toBe(2);
    expect(map.get('a')).toBe(a);
    expect(map.get('b')).toBe(b);
    expect(map.get('c')).toBeUndefined();
  });

  it('handles an empty array', () => {
    expect(indexServers([]).size).toBe(0);
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

// ── toPublicServerEntry ─────────────────────────────────────────────────

describe('toPublicServerEntry', () => {
  it('strips requestHeaders and keeps everything else', () => {
    const entry: ServerEntry = {
      id: 's',
      displayName: 'My Server',
      serverType: 'ollama',
      serverUrl: 'http://h:11434',
      requestHeaders: { Authorization: 'Bearer test-key' },
    };
    expect(toPublicServerEntry(entry)).toEqual({
      id: 's',
      displayName: 'My Server',
      serverType: 'ollama',
      serverUrl: 'http://h:11434',
    });
  });
});

// ── serverEntryFingerprint ──────────────────────────────────────────────

describe('serverEntryFingerprint', () => {
  it('produces the same fingerprint for same URL + headers', () => {
    const a: ServerEntry = {
      id: 'a',
      serverUrl: 'http://h:8000',
      requestHeaders: { Authorization: 'Bearer test-key', 'X-A': '1' },
    };
    // Same facts, different id, different header order, un-normalized URL.
    const b: ServerEntry = {
      id: 'b',
      serverUrl: 'http://h:8000/',
      requestHeaders: { 'X-A': '1', Authorization: 'Bearer test-key' },
    };
    expect(serverEntryFingerprint(a)).toBe(serverEntryFingerprint(b));
  });

  it('produces different fingerprints for different headers', () => {
    const a: ServerEntry = { id: 'a', serverUrl: 'http://h:8000', requestHeaders: { 'X-A': '1' } };
    const b: ServerEntry = { id: 'b', serverUrl: 'http://h:8000', requestHeaders: { 'X-A': '2' } };
    expect(serverEntryFingerprint(a)).not.toBe(serverEntryFingerprint(b));
  });

  it('produces different fingerprints for different URLs', () => {
    const a: ServerEntry = { id: 'a', serverUrl: 'http://h:8000' };
    const b: ServerEntry = { id: 'b', serverUrl: 'http://h:8001' };
    expect(serverEntryFingerprint(a)).not.toBe(serverEntryFingerprint(b));
  });
});
