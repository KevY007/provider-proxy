"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { format } from "date-fns";
import Link from "next/link";
import { Download } from "lucide-react";
import { AreaChart, BarChart, ChartCard, DonutChart } from "@/components/common/chart-card";
import { DataTable } from "@/components/common/data-table";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatCompact, formatDuration, formatNumber, formatPercent } from "@/lib/utils";
import { formatUSD } from "@/lib/money";
import type { BreakdownRow, TimePoint } from "@/server/analytics/queries";
import type { BreakdownDim, Granularity } from "@/server/analytics/params";
import { useUrlFilters } from "./url-filters";

const usd = (v: number) => formatUSD(v, { compact: true });

function xFormatter(gran: Granularity) {
  return (v: string | number) => {
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) return String(v);
    if (gran === "hour") return format(d, "MMM d HH:mm");
    if (gran === "month") return format(d, "MMM yyyy");
    return format(d, "MMM d");
  };
}

export type SeriesMode = "money" | "requests" | "tokens";

/** Time-series area chart with a Money / Requests / Tokens toggle (data from getTimeSeries). */
export function TimeSeriesChart({
  data,
  gran,
  title = "Revenue, cost and profit",
  initialMode = "money",
  height = 280,
  hideToggle,
}: {
  data: TimePoint[];
  gran: Granularity;
  title?: string;
  initialMode?: SeriesMode;
  height?: number;
  hideToggle?: boolean;
}) {
  const [mode, setMode] = useState<SeriesMode>(initialMode);
  const empty = data.every((p) => !p.requests);
  const cfg =
    mode === "money"
      ? { series: [{ key: "revenue", label: "Revenue", color: "var(--chart-2)" }, { key: "cost", label: "Cost", color: "var(--chart-4)" }, { key: "profit", label: "Profit", color: "var(--chart-1)" }], fmt: usd }
      : mode === "requests"
        ? { series: [{ key: "requests", label: "Requests", color: "var(--chart-1)" }, { key: "errors", label: "Errors", color: "var(--chart-5)" }], fmt: (v: number) => formatCompact(v) }
        : { series: [{ key: "tokens", label: "Tokens", color: "var(--chart-3)" }], fmt: (v: number) => formatCompact(v) };
  return (
    <ChartCard
      title={title}
      empty={empty}
      emptyText="No requests in this period"
      action={
        hideToggle ? undefined : (
          <ToggleGroup type="single" size="sm" variant="outline" value={mode} onValueChange={(v) => v && setMode(v as SeriesMode)}>
            <ToggleGroupItem value="money">USD</ToggleGroupItem>
            <ToggleGroupItem value="requests">Requests</ToggleGroupItem>
            <ToggleGroupItem value="tokens">Tokens</ToggleGroupItem>
          </ToggleGroup>
        )
      }
    >
      <AreaChart data={data as unknown as Array<Record<string, string | number | null>>} xKey="t" series={cfg.series} valueFormatter={cfg.fmt} xFormatter={xFormatter(gran)} height={height} />
    </ChartCard>
  );
}

export type BreakdownMetric = "revenue" | "cost" | "profit" | "requests" | "tokens";
const METRICS: Array<{ value: BreakdownMetric; label: string }> = [
  { value: "revenue", label: "Revenue" },
  { value: "cost", label: "Cost" },
  { value: "profit", label: "Profit" },
  { value: "requests", label: "Requests" },
  { value: "tokens", label: "Tokens" },
];

const DIM_LABEL: Record<BreakdownDim, string> = {
  model: "Model",
  provider: "Provider",
  providerKey: "Provider key",
  customer: "Customer",
  group: "Group",
  endpoint: "Endpoint",
  status: "Status",
  errorCode: "Error code",
  apiKey: "API key",
};

