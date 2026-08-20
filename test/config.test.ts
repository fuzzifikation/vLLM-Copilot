import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { getConfig, buildEndpoint, normalizeServerUrl } from '../src/config.js';

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
