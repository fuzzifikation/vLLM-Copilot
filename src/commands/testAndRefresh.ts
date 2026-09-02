/**
 * Test & Refresh workflow: group configured models by server, probe each unique
 * server once, and surface a consolidated status. Extracted from the root
 * `commands.ts` facade (refactor-plan §2.3) so the workflow — including its pure
 * grouping helpers — is independently testable.
 */

import * as vscode from 'vscode';
import type { VllmChatModelProvider } from '../provider.js';
import { getConfig, buildEndpoint, resolveServerConfig, resolveVllmModelId, resolveServerType } from '../config.js';
import type { ModelConfig } from '../config.js';
import type { ServerEntry } from '../serverRegistry.js';
import type { VllmModel } from '../types.js';

import { describeError, isTlsCertificateError, TLS_CERT_SUGGESTION } from '../messageConverter.js';
import { resolveRuntimeLimits } from '../runtimeLimits.js';
import { runDiagnostics, formatReport } from '../diagnostics.js';

/**
 * Result of testing a single unique server (grouped by URL + auth).
 * Each unique server is tested once regardless of how many model configs
 * point to it.
 */
export interface ServerTestResult {
  serverUrl: string;
  status: 'ok' | 'error' | 'no-match' | 'ctx-error';
  /** All model configs grouped under this server. */
  modelConfigs: ModelConfig[];
  /** Models whose vllmModelId matched a served model. */
  matched: Array<{ config: ModelConfig; vllmModelId: string; maxModelLen?: number; ctxError?: string }>;
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
 * Group model configs by the registry ENTRY their `server` ref points at, so
 * each unique server is probed once instead of N times — the entry id IS the
 * server identity. Models whose `server` reference does not resolve each get
 * their own singleton group so they can be reported individually.
 * @internal Exported for testing.
 */
export function groupModelsByServer(models: ModelConfig[], servers: ServerEntry[]): ServerGroup[] {
  const groups = new Map<string, ServerGroup>();
  models.forEach((model, index) => {
    const resolved = resolveServerConfig(model, servers);
    if (!resolved) {
      groups.set(`__nourl__${index}`, { serverUrl: '', requestHeaders: {}, models: [model] });
      return;
    }
    const existing = groups.get(model.server);
    if (existing) {
      existing.models.push(model);
    } else {
      groups.set(model.server, {
        serverUrl: resolved.serverUrl,
        requestHeaders: resolved.requestHeaders,
        models: [model],
      });
    }
  });
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
 * Models are grouped by the registry ENTRY their `server` field references
 * (entry id is the identity), so each entry is queried exactly once via
 * GET /v1/models. The output is a single consolidated status message — one
 * line per entry — rather than one popup per model config.
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
    const servers = cfg.servers || [];

    if (models.length === 0) {
      const pick = await vscode.window.showInformationMessage(
        'No models are configured yet.',
        'Add vLLM Server & Model'
      );
      if (pick) await vscode.commands.executeCommand('vllm-copilot.addServerModel');
      return;
    }

    // ── 1. Group models by their referenced registry entry (see the header
    // comment: one probe batch per entry, never merged across entries) ──
    // Models on two entries that merely share a connection probe separately:
    // two entries are two servers by doctrine, however redundant validateConfig
    // calls them.
    const groups = groupModelsByServer(models, servers);

    // ── 2. Test each unique server once (parallel) ──
    const serverTasks = groups.map(async (group): Promise<ServerTestResult> => {
      if (!group.serverUrl) {
        // Models whose server reference does not resolve — they cannot be tested.
        return {
          serverUrl: '',
          status: 'error',
          modelConfigs: group.models,
          matched: [],
          parked: group.models.map(m => ({
            config: m,
            vllmModelId: resolveVllmModelId(m) ?? '(unnamed)',
          })),
          errorMessage: 'No resolvable server configured',
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
              vllmModelId: resolveVllmModelId(m) ?? '(unnamed)',
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
              vllmModelId: resolveVllmModelId(m) ?? '(unnamed)',
            })),
            errorMessage: `HTTP ${resp.status}`,
          };
        }

        const data = await resp.json() as { data?: VllmModel[] };
        const serverModels: VllmModel[] = data.data || [];

        // Match each configured model against the server's loaded models.
        // EXACT wire-id matching only — `vllmModelId` must be one of the server's
        // served model ids. The extension's write paths always store the exact
        // served id, so a config that doesn't match was hand-edited to point at a
        // name the server does not serve — that must surface as "parked" loudly,
        // not be forgiven here and replayed as a request the server will reject.
        const matched: Array<{ config: ModelConfig; vllmModelId: string; maxModelLen?: number; ctxError?: string }> = [];
        const parked: Array<{ config: ModelConfig; vllmModelId: string }> = [];

