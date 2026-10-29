"use client";

import { format } from "date-fns";
import { AreaChart, ChartCard, DonutChart } from "@/components/common/chart-card";
import { formatUSD } from "@/lib/money";
import { formatCompact } from "@/lib/utils";

export interface SpendPoint {
  bucket: string; // ISO
  spend: number;
  requests: number;
}

export function SpendOverTimeCard({ data }: { data: SpendPoint[] }) {
  const rows = data.map((p) => ({ x: p.bucket, spend: p.spend, requests: p.requests }));
  const empty = data.every((p) => p.requests === 0);
  return (
    <ChartCard title="Spend over time" description="Last 14 days" empty={empty} emptyText="No usage yet. Make your first API request to see spend here." className="lg:col-span-2">
      <AreaChart
        data={rows}
        xKey="x"
        series={[{ key: "spend", label: "Spend" }]}
        valueFormatter={(v) => formatUSD(v)}
        xFormatter={(v) => format(new Date(String(v)), "MMM d")}
      />
    </ChartCard>
  );
}

export function ModelDonutCard({ data, metric }: { data: Array<{ name: string; spend: number; requests: number }>; metric: "spend" | "requests" }) {
  const rows = data.filter((d) => d[metric] > 0).map((d) => ({ name: d.name, value: d[metric] }));
  const total = rows.reduce((a, r) => a + r.value, 0);
  return (
    <ChartCard title="Model distribution" description={`Last 7 days by ${metric === "spend" ? "spend" : "requests"}`} empty={rows.length === 0} emptyText="No requests in the last 7 days">
      <DonutChart
        data={rows}
        valueFormatter={(v) => (metric === "spend" ? formatUSD(v) : formatCompact(v))}
        centerValue={metric === "spend" ? formatUSD(total) : formatCompact(total)}
        centerLabel={metric === "spend" ? "total spend" : "requests"}
      />
    </ChartCard>
  );
}
