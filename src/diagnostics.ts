/**
 * Network diagnostics for corporate TLS / proxy issues.
 *
 * Runs platform-native and Node fetch against the same endpoint so an expert
 * (or AI) can determine whether a failure is a TLS trust gap, an auth problem,
 * a network/proxy issue, or something in our code.
 *
 * Platform-native fetch:
 *   - Windows:  PowerShell Invoke-WebRequest (SChannel / .NET)
 *   - macOS:    curl (Secure Transport)
 *   - Linux:    curl (OpenSSL or GnuTLS)
 *
 * Certificate chain inspection (only on TLS errors):
 *   - Windows:  SChannel chain via PowerShell
 *   - macOS:    openssl s_client
 *   - Linux:    openssl s_client
 *
 * The report is factual and neutral: each test shows what was tested and the
 * raw outcome (status code, error message). The conclusion is a neutral
 * recommendation — it distinguishes connectivity failures (server unreachable,
 * TLS error) from HTTP errors (401/403) that prove the server is reachable.
 */

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describeError } from './messageConverter.js';

const execFileAsync = promisify(execFile);

/** Result of a single fetch test (Node or platform-native). */
export interface FetchResult {
  /** Whether the HTTP request completed (got an HTTP response, any status). */
  ok: boolean;
  /** HTTP status code if a response was received. */
  status?: number;
  /** Error message if the request did not complete (no HTTP response). */
  error?: string;
  /** TLS backend used by this test (e.g. "SChannel", "Secure Transport", "OpenSSL"). */
  backend?: string;
}

/** Certificate chain inspection result. */
export interface CertChainResult {
  valid?: boolean;
  errors?: string;
  statuses?: string[];
  elements?: Array<{ subject?: string; issuer?: string; thumbprint?: string }>;
  error?: string;
}

/** Result of an auto-fix attempt for a TLS trust gap on Windows. */
export interface TlsFixResult {
  /** Whether a missing intermediate was found and exported. */
  exported: boolean;
  /** Path to the exported PEM file, if any. */
  pemPath?: string;
  /** The Subject of the intermediate that was exported. */
  intermediateSubject?: string;
  /** The env var to set (always NODE_EXTRA_CA_CERTS on Node). */
  envVar?: string;
  /** Error message if the export failed. */
  error?: string;
}

/** OS-level proxy configuration (WinHTTP on Windows, none elsewhere for now). */
export interface ProxyInfo {
  /** Source of the proxy config (e.g., "winhttp", "not-applicable"). */
  source: string;
  /** Proxy server address if configured. */
  server?: string;
  /** Bypass list if configured. */
  bypass?: string;
  /** Raw output for expert analysis. */
  raw?: string;
  /** Error message if detection failed. */
  error?: string;
}

/** Windows Internet Explorer proxy settings (registry). */
export interface IeProxyInfo {
  /** Source (always "registry" on Windows). */
  source: string;
  /** Whether proxy is enabled (ProxyEnable). */
  enabled: boolean;
  /** Proxy server address if enabled. */
  server?: string;
  /** Proxy bypass list if enabled. */
  bypass?: string;
  /** Whether the settings are user-configurable (`0` = managed by policy, `1` = user choice). */
  userChoice?: number;
  /** Error message if detection failed. */
  error?: string;
}

/** Full diagnostic report for one endpoint. */
export interface DiagnosticReport {
  extensionVersion: string;
  nodeVersion: string;
  vscodeVersion: string;
  platform: string;
  targetUrl: string;
  /** VS Code http.* settings that gate the patched fetch. */
  settings: Record<string, unknown>;
  /** Relevant env vars. */
  env: Record<string, string | undefined>;
  dns?: { host: string; resolved: string | null; error?: string };
  tcp?: { host: string; port: number; ok: boolean; error?: string };
  /** Platform-native fetch (SChannel / Secure Transport / system curl). */
  systemFetch?: FetchResult;
  /** Node fetch (VS Code patched fetch). */
  nodeFetch: FetchResult;
  /** Direct Node http/https request, without VS Code's patched fetch layer. */
  nodeDirectFetch: FetchResult;
  /** Certificate chain inspection (on TLS errors only). */
  chain?: CertChainResult;
  /** OS-level proxy configuration. */
  proxyInfo?: ProxyInfo;
  /** Internet Explorer proxy settings (Windows registry). */
  ieProxyInfo?: IeProxyInfo;
  /** Auto-fix attempt for Windows TLS trust gap (export missing intermediate). */
  tlsFix?: TlsFixResult;
  /** Neutral one-line conclusion / recommendation. */
  conclusion: string;
}

// Set at activation from context.extension.packageJSON.version so the
// version is always correct regardless of publisher/name.
let extensionVersion = 'unknown';

/** Set the extension version at activation (called from extension.ts). */
export function setExtensionVersion(v: string): void {
  extensionVersion = v;
}

function getExtensionVersion(): string {
  return extensionVersion;
}

