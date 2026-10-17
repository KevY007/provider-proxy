import type { Metadata } from "next";
import { AlertTriangle, CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import { AutoRefresh } from "@/components/marketing/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { vendorLabel } from "@/server/customer/labels";
import { getStatusSnapshot } from "@/server/customer/status";
import { LEVEL_LABEL, type DayBar, type StatusLevel } from "@/server/customer/status-calc";

export const metadata: Metadata = { title: "Status", description: "Live availability of every model family." };
export const dynamic = "force-dynamic";

const BAR_COLOR: Record<StatusLevel, string> = {
  operational: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-red-500",
  nodata: "bg-muted",
};
const TEXT_COLOR: Record<StatusLevel, string> = {
  operational: "text-emerald-600 dark:text-emerald-400",
  degraded: "text-amber-600 dark:text-amber-400",
  down: "text-red-600 dark:text-red-400",
  nodata: "text-muted-foreground",
};
const ICON = { operational: CheckCircle2, degraded: AlertTriangle, down: XCircle, nodata: CircleHelp } as const;

const pct = (v: number | null) => (v === null ? "-" : `${v >= 99.995 ? "100" : v.toFixed(v >= 99 ? 2 : 1)}%`);

function Bars({ bars }: { bars: DayBar[] }) {
  return (
    <div className="flex h-9 items-end gap-[2px]" role="img" aria-label="90 day availability history">
      {bars.map((b) => (
        <div
          key={b.date}
          title={`${b.date}: ${b.pct === null ? "no data" : `${pct(b.pct)} (${(b.success + b.failed).toLocaleString()} requests)`}`}
          className={cn("h-full min-w-[2px] flex-1 rounded-[2px] transition-opacity hover:opacity-70", BAR_COLOR[b.level])}
        />
      ))}
    </div>
  );
}

export default async function StatusPage() {
  const snap = await getStatusSnapshot();
  const Icon = ICON[snap.overall];
  const banner =
    snap.overall === "operational"
      ? "All systems operational"
      : snap.overall === "degraded"
        ? "Some systems are experiencing issues"
        : snap.overall === "down"
          ? "Major outage"
          : "No recent traffic to report on";
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12">
      <div className="mb-8 space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">System status</h1>
        <p className="text-muted-foreground">Availability per model family, computed from live request outcomes and health checks.</p>
      </div>

      <div
        className={cn(
          "mb-8 flex items-center gap-3 rounded-xl border p-5",
          snap.overall === "operational" && "border-emerald-500/30 bg-emerald-500/10",
          snap.overall === "degraded" && "border-amber-500/30 bg-amber-500/10",
          snap.overall === "down" && "border-red-500/30 bg-red-500/10",
        )}
      >
        <Icon className={cn("size-6", TEXT_COLOR[snap.overall])} />
        <div className="flex-1">
          <p className="font-medium">{banner}</p>
          <p className="text-xs text-muted-foreground">Updated {new Date(snap.generatedAt).toISOString().replace("T", " ").slice(0, 19)} UTC</p>
        </div>
        <AutoRefresh seconds={30} />
      </div>

      {snap.vendors.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">No models are published yet.</div>
      ) : (
        <div className="space-y-4">
          {snap.vendors.map((v) => {
            const VIcon = ICON[v.level];
            return (
              <section key={v.vendor} className="rounded-xl border bg-card/50 p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <h2 className="text-lg font-medium">{vendorLabel(v.vendor)}</h2>
                    <Badge variant="secondary" className="font-normal">
                      {v.modelCount} {v.modelCount === 1 ? "model" : "models"}
                    </Badge>
                  </div>
                  <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", TEXT_COLOR[v.level])}>
                    <VIcon className="size-4" />
                    {LEVEL_LABEL[v.level]}
                  </span>
                </div>
                <Bars bars={v.bars} />
                <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                  <span>90 days ago</span>
                  <span>Today</span>
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-3 border-t pt-4 text-sm">
                  {[
                    ["Last 24 hours", v.availability24h],
                    ["Last 7 days", v.availability7d],
                    ["Last 90 days", v.availability90d],
                  ].map(([label, val]) => (
                    <div key={label as string}>
                      <dt className="text-xs text-muted-foreground">{label as string}</dt>
                      <dd className="font-medium tabular-nums">{pct(val as number | null)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-4 text-xs text-muted-foreground">
        {(["operational", "degraded", "down", "nodata"] as const).map((l) => (
          <span key={l} className="inline-flex items-center gap-1.5">
            <span className={cn("size-2.5 rounded-sm", BAR_COLOR[l])} />
            {LEVEL_LABEL[l]}
          </span>
        ))}
      </div>
    </div>
  );
}
