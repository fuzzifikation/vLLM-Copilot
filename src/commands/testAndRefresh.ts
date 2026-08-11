/**
 * Test & Refresh workflow: group configured models by server, probe each unique
 * server once, and surface a consolidated status. Extracted from the root
 * `commands.ts` facade (refactor-plan §2.3) so the workflow — including its pure
 * grouping helpers — is independently testable.
 */

import * as vscode from 'vscode';
import type { VllmChatModelProvider } from '../provider.js';
import { getConfig, buildEndpoint, resolveServerConfig, resolveVllmModelId, normalizeModelId } from '../config.js';
import type { ModelConfig } from '../config.js';
import type { VllmModel } from '../types.js';
import { describeError } from '../messageConverter.js';
import { runDiagnostics, formatReport } from '../diagnostics.js';

/**
 * Result of testing a single unique server (grouped by URL + auth).
 * Each unique server is tested once regardless of how many model configs
 * point to it.
 */
export interface ServerTestResult {
  serverUrl: string;
  status: 'ok' | 'error' | 'no-match';
  /** All model configs grouped under this server. */
  modelConfigs: ModelConfig[];
  /** Models whose vllmModelId matched a served model. */
  matched: Array<{ config: ModelConfig; vllmModelId: string; maxModelLen?: number }>;
  /** Models whose vllmModelId was NOT found on the server (parked). */
  parked: Array<{ config: ModelConfig; vllmModelId: string }>;
  errorMessage?: string;
  /** The full model list returned by the server (for picker/diagnostic). */
  serverModelList?: VllmModel[];
}

/**
 * Internal grouping types for server-dedup logic.
 */
interface ServerGroup {
  serverUrl: string;
  requestHeaders: Record<string, string>;
  models: ModelConfig[];
}

/**
 * Build a deterministic fingerprint for a server from its URL and auth headers.
 * Two model configs that point to the same server (same URL + same headers)
 * produce the same fingerprint and are tested together.
 * @internal Exported for testing.
 */
export function serverFingerprint(url: string, headers: Record<string, string>): string {
  const sorted = Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([url, sorted]);
}

/**
 * Group model configs by unique server (URL + auth headers fingerprint).
 * Each unique server appears once in the output; models without a serverUrl
 * each get their own singleton group so they can be reported individually.
 * @internal Exported for testing.
 */
export function groupModelsByServer(
  models: ModelConfig[],
  resolveServer: (m: ModelConfig) => { serverUrl: string; requestHeaders: Record<string, string> },
  resolveId: (m: ModelConfig) => string | undefined,
): ServerGroup[] {
  const groups = new Map<string, ServerGroup>();
  for (const model of models) {
    if (!model.serverUrl) {
      const fp = `__nourl__${model.id ?? resolveId(model) ?? Math.random()}`;
      groups.set(fp, { serverUrl: '', requestHeaders: {}, models: [model] });
      continue;
    }
    const { serverUrl, requestHeaders } = resolveServer(model);
    const fp = serverFingerprint(serverUrl, requestHeaders);
    const existing = groups.get(fp);
    if (existing) {
      existing.models.push(model);
    } else {
      groups.set(fp, { serverUrl, requestHeaders, models: [model] });
    }
  }
  return Array.from(groups.values());
}

/**
 * Check VS Code's network/proxy gating settings. The patched `globalThis.fetch`
 * (which handles proxy routing and OS certificate loading) is gated by three
 * settings. If IT pushed any to off/false via managed policy, all VS Code network
 * features break — not just ours.
 *
 * Returns warning strings for any non-default values. Empty array = all fine.
 */
function checkNetworkGatingSettings(): string[] {
  const config = vscode.workspace.getConfiguration('http');
  const warnings: string[] = [];

  const proxySupport = config.get<string>('proxySupport', 'override');
  if (proxySupport === 'off') {
    warnings.push('http.proxySupport is "off" — proxy patch is disabled');
  }

  const fetchAdditionalSupport = config.get<boolean>('fetchAdditionalSupport', true);
  if (fetchAdditionalSupport === false) {
    warnings.push('http.fetchAdditionalSupport is false — fetch proxy/cert patch is disabled');
  }

  const systemCertificates = config.get<boolean>('systemCertificates', true);
  if (systemCertificates === false) {
    warnings.push('http.systemCertificates is false — OS certificate store not used');
  }

  return warnings;
}

