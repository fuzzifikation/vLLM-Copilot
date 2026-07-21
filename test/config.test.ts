import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { getConfig, buildEndpoint, normalizeServerUrl } from '../src/config.js';

/** Minimal fake ExtensionContext for config tests. */
function makeContext(): any {
  return { secrets: { get: async () => undefined } };
}

describe('normalizeServerUrl', () => {
  it('prepends http:// when scheme is missing', () => {
    expect(normalizeServerUrl('localhost:8000')).toBe('http://localhost:8000');
  });

  it('keeps http:// when already present', () => {
    expect(normalizeServerUrl('http://localhost:8000')).toBe('http://localhost:8000');
  });

  it('keeps https:// when already present', () => {
    expect(normalizeServerUrl('https://example.com')).toBe('https://example.com');
  });

  it('removes trailing slash when scheme is present', () => {
    expect(normalizeServerUrl('https://example.com/')).toBe('https://example.com');
  });

  it('removes trailing slashes when scheme is missing', () => {
    expect(normalizeServerUrl('localhost:8000///')).toBe('http://localhost:8000');
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
