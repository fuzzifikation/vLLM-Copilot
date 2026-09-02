import { describe, it, expect } from 'vitest';
import {
  buildEndpoint,
  resolveServerConfig,
} from '../src/config.js';

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
