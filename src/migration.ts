/**
 * One-time migration from the legacy global-server config model to the per-model
 * config model. Moves the deprecated global server URL, request headers, API key,
 * and generation/token/transport settings into each entry of `vllm-copilot.models`,
 * then clears the globals so they no longer apply.
 *
 * Runs once per machine (guarded by a globalState flag). Idempotent and safe to
 * call on every activation.
 */

import * as vscode from 'vscode';
import type { ModelConfig } from './config.js';
import { normalizeServerUrl, resolveVllmModelId, buildModelId, buildAuthHeaders } from './config.js';

const MIGRATION_FLAG = 'vllm-copilot.migratedPerModelServer.v1';
const COMPOSITE_ID_FLAG = 'vllm-copilot.migratedCompositeIds.v1';

/** Legacy global generation settings → raw vLLM request-body keys (snake_case). */
interface LegacyParams {
  params: Record<string, unknown>;
  maxOutputTokens?: number;

  estimateCharsPerToken?: number;
  streamInactivityTimeout?: number;
  autoContinueRetries?: number;
}

/** Read a setting's explicitly-configured value (workspace wins over global). Undefined if unset. */
function explicit<T>(section: vscode.WorkspaceConfiguration, key: string): T | undefined {
  const info = section.inspect<T>(key);
  return (info?.workspaceValue ?? info?.globalValue) as T | undefined;
}

/** Collect explicitly-set legacy generation/token/transport settings. */
function collectLegacyParams(section: vscode.WorkspaceConfiguration): LegacyParams {
  const params: Record<string, unknown> = {};
  const set = (key: string, requestKey: string, predicate: (v: any) => boolean = () => true) => {
    const v = explicit<any>(section, key);
    if (v !== undefined && predicate(v)) params[requestKey] = v;
  };

  set('temperature', 'temperature');
  set('topP', 'top_p');
  set('topK', 'top_k', v => v !== -1);
  set('minP', 'min_p', v => v !== 0);
  set('repetitionPenalty', 'repetition_penalty', v => v !== 1.0);
  set('presencePenalty', 'presence_penalty', v => v !== 0);
  set('frequencyPenalty', 'frequency_penalty', v => v !== 0);
  set('seed', 'seed', v => typeof v === 'number' && v >= 0);
  set('minOutputTokens', 'min_tokens', v => typeof v === 'number' && v > 0);
  set('thinkingTokenBudget', 'thinking_token_budget', v => typeof v === 'number' && v > 0);
  set('ignoreEos', 'ignore_eos', v => v === true);

  const stop = explicit<string[]>(section, 'stopSequences');
  if (Array.isArray(stop) && stop.length > 0) params.stop = stop;

  const badWords = explicit<string[]>(section, 'badWords');
  if (Array.isArray(badWords) && badWords.filter(w => w.trim()).length > 0) {
    params.bad_words = badWords.filter(w => w.trim());
  }

  const rd = explicit<any>(section, 'repetitionDetection');
  if (rd && typeof rd === 'object' && (rd.maxPatternSize || rd.minCount || rd.minPatternSize)) {
    params.repetition_detection = {
      max_pattern_size: rd.maxPatternSize ?? 0,
      min_count: rd.minCount ?? 0,
      min_pattern_size: rd.minPatternSize ?? 0,
    };
  }

  const so = explicit<any>(section, 'structuredOutput');
  if (so && typeof so === 'object' && Object.keys(so).length > 0) {
    params.structured_outputs = so;
  }

  return {
    params,
    maxOutputTokens: explicit<number>(section, 'maxOutputTokens'),
    estimateCharsPerToken: explicit<number>(section, 'estimateCharsPerToken'),
    streamInactivityTimeout: explicit<number>(section, 'streamInactivityTimeout'),
    autoContinueRetries: explicit<number>(section, 'autoContinueRetries'),
  };
}

const LEGACY_KEYS_TO_CLEAR = [
  'serverUrl', 'requestHeaders',
  'temperature', 'topP', 'topK', 'minP', 'repetitionPenalty', 'presencePenalty',
  'frequencyPenalty', 'seed', 'stopSequences', 'minOutputTokens', 'maxOutputTokens',
  'maxModelTokens', 'thinkingTokenBudget', 'streamInactivityTimeout', 'autoContinueRetries',
  'estimateCharsPerToken', 'badWords', 'ignoreEos', 'repetitionDetection', 'structuredOutput',
];

function hasAuthHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some(k => {
    const lk = k.toLowerCase();
    return lk === 'authorization' || lk === 'x-api-key';
  });
}

/**
 * Migrate legacy global settings into per-model config. Returns true if any change
 * was written. Only runs once (guarded by a globalState flag).
 */
