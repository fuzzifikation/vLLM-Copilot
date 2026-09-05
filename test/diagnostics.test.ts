import { describe, it, expect } from 'vitest';
import { formatReport } from '../src/ui/diagnostics.js';
import type { DiagnosticReport } from '../src/ui/diagnostics.js';

/**
 * formatReport tests — focused on the "Transport comparison" block, which must
 * only suggest a certificate-chain problem when the Node fetch failure is
 * actually TLS-related — and even then as a possibility, not an asserted fact
 * (the two transport paths can differ in proxy routing or trust stores). A
 * non-TLS failure (e.g. a proxy routing issue) while the direct/system
 * transport succeeds is the proxy case, not a cert-chain case.
 */
function makeReport(overrides: Partial<DiagnosticReport> = {}): DiagnosticReport {
  return {
    extensionVersion: 'test',
    nodeVersion: 'v22.0.0',
    vscodeVersion: '1.125.0',
    platform: 'linux',
    targetUrl: 'https://host:8000',
    settings: {},
    env: {},
    nodeFetch: { ok: false, error: 'fetch failed', backend: 'OpenSSL (Node)' },
    nodeDirectFetch: { ok: true, status: 200, backend: 'Node https.request (direct transport)' },
    conclusion:
      "VS Code's fetch failed but direct Node transport succeeded — possible proxy or VS Code network configuration issue.",
    ...overrides,
  };
}

describe('formatReport credential redaction', () => {
  it('redacts user:password from the proxy server line', () => {
    const text = formatReport(makeReport({
      proxyInfo: { source: 'winhttp', server: 'http://user:secret@proxy.corp:8080', bypass: '<local>' },
    }));
    expect(text).not.toContain('secret');
    expect(text).toContain('http://<redacted>@proxy.corp:8080');
  });

  it('redacts user:password from the IE proxy server line', () => {
    const text = formatReport(makeReport({
      ieProxyInfo: { source: 'registry', enabled: true, server: 'http://alice:topsecret@ie-proxy:8080', bypass: '<local>' },
    }));
    expect(text).not.toContain('topsecret');
    expect(text).toContain('http://<redacted>@ie-proxy:8080');
  });

  it('redacts user:password from env proxy vars and the http.proxy setting', () => {
    const text = formatReport(makeReport({
      targetUrl: 'https://admin:sekret@host:8000',
      settings: { 'http.proxy': 'http://user:pw@proxy.corp:8080' },
      env: { HTTPS_PROXY: 'http://user:pw@proxy.corp:8080', NO_PROXY: '<local>' },
    }));
    expect(text).not.toContain('sekret');
    expect(text).not.toContain('pw@');
    expect(text).toContain('https://<redacted>@host:8000');
    expect(text).toContain('http://<redacted>@proxy.corp:8080');
  });
});
