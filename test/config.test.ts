import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { getConfig, buildEndpoint, normalizeServerUrl, resolveServerConfig, serverIdentity, modelServerIdentity, serverFingerprint, serverGroupKey } from '../src/config.js';

/** Minimal fake ExtensionContext for config tests. */
function makeContext(): any {
  return { secrets: { get: async () => undefined } };
}

describe('normalizeServerUrl', () => {
  it('prepends http:// when scheme is missing and host has a port', () => {
    expect(normalizeServerUrl('localhost:8000')).toBe('http://localhost:8000');
  });

  it('prepends https:// when scheme is missing and host has no port', () => {
    expect(normalizeServerUrl('example.com')).toBe('https://example.com');
  });

  it('prepends https:// for localhost without a port', () => {
    expect(normalizeServerUrl('localhost')).toBe('https://localhost');
  });

  it('prepends http:// for bare IP with port', () => {
    expect(normalizeServerUrl('192.168.1.50:8080')).toBe('http://192.168.1.50:8080');
  });

  it('keeps http:// when already present', () => {
    expect(normalizeServerUrl('http://localhost:8000')).toBe('http://localhost:8000');
  });

  it('keeps https:// when already present', () => {
    expect(normalizeServerUrl('https://example.com')).toBe('https://example.com');
  });

  it('recognizes and canonicalizes URI schemes case-insensitively', () => {
    expect(normalizeServerUrl('HTTPS://example.com/v1')).toBe('https://example.com');
    expect(normalizeServerUrl('HTTP://localhost:8000/')).toBe('http://localhost:8000');
  });

  it('removes trailing slash when scheme is present', () => {
    expect(normalizeServerUrl('https://example.com/')).toBe('https://example.com');
  });

  it('removes trailing slashes when scheme is missing', () => {
    expect(normalizeServerUrl('localhost:8000///')).toBe('http://localhost:8000');
  });

  it('strips trailing /v1 path segment', () => {
    expect(normalizeServerUrl('https://example.com/v1')).toBe('https://example.com');
  });

  it('strips /v1 even with trailing slash', () => {
    expect(normalizeServerUrl('https://example.com/v1/')).toBe('https://example.com');
  });

  it('strips /v1 when scheme was missing', () => {
    expect(normalizeServerUrl('localhost:8000/v1')).toBe('http://localhost:8000');
  });

  it('does not strip /v1 in a longer path', () => {
    expect(normalizeServerUrl('https://example.com/v1/models')).toBe('https://example.com/v1/models');
  });

  it('does not strip non-trailing /v1 segments', () => {
    expect(normalizeServerUrl('https://example.com/v1/proxy/v2')).toBe('https://example.com/v1/proxy/v2');
  });
});

describe('buildEndpoint', () => {
  it('joins base URL and path without leading slash', () => {
    expect(buildEndpoint('http://localhost:8000', 'v1/models')).toBe('http://localhost:8000/v1/models');
  });

  it('joins base URL and path with leading slash', () => {
    expect(buildEndpoint('http://localhost:8000', '/v1/models')).toBe('http://localhost:8000/v1/models');
  });

  it('handles HTTPS base URL', () => {
    expect(buildEndpoint('https://example.com', 'v1/chat/completions')).toBe('https://example.com/v1/chat/completions');
  });

  it('handles base URL with path prefix', () => {
    expect(buildEndpoint('http://localhost:8000/proxy', 'v1/models')).toBe('http://localhost:8000/proxy/v1/models');
  });

  it('handles path with multiple segments', () => {
    expect(buildEndpoint('http://localhost:8000', 'v1/chat/completions')).toBe('http://localhost:8000/v1/chat/completions');
  });
});

describe('serverIdentity (registry-resolved)', () => {
  const model = { id: 'm', server: 'srv' } as any;
  const entry = (overrides: Record<string, unknown> = {}) =>
    [{ id: 'srv', serverUrl: 'http://gw:8000', ...overrides } as any];

  it('fingerprints exactly the pair resolveServerConfig hands the request path', () => {
    const servers = entry({ requestHeaders: { Authorization: 'Bearer secret', Cookie: 'never-sent' } });
    const identity = modelServerIdentity(model, servers);
    const resolved = resolveServerConfig(model, servers)!;
    expect(identity.serverUrl).toBe(resolved.serverUrl);
    expect(identity.requestHeaders).toEqual(resolved.requestHeaders);
    // The hash is of THAT pair — so a server is one identity everywhere.
    expect(identity.fingerprint).toBe(serverFingerprint(resolved.serverUrl, resolved.requestHeaders));
  });

  it('is the same identity from a bare URL + headers as from a model + entry', () => {
    const headers = { Authorization: 'Bearer secret', Connection: 'keep-alive' };
    expect(serverIdentity('http://gw:8000', headers).fingerprint)
      .toBe(modelServerIdentity(model, entry({ requestHeaders: headers })).fingerprint);
  });

  it('drops headers that never reach the wire so a server keeps one identity', () => {
    const withBlocked = modelServerIdentity(model, entry({ requestHeaders: { Authorization: 'Bearer secret', Connection: 'keep-alive' } }));
    const without = modelServerIdentity(model, entry({ requestHeaders: { Authorization: 'Bearer secret' } }));
    expect(withBlocked.fingerprint).toBe(without.fingerprint);
  });

  it('ignores header order and URL spelling variants', () => {
    const a = modelServerIdentity(model, entry({ requestHeaders: { 'X-A': '1', 'X-B': '2' } }));
    const b = modelServerIdentity(model, entry({ serverUrl: 'http://gw:8000/v1/', requestHeaders: { 'X-B': '2', 'X-A': '1' } }));
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('case-folds header names — spelling is not identity — while values stay case-sensitive', () => {
    const upper = modelServerIdentity(model, entry({ requestHeaders: { Authorization: 'BeaR' } }));
    const lower = modelServerIdentity(model, entry({ requestHeaders: { authorization: 'BeaR' } }));
    expect(upper.fingerprint).toBe(lower.fingerprint);
    const otherValue = modelServerIdentity(model, entry({ requestHeaders: { Authorization: 'bear' } }));
    expect(upper.fingerprint).not.toBe(otherValue.fingerprint);
  });

  it('is empty when the server ref resolves to nothing', () => {
    const identity = modelServerIdentity({ id: 'm', server: 'ghost' } as any, entry());
    expect(identity.serverUrl).toBe('');
    expect(identity.requestHeaders).toEqual({});
  });
});

describe('serverGroupKey', () => {
  it('is deterministic, distinct per header identity, and leaks no header values', () => {
    const fpA = serverFingerprint('http://gw:8000', { Authorization: 'Bearer secret-a' });
    const fpB = serverFingerprint('http://gw:8000', { Authorization: 'Bearer secret-b' });
    const kA1 = serverGroupKey(fpA);
    const kA2 = serverGroupKey(fpA);
    const kB = serverGroupKey(fpB);
    expect(kA1).toBe(kA2);
    expect(kA1).not.toBe(kB);
    expect(kA1).toMatch(/^srv-/);
    // The key must not be (or contain) the raw fingerprint, which embeds secrets.
    expect(kA1).not.toContain('Bearer');
    expect(kA1).not.toContain('secret-a');
    expect(kA1).not.toBe(fpA);
  });
});
