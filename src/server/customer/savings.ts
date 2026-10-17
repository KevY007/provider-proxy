/**
 * Savings helpers (PLAN 9c). Pure: safe in server + client code and tests.
 *   Official price = what the original provider charges. Your price = what we charge.
 *   Savings = Official - Your price. Negative savings are shown neutrally/amber, never hidden.
 */
import { formatUSD, toDecimal, type MoneyLike } from "@/lib/money";

export type SavingsTone = "saving" | "premium" | "same" | "unknown";

export interface SavingsInfo {
  /** (official - price) / official * 100; null when there is no official price to compare to. */
  pct: number | null;
  tone: SavingsTone;
  /** Badge text: "-62% vs official" / "+15% vs official" / "Same as official" / "-". */
  label: string;
}

const blank = (v: MoneyLike) => v === null || v === undefined || v === "";

/** (official - price) / official * 100, null when official is missing/zero or price is missing. */
export function savingsPctOf(official: MoneyLike, price: MoneyLike): number | null {
  if (blank(official) || blank(price)) return null;
  const o = toDecimal(official);
  if (o.isZero() || o.isNegative()) return null;
  return o.minus(toDecimal(price)).div(o).times(100).toNumber();
}

export function describeSavings(official: MoneyLike, price: MoneyLike): SavingsInfo {
  const pct = savingsPctOf(official, price);
  if (pct === null || Number.isNaN(pct)) return { pct: null, tone: "unknown", label: "-" };
  const r = Math.round(pct);
  if (r === 0) return { pct, tone: "same", label: "Same as official" };
  // Real minus sign for savings (the price went down), plus for premiums.
  return r > 0 ? { pct, tone: "saving", label: `−${r}% vs official` } : { pct, tone: "premium", label: `+${Math.abs(r)}% vs official` };
}

export const SAVINGS_TONE_CLASS: Record<SavingsTone, string> = {
  saving: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  premium: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  same: "border-border bg-muted text-muted-foreground",
  unknown: "border-transparent text-muted-foreground",
};

export type SavingsKind = "saved" | "paid_more" | "even";

export interface SavingsSummary {
  kind: SavingsKind;
  /** Absolute dollar amount (always >= 0). */
  amount: string;
  /** Savings as a % of the official total (can be negative); null when official total is 0. */
  pct: number | null;
  /** Headline: "You saved $12.40 vs official prices" / "You paid $1.20 more than official prices". */
  headline: string;
  /** Short value for a KPI tile: "$12.40" */
  value: string;
}

/** Aggregate over a range: sum(officialPrice) vs sum(price). */
export function summarizeSavings(officialTotal: MoneyLike, paidTotal: MoneyLike): SavingsSummary {
  const o = toDecimal(officialTotal);
  const p = toDecimal(paidTotal);
  const diff = o.minus(p);
  const pct = o.isZero() ? null : diff.div(o).times(100).toNumber();
  const amount = diff.abs().toString();
  const value = formatUSD(diff.abs());
  if (diff.abs().lt("0.000001")) return { kind: "even", amount: "0", pct, headline: "Same as official prices", value: formatUSD(0) };
  if (diff.isPositive()) return { kind: "saved", amount, pct, headline: `You saved ${value} vs official prices`, value };
  return { kind: "paid_more", amount, pct, headline: `You paid ${value} more than official prices`, value };
}

/** Per-request: saved = officialPrice - price. Signed Decimal string (negative = paid more). "0" when no official price was recorded. */
export function requestSaving(officialPrice: MoneyLike, price: MoneyLike): string {
  if (blank(officialPrice) || toDecimal(officialPrice).isZero()) return "0";
  return toDecimal(officialPrice).minus(toDecimal(price)).toString();
}
