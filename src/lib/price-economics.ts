// Pure, client-safe pricing economics for the admin editors: what a price rule earns on a sample workload, and the
// rule value that hits a target ("$40 revenue on $30 of upstream spend"). USD per 1M tokens throughout.

export interface TokenPrices {
  input: number;
  output: number;
  /** cached input; null = billed as input */
  cached: number | null;
}

/** A sample workload, in millions of tokens. Default: 10M tokens, 3:1 input:output, half the input from cache. */
export interface Workload {
  inputM: number;
  outputM: number;
  cachedM: number;
}

export const DEFAULT_WORKLOAD: Workload = { inputM: 3.75, outputM: 2.5, cachedM: 3.75 };

export const workloadTotal = (w: Workload) => w.inputM + w.outputM + w.cachedM;

/** Price of a workload under a token price list. */
export function workloadPrice(p: TokenPrices, w: Workload): number {
  return w.inputM * p.input + w.outputM * p.output + w.cachedM * (p.cached ?? p.input);
}

export interface Economics {
  /** what the customer pays */
  revenue: number;
  /** what the upstream charges us */
  cost: number;
  /** the same usage at the maker's official list price (null = unknown) */
  list: number | null;
  profit: number;
  /** profit / revenue x 100 */
  marginPct: number | null;
  /** (list - revenue) / list x 100: what the customer saves */
  savingsPct: number | null;
}

export function economics(revenue: number, cost: number, list: number | null): Economics {
  const profit = revenue - cost;
  return {
    revenue,
    cost,
    list,
    profit,
    marginPct: revenue > 0 ? (profit / revenue) * 100 : null,
    savingsPct: list && list > 0 ? ((list - revenue) / list) * 100 : null,
  };
}

/** Sum economics over several models (each priced on the same workload). */
export function sumEconomics(rows: Economics[]): Economics {
  const revenue = rows.reduce((a, r) => a + r.revenue, 0);
  const cost = rows.reduce((a, r) => a + r.cost, 0);
  const lists = rows.map((r) => r.list);
  const list = lists.every((l) => l !== null) ? lists.reduce((a: number, l) => a + (l as number), 0) : null;
  return economics(revenue, cost, list);
}

export type Target =
  | { kind: "revenue_per_cost"; revenue: number; cost: number } // "$40 revenue on $30 of upstream spend"
  | { kind: "margin"; pct: number } // profit as % of revenue
  | { kind: "markup"; pct: number } // profit as % of cost
  | { kind: "savings"; pct: number }; // customer pays this % less than the list price

/**
 * The multiplier (factor on the basis price) that reaches a target, given the basis price, cost and list price of the
 * same workload. Returns null when the target cannot be expressed (no cost / list price to aim at).
 *   revenue = basis x factor
 */
export function solveFactor(target: Target, basis: number, cost: number, list: number | null): number | null {
  if (!(basis > 0)) return null;
  let revenue: number | null = null;
  switch (target.kind) {
    case "revenue_per_cost":
      if (!(target.cost > 0) || !(cost > 0)) return null;
      revenue = cost * (target.revenue / target.cost);
      break;
    case "margin":
      if (!(cost > 0) || target.pct >= 100) return null;
      revenue = cost / (1 - target.pct / 100);
      break;
    case "markup":
      if (!(cost > 0)) return null;
      revenue = cost * (1 + target.pct / 100);
      break;
    case "savings":
      if (!list || !(list > 0)) return null;
      revenue = list * (1 - target.pct / 100);
      break;
  }
  return revenue !== null && revenue >= 0 ? revenue / basis : null;
}

/** "$1,234.56" / "$0.0042" (more decimals for small amounts). */
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return `${n < 0 ? "-" : ""}$${abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export const fmtPctN = (n: number | null | undefined, d = 0) => (n === null || n === undefined || !Number.isFinite(n) ? "-" : `${n.toFixed(d)}%`);
