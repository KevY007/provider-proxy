"use client";

import { AreaChart, BarChart, ChartCard } from "@/components/common/chart-card";
import { MoneyText } from "@/components/common/money-text";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCompact, formatNumber } from "@/lib/utils";
import { formatUSD } from "@/lib/money";
import type { Granularity } from "@/server/analytics/params";
import type { BreakdownRow, TimePoint } from "@/server/analytics/queries";

function label(iso: string, gran: Granularity) {
  return gran === "hour" ? iso.slice(5, 16).replace("T", " ") : iso.slice(5, 10);
}

export function CustomerUsage({ series, models, gran }: { series: TimePoint[]; models: BreakdownRow[]; gran: Granularity }) {
  const data = series.map((p) => ({ ...p, label: label(p.t, gran) }));
  const empty = series.every((p) => p.requests === 0);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Spend, cost & profit" description="What the customer paid vs. what it cost us" empty={empty}>
          <AreaChart data={data} xKey="label" series={[{ key: "revenue", label: "Spend" }, { key: "cost", label: "Cost" }, { key: "profit", label: "Profit" }]} valueFormatter={(v) => formatUSD(v)} />
        </ChartCard>
        <ChartCard title="Requests" description="Total vs. errors" empty={empty}>
          <BarChart data={data} xKey="label" series={[{ key: "requests", label: "Requests" }, { key: "errors", label: "Errors", color: "var(--destructive)" }]} valueFormatter={(v) => formatCompact(v)} />
        </ChartCard>
      </div>
      <ChartCard title="By model" description="Top models in the selected range" empty={models.length === 0}>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Profit</TableHead>
                <TableHead className="text-right">Margin</TableHead>
                <TableHead className="text-right">Errors</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((m) => (
                <TableRow key={m.key}>
                  <TableCell className="font-mono text-xs">{m.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(m.requests)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCompact(m.tokens)}</TableCell>
                  <TableCell className="text-right">
                    <MoneyText value={m.revenue} />
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyText value={m.cost} />
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyText value={m.profit} colorize />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{m.marginPct.toFixed(1)}%</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(m.errors)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </ChartCard>
    </div>
  );
}
