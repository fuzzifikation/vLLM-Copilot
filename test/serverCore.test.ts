import { describe, it, expect } from 'vitest';
import { normalizeServerUrl, sanitizeRequestHeaders, serverFingerprint } from '../src/serverCore.js';

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

describe('serverFingerprint', () => {
  it('is stable for the same URL and headers', () => {
    expect(serverFingerprint('http://gw:8000', { 'X-A': '1' }))
      .toBe(serverFingerprint('http://gw:8000', { 'X-A': '1' }));
  });

  it('ignores header order and header-name spelling — the wire sees one header', () => {
    expect(serverFingerprint('http://gw:8000', { 'X-B': '2', 'X-A': '1' }))
      .toBe(serverFingerprint('http://gw:8000', { 'X-A': '1', 'X-B': '2' }));
    expect(serverFingerprint('http://gw:8000', { 'x-a': '1' }))
      .toBe(serverFingerprint('http://gw:8000', { 'X-A': '1' }));
  });

  it('separates servers that differ only in a header value or the URL', () => {
    expect(serverFingerprint('http://gw:8000', { 'X-A': 'BeaR' }))
      .not.toBe(serverFingerprint('http://gw:8000', { 'X-A': 'bear' }));
    expect(serverFingerprint('http://gw:8000', {}))
      .not.toBe(serverFingerprint('http://other:8000', {}));
  });
});