/**
 * Test all configured models and refresh the model list.
 *
 * Models are grouped by unique server (normalized URL + auth headers),
 * so each server is queried exactly once via GET /v1/models. The output
 * is a single consolidated status message — one line per server — rather
 * than one popup per model config.
 *
 * If a server is reachable and at least one configured model matches a
 * served model, that's reported as "OK" and the matching model(s) go into
 * the Copilot model picker. Non-matching models on the same server are
 * silently parked (kept in settings but not in the picker). An error is
 * only shown when a server is unreachable, returns an error, or has no
 * matching model at all — in which case the user is offered to pick or
 * auto-configure a model from the server.
 *
 * Cache is cleared so discovery re-runs.
 */
export function registerTestAndRefreshModelsCommand(
  context: vscode.ExtensionContext,
  provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.testAndRefreshModels', async () => {
    const cfg = await getConfig(context);
    const models = cfg.models || [];

    if (models.length === 0) {
      const pick = await vscode.window.showInformationMessage(
        'No models are configured yet.',
        'Add vLLM Server & Model'
      );
      if (pick) await vscode.commands.executeCommand('vllm-copilot.addServerModel');
      return;
    }

    // ── 1. Group models by unique server fingerprint (URL + auth headers) ──
    // Servers with identical URL and headers share one fetch instead of N.
    const groups = groupModelsByServer(models, resolveServerConfig, resolveVllmModelId);

    // ── 2. Test each unique server once (parallel) ──
    const serverTasks = groups.map(async (group): Promise<ServerTestResult> => {
      if (!group.serverUrl) {
        // Models without a serverUrl — they cannot be tested.
        return {
          serverUrl: '',
          status: 'error',
          modelConfigs: group.models,
          matched: [],
          parked: group.models.map(m => ({
            config: m,
            vllmModelId: resolveVllmModelId(m) || m.id || '(unnamed)',
          })),
          errorMessage: 'No serverUrl configured',
        };
      }

      try {
        const resp = await fetch(buildEndpoint(group.serverUrl, 'v1/models'), {
          headers: group.requestHeaders,
          signal: AbortSignal.timeout(10000),
        });

        if (resp.status === 401 || resp.status === 403) {
          return {
            serverUrl: group.serverUrl,
            status: 'error',
            modelConfigs: group.models,
            matched: [],
            parked: group.models.map(m => ({
              config: m,
              vllmModelId: resolveVllmModelId(m) || m.id || '(unnamed)',
            })),
            errorMessage: `Authentication failed (HTTP ${resp.status})`,
          };
        }

        if (!resp.ok) {
          return {
            serverUrl: group.serverUrl,
            status: 'error',
            modelConfigs: group.models,
            matched: [],
            parked: group.models.map(m => ({
              config: m,
              vllmModelId: resolveVllmModelId(m) || m.id || '(unnamed)',
            })),
            errorMessage: `HTTP ${resp.status}`,
          };
        }

        const data = await resp.json() as { data?: VllmModel[] };
        const serverModels: VllmModel[] = data.data || [];

        // Match each configured model against the server's loaded models.
        // Matching is quantization-agnostic (org-aware), consistent with the rest
        // of the extension (`resolveOverrideForModel`): a config for
        // "Qwen/Qwen3.6-27B" must match a server serving "Qwen/Qwen3.6-27B-FP8".
        // Strict wire-id matching here reported perfectly valid models as
        // "parked" and steered users to re-adopt what they already configured.
        const matched: Array<{ config: ModelConfig; vllmModelId: string; maxModelLen?: number }> = [];
        const parked: Array<{ config: ModelConfig; vllmModelId: string }> = [];

        for (const model of group.models) {
          const vllmModelId = resolveVllmModelId(model) || model.id || '';
          if (!vllmModelId) {
            parked.push({ config: model, vllmModelId: '(unnamed)' });
            continue;
          }
          const found = serverModels.find((m: VllmModel) => normalizeModelId(m.id) === normalizeModelId(vllmModelId));
          if (found) {
            matched.push({ config: model, vllmModelId, maxModelLen: found.max_model_len });
          } else {
            parked.push({ config: model, vllmModelId });
          }
        }

        if (matched.length > 0) {
          return {
            serverUrl: group.serverUrl,
            status: 'ok',
            modelConfigs: group.models,
            matched,
            parked,
            serverModelList: serverModels,
          };
        } else {
          return {
            serverUrl: group.serverUrl,
            status: 'no-match',
            modelConfigs: group.models,
            matched: [],
            parked,
            errorMessage: 'No configured model matches any served model',
            serverModelList: serverModels,
          };
        }
      } catch (err) {
        return {
          serverUrl: group.serverUrl,
          status: 'error',
          modelConfigs: group.models,
          matched: [],
          parked: group.models.map(m => ({
            config: m,
            vllmModelId: resolveVllmModelId(m) || m.id || '(unnamed)',
          })),
          errorMessage: describeError(err),
        };
      }
    });

    const serverResults = await Promise.all(serverTasks);

    // ── 3. Consolidated popups: ONE for working servers, ONE for failures ──
    // Server-focused: a server is "OK" if it's reachable and at least one
    // configured model matches a served model. Ten models on one reachable
    // server = one line, not ten popups. Unreachable/auth-failed servers are
    // grouped into a single failure popup instead of one toast per server.
    const okResults = serverResults.filter(r => r.status === 'ok');
    // Only server-ful errors are genuine network failures. A server-less config
    // (no serverUrl) is a configuration error, not a network problem — it must not
    // trigger the network-gating warning or the deep-diagnostic offer.
    const errResults = serverResults.filter(r => r.status === 'error' && r.serverUrl);
    const serverlessResults = serverResults.filter(r => r.status === 'error' && !r.serverUrl);
    const anyFailure = errResults.length > 0;
    // Reachable servers that matched nothing. Includes servers whose /v1/models
    // returned zero models — that is still a condition the user must hear about,
    // so it is reported (3c) rather than silently dropped.
    const noMatchResults = serverResults.filter(r => r.status === 'no-match');

    // 3a. ONE success popup — every working server in a single message.
    if (okResults.length > 0) {
      const lines = okResults.map(r => {
        const names = r.matched.map(m => m.vllmModelId).join(', ');
        const ctx = r.matched[0]?.maxModelLen
          ? ` (${r.matched[0].maxModelLen.toLocaleString()} ctx)`
          : '';
        // A server with at least one match is "OK", but a configured model whose
        // wire id isn't served is silently dropped from the picker — surface it
        // rather than reporting unqualified success.
        const parkedNames = r.parked.map(m => m.vllmModelId).join(', ');
        const parkedHint = parkedNames ? ` — parked: ${parkedNames}` : '';
        return `✓ ${r.serverUrl} — ${names}${ctx}${parkedHint}`;
      });
      vscode.window.showInformationMessage(
        lines.length === 1 ? lines[0] : `Reachable servers:\n${lines.join('\n')}`
      );
    }

    // 3b. ONE failure popup — every unreachable/auth-failed server together.
    if (errResults.length > 0) {
      const lines = errResults.map(r => {
        let line = `✗ ${r.serverUrl} — ${r.errorMessage}`;
        if (r.modelConfigs.length > 1) {
          const modelNames = r.modelConfigs
            .map(m => m.displayName || m.id || resolveVllmModelId(m) || '(unnamed)')
            .join(', ');
          line += `\n  Models: ${modelNames}`;
        }
        return line;
      });
      vscode.window.showWarningMessage(
        lines.length === 1 ? lines[0] : `Unreachable servers:\n${lines.join('\n')}`
      );
    }

    // 3b2. ONE warning for server-less configs (configuration error, not network).
    if (serverlessResults.length > 0) {
      const lines = serverlessResults.flatMap(r =>
        r.modelConfigs.map(c =>
          `✗ ${c.displayName || c.id || resolveVllmModelId(c) || '(unnamed)'} — no serverUrl configured`
        )
      );
      vscode.window.showWarningMessage(
        lines.length === 1 ? lines[0] : `Models without a serverUrl:\n${lines.join('\n')}`
      );
    }

    // 3c. ONE hint for reachable servers that host models nobody configured.
    //    The server is fine; the user just has unconfigured models to adopt.
    const noMatchWithModels = noMatchResults.filter(r => r.serverModelList && r.serverModelList.length > 0);
    if (noMatchWithModels.length > 0) {
      const unconfiguredCount = noMatchWithModels.reduce(
        (sum, r) => sum + (r.serverModelList?.length ?? 0),
        0
      );
      const configurePick = await vscode.window.showWarningMessage(
        `${noMatchWithModels.length} reachable server(s) host ${unconfiguredCount} model(s) not configured in settings.json. Configure them in Server Settings to use them in Copilot.`,
        'Open Server Settings'
      );
      if (configurePick) {
        await vscode.commands.executeCommand('vllm-copilot.serverSettings.focus');
      }
    }

    // 3c2. Reachable servers that served zero models — not an error, but the
    //    absence is still worth one line so it is never mistaken for a hang.
    const noMatchEmpty = noMatchResults.filter(r => !(r.serverModelList && r.serverModelList.length > 0));
    if (noMatchEmpty.length > 0) {
      const lines = noMatchEmpty.map(r => `• ${r.serverUrl} — reachable, but no models served`);
      vscode.window.showInformationMessage(
        lines.length === 1 ? lines[0] : `Reachable servers with no models:\n${lines.join('\n')}`
      );
    }

    // ── 4. Post-check corrective actions ──

    // 4a. Unreachable servers: network check + diagnostic offer (see 4b).
    // No per-server "configure now" wizard here — the consolidated 3c hint
    // (Open Server Settings) is the single place users adopt unconfigured models.

    // 4b. For errored servers: network check + diagnostic offer.
    try {
      if (anyFailure) {
        const networkWarnings = checkNetworkGatingSettings();
        if (networkWarnings.length > 0) {
          const detail = networkWarnings.join('\n');
          const settingsPick = await vscode.window.showWarningMessage(
            `VS Code network settings may be blocking the connection:\n\n${detail}\n\nThese settings gate the patched fetch that handles proxy routing and OS certificates.`,
            'Open Settings'
          );
          if (settingsPick) {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'http.proxy');
          }
        }

        // Target the first genuine server error (has a serverUrl). A server-less
        // config produces an error too, but there is nothing to diagnose.
        const firstFailed = serverResults.find(r => r.status === 'error' && r.serverUrl);
        if (firstFailed) {
          const diagPick = await vscode.window.showWarningMessage(
            'One or more servers failed to connect. Run a deep diagnostic?',
            'Run Diagnostic'
          );
          if (diagPick === 'Run Diagnostic') {
            outputChannel.show(true);
            outputChannel.appendLine('[INFO] Running diagnostics…');
            try {
              const report = await runDiagnostics(
                buildEndpoint(firstFailed.serverUrl, 'v1/models'),
                // Use the first model's resolved headers for the diagnostic.
                (() => {
                  const firstCfg = firstFailed.modelConfigs[0];
                  return firstCfg ? resolveServerConfig(firstCfg).requestHeaders : {};
                })(),
              );
              outputChannel.appendLine(formatReport(report));
              outputChannel.appendLine('');
              outputChannel.appendLine(
                'Copy this report (right-click → Copy) and share it when reporting issues.'
              );
            } catch (err) {
              // runDiagnostics converts operational failures to reports and does
              // not normally reject; guard anyway so a future rejection cannot
              // skip clearCache below (moved to finally).
              outputChannel.appendLine(`[ERROR] Diagnostics failed unexpectedly: ${describeError(err)}`);
            }
          }
        }
      }
    } finally {
      // Clear cached models so the provider re-fetches on next use. Guaranteed
      // to run even if a popup/diagnostic path throws unexpectedly.
      provider.clearCache();
    }
  });
}
