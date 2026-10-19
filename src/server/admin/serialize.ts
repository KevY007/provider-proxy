import { toDecimal, type MoneyLike } from "@/lib/money";

/** Decimal-ish -> plain decimal string (safe to pass to client components). null stays null. */
export function dstr(v: MoneyLike): string | null {
  if (v === null || v === undefined) return null;
  return toDecimal(v).toFixed();
}

/** Decimal-ish -> string, never null ("0" fallback). */
export function dstr0(v: MoneyLike): string {
  return toDecimal(v).toFixed();
}

/** Date -> ISO string (or null). */
export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** Postgres bigint / numeric / string -> JS number. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  const n = Number(String(v));
  return Number.isFinite(n) ? n : 0;
}