export async function migrateToPerModelServer(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<boolean> {
  if (context.globalState.get<boolean>(MIGRATION_FLAG)) return false;

  const section = vscode.workspace.getConfiguration('vllm-copilot');
  const models: ModelConfig[] = (section.get<ModelConfig[]>('models') || []).map(m => ({ ...m }));

  const legacyServerUrl = (explicit<string>(section, 'serverUrl') || '').trim();
  const legacyHeaders = explicit<Record<string, string>>(section, 'requestHeaders') || {};
  const apiKey = await context.secrets.get('vllm-copilot.apiKey');
  const legacy = collectLegacyParams(section);

  const hasLegacyServer = legacyServerUrl.length > 0;
  const hasLegacyHeaders = Object.keys(legacyHeaders).length > 0;
  const hasLegacyParams =
    Object.keys(legacy.params).length > 0 ||
    legacy.maxOutputTokens !== undefined ||
    legacy.estimateCharsPerToken !== undefined ||
    legacy.streamInactivityTimeout !== undefined ||
    legacy.autoContinueRetries !== undefined;

  // Nothing to migrate — mark done and exit quietly.
  if (!hasLegacyServer && !hasLegacyHeaders && !hasLegacyParams && !apiKey) {
    await context.globalState.update(MIGRATION_FLAG, true);
    return false;
  }

  for (const m of models) {
    // Server URL
    if (!m.serverUrl && hasLegacyServer) {
      m.serverUrl = normalizeServerUrl(legacyServerUrl);
    }

    // Headers: legacy global headers as base, model headers win; add bearer from apiKey.
    const mergedHeaders: Record<string, string> = { ...legacyHeaders, ...(m.requestHeaders ?? {}) };
    if (apiKey && !hasAuthHeader(mergedHeaders)) {
      Object.assign(mergedHeaders, buildAuthHeaders(apiKey));
    }
    if (Object.keys(mergedHeaders).length > 0) {
      m.requestHeaders = mergedHeaders;
    }

    // Generation params → defaultParams (model-scope wins over legacy).
    if (Object.keys(legacy.params).length > 0) {
      m.defaultParams = { ...legacy.params, ...(m.defaultParams ?? {}) };
    }

    // Typed token/transport settings (only fill when not already set on the model).
    if (m.maxOutputTokens === undefined && legacy.maxOutputTokens !== undefined) m.maxOutputTokens = legacy.maxOutputTokens;
    if (m.estimateCharsPerToken === undefined && legacy.estimateCharsPerToken !== undefined) m.estimateCharsPerToken = legacy.estimateCharsPerToken;
    if (m.streamInactivityTimeout === undefined && legacy.streamInactivityTimeout !== undefined) m.streamInactivityTimeout = legacy.streamInactivityTimeout;
    if (m.autoContinueRetries === undefined && legacy.autoContinueRetries !== undefined) m.autoContinueRetries = legacy.autoContinueRetries;
  }

  if (models.length > 0) {
    await section.update('models', models, vscode.ConfigurationTarget.Global);
  }

  // Clear the legacy globals at whichever scope they were set.
  for (const key of LEGACY_KEYS_TO_CLEAR) {
    const info = section.inspect(key);
    if (info?.globalValue !== undefined) await section.update(key, undefined, vscode.ConfigurationTarget.Global);
    if (info?.workspaceValue !== undefined) await section.update(key, undefined, vscode.ConfigurationTarget.Workspace);
  }
  if (apiKey) await context.secrets.delete('vllm-copilot.apiKey');

  await context.globalState.update(MIGRATION_FLAG, true);

  output.appendLine(`[INFO] Migrated ${models.length} model(s) to per-model server config; cleared legacy global settings.`);
  if (models.length > 0) {
    vscode.window.showInformationMessage(
      'vLLM-Copilot: your settings were migrated to per-model servers. The global server, headers, and sampling settings are now stored on each model.'
    );
  } else if (hasLegacyServer) {
    vscode.window.showWarningMessage(
      'vLLM-Copilot: a global server was configured but no models exist to attach it to. Run "Add vLLM Server & Model" to set one up.'
    );
  }
  return true;
}

/**
 * Pure core of the composite-id migration: rewrite each model's `id` to the
 * `"<model> on <host>"` form and pin `vllmModelId` to the raw wire identity.
 * Models without a `serverUrl` (unreachable — no host) are passed through
 * unchanged. Idempotent: a model already in composite form is left as-is.
 *
 * @returns the (possibly) rewritten models and whether anything changed.
 * @internal Exported for testing.
 */
export function computeCompositeIdMigration(models: ModelConfig[]): { models: ModelConfig[]; changed: boolean } {
  let changed = false;
  const updated = models.map(m => {
    if (!m.serverUrl) return m; // no host to build from — skip unreachable model
    const rawVllmId = resolveVllmModelId(m); // vllmModelId ?? id
    if (!rawVllmId) return m;
    const newId = buildModelId(m.serverUrl, rawVllmId);
    if (m.id === newId && m.vllmModelId === rawVllmId) return m; // already composite
    changed = true;
    return { ...m, id: newId, vllmModelId: rawVllmId };
  });
  return { models: updated, changed };
}

/**
 * One-time migration to composite model ids: rewrites each model's `id` to the
 * readable `"<model> on <host>"` form so the same model served from two servers
 * stays distinct in the picker. Preserves the raw wire identity by pinning
 * `vllmModelId` (falling back to the old `id` when it was unset).
 *
 * Runs once per machine (own globalState flag), after the per-model migration so
 * every model already has its `serverUrl`. Models without a `serverUrl` are left
 * untouched — they are unreachable and cannot yield a host. Idempotent.
 */
export async function migrateToCompositeIds(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<boolean> {
  if (context.globalState.get<boolean>(COMPOSITE_ID_FLAG)) return false;

  const section = vscode.workspace.getConfiguration('vllm-copilot');
  const models: ModelConfig[] = section.get<ModelConfig[]>('models') || [];

  const { models: updated, changed } = computeCompositeIdMigration(models);

  if (changed) {
    await section.update('models', updated, vscode.ConfigurationTarget.Global);
    output.appendLine(`[INFO] Migrated ${updated.length} model(s) to composite ids ("<model> on <host>").`);
  }
  await context.globalState.update(COMPOSITE_ID_FLAG, true);
  return changed;
}