        for (const model of group.models) {
          const vllmModelId = resolveVllmModelId(model) ?? '';
          if (!vllmModelId) {
            parked.push({ config: model, vllmModelId: '(unnamed)' });
            continue;
          }
          const found = serverModels.find((m: VllmModel) => m.id === vllmModelId);
          if (found) {
            // Display-only context, resolved via the SHARED backend resolver
            // (same code path as provider discovery). Independent parsing here would
            // drift — a llama.cpp /v1/models entry has no max_model_len at all.
            // A failure is NOT swallowed: the model discovery refuses to advertise
            // must not display as healthy (no context, no model).
            let maxModelLen: number | undefined;
            let ctxError: string | undefined;
            try {
              const limits = await resolveRuntimeLimits(
                resolveServerType(model, servers),
                group.serverUrl,
                group.requestHeaders ?? {},
                vllmModelId
              );
              maxModelLen = limits.contextWindow;
            } catch (err) {
              ctxError = describeError(err);
              outputChannel.appendLine(`[WARN] Model "${vllmModelId}" matched but has no resolvable context: ${ctxError} — it will not be served.`);
            }
            matched.push({ config: model, vllmModelId, maxModelLen, ctxError });
          } else {
            parked.push({ config: model, vllmModelId });
          }
        }

        if (matched.length > 0) {
          // A server is only "OK" if at least one matched model actually has a
          // resolvable context window — i.e. it will genuinely be served. A wire
          // match whose context failed is NOT healthy (the model is refused), so a
          // server where every match failed context must not render as a green ✓.
          const healthy = matched.some((m) => m.maxModelLen !== undefined);
          return {
            serverUrl: group.serverUrl,
            status: healthy ? 'ok' : 'ctx-error',
            modelConfigs: group.models,
            matched,
            parked,
            serverModelList: serverModels,
            ...(healthy ? {} : { errorMessage: 'Models matched but have no resolvable context' }),
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
        const message = describeError(err);
        return {
          serverUrl: group.serverUrl,
          status: 'error',
          modelConfigs: group.models,
          matched: [],
          parked: group.models.map(m => ({
            config: m,
            vllmModelId: resolveVllmModelId(m) ?? '(unnamed)',
          })),
          // A certificate-ish failure gets the short suggestion: network test +
          // maybe the setting. One bucket, no deeper classification.
          errorMessage: isTlsCertificateError(message)
            ? `${message}\n\n${TLS_CERT_SUGGESTION}`
            : message,
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
    // Only server-ful errors are genuine network failures. A config whose server
    // ref does not resolve is a configuration error, not a network problem — it
    // must not trigger the network-gating warning or the deep-diagnostic offer.
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
          ? ` (${r.matched[0].maxModelLen.toLocaleString('en-US')} ctx)`
          : r.matched[0]?.ctxError
            ? ' (⚠ no context — not served)'
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

    // 3a2. ONE warning for servers whose matched models ALL lack a resolvable
    //    context window. Their wire ids matched, but nothing will be served — so
    //    this is a ⚠, never the green ✓ reserved for servers that actually serve.
    const ctxErrorResults = serverResults.filter(r => r.status === 'ctx-error');
    if (ctxErrorResults.length > 0) {
      const lines = ctxErrorResults.map(r => {
        const details = r.matched
          .map(m => `${m.vllmModelId}: ${m.ctxError ?? 'no resolvable context'}`)
          .join('\n  ');
        return `⚠ ${r.serverUrl} — matched but not served:\n  ${details}`;
      });
      vscode.window.showWarningMessage(
        lines.length === 1 ? lines[0] : `Models matched but have no resolvable context:\n${lines.join('\n')}`
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

    // 3b2. ONE warning for configs with an unresolvable server (configuration
    //    error, not network).
    if (serverlessResults.length > 0) {
      const lines = serverlessResults.flatMap(r =>
        r.modelConfigs.map(c =>
          `✗ ${c.displayName || c.id || resolveVllmModelId(c) || '(unnamed)'} — no resolvable server configured`
        )
      );
      vscode.window.showWarningMessage(
        lines.length === 1 ? lines[0] : `Models without a resolvable server:\n${lines.join('\n')}`
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
        `${noMatchWithModels.length} reachable server(s) host ${unconfiguredCount} model(s) not configured in settings.json. Configure them in Model Settings to use them in Copilot.`,
        'Open Model Settings'
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
                  return (firstCfg && resolveServerConfig(firstCfg, servers)?.requestHeaders) || {};
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
