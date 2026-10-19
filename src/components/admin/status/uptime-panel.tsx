"use client";

import { useState } from "react";
import { format } from "date-fns";
import { BarChart, ChartCard } from "@/components/common/chart-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useUrlFilters } from "@/components/admin/url-filters";
import { cn, formatDuration } from "@/lib/utils";
import type { UptimeLevel, UptimeProvider, UptimeRange } from "@/server/admin/uptime-queries";

const COLOR: Record<UptimeLevel, string> = { up: "bg-emerald-500", degraded: "bg-amber-500", down: "bg-red-500", nodata: "bg-muted" };
const pct = (v: number | null) => (v === null ? "no data" : `${v >= 99.995 ? "100" : v.toFixed(v >= 99 ? 2 : 1)}%`);

function Strip({ p, range }: { p: UptimeProvider; range: UptimeRange }) {
  const fmt = range === "24h" ? "MMM d HH:mm" : "MMM d HH:mm";
  return (
    <div className="flex h-8 items-end gap-px" role="img" aria-label={`${p.name} uptime history`}>
      {p.buckets.map((b) => (
        <div
          key={b.t}
          title={`${format(new Date(b.t), fmt)}: ${pct(b.pct)}${b.calls ? ` - ${b.calls} calls (${b.failedCalls} failed)` : ""}${b.pings ? ` - ${b.pings} pings (${b.failedPings} failed)` : ""}${b.pingMs !== null ? ` - ping ${b.pingMs} ms` : ""}${b.p50Ms !== null ? ` - p50 ${formatDuration(b.p50Ms)}` : ""}`}
          className={cn("h-full min-w-[2px] flex-1 rounded-[2px] hover:opacity-70", COLOR[b.level])}
        />
      ))}
    </div>
  );
}

/** Uptime / downtime bars per provider + ping / latency history of one provider. */
export function UptimePanel({ range, providers, monitoring }: { range: UptimeRange; providers: UptimeProvider[]; monitoring: boolean }) {
  const { setMany } = useUrlFilters();
  const withData = providers.filter((p) => p.uptimePct !== null);
  const [sel, setSel] = useState<string>(withData[0]?.id ?? providers[0]?.id ?? "");
  const chosen = providers.find((p) => p.id === sel);
  const xFmt = (v: string | number) => format(new Date(String(v)), range === "24h" ? "HH:mm" : "MMM d");
  const chartRows = (chosen?.buckets ?? []).map((b) => ({ x: b.t, ping: b.pingMs, p50: b.p50Ms }));
  const hasChart = chartRows.some((r) => r.ping !== null || r.p50 !== null);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Uptime history</CardTitle>
            <CardDescription>
              Green = up (99%+ of calls{monitoring ? " and pings" : ""} succeeded), amber = degraded, red = down, grey = no calls{monitoring ? " and no pings" : ""} in that period.{" "}
              {monitoring ? "Uptime pings are on (Settings > Monitoring)." : "Uptime pings are off, so idle periods stay grey: turn on Uptime monitoring in Settings for 24/7 checks."}
            </CardDescription>
          </div>
          <ToggleGroup type="single" variant="outline" size="sm" value={range} onValueChange={(v) => v && setMany({ uptime: v })} aria-label="Uptime range">
            <ToggleGroupItem value="24h">24h</ToggleGroupItem>
            <ToggleGroupItem value="7d">7d</ToggleGroupItem>
            <ToggleGroupItem value="30d">30d</ToggleGroupItem>
          </ToggleGroup>
        </CardHeader>
        <CardContent className="space-y-4">
          {providers.length === 0 && <p className="text-sm text-muted-foreground">No active providers.</p>}
          {providers.map((p) => (
            <div key={p.id} className="space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  <span className={cn("font-medium tabular-nums", p.uptimePct === null ? "" : p.uptimePct >= 99 ? "text-emerald-600 dark:text-emerald-400" : p.uptimePct >= 90 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400")}>{pct(p.uptimePct)}</span> uptime
                  {p.downMinutes > 0 && <> · ~{p.downMinutes >= 120 ? `${Math.round(p.downMinutes / 60)} h` : `${p.downMinutes} min`} down</>}
                  {p.lastPingMs !== null && <> · last ping {p.lastPingMs} ms</>}
                </span>
              </div>
              <Strip p={p} range={range} />
            </div>
          ))}
        </CardContent>
      </Card>

      <ChartCard
        title="Ping and latency history"
        description="Ping = round trip of an uptime ping (only while uptime monitoring is on). p50 = median total time of successful real calls."
        action={
          <Select value={sel} onValueChange={setSel}>
            <SelectTrigger size="sm" className="w-auto min-w-40" aria-label="Provider">
              <SelectValue placeholder="Provider" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        empty={!hasChart}
        emptyText="No calls or pings for this provider in this period"
      >
        <BarChart
          data={chartRows}
          xKey="x"
          series={[
            { key: "ping", label: "Ping" },
            { key: "p50", label: "p50 real calls" },
          ]}
          valueFormatter={(v) => formatDuration(v)}
          xFormatter={xFmt}
        />
      </ChartCard>
    </div>
  );
}
