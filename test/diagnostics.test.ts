import { describe, it, expect } from 'vitest';
import { formatReport } from '../src/diagnostics.js';
import type { DiagnosticReport } from '../src/diagnostics.js';
import { TLS_CERT_SUGGESTION } from '../src/messageConverter.js';

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

describe('formatReport transport comparison', () => {
  it('does not claim an incomplete cert chain for a non-TLS (proxy) nodeFetch failure', () => {
    const text = formatReport(makeReport());
    expect(text).not.toContain('Transport comparison');
    expect(text).not.toContain('complete certificate chain');
  });

  it('suggests a cert-chain possibility only when the nodeFetch failure is TLS-related', () => {
    const text = formatReport(
      makeReport({
        nodeFetch: { ok: false, error: 'unable to verify the first certificate', backend: 'OpenSSL (Node)' },
        chain: { valid: false, errors: 'unable to verify the first certificate' },
      }),
    );
    expect(text).toContain('Transport comparison');
    // Conditional on purpose — a trust-store difference is a possibility, not a proven fact.
    expect(text).toContain('may mean the server is not sending the complete certificate chain');
  });

  it('does not emit the comparison when no other transport succeeded either', () => {
    const text = formatReport(
      makeReport({
        nodeFetch: { ok: false, error: 'unable to verify the first certificate', backend: 'OpenSSL (Node)' },
        nodeDirectFetch: { ok: false, error: 'connection refused', backend: 'Node https.request (direct transport)' },
        chain: { valid: false, errors: 'unable to verify the first certificate' },
      }),
    );
    expect(text).not.toContain('Transport comparison');
  });

  it('does not repeat the full suggestion when the conclusion already carries it', () => {
    const text = formatReport(
      makeReport({
        nodeFetch: { ok: false, error: 'unable to verify the first certificate', backend: 'OpenSSL (Node)' },
        chain: { valid: false, errors: 'unable to verify the first certificate' },
        conclusion: `TLS certificate verification failed in VS Code's fetch but succeeded in the system native test. ${TLS_CERT_SUGGESTION}`,
      }),
    );
    expect(text).toContain('Transport comparison');
    // The suggestion lives in the conclusion (printed last) — exactly once.
    expect(text.split(TLS_CERT_SUGGESTION)).toHaveLength(2);
  });
});

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
