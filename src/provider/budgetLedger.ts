/**
 * Last-known-good budget ledger: what each server honestly reported the last
 * time it answered this session. When a server is unreachable, discovery
 * reconstructs the model's advertised budget from here instead of fabricating
 * one: a model stays visible in the picker with a stale-but-real budget
 * rather than vanishing or advertising an invented window.
 *
 * In-memory only, by design: server health changes from one moment to the
 * next, so nothing is persisted. After a restart the ledger is empty and
 * offline rows fall back to configured limits with labeled placeholders until
 * each server answers once.
 *
 * Identity: entries are keyed by (serverUrl, vLLM wire model id), NOT the
 * picker id. Picker ids are user-chosen and can be repointed, so keying by
 * picker id would let one server's budget graft onto a different model that
 * merely shares the id.
 */

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

/** Composite identity key for a model's REAL identity (see header). */
export function ledgerKey(serverUrl: string, vllmModelId: string): string {
  // NUL separator: cannot occur in a URL or a model id, so the composite is unambiguous.
  return `${serverUrl}\u0000${vllmModelId}`;
}

export function createBudgetLedger(): BudgetLedger {
  const budgets = new Map<string, KnownBudget>();
  return {
    recall: key => budgets.get(key),
    record: (key, budget) => { budgets.set(key, budget); },
  };
}
