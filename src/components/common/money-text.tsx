import { cn } from "@/lib/utils";
import { formatUSD, toDecimal, type FormatUSDOptions, type MoneyLike } from "@/lib/money";

export interface MoneyTextProps extends FormatUSDOptions {
  /** Prisma Decimal, decimal.js, string or number. Serialize Decimals with `.toString()` when passing to client components. */
  value: MoneyLike;
  /** Colour negatives red and (with `signed`) positives green. */
  colorize?: boolean;
  className?: string;
}

/**
 * Renders USD with smart precision (see `formatUSD`): `$12.34`, `$0.0421`, `$0.000123`.
 * Uses tabular numerals so columns line up. Works in server and client components.
 */
export function MoneyText({ value, colorize, className, ...fmt }: MoneyTextProps) {
  const d = toDecimal(value);
  return (
    <span
      className={cn(
        "tabular-nums",
        colorize && d.isNegative() && "text-red-500",
        colorize && fmt.signed && d.isPositive() && !d.isZero() && "text-emerald-500",
        className,
      )}
      title={d.toFixed(12).replace(/\.?0+$/, "")}
    >
      {formatUSD(d, fmt)}
    </span>
  );
}
