import { describe, it, expect } from 'vitest';
import { resolveServerConfig, type ModelConfig } from '../src/state/config.js';
import type { ServerEntry } from '../src/state/serverRegistry.js';

/**
 * Registry-based server resolution: a model's `server` ref looks up the
 * registry entry that owns its URL and credentials. A ref that does not
 * resolve yields `undefined` — the caller treats the model as unreachable.
 */
describe('resolveServerConfig', () => {
  const model: ModelConfig = { id: 'test', server: 'srv' };
  const servers: ServerEntry[] = [
    { id: 'srv', serverUrl: 'http://remote-server:9000' },
  ];

  it('returns the registry entry serverUrl', () => {
    const result = resolveServerConfig(model, servers);
    expect(result?.serverUrl).toBe('http://remote-server:9000');
    // An entry with no headers resolves to an empty header set.
    expect(result?.requestHeaders).toEqual({});
  });

  it('normalizes the entry serverUrl (adds scheme, strips trailing slash)', () => {
    const raw: ServerEntry[] = [{ id: 'srv', serverUrl: 'remote-server:9000/' }];
    expect(resolveServerConfig(model, raw)?.serverUrl).toBe('http://remote-server:9000');
  });

  it('returns only the resolved entry request headers (isolated per server)', () => {
    const withAuth: ServerEntry[] = [
      { id: 'srv', serverUrl: 'http://remote-server:9000', requestHeaders: { 'X-Key': 'a' } },
      { id: 'other', serverUrl: 'http://elsewhere:9000', requestHeaders: { 'X-Key': 'b' } },
    ];
    expect(resolveServerConfig(model, withAuth)?.requestHeaders).toEqual({ 'X-Key': 'a' });
  });

  it('resolves url and headers from the same entry together', () => {
    const both: ServerEntry[] = [
      {
        id: 'srv',
        serverUrl: 'https://remote.example.com',
        requestHeaders: { 'X-Tenant': 'abc123' },
      },
    ];
    const result = resolveServerConfig(model, both);
    expect(result?.serverUrl).toBe('https://remote.example.com');
    expect(result?.requestHeaders).toEqual({ 'X-Tenant': 'abc123' });
  });

  it('does not mutate the registry entry', () => {
    const entry: ServerEntry = {
      id: 'srv',
      serverUrl: 'http://remote-server:9000',
      requestHeaders: { 'X-Model': 'model-value' },
    };
    resolveServerConfig(model, [entry]);
    expect(entry.requestHeaders).toEqual({ 'X-Model': 'model-value' });
    expect(entry.serverUrl).toBe('http://remote-server:9000');
  });
});