/** Collect VS Code network settings that gate the patched fetch. */
function collectSettings(): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration('http');
  return {
    'http.proxy': config.get('proxy'),
    'http.noProxy': config.get('noProxy'),
    'http.proxySupport': config.get('proxySupport', 'override'),
    'http.fetchAdditionalSupport': config.get('fetchAdditionalSupport', true),
    'http.systemCertificates': config.get('systemCertificates', true),
    'http.proxyStrictSSL': config.get('proxyStrictSSL', true),
  };
}

/** Collect relevant env vars. */
function collectEnv(): Record<string, string | undefined> {
  return {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
  };
}

/** Resolve a hostname via dns.lookup. */
async function checkDns(host: string): Promise<DiagnosticReport['dns']> {
  try {
    const dns = await import('node:dns');
    const result = await dns.promises.lookup(host);
    return { host, resolved: result.address };
  } catch (err) {
    return { host, resolved: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Open a TCP socket to host:port with a 5s timeout. */
async function checkTcp(host: string, port: number): Promise<DiagnosticReport['tcp']> {
  try {
    const net = await import('node:net');
    return await new Promise<DiagnosticReport['tcp']>(resolve => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({ host, port, ok: false, error: 'timeout (5s)' });
      }, 5000);
      socket.once('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({ host, port, ok: true });
      });
      socket.once('error', err => {
        clearTimeout(timeout);
        resolve({ host, port, ok: false, error: err.message });
      });
      socket.connect(port, host);
    });
  } catch (err) {
    return { host, port, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Windows: PowerShell (SChannel) ──────────────────────────────────────

const POWERSHELL_CHAIN_SCRIPT = String.raw`
$target = $env:VLLM_DIAG_TARGET
$script:capture = $null
$oldCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
try {
  [System.Net.ServicePointManager]::ServerCertificateValidationCallback = {
    param($sender, $certificate, $chain, $sslPolicyErrors)
    $certs = @()
    if ($chain -ne $null) {
      foreach ($element in $chain.ChainElements) {
        $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $element.Certificate
        $certs += [PSCustomObject]@{
          subject = $c.Subject
          issuer = $c.Issuer
          thumbprint = $c.Thumbprint
        }
      }
    }
    $statuses = @()
    if ($chain -ne $null) {
      foreach ($status in $chain.ChainStatus) {
        $statuses += ($status.Status.ToString() + ': ' + ($status.StatusInformation.Trim()))
      }
    }
    $script:capture = [PSCustomObject]@{
      valid = ($sslPolicyErrors -eq [System.Net.Security.SslPolicyErrors]::None)
      errors = $sslPolicyErrors.ToString()
      statuses = $statuses
      elements = $certs
    }
    return $true
  }
  try {
    $request = [System.Net.HttpWebRequest]::Create($target)
    $request.Method = 'GET'
    $request.Timeout = 15000
    $request.ReadWriteTimeout = 15000
    $request.UserAgent = 'vLLM-Copilot-Diagnostic'
    $response = $request.GetResponse()
    $response.Close()
  } catch [System.Net.WebException] {
    if ($_.Exception.Response -ne $null) { $_.Exception.Response.Close() }
  }
  if ($script:capture -eq $null) {
    [PSCustomObject]@{ valid = $false; errors = 'No TLS callback received' } | ConvertTo-Json -Depth 4 -Compress
  } else {
    $script:capture | ConvertTo-Json -Depth 4 -Compress
  }
} finally {
  [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $oldCallback
}
`;

/** Windows: Run PowerShell (SChannel) to test the endpoint. */
async function runPowerShellTest(url: string, headers?: Record<string, string>): Promise<FetchResult> {
  // Build a single PowerShell hashtable string from all headers.
  // PowerShell syntax: @{ 'key1' = 'val1'; 'key2' = 'val2' }
  let headerParam = '';
  if (headers && Object.keys(headers).length > 0) {
    const pairs = Object.entries(headers).map(([k, v]) =>
      `'${k.replace(/'/g, "''")}' = '${v.replace(/'/g, "''")}'`
    );
    headerParam = `-Headers @{ ${pairs.join('; ')} }`;
  }
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:VLLM_DIAG_TARGET
try {
  $response = Invoke-WebRequest -Uri $target -UseBasicParsing -TimeoutSec 15 ${headerParam}
  [PSCustomObject]@{ ok = $true; status = $response.StatusCode } | ConvertTo-Json -Compress
} catch {
  $msg = $_.Exception.Message
  $code = ''
  if ($_.Exception.InnerException -and $_.Exception.InnerException.Status) {
    $code = $_.Exception.InnerException.Status.ToString()
  }
  $sc = $null
  try { $sc = [int]$_.Exception.Response.StatusCode } catch {}
  [PSCustomObject]@{ ok = $false; status = $sc; error = "$msg$(if ($code) { " [$code]" })" } | ConvertTo-Json -Compress
}
`;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 20000, windowsHide: true, env: { ...process.env, VLLM_DIAG_TARGET: url } }
    );
    const result = JSON.parse(stdout.trim());
    // PowerShell may output null for status when there was no HTTP response
    // (e.g., TLS error). Normalize null → undefined so our checks work.
    const status = result.status ?? undefined;
    return { ok: result.ok, status, error: result.error, backend: 'SChannel (.NET)' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), backend: 'SChannel (.NET)' };
  }
}

/** Windows: Run the SChannel cert chain build. */
async function runChainBuildWindows(url: string): Promise<CertChainResult> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_CHAIN_SCRIPT],
      { timeout: 25000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, VLLM_DIAG_TARGET: url } }
    );
    const result = JSON.parse(stdout.trim());
    return {
      valid: result.valid,
      errors: result.errors,
      statuses: result.statuses,
      elements: result.elements,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── macOS / Linux: curl ─────────────────────────────────────────────────

/** Detect curl's TLS backend from `curl --version`. */
async function detectCurlBackend(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('curl', ['--version'], { timeout: 5000 });
    // curl --version output varies by platform:
    //   macOS:    curl 8.7.1 (x86_64-apple-darwin23.0) libcurl/8.7.1 (Secure Transport) ...
    //   Linux:   curl 7.81.0 (x86_64-pc-linux-gnu) libcurl/7.81.0 OpenSSL/3.0.2 ...
    //   Linux:   curl 7.74.0 (x86_64-pc-linux-gnu) libcurl/7.74.0 GnuTLS/3.7.3 ...
    //   Windows: curl 8.0.1 (Windows) libcurl/8.0.1 Schannel ...
    // The first (...) is the platform, not the TLS backend. Search for
    // known backend names in the full output instead.
    if (/Secure Transport/i.test(stdout)) return 'Secure Transport';
    if (/OpenSSL/i.test(stdout)) return 'OpenSSL';
    if (/GnuTLS/i.test(stdout)) return 'GnuTLS';
    if (/Schannel/i.test(stdout)) return 'Schannel';
    if (/wolfSSL/i.test(stdout)) return 'wolfSSL';
    if (/mbedTLS/i.test(stdout)) return 'mbedTLS';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** macOS / Linux: Run curl to test the endpoint. */
async function runCurlTest(url: string, headers?: Record<string, string>): Promise<FetchResult> {
  const backend = await detectCurlBackend();
  const args = [
    '--silent', '--show-error',
    '--write-out', '\n%{http_code}',
    '--max-time', '15',
    '--output', '/dev/null',
  ];
  for (const [k, v] of Object.entries(headers ?? {})) {
    args.push('-H', `${k}: ${v}`);
  }
  args.push(url);
  try {
    const { stdout, stderr } = await execFileAsync('curl', args, { timeout: 20000 });
    const lines = stdout.trim().split('\n');
    const code = parseInt(lines[lines.length - 1], 10);
    if (code > 0) {
      return { ok: code >= 200 && code < 400, status: code, backend };
    }
    return { ok: false, error: stderr.trim() || 'No HTTP response', backend };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), backend };
  }
}

// ── Proxy detection ───────────────────────────────────────────────────

/** Detect OS-level proxy configuration on Windows via WinHTTP. */
async function detectWinHttpProxy(): Promise<ProxyInfo> {
  try {
    const { stdout } = await execFileAsync(
      'netsh',
      ['winhttp', 'show', 'proxy'],
      { timeout: 5000, windowsHide: true }
    );
    const raw = stdout.trim();
    // Output format:
    //   Current WinHTTP proxy settings:
    //     Proxy Server(s):  proxy.corp.example.com:8080
    //     Bypass List:     <local>;*.corp.example.com
    // OR:
    //   Current WinHTTP proxy settings:
    //     Direct access
    //     (no proxy server)
    const serverMatch = raw.match(/Proxy Server\(s\):\s*(.+)/i);
    const bypassMatch = raw.match(/Bypass List:\s*(.+)/i);
    return {
      source: 'winhttp',
      server: serverMatch?.[1]?.trim(),
      bypass: bypassMatch?.[1]?.trim(),
      raw,
    };
  } catch (err) {
    return {
      source: 'winhttp',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Get OS-level proxy info. Returns undefined if not applicable on this platform. */
async function getProxyInfo(): Promise<ProxyInfo | undefined> {
  if (process.platform === 'win32') {
    return detectWinHttpProxy();
  }
  // macOS/Linux: could read system proxy from networksetup or gsettings,
  // but for now focus on Windows where corporate proxy is most common.
  return undefined;
}

// ── Windows IE proxy settings (registry) ────────────────────────────────

/**
 * Read Internet Explorer proxy settings from the Windows registry.
 *
 * Group Policy can set these without the user knowing — they are separate
 * from WinHTTP settings and are what browsers use.
 *
 * Registry path: HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
 */
async function detectIeProxySettings(): Promise<IeProxyInfo | undefined> {
  if (process.platform !== 'win32') return undefined;
  try {
    // Use PowerShell to read the registry — it's available on all modern Windows.
    const script = String.raw`
$regPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$proxyEnable = (Get-ItemProperty -Path $regPath -ErrorAction Stop).ProxyEnable
$proxyServer = (Get-ItemProperty -Path $regPath -ErrorAction Stop).ProxyServer
$proxyOverride = (Get-ItemProperty -Path $regPath -ErrorAction Stop).ProxyOverride
$userChoice = (Get-ItemProperty -Path $regPath -ErrorAction Stop).UserChoice
[PSCustomObject]@{
  enabled = [bool]$proxyEnable
  server = $proxyServer
  bypass = $proxyOverride
  userChoice = [int]$userChoice
} | ConvertTo-Json -Compress
`;
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 10000, windowsHide: true }
    );
    const result = JSON.parse(stdout.trim());
    return {
      source: 'registry',
      enabled: !!result.enabled,
      server: result.server || undefined,
      bypass: result.bypass || undefined,
      userChoice: result.userChoice,
    };
  } catch (err) {
    return {
      source: 'registry',
      enabled: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** macOS / Linux: Inspect cert chain via openssl s_client. */
async function runChainBuildOpenSSL(url: string): Promise<CertChainResult> {
  const parsed = new URL(url);
  const port = parsed.port || '443';
  try {
    // openssl s_client reads from stdin; we pipe an empty string so it
    // connects, gets the cert chain, then closes on EOF.
    const { exec } = await import('node:child_process');
    const stdout = await new Promise<string>((resolve, reject) => {
      exec(
        `echo | openssl s_client -connect ${parsed.hostname}:${port} -showcerts 2>&1`,
        { timeout: 20000 },
        (err, stdout) => {
          if (err && !stdout) { reject(err); return; }
          resolve(stdout ?? '');
        }
      );
    });
    const elements: Array<{ subject?: string; issuer?: string }> = [];
    let currentSubject = '';
    let currentIssuer = '';
    let verifyError = '';
    for (const line of stdout.split('\n')) {
      if (/verify return code: 0/i.test(line)) {
        // verification OK
      } else if (/verify error:/i.test(line)) {
        verifyError = line.trim();
      }
      if (/subject=/i.test(line)) {
        currentSubject = line.replace(/.*subject=/i, '').trim();
      }
      if (/issuer=/i.test(line)) {
        currentIssuer = line.replace(/.*issuer=/i, '').trim();
      }
      if (/-----END CERTIFICATE-----/i.test(line) && (currentSubject || currentIssuer)) {
        elements.push({ subject: currentSubject, issuer: currentIssuer });
        currentSubject = '';
        currentIssuer = '';
      }
    }
    return {
      valid: !verifyError,
      errors: verifyError || 'none',
      elements,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Platform dispatch ───────────────────────────────────────────────────

/** Run the platform-native fetch test. Returns undefined if not supported. */
async function runSystemFetch(
  url: string,
  headers?: Record<string, string>,
): Promise<FetchResult | undefined> {
  switch (process.platform) {
    case 'win32':
      return runPowerShellTest(url, headers);
    case 'darwin':
    case 'linux':
      return runCurlTest(url, headers);
    default:
      return undefined;
  }
}

/**
 * Run a direct Node http/https request using the Node core API.
 * Uses the same underlying Node transport as VS Code's patched fetch,
 * but without the Fetch API layer — useful to isolate whether the
 * failure is specific to the Fetch implementation.
 */
async function runDirectNodeFetch(
  url: string,
  headers?: Record<string, string>,
): Promise<FetchResult> {
  const parsedUrl = new URL(url);
  const backend = parsedUrl.protocol === 'https:'
    ? 'Node https.request (direct transport)'
    : 'Node http.request (direct transport)';

  try {
    const transport = parsedUrl.protocol === 'https:'
      ? await import('node:https')
      : await import('node:http');
    return await new Promise<FetchResult>(resolve => {
      const request = transport.request(parsedUrl, {
        method: 'GET',
        headers: { ...(headers ?? {}) },
        timeout: 15000,
      }, response => {
        response.resume();
        response.once('end', () => {
          const status = response.statusCode;
          resolve({
            ok: status !== undefined && status >= 200 && status < 400,
            status,
            backend,
          });
        });
      });
      request.once('timeout', () => request.destroy(new Error('request timed out after 15s')));
      request.once('error', err => resolve({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        backend,
      }));
      request.end();
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      backend,
    };
  }
}

/** Run cert chain inspection. Returns undefined if not supported. */
async function runChainInspection(url: string): Promise<CertChainResult | undefined> {
  switch (process.platform) {
    case 'win32':
      return runChainBuildWindows(url);
    case 'darwin':
    case 'linux':
      return runChainBuildOpenSSL(url);
    default:
      return undefined;
  }
}

/**
 * Windows-only: attempt to auto-fix a TLS trust gap by exporting the missing
 * intermediate certificate from the Windows CA store to a PEM file.
 *
 * The chain inspection (`chain.elements`) gives us the chain as SChannel sees
 * it. The element whose issuer != itself and that isn't the leaf is the
 * intermediate. We search Cert:\LocalMachine\CA and Cert:\CurrentUser\CA for
 * a cert whose Subject matches that intermediate's Subject, export it as PEM,
 * and return the PEM path. The caller will advise setting NODE_EXTRA_CA_CERTS.
 */
async function tryExportMissingIntermediate(
  chain: CertChainResult | undefined,
): Promise<TlsFixResult | undefined> {
  if (process.platform !== 'win32') return undefined;
  if (!chain?.elements || chain.elements.length < 2) return undefined;

  // The intermediate is the element at index 1 (leaf=0, inter=1, root=last).
  // If only leaf+root (2 elements), there's no intermediate to export — the
  // server sent it and SChannel built it. If 3+ elements, element [1] is it.
  const intermediate = chain.elements[1];
  if (!intermediate?.subject) return undefined;

  // Don't export if the intermediate IS the root (self-signed, 2-element chain).
  if (chain.elements.length === 2) return undefined;

  const subject = intermediate.subject;
  // Escape single quotes for PowerShell.
  const psSubject = subject.replace(/'/g, "''");

  const script = String.raw`
$ErrorActionPreference = 'Stop'
$subj = '${psSubject}'
$cert = Get-ChildItem Cert:\LocalMachine\CA, Cert:\CurrentUser\CA -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -eq $subj } |
  Select-Object -First 1
if ($cert -eq $null) {
  [PSCustomObject]@{ found = $false } | ConvertTo-Json -Compress
  exit
}
$pem = Join-Path $env:USERPROFILE 'vllm-copilot-intermediate.pem'
$lines = [Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks')
$pemContent = "-----BEGIN CERTIFICATE-----" + [char]13 + [char]10 + $lines + [char]13 + [char]10 + "-----END CERTIFICATE-----"
$pemContent | Set-Content $pem -Encoding ascii
[PSCustomObject]@{ found = $true; pem = $pem; subject = $cert.Subject } | ConvertTo-Json -Compress
`;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 10000, windowsHide: true },
    );
    const result = JSON.parse(stdout.trim());
    if (!result.found) {
      return { exported: false, error: `Intermediate "${subject}" not found in Windows CA store` };
    }
    return {
      exported: true,
      pemPath: result.pem,
      intermediateSubject: result.subject,
      envVar: 'NODE_EXTRA_CA_CERTS',
    };
  } catch (err) {
    return {
      exported: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Human-readable label for the platform-native fetch test. */
function systemFetchLabel(): string {
  switch (process.platform) {
    case 'win32':
      return 'PowerShell (SChannel / .NET)';
    case 'darwin':
    case 'linux':
      return 'System curl';
    default:
      return 'System fetch';
  }
}

/**
 * Run a full diagnostic against the given endpoint URL.
 *
 * @param url - The endpoint URL to test.
 * @param requestHeaders - Optional auth/routing headers. Used by the Add Server
 *   flow where headers are in-memory (not yet in settings.json) so the
 *   diagnostic tests the same request the user just typed.
 */
export async function runDiagnostics(
  url: string,
  requestHeaders?: Record<string, string>,
): Promise<DiagnosticReport> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      extensionVersion: getExtensionVersion(),
      nodeVersion: process.version,
      vscodeVersion: vscode.version,
      platform: process.platform,
      targetUrl: url,
      settings: collectSettings(),
      env: collectEnv(),
      nodeFetch: { ok: false, error: 'Invalid URL' },
      nodeDirectFetch: { ok: false, error: 'Invalid URL', backend: 'Node direct transport' },
      conclusion: 'Invalid URL — cannot diagnose.',
    };

  }

  // Run all independent tests in parallel: DNS, TCP, system fetch, and Node fetch.
  // This reduces total time from ~40s (sequential) to ~15-20s (parallel).
  const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : (parsedUrl.protocol === 'https:' ? 443 : 80);
  const [dns, tcp, systemFetch, nodeFetchResult, nodeDirectFetch] = await Promise.all([
    checkDns(parsedUrl.hostname),
    checkTcp(parsedUrl.hostname, port),
    runSystemFetch(url, requestHeaders),
    (async (): Promise<FetchResult> => {
      try {
        const resp = await fetch(url, {
          headers: { ...(requestHeaders ?? {}) },
          signal: AbortSignal.timeout(15000),
        });
        return { ok: resp.ok, status: resp.status, backend: 'OpenSSL (Node)' };
      } catch (err) {
        return { ok: false, error: describeError(err), backend: 'OpenSSL (Node)' };
      }
    })(),
    runDirectNodeFetch(url, requestHeaders),
  ]);
  const nodeFetch = nodeFetchResult;

  // Chain inspection — if ANY fetch failed with a TLS error, inspect the chain.
  // This ensures we catch TLS issues even when they only appear in one transport.
  const tlsError = (r?: FetchResult) =>
    r && !r.ok && r.error && /verify|certificate|cert|ssl|tls|handshake/i.test(r.error);
  let chain: CertChainResult | undefined;
  if (tlsError(nodeFetch) || tlsError(systemFetch) || tlsError(nodeDirectFetch)) {
    chain = await runChainInspection(url);
  }

  // Collect settings once for conclusion logic and report.
  const settings = collectSettings();

  // Proxy info — detect OS-level proxy configuration.
  // IE proxy settings (Windows registry) — Group Policy can set these silently.
  // Both are independent — run in parallel.
  const [proxyInfo, ieProxyInfo] = await Promise.all([
    getProxyInfo(),
    detectIeProxySettings(),
  ]);

  // ── Conclusion ──
  // Node-fetch-centric: we're diagnosing whether VS Code's patched fetch works.
  // The system fetch (SChannel / curl) is only comparison context — if Node
  // fails with TLS but system succeeds, that confirms a cert trust gap.
  //
  // Key insight: if Node fetch got ANY HTTP response (status !== undefined),
  // the server is reachable. For HTTPS, TLS is valid by definition. For HTTP,
  // there is no TLS.
  let conclusion: string;
  let reportTlsFix: TlsFixResult | undefined;

  const nodeTlsError = tlsError(nodeFetch);
  // "System TLS succeeded" = system fetch got ANY HTTP response (even 401/500).
  // A 401 from the system means TLS worked — the cert verified, auth didn't.
  const systemTlsSucceeded = systemFetch?.status !== undefined;
  // Whether the direct transport also succeeded (any HTTP response).
  const directTlsSucceeded = nodeDirectFetch?.status !== undefined;
  const isHttps = parsedUrl.protocol === 'https:';
  const tlsOkPhrase = isHttps ? 'TLS is valid' : 'connection succeeded (HTTP, no TLS)';

  if (nodeFetch.ok) {
    // VS Code fetch got a 2xx — server is up.
    conclusion = `Server is reachable and ${tlsOkPhrase}. If Copilot chat still fails, the issue is in model config, streaming, or request format — not connectivity.`;
  } else if (nodeFetch.status === 401 || nodeFetch.status === 403) {
    // VS Code fetch got through TLS and received an HTTP response — TLS works.
    conclusion = `Server is reachable and ${tlsOkPhrase}. The request was rejected with 401/403 — the API key or requestHeaders are missing or incorrect.`;
  } else if (nodeFetch.status === 407) {
    // Proxy authentication required.
    conclusion = `Server is reachable and ${tlsOkPhrase}, but a proxy returned HTTP 407 (Proxy Authentication Required). Check http.proxy and proxy credentials.`;
  } else if (nodeFetch.status !== undefined && nodeFetch.status >= 500) {
    // VS Code fetch got through TLS — server is erroring.
    conclusion = `Server is reachable and ${tlsOkPhrase}, but the server returned HTTP ${nodeFetch.status} — the vLLM server itself is erroring. Check the vLLM server logs.`;
  } else if (nodeFetch.status !== undefined) {
    // VS Code fetch got through TLS but got an unexpected status (404, 405, etc.).
    conclusion = `Server is reachable and ${tlsOkPhrase}, but returned HTTP ${nodeFetch.status}. Check the serverUrl and endpoint path — the server may not serve this route.`;
  } else if (nodeTlsError) {
    // VS Code fetch CANNOT verify the cert — the critical diagnosis.
    // Check settings collected earlier (local variable `settings`, not the report yet).
    // Settings use dot-notation keys (e.g., 'http.systemCertificates').
    const sysCertsDisabled = settings['http.systemCertificates'] === false;
    const proxySupportOff = settings['http.proxySupport'] === 'off';
    // Try to auto-fix a Windows TLS trust gap by exporting the missing
    // intermediate from the Windows CA store to a PEM file.
    let tlsFix: TlsFixResult | undefined;
    if ((systemTlsSucceeded || directTlsSucceeded) && !sysCertsDisabled && !proxySupportOff) {
      tlsFix = await tryExportMissingIntermediate(chain);
    }
    if (proxySupportOff) {
      conclusion = `TLS certificate verification failed in VS Code's fetch — http.proxySupport is set to 'off', which disables proxy usage. If you're behind a corporate proxy, set it to 'override' or 'override-default'.`;
    } else if (sysCertsDisabled) {
      conclusion = `TLS certificate verification failed in VS Code's fetch — http.systemCertificates is set to false, which disables loading OS certificates. Set it to true and restart VS Code.`;
    } else if (systemTlsSucceeded || directTlsSucceeded) {
      // System succeeded but Node didn't — the server is not sending the full
      // certificate chain. Node's OpenSSL requires the complete chain, while
      // SChannel can retrieve missing intermediates from the OS trust store.
      const intermediate = tlsFix?.intermediateSubject || chain?.elements?.[1]?.subject?.split(',')[0]?.replace('CN=', '');
      if (intermediate) {
        conclusion = `TLS certificate verification failed — the server is not sending the intermediate certificate ("${intermediate}"). This certificate exists in the OS trust store, so SChannel succeeds, but Node's OpenSSL requires the full chain. The server administrator should configure the server to send the complete certificate chain.`;
      } else {
        conclusion = `TLS certificate verification failed in Node but succeeded in the system native test — the server's certificate chain is incomplete. The server administrator should configure the server to send the complete certificate chain.`;
      }
      reportTlsFix = tlsFix;
    } else {
      conclusion = 'TLS certificate verification failed in all transports — the server\'s certificate chain is incomplete or untrusted. The server administrator should configure the server to send the complete certificate chain.';
    }
  } else if (!dns?.resolved) {
    conclusion = 'DNS resolution failed — the host cannot be resolved. Check the serverUrl or network/DNS configuration.';
  } else if (dns?.resolved && !tcp?.ok) {
    conclusion = `TCP connect to ${dns.resolved}:${port} failed — host is unreachable (firewall, host down, or wrong port).`;
  } else {
    // Node fetch failed without a TLS error and without DNS/TCP failure.
    if (systemTlsSucceeded || directTlsSucceeded) {
      const successPath = systemTlsSucceeded ? 'system native test' : 'direct Node transport';
      conclusion = `VS Code's fetch failed but ${successPath} succeeded — possible proxy or VS Code network configuration issue. Check http.proxy, http.proxySupport, and http.systemCertificates settings.`;
    } else {
      conclusion = 'No HTTP response received from any transport — likely a network or proxy issue. Check http.proxy, proxy auth (407), or server availability.';
    }
  }

  return {
    extensionVersion: getExtensionVersion(),
    nodeVersion: process.version,
    vscodeVersion: vscode.version,
    platform: process.platform,
    targetUrl: url,
    settings,
    env: collectEnv(),
    dns,
    tcp,
    systemFetch,
    nodeFetch,
    nodeDirectFetch,
    chain,
    proxyInfo,
    ieProxyInfo,
    tlsFix: reportTlsFix,
    conclusion,
  };
}

