import { Decimal, formatUSD } from "@/lib/money";

/** Pure (client-safe) top-up amount rules. */

/** Stripe won't charge less than $0.50 (USD). */
export const STRIPE_MIN_USD = 0.5;
/** Stripe's maximum single charge for USD. */
export const STRIPE_MAX_USD = 999_999.99;

export type AmountCheck = { ok: true; amount: Decimal } | { ok: false; error: string };

/**
 * Validate a user-supplied top-up amount against the `minTopup` / `maxTopup` settings and Stripe's limits.
 * Accepts numbers or numeric strings; max two decimals (whole cents).
 */
export function validateTopupAmount(raw: unknown, limits: { min: number; max: number }): AmountCheck {
  if (raw === null || raw === undefined || raw === "") return { ok: false, error: "Enter an amount" };
  if (typeof raw !== "number" && typeof raw !== "string") return { ok: false, error: "Enter a valid amount" };
  const s = String(raw).trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    return { ok: false, error: /^\d+\.\d{3,}$/.test(s) ? "Use at most 2 decimal places" : "Enter a valid amount" };
  }
  const amount = new Decimal(s);
  if (amount.lte(0)) return { ok: false, error: "Amount must be greater than zero" };
  const min = Math.max(limits.min, STRIPE_MIN_USD);
  const max = Math.min(limits.max > 0 ? limits.max : STRIPE_MAX_USD, STRIPE_MAX_USD);
  if (amount.lt(min)) return { ok: false, error: `Minimum top-up is ${formatUSD(min)}` };
  if (amount.gt(max)) return { ok: false, error: `Maximum top-up is ${formatUSD(max)}` };
  return { ok: true, amount };
}
