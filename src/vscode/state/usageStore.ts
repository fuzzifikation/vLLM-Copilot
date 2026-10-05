/**
 * Editor binding of the usage ledger: this file owns the extension's
 * canonical storage location (globalStorage/usage.json), the legacy globalState
 * downgrade mirror, the log sink and the `onUsageStoreDidChange` event — the
 * accounting state, aggregation, persistence format, delta merge and money
 * semantics live in `core/usage/ledger.ts` as an explicit instance.
 *
 * The extension remains the sole ingestion point for requests in its host
 * (`recordRequest`, fed by the provider's completion path). A standalone Node
 * consumer instantiates its own `UsageLedger` at an explicitly selected path:
 * separate installations, not one global ledger across machines.
 *
 * Identity ruling (complexity audit P14-1, 2026-09-03): usage is keyed by
 * normalized server URL BY DESIGN: counters follow the machine, not the
 * credential. Two registry entries that share one serverUrl (e.g. different
 * API keys) get separate metrics engines and dashboard nodes but share these
 * token/cost counters and the Last Request capture. Re-keying by registry
 * entry id would rewrite historical totals; the config shape that would
 * notice is rare and the merged view ("what this box burned") is the useful
 * one.
 *
 * Same public API as before the extraction: every caller (dashboard, status
 * bar, provider, commands) keeps importing these functions unchanged, and
 * `recordRequest`/`resetUsage` stay synchronous — the change event fires
 * after the synchronous mutation/scheduling, as always.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import type { ModelConfig } from '../../core/config/config.js';
import { readServers } from './configStore.js';
import {
  UsageLedger,
  findModelCost as ledgerFindModelCost,
  type CostRates,
  type ServerCost,
  type ServerUsage,
  type UsageLedgerHost,
} from '../../core/index.js';

// ─── Canonical types, re-exported for existing consumers ─────────────────

export { emptyCounts } from '../../core/usage/ledger.js';
export type { UsageCounts, UsageServerMap, UsageCostMap, ServerUsage, ServerCost } from '../../core/usage/ledger.js';
export type { CostRates } from '../../core/usage/money.js';
/** Data captured from a single completed request. The canonical type lives in
 *  core (the execution core BUILDS it); re-exported here for existing consumers. */
export type { LastRequestData } from '../../core/usage/record.js';
import type { LastRequestData } from '../../core/usage/record.js';

const emitter = new vscode.EventEmitter<void>();

/** Fired after any store mutation (record or reset) — the dashboard re-renders. */
export const onUsageStoreDidChange: vscode.Event<void> = emitter.event;

const resetEmitter = new vscode.EventEmitter<'all' | { serverUrl: string }>();

/**
 * Fired after a reset, with its scope. A reset means more than zeroed
 * counters: totals cleared at time T imply that traffic completed before T must
 * not be folded in afterwards, or a user who clears their dashboard watches the
 * old numbers crawl back. External ingestion listens and refuses older records.
 */
export const onUsageDidReset: vscode.Event<'all' | { serverUrl: string }> = resetEmitter.event;

const STORAGE_KEY = 'vllm-copilot.usage.v1';

/**
 * The window's ledger instance, created at import time: consumers call
 * recordRequest/getLastRequest without awaiting activation, so the store runs
 * memory-only until initUsageStore binds the storage path, the memento mirror
 * and the log sink (exactly the old no-globalStorage degrade).
 */
const host: UsageLedgerHost = { onChange: () => emitter.fire() };
const ledger = new UsageLedger(host);

// ─── Activation ──────────────────────────────────────────────────────

/**
 * Initialize the store. Called once from `activate()` (awaited) before any
 * request can complete. Binds the canonical storage location, the legacy
 * globalState downgrade mirror and the log sink, then loads: the shared
 * `usage.json` wins; absent OR unreadable, the legacy globalState blob is
 * adopted as the recovery source (one-time migration — the next persist
 * writes it back as the file). Returns a Disposable that releases the event.
 */
export async function initUsageStore(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<{ dispose(): void }> {
  host.filePath = context.globalStorageUri
    ? path.join(context.globalStorageUri.fsPath, 'usage.json')
    : undefined;
  host.log = { appendLine: msg => outputChannel.appendLine(msg) };
  host.mirror = {
    read: () => context.globalState.get(STORAGE_KEY),
    write: value => context.globalState.update(STORAGE_KEY, value),
  };
  await ledger.load();
  return { dispose: () => emitter.dispose() };
}

// ─── Record / read / reset ────────────────────────────────────────────────

/**
 * Record a completed request. Stores it as the server's last request AND
 * accumulates it into the all-time and today counters, then persists and
 * fires the change event (the dashboard re-renders immediately).
 * Semantics (planes, actual-cost separation, first-record stamping, delta
 * replay) live in the core ledger — this is the synchronous wrapper.
 */
export function recordRequest(data: LastRequestData): void {
  ledger.recordRequest(data);
}

/**
 * Fold an externally completed request into the counters, leaving the Last
 * Request capture alone. See `UsageLedger.recordExternalRequest`.
 */
export function recordExternalRequest(data: LastRequestData): void {
  ledger.recordExternalRequest(data);
}

/** Last request for a server, or undefined if none recorded this activation. */
export function getLastRequest(serverUrl: string): LastRequestData | undefined {
  return ledger.getLastRequest(serverUrl);
}

/**
 * The freshest last-request record across all servers, or undefined while
 * nothing has been captured this activation. Backs the status bar chip.
 * Ephemeral: `resetUsage` deliberately keeps the map, a reload empties it.
 */
export function getLatestRequest(): LastRequestData | undefined {
  return ledger.getLatestRequest();
}

/** Cumulative per-model counts for a server across all-time and today. */
export function getServerUsage(serverUrl: string): ServerUsage {
  return ledger.getServerUsage(serverUrl);
}

/** Cumulative actual reported cost (USD) per model for a server, all-time and today. */
export function getServerCost(serverUrl: string): ServerCost {
  return ledger.getServerCost(serverUrl);
}

/** True when a server has any recorded usage (all-time). */
export function hasServerUsage(serverUrl: string): boolean {
  return ledger.hasServerUsage(serverUrl);
}

/** Server URLs that have any recorded usage (all-time). */
export function getServersWithUsage(): string[] {
  return ledger.getServersWithUsage();
}

/** Epoch ms of the first recorded request for (serverUrl, modelId), or undefined. */
export function getModelStartedAt(serverUrl: string, modelId: string): number | undefined {
  return ledger.getModelStartedAt(serverUrl, modelId);
}

/**
 * Clear accumulated usage for a scope. `'all'` clears every server; an object
 * clears one server only. Last Request is deliberately NOT cleared. Persists
 * and fires the change event; the cross-window deletion replay lives in the
 * ledger.
 */
export function resetUsage(scope: 'all' | { serverUrl: string }): void {
  ledger.reset(scope);
  resetEmitter.fire(scope);
}

// ─── Cost derivation (render-time, never stored) ──────────────────────────

/**
 * Locate a model's cost rates by `(serverUrl, wire modelId)`.
 * The wire id (`vllmModelId` or legacy `id`) is what the tracker keys on.
 * Returns undefined when the model has no `cost` config. The registry comes
 * from the editor settings here; the core lookup itself takes it explicitly.
 */
export function findModelCost(
  models: ModelConfig[],
  serverUrl: string,
  modelId: string,
): CostRates | undefined {
  return ledgerFindModelCost(models, readServers(), serverUrl, modelId);
}