/** Format a fetch result for display. */
function formatFetchResult(label: string, r?: FetchResult): string[] {
  if (!r) {
    return [`— ${label} —`, '  (not available on this platform)', ''];
  }
  const backend = r.backend ? ` [${r.backend}]` : '';
  if (r.ok) {
    return [`— ${label} —`, `  HTTP ${r.status ?? 'OK'} (success)${backend}`, ''];
  }
  // Distinguish "got an HTTP error response" from "connection failed"
  if (r.status !== undefined) {
    return [`— ${label} —`, `  HTTP ${r.status}${r.error ? ` — ${r.error}` : ''}${backend}`, ''];
  }
  return [`— ${label} —`, `  connection failed${r.error ? `: ${r.error}` : ''}${backend}`, ''];
}

/** Format a report as a human-readable string for the Output channel. */
export function formatReport(r: DiagnosticReport): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('vLLM-Copilot — Network Diagnostics');
  lines.push('---');
  lines.push(`  Extension:  v${r.extensionVersion}`);
  lines.push(`  Node:       ${r.nodeVersion}`);
  lines.push(`  VS Code:    ${r.vscodeVersion}`);
  lines.push(`  Platform:   ${r.platform}`);
  lines.push(`  Target:     ${r.targetUrl}`);
  lines.push('---');
  lines.push('');
  lines.push('— VS Code network settings —');
  for (const [k, v] of Object.entries(r.settings)) {
    lines.push(`  ${k} = ${v === undefined ? '(unset)' : JSON.stringify(v)}`);
  }
  lines.push('');
  lines.push('— Environment —');
  for (const [k, v] of Object.entries(r.env)) {
    lines.push(`  ${k} = ${v === undefined ? '(unset)' : v}`);
  }
  lines.push('');
  // Only show DNS/TCP sections when something failed — they're noise when all fetches succeed.
  const nodeSucceeded = r.nodeFetch?.ok ?? false;
  const systemSucceeded = r.systemFetch?.ok ?? false;
  const directSucceeded = r.nodeDirectFetch?.ok ?? false;
  const dnsFailed = r.dns && !r.dns.resolved;
  const tcpFailed = r.tcp && !r.tcp.ok;
  const showDnsTcp = !nodeSucceeded || !systemSucceeded || !directSucceeded || dnsFailed || tcpFailed;
  if (showDnsTcp) {
    if (r.dns) {
      lines.push('— DNS —');
      lines.push(`  ${r.dns.host} → ${r.dns.resolved ?? 'unresolved'}${r.dns.error ? ` (${r.dns.error})` : ''}`);
      lines.push('');
    }
    if (r.tcp) {
      lines.push('— TCP —');
      lines.push(`  ${r.tcp.host}:${r.tcp.port} → ${r.tcp.ok ? 'connected' : 'failed'}${r.tcp.error ? ` (${r.tcp.error})` : ''}`);
      lines.push('');
    }
  }
  // OS-level proxy configuration
  if (r.proxyInfo) {
    lines.push('— OS proxy configuration —');
    if (r.proxyInfo.error) {
      lines.push(`  Error: ${r.proxyInfo.error}`);
    } else if (r.proxyInfo.server) {
      lines.push(`  Source: ${r.proxyInfo.source}`);
      lines.push(`  Proxy:  ${r.proxyInfo.server}`);
      if (r.proxyInfo.bypass) {
        lines.push(`  Bypass: ${r.proxyInfo.bypass}`);
      }
    } else {
      lines.push(`  No proxy configured (${r.proxyInfo.source})`);
    }
    lines.push('');
  }
  // Internet Explorer proxy settings (Windows registry) — Group Policy can set these silently
  if (r.ieProxyInfo) {
    lines.push('— IE proxy settings (registry) —');
    if (r.ieProxyInfo.error) {
      lines.push(`  Error: ${r.ieProxyInfo.error}`);
    } else if (r.ieProxyInfo.enabled) {
      lines.push(`  Enabled: yes`);
      lines.push(`  Proxy:  ${r.ieProxyInfo.server}`);
      if (r.ieProxyInfo.bypass) {
        lines.push(`  Bypass: ${r.ieProxyInfo.bypass}`);
      }
      if (r.ieProxyInfo.userChoice != null && r.ieProxyInfo.userChoice === 0) {
        lines.push('  ⚠ Managed by Group Policy (user cannot change)');
      }
    } else {
      lines.push('  No proxy enabled');
    }
    lines.push('');
  }
  // Platform-native fetch
  lines.push(...formatFetchResult(systemFetchLabel(), r.systemFetch));
  // Node fetch
  lines.push(...formatFetchResult('Node fetch (VS Code patched fetch)', r.nodeFetch));
  // Direct Node transport (http/https.request) — same Node core modules,
  // but without the Fetch API layer. Useful to isolate Fetch-specific failures.
  lines.push(...formatFetchResult('Node direct transport (http/https.request)', r.nodeDirectFetch));
  // Add a brief comparison note when transports disagree on TLS.
  const nodeFailed = !r.nodeFetch.ok;
  const directOk = r.nodeDirectFetch.ok;
  const systemOk = r.systemFetch?.ok ?? false;
  if (nodeFailed && (directOk || systemOk)) {
    const okPath = directOk ? 'direct Node transport' : 'system native test';
    lines.push('');
    lines.push('— Transport comparison —');
    lines.push(`  VS Code's patched fetch failed but ${okPath} succeeded.`);
    lines.push('  This indicates the server is not sending the complete certificate chain.');
    lines.push('  Node\'s OpenSSL requires the full chain, while SChannel can retrieve');
    lines.push('  missing intermediates from the OS trust store.');
    if (r.chain) {
      lines.push('  See the certificate chain section for details.');
    }
    lines.push('');
  }
  // Certificate chain
  if (r.chain) {
    lines.push('— Certificate chain —');
    if (r.chain.error) {
      lines.push(`  Error: ${r.chain.error}`);
    } else {
      lines.push(`  Valid: ${r.chain.valid ? 'yes' : 'no'} (errors: ${r.chain.errors ?? 'none'})`);
      if (r.chain.statuses && r.chain.statuses.length > 0) {
        lines.push(`  Status: ${r.chain.statuses.join('; ')}`);
      }
      if (r.chain.elements && r.chain.elements.length > 0) {
        lines.push('  Chain elements:');
        r.chain.elements.forEach((el, i) => {
          lines.push(`    [${i}] ${el.subject ?? '(unnamed)'}`);
          if (el.issuer) lines.push(`        issuer: ${el.issuer}`);
        });
      }
    }
    lines.push('');
  }
  // Auto-fix suggestion for Windows TLS trust gap
  if (r.tlsFix) {
    lines.push('— Suggested fix —');
    if (r.tlsFix.exported) {
      const intermediate = r.tlsFix.intermediateSubject;
      if (intermediate) {
        lines.push(`  Missing intermediate: ${intermediate}`);
        lines.push('');
        lines.push('  This certificate is in the OS trust store, so SChannel can verify.');
        lines.push('  The server should be configured to send the full certificate chain.');
        lines.push('  Contact the server administrator and provide this diagnostic.');
      }
      if (r.tlsFix.pemPath) {
        lines.push('');
        lines.push(`  Intermediate exported to: ${r.tlsFix.pemPath}`);
        lines.push('  (For diagnostic reference only.)');
      }
    } else if (r.tlsFix.error) {
      lines.push(`  Could not auto-fix: ${r.tlsFix.error}`);
      lines.push('  The server should be configured to send the full certificate chain.');
    }
    lines.push('');
  }
  lines.push('---');
  lines.push(`CONCLUSION: ${r.conclusion}`);
  lines.push('---');
  return lines.join('\n');
}
