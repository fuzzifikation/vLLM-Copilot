/**
 * Last-known-good budget ledger: what each server honestly reported the last
 * time it answered. When a server is unreachable, discovery reconstructs the
 * model's advertised budget from here instead of fabricating one — a model
 * stays visible in the picker with a stale-but-real budget rather than
 * vanishing or advertising an invented window.
 *
 * Identity: entries are keyed by (serverUrl, vLLM wire model id) — NOT the
 * picker id. `globalState` is shared across workspaces in the profile and
 * picker ids are user-chosen, so keying by picker id would let one server's
 * budget graft onto a different model that merely shares the id.
 *
 * Best-effort storage: memento writes are fire-and-forget (the in-memory copy
 * is authoritative for this session), and any malformed persisted entry is
 * dropped at load — a corrupted ledger degrades to "never reached" offline
 * rows, never to a poisoned budget.
 *
 * Entries are deliberately NEVER pruned. Removed servers/models leave a few
 * two-number orphans behind — harmless. Pruning to the keys this workspace
 * just saw would NOT be harmless: globalState is shared across every
 * workspace in the profile, so a pass here would silently delete another
 * window's models' budgets, and that window would wake up mid-outage to
 * placeholders instead of its own last-known-good numbers. Storage dust
 * beats stealing a neighbor's memory.
 */
import * as vscode from 'vscode';

export interface KnownBudget {
  /** Total context window the server reported (input + output). */
  maxModelLen: number;
  /** The output budget we last advertised for this model. */
  maxOutputTokens: number;
}

export interface BudgetLedger {
  recall(key: string): KnownBudget | undefined;
  record(key: string, budget: KnownBudget): void;
}

/** Composite storage key for a model's REAL identity (see header). */
export function ledgerKey(serverUrl: string, vllmModelId: string): string {
  // NUL separator: cannot occur in a URL or a model id, so the composite is unambiguous.
  return `${serverUrl}\u0000${vllmModelId}`;
}

const STORAGE_KEY = 'vllm-copilot.lastKnownBudgets';

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1;
}

function isBudget(value: unknown): value is KnownBudget {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as KnownBudget;
  return isPositiveInt(b.maxModelLen) && isPositiveInt(b.maxOutputTokens);
}

/** Test fixture stand-in when the host provides no memento at all. */
function inMemoryMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: (key: string) => store.get(key),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: async (key: string, value: any) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
    keys: () => [...store.keys()],
  };
}

export function createBudgetLedger(state: vscode.Memento | undefined): BudgetLedger {
  const memento = state ?? inMemoryMemento();
  const budgets = new Map<string, KnownBudget>();

  const persisted = memento.get<unknown>(STORAGE_KEY);
  if (persisted && typeof persisted === 'object') {
    for (const [key, value] of Object.entries(persisted as Record<string, unknown>)) {
      if (isBudget(value)) budgets.set(key, value);
    }
  }

  return {
    recall: key => budgets.get(key),
    record(key, budget) {
      const previous = budgets.get(key);
      if (previous
        && previous.maxModelLen === budget.maxModelLen
        && previous.maxOutputTokens === budget.maxOutputTokens) {
        return; // unchanged — no pointless persistence churn
      }
      budgets.set(key, budget);
      void Promise
        .resolve(memento.update(STORAGE_KEY, Object.fromEntries(budgets)))
        .catch(() => { /* storage failure only costs future offline fidelity */ });
    },
  };
}
