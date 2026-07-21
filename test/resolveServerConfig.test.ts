import { describe, it, expect } from 'vitest';
import { resolveServerConfig, type ModelConfig } from '../src/config.js';

describe('resolveServerConfig', () => {
  it('returns empty config when override is undefined', () => {
    const result = resolveServerConfig(undefined);
    expect(result.serverUrl).toBe('');
    expect(result.requestHeaders).toEqual({});
  });

  it('returns empty config when override has no server-related fields', () => {
    const override: ModelConfig = { id: 'test' };
    const result = resolveServerConfig(override);
    expect(result.serverUrl).toBe('');
    expect(result.requestHeaders).toEqual({});
  });

  it('returns the model serverUrl when set', () => {
    const override: ModelConfig = {
      id: 'test',
      serverUrl: 'http://remote-server:9000',
    };
    const result = resolveServerConfig(override);
    expect(result.serverUrl).toBe('http://remote-server:9000');
    // A model with no headers gets an empty header set.
    expect(result.requestHeaders).toEqual({});
  });

  it('normalizes model serverUrl (adds scheme, strips trailing slash)', () => {
    const override: ModelConfig = { id: 'test', serverUrl: 'remote-server:9000/' };
    const result = resolveServerConfig(override);
    expect(result.serverUrl).toBe('http://remote-server:9000');
  });

  it('returns only the model\'s own request headers (isolated)', () => {
    const override: ModelConfig = {
      id: 'test',
      serverUrl: 'http://remote-server:9000',
      requestHeaders: { 'X-Model': 'model-value', 'X-Shared': 'model-shared' },
    };
    const result = resolveServerConfig(override);
    expect(result.requestHeaders).toEqual({
      'X-Model': 'model-value',
      'X-Shared': 'model-shared',
    });
  });

  it('sanitizes model requestHeaders (blocks forbidden names)', () => {
    const override: ModelConfig = {
      id: 'test',
      serverUrl: 'http://remote-server:9000',
      requestHeaders: { 'Host': 'evil.com', 'X-Model': 'ok' },
    };
    const result = resolveServerConfig(override);
    expect(result.requestHeaders).not.toHaveProperty('Host');
    expect(result.requestHeaders['X-Model']).toBe('ok');
  });

  it('sanitizes model requestHeaders (strips CRLF values)', () => {
    const override: ModelConfig = {
      id: 'test',
      serverUrl: 'http://remote-server:9000',
      requestHeaders: { 'X-Bad': 'value\r\nX-Injected: true' },
    };
    const result = resolveServerConfig(override);
    expect(result.requestHeaders).not.toHaveProperty('X-Bad');
  });

  it('handles both serverUrl and requestHeaders together', () => {
    const override: ModelConfig = {
      id: 'remote',
      serverUrl: 'https://remote.example.com',
      requestHeaders: { 'X-Tenant': 'abc123' },
    };
    const result = resolveServerConfig(override);
    expect(result.serverUrl).toBe('https://remote.example.com');
    expect(result.requestHeaders).toEqual({ 'X-Tenant': 'abc123' });
  });

  it('does not mutate the override', () => {
    const override: ModelConfig = {
      id: 'test',
      serverUrl: 'http://remote-server:9000',
      requestHeaders: { 'X-Model': 'model-value' },
    };
    resolveServerConfig(override);
    expect(override.requestHeaders).toEqual({ 'X-Model': 'model-value' });
  });
});