/**
 * Money semantics — neutral formatting for the accounting planes. USD is the
 * only unit this product uses; every rate is denominated in dollars. No
 * editor, no settings, no storage.
 */

/** Per-1M-token cost rates. All values are interpreted in `currency` units. */
export interface CostRates {
  input?: number;
  output?: number;
  cachedInput?: number;
  currency?: string;
}

/** Precision-aware amount formatting (no currency decoration). */
function formatAmount(value: number): string {
  // Money convention for >= $1 (keep 2 decimals); extended precision with
  // trailing-zero stripping below $1 so per-request costs survive rounding.
  if (value >= 100) return value.toFixed(0);
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4).replace(/\.?0+$/, '');
  return value.toFixed(6).replace(/\.?0+$/, '');
}

/**
 * Currency decoration — deliberately NOT an i18n toolbox. USD is the only
 * unit this product uses; every rate is denominated in dollars.
 *
 * The raw-label fallback exists for a hand-edited `currency` in
 * settings.json: an unrecognised label is shown verbatim rather than
 * wearing a `$` that would be a lie. Nothing in the shipped UI can produce
 * one (ruling 2026-09-25: USD only).
 */
function currencyPrefix(currency?: string): string {
  const label = currency ?? 'USD';
  return label.toLowerCase() === 'usd' ? '$' : `${label} `;
}

/**
 * Format a cost with its currency label, rounded to 2 decimals — the standard
 * money display, for amounts that are genuinely money totals (credit balances,
 * budgets, monthly spend). Per-request costs use {@link formatCostFine} and
 * per-million model rates use {@link formatCostRate}, because 2 decimals
 * annihilates both.
 */
export function formatCost(value: number, currency?: string): string {
  return `${currencyPrefix(currency)}${value.toFixed(2)}`;
}

/**
 * Fine-precision variant for numbers that can be legitimately tiny: a request
 * can cost $0.000019 and a per-million rate can be $0.004, and 2 decimals
 * renders both as $0.00, which is not rounding, it is erasure. Keeps the
 * adaptive precision (up to 6 decimals, trailing zeros stripped).
 */
export function formatCostFine(value: number, currency?: string): string {
  return `${currencyPrefix(currency)}${formatAmount(value)}`;
}

/**
 * A per-million model RATE, shared by the model picker and the dashboard.
 *
 * Money formatting is right for a total and wrong for a rate: a configured
 * $0.004 rendered as $0.00, which deletes the number instead of approximating
 * it. The money look is therefore kept whenever 2 decimals is LOSSLESS (`$0.30`,
 * `$1.20`), and the adaptive precision takes over only when rounding would
 * change the value. One owner for both surfaces, so the picker and the
 * dashboard can never print the same rate two different ways.
 */
export function formatCostRate(value: number, currency?: string): string {
  if (value === 0) return formatCost(0, currency);
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-9
    ? formatCost(value, currency)
    : formatCostFine(value, currency);
}

/**
 * Compact cost summary: `$11.51 today and $31.13 total` — shows exactly what
 * the API/store reports. "Today" only when a today figure exists, "Total" only
 * when an all-time figure exists, both joined when both exist. NO fabricated
 * window math (the old "in N days" phrasing divided total spend by an invented
 * recording window — a rate, not a fact). `undefined` when neither figure
 * exists. Sub-cent costs use fine precision so they never collapse to $0.00.
 */
export function formatCostSummary(
  todayCost: number | undefined,
  overallCost: number | undefined,
  currency: string | undefined,
): string | undefined {
  if (todayCost === undefined && overallCost === undefined) return undefined;
  const parts: string[] = [];
  if (todayCost !== undefined) parts.push(`${formatCostFine(todayCost, currency)} today`);
  if (overallCost !== undefined) parts.push(`${formatCostFine(overallCost, currency)} total`);
  return parts.join(' and ');
}