/** Bar + donut charts and a full table for one breakdown dimension. */
export function BreakdownPanel({
  dim,
  rows,
  exportHref,
  customerLinks,
}: {
  dim: BreakdownDim;
  rows: BreakdownRow[];
  exportHref?: string;
  /** link customer rows to /admin/customers/[id] */
  customerLinks?: boolean;
}) {
  const [metric, setMetric] = useState<BreakdownMetric>(dim === "errorCode" || dim === "status" ? "requests" : "revenue");
  const money = metric === "revenue" || metric === "cost" || metric === "profit";
  const fmt = money ? usd : (v: number) => formatCompact(v);
  const top = useMemo(() => [...rows].sort((a, b) => b[metric] - a[metric]).slice(0, 10), [rows, metric]);
  const donut = useMemo(() => {
    const pos = top.filter((r) => r[metric] > 0);
    return pos.map((r) => ({ name: r.label.length > 28 ? `${r.label.slice(0, 27)}…` : r.label, value: r[metric] }));
  }, [top, metric]);

  const columns = useMemo<ColumnDef<BreakdownRow>[]>(
    () => [
      {
        accessorKey: "label",
        header: DIM_LABEL[dim],
        cell: ({ row }) =>
          customerLinks && row.original.key !== "(none)" ? (
            <Link href={`/admin/customers/${row.original.key}`} className="font-medium hover:underline">
              {row.original.label}
            </Link>
          ) : (
            <span className="font-medium">{row.original.label}</span>
          ),
      },
      { accessorKey: "requests", header: "Requests", cell: ({ row }) => formatNumber(row.original.requests), meta: { className: "text-right tabular-nums" } },
      { accessorKey: "errorRate", header: "Err %", cell: ({ row }) => formatPercent(row.original.errorRate), meta: { className: "text-right tabular-nums", label: "Error rate" } },
      { accessorKey: "revenue", header: "Revenue", cell: ({ row }) => formatUSD(row.original.revenue), meta: { className: "text-right tabular-nums" } },
      { accessorKey: "cost", header: "Cost", cell: ({ row }) => formatUSD(row.original.cost), meta: { className: "text-right tabular-nums" } },
      {
        accessorKey: "profit",
        header: "Profit",
        cell: ({ row }) => <span className={row.original.profit < 0 ? "text-red-500" : undefined}>{formatUSD(row.original.profit)}</span>,
        meta: { className: "text-right tabular-nums" },
      },
      {
        accessorKey: "marginPct",
        header: "Margin",
        cell: ({ row }) => <span className={row.original.marginPct < 0 ? "text-red-500" : undefined}>{row.original.marginPct.toFixed(1)}%</span>,
        meta: { className: "text-right tabular-nums" },
      },
      { accessorKey: "tokens", header: "Tokens", cell: ({ row }) => formatCompact(row.original.tokens), meta: { className: "text-right tabular-nums" } },
      { accessorKey: "avgLatencyMs", header: "Avg lat.", cell: ({ row }) => formatDuration(row.original.avgLatencyMs), meta: { className: "text-right tabular-nums", label: "Avg latency" } },
      { accessorKey: "p95LatencyMs", header: "p95 lat.", cell: ({ row }) => formatDuration(row.original.p95LatencyMs), meta: { className: "text-right tabular-nums", label: "p95 latency" } },
    ],
    [dim, customerLinks],
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title={`Top ${DIM_LABEL[dim].toLowerCase()}s by ${metric}`}
          empty={top.length === 0}
          action={
            <ToggleGroup type="single" size="sm" variant="outline" value={metric} onValueChange={(v) => v && setMetric(v as BreakdownMetric)}>
              {METRICS.map((m) => (
                <ToggleGroupItem key={m.value} value={m.value}>
                  {m.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          }
        >
          <BarChart
            horizontal
            data={top.map((r) => ({ name: r.label.length > 20 ? `${r.label.slice(0, 19)}…` : r.label, value: r[metric] }))}
            xKey="name"
            series={[{ key: "value", label: METRICS.find((m) => m.value === metric)?.label ?? metric }]}
            valueFormatter={fmt}
            height={Math.max(200, top.length * 30 + 30)}
          />
        </ChartCard>
        <ChartCard title="Share" empty={donut.length === 0}>
          <DonutChart data={donut} valueFormatter={fmt} />
        </ChartCard>
      </div>
      <DataTable
        columns={columns}
        data={rows}
        searchKey="label"
        searchPlaceholder={`Search ${DIM_LABEL[dim].toLowerCase()}...`}
        exportFilename={`analytics-by-${dim}`}
        initialSorting={[{ id: money ? metric : "requests", desc: true }]}
        pageSize={25}
        emptyTitle="No data for this period"
        toolbar={
          exportHref ? (
            <Button variant="outline" size="sm" asChild>
              <a href={exportHref}>
                <Download className="size-4" /> Server CSV
              </a>
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

/** Tab-like selector for the breakdown dimension, bound to `?by=`. */
export function DimensionTabs({ value, dims }: { value: BreakdownDim; dims: BreakdownDim[] }) {
  const { set } = useUrlFilters();
  return (
    <ToggleGroup type="single" variant="outline" size="sm" value={value} onValueChange={(v) => v && set("by", v)} className="flex-wrap">
      {dims.map((d) => (
        <ToggleGroupItem key={d} value={d}>
          {DIM_LABEL[d]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
