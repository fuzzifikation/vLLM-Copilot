import { describe, it, expect } from 'vitest';
import { formatReport } from '../src/diagnostics.js';
import type { DiagnosticReport } from '../src/diagnostics.js';

/**
 * formatReport tests — focused on the "Transport comparison" block, which must
 * claim an incomplete certificate chain ONLY when the Node fetch failure is
 * actually TLS-related. A non-TLS failure (e.g. a proxy routing issue) while
 * the direct/system transport succeeds is the proxy case, not a cert-chain
 * case, and must not be misreported.
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

  it('claims an incomplete cert chain only when the nodeFetch failure is TLS-related', () => {
    const text = formatReport(
      makeReport({
        nodeFetch: { ok: false, error: 'unable to verify the first certificate', backend: 'OpenSSL (Node)' },
        chain: { valid: false, errors: 'unable to verify the first certificate' },
      }),
    );
    expect(text).toContain('Transport comparison');
    expect(text).toContain('complete certificate chain');
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
});
