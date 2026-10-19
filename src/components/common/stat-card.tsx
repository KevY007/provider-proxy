import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface StatCardProps {
  label: string;
  /** Pre-formatted value (e.g. from formatUSD / formatCompact) or any node such as <MoneyText/>. */
  value: React.ReactNode;
  /** Small muted text under the value. */
  hint?: React.ReactNode;
  icon?: LucideIcon;
  /** Change vs previous period, as a percentage number (e.g. 12.5 or -3). */
  trend?: number | null;
  /** When true, a rising trend is shown as bad (e.g. error rate, cost). */
  invertTrend?: boolean;
  loading?: boolean;
  className?: string;
}

/** KPI tile: label, big value, optional icon, trend arrow and hint. */
export function StatCard({ label, value, hint, icon: Icon, trend, invertTrend, loading, className }: StatCardProps) {
  const up = (trend ?? 0) > 0;
  const good = invertTrend ? !up : up;
  return (
    <Card className={cn("gap-0 py-0", className)}>
      <CardContent className="flex items-start justify-between gap-3 p-5">
        <div className="min-w-0 space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="h-8 w-28" />
          ) : (
            <p className="truncate text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
          )}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {trend != null && !loading && (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 font-medium",
                  trend === 0 ? "text-muted-foreground" : good ? "text-emerald-500" : "text-red-500",
                )}
              >
                {trend !== 0 && (up ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />)}
                {Math.abs(trend).toFixed(1)}%
              </span>
            )}
            {hint && <span className="truncate">{hint}</span>}
          </div>
        </div>
        {Icon && (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-4" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
