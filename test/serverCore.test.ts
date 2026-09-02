import { describe, it, expect } from 'vitest';
import { normalizeServerUrl, sanitizeRequestHeaders, sameHeaders } from '../src/serverCore.js';

/**
 * serverCore.ts is the leaf module every server identity flows through, so it is
 * tested on the bare functions — no registry, no client, no settings involved.
 */

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

  it('returns the localhost default sentinel for a host-less URL', () => {
    // Sentinel contract (see serverCore doc): never throws, never warns. The
    // migration planner must detect the host-less shape itself before calling.
    expect(normalizeServerUrl('http://')).toBe('http://localhost:8000');
    expect(normalizeServerUrl('https:///')).toBe('http://localhost:8000');
    expect(normalizeServerUrl('   ')).toBe('http://localhost:8000');
  });

  it('canonicalizes host case — one identity for fingerprints, entries and pollers', () => {
    expect(normalizeServerUrl('http://EXAMPLE.com:8000')).toBe('http://example.com:8000');
    expect(normalizeServerUrl('https://API.Example.COM/v1')).toBe('https://api.example.com');
    expect(normalizeServerUrl('HTTP://EXAMPLE.com')).toBe('http://example.com');
  });

  it('strips the scheme-default port — :80 on http and :443 on https are the same origin', () => {
    expect(normalizeServerUrl('http://example.com:80')).toBe('http://example.com');
    expect(normalizeServerUrl('https://example.com:443')).toBe('https://example.com');
    expect(normalizeServerUrl('http://EXAMPLE.com:80/v1')).toBe('http://example.com');
    expect(normalizeServerUrl('http://[::1]:80')).toBe('http://[::1]');
  });

  it('keeps a non-default port, even when it matches the other scheme\'s default', () => {
    expect(normalizeServerUrl('https://example.com:80')).toBe('https://example.com:80');
    expect(normalizeServerUrl('http://example.com:443')).toBe('http://example.com:443');
    expect(normalizeServerUrl('http://example.com:8080')).toBe('http://example.com:8080');
    expect(normalizeServerUrl('http://[::1]:8000')).toBe('http://[::1]:8000');
  });

  it('keeps userinfo (user:pass@) byte-exact — credentials are case-sensitive', () => {
    expect(normalizeServerUrl('http://User:PaSS@EXAMPLE.com:80')).toBe('http://User:PaSS@example.com');
  });
});

describe('sanitizeRequestHeaders', () => {
  it('allows valid custom headers', () => {
    const headers = sanitizeRequestHeaders({ 'X-Tenant-ID': 'abc123', 'X-Custom': 'hello' });
    expect(headers['X-Tenant-ID']).toBe('abc123');
    expect(headers['X-Custom']).toBe('hello');
  });

  it('collapses case-duplicate header names — last occurrence wins, surviving spelling kept', () => {
    // HTTP header names are case-insensitive; persisting `authorization` AND
    // `Authorization` meant requests carried the same header twice.
    const headers = sanitizeRequestHeaders({ authorization: 'first', Authorization: 'second', 'X-Tenant-ID': 'abc' });
    expect(headers['authorization']).toBeUndefined();
    expect(headers['Authorization']).toBe('second');
    expect(Object.keys(headers)).toEqual(['Authorization', 'X-Tenant-ID']);
  });

  it.each([
    ['host', 'evil.com'],
    ['Host', 'evil.com'],
    ['cookie', 'session=abc'],
    ['origin', 'https://evil.com'],
    ['connection', 'keep-alive'],
    ['content-length', '0'],
    ['transfer-encoding', 'chunked'],
    ['upgrade', 'websocket'],
    ['te', 'trailers'],
    ['trailer', 'Max-Forwards'],
  ])('strips blocked header: %s', (name, value) => {
    expect(sanitizeRequestHeaders({ [name]: value })[name]).toBeUndefined();
  });

  it('rejects header values with carriage return (CRLF injection)', () => {
    expect(sanitizeRequestHeaders({ 'X-Bad': 'value\r\nX-Injected: evil' })['X-Bad']).toBeUndefined();
  });

  it('rejects header values with newline', () => {
    expect(sanitizeRequestHeaders({ 'X-Bad': 'value\nX-Injected: evil' })['X-Bad']).toBeUndefined();
  });

  it('rejects header names with invalid characters', () => {
    expect(sanitizeRequestHeaders({ 'X Bad Header': 'value' })['X Bad Header']).toBeUndefined();
  });

  it('allows header names with valid special characters', () => {
    expect(sanitizeRequestHeaders({ 'X-Custom-Header': 'value' })['X-Custom-Header']).toBe('value');
  });

  it('strips multiple blocked headers but keeps valid ones', () => {
    const headers = sanitizeRequestHeaders({
      'host': 'evil.com',
      'X-Tenant': 'good',
      'cookie': 'session=123',
      'X-Proxy': 'also-good',
    });
    expect(headers['host']).toBeUndefined();
    expect(headers['cookie']).toBeUndefined();
    expect(headers['X-Tenant']).toBe('good');
    expect(headers['X-Proxy']).toBe('also-good');
  });
});

describe('sameHeaders (write-time connection comparison)', () => {
  it('is reflexive for the same map content', () => {
    const h = { 'X-A': '1' };
    expect(sameHeaders(h, { ...h })).toBe(true);
  });

  it('ignores header order and header-name spelling — the wire sees one header', () => {
    expect(sameHeaders({ 'X-B': '2', 'X-A': '1' }, { 'X-A': '1', 'X-B': '2' }))
      .toBe(true);
    expect(sameHeaders({ 'x-a': '1' }, { 'X-A': '1' }))
      .toBe(true);
  });

  it('separates maps that differ in a value or a header count (values are case-sensitive)', () => {
    expect(sameHeaders({ 'X-A': 'BeaR' }, { 'X-A': 'bear' })).toBe(false);
    expect(sameHeaders({ 'X-A': '1' }, {})).toBe(false);
    expect(sameHeaders({ 'X-A': '1' }, { 'X-A': '1', 'X-B': '2' })).toBe(false);
  });
});
