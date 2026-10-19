import Decimal from "decimal.js";

/**
 * Money helpers. All money is USD, stored as Decimal(24,12). Never use JS numbers for balances/prices.
 * Prisma returns `Prisma.Decimal` (decimal.js based); `toDecimal` accepts those, strings, numbers, null.
 */
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
export type MoneyLike = Decimal.Value | { toString(): string } | null | undefined;

export const ZERO = new Decimal(0);
export const ONE_MILLION = new Decimal(1_000_000);

/** Coerce anything numeric-ish (Prisma Decimal, string, number, null) to a Decimal. Invalid/null => `fallback`. */
export function toDecimal(v: MoneyLike, fallback: Decimal.Value = 0): Decimal {
  if (v === null || v === undefined || v === "") return new Decimal(fallback);
  if (v instanceof Decimal) return v;
  try {
    return new Decimal(typeof v === "object" ? v.toString() : (v as Decimal.Value));
  } catch {
    return new Decimal(fallback);
  }
}

/** Sum an iterable of money-likes. */
export function sum(values: Iterable<MoneyLike>): Decimal {
  let total = new Decimal(0);
  for (const v of values) total = total.plus(toDecimal(v));
  return total;
}

/** `units * pricePerMillion / 1e6` (token pricing). */
export function perMillion(units: Decimal.Value, pricePerMillion: MoneyLike): Decimal {
  return new Decimal(units).times(toDecimal(pricePerMillion)).div(ONE_MILLION);
}

/** Round to the DB scale (12 dp) - use before persisting computed values. */
export function roundDb(v: MoneyLike): Decimal {
  return toDecimal(v).toDecimalPlaces(12, Decimal.ROUND_HALF_UP);
}

/** Decimal string safe to hand to Prisma / JSON (no exponent). */
export function toDbString(v: MoneyLike): string {
  return roundDb(v).toFixed(12);
}

/** Lossy conversion for charts only. */
export function toNumber(v: MoneyLike): number {
  return toDecimal(v).toNumber();
}

export function isZero(v: MoneyLike): boolean {
  return toDecimal(v).isZero();
}

export function max(a: MoneyLike, b: MoneyLike): Decimal {
  return Decimal.max(toDecimal(a), toDecimal(b));
}

export function min(a: MoneyLike, b: MoneyLike): Decimal {
  return Decimal.min(toDecimal(a), toDecimal(b));
}

export interface FormatUSDOptions {
  /** Force an exact number of decimals (disables smart precision). */
  decimals?: number;
  /** Prefix positive numbers with "+". */
  signed?: boolean;
  /** Significant digits to show for tiny amounts (<$0.01). Default 3. */
  tinyDigits?: number;
  /** Use compact notation for large amounts ($1.2K, $3.4M). */
  compact?: boolean;
}

const groupFmt = (dp: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

/**
 * Format USD with smart precision:
 *  - >= $1            => 2 decimals ($1,234.57)
 *  - >= $0.01         => up to 4 decimals, min 2 ($0.0421, $0.50)
 *  - tiny non-zero    => enough decimals for `tinyDigits` significant digits ($0.000123), capped at 12
 *  - zero             => $0.00
 */
export function formatUSD(v: MoneyLike, opts: FormatUSDOptions = {}): string {
  const d = toDecimal(v);
  const neg = d.isNegative() && !d.isZero();
  const abs = d.abs();
  let body: string;

  if (opts.compact && abs.gte(1000)) {
    const n = abs.toNumber();
    body =
      "$" +
      new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
  } else if (opts.decimals !== undefined) {
    body = "$" + groupFmt(opts.decimals).format(Number(abs.toFixed(opts.decimals)));
  } else if (abs.isZero()) {
    body = "$0.00";
  } else if (abs.gte(1)) {
    body = "$" + groupFmt(2).format(Number(abs.toFixed(2)));
  } else if (abs.gte(0.01)) {
    const s = abs.toFixed(4).replace(/0+$/, "");
    const [i, f = ""] = s.split(".");
    body = `$${i}.${f.padEnd(2, "0")}`;
  } else {
    const sig = opts.tinyDigits ?? 3;
    // number of leading zeros after the decimal point
    const exp = abs.e; // e.g. 0.000123 => -4
    const dp = Math.min(12, -exp - 1 + sig);
    const s = abs.toFixed(Math.max(dp, 2));
    body = "$" + s.replace(/0+$/, "").replace(/\.$/, ".00");
    if (/^\$0\.0*$/.test(body) || body === "$0") body = "$0.00";
  }
  const sign = neg ? "-" : opts.signed && !abs.isZero() ? "+" : "";
  return sign + body;
}

/** "$2.50 / 1M" style per-million token price. */
export function formatPricePerMillion(v: MoneyLike): string {
  const d = toDecimal(v);
  if (d.isZero()) return "$0";
  const abs = d.abs();
  if (abs.gte(1)) return `$${abs.toFixed(2)}`;
  const [i, f = ""] = abs.toFixed(6).split(".");
  const trimmed = f.replace(/0+$/, "").padEnd(2, "0");
  return `$${i}.${trimmed}`;
}

/** Percentage helper: part/whole*100 as a number (0 when whole is 0). */
export function percent(part: MoneyLike, whole: MoneyLike): number {
  const w = toDecimal(whole);
  if (w.isZero()) return 0;
  return toDecimal(part).div(w).times(100).toNumber();
}
