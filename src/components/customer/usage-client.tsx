"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { format } from "date-fns";
import type { ColumnDef } from "@tanstack/react-table";
import { Activity, AlertCircle, Clock, Coins, Download, Hash, Layers, PiggyBank } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AreaChart, BarChart, ChartCard } from "@/components/common/chart-card";
import { DataTable } from "@/components/common/data-table";
import { DateRangePicker } from "@/components/common/date-range-picker";
import { MoneyText } from "@/components/common/money-text";
import { StatCard } from "@/components/common/stat-card";
import { rangeToParams, type DateRangeValue } from "@/lib/date-range";
import { formatUSD } from "@/lib/money";
import { summarizeSavings } from "@/server/customer/savings";
import { formatCompact, formatDuration, formatNumber, formatPercent } from "@/lib/utils";

export interface UsageSeriesPoint {
  bucket: string;
  requests: number;
  spend: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  errors: number;
  official: number;
  comparable: number;
}
export interface UsageBreakdownRow {
  name: string;
  requests: number;
  spend: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  errors: number;
  avgLatencyMs: number;
  official: number;
  comparable: number;
}
export interface UsageClientProps {
  range: { preset: DateRangeValue["preset"]; from: string; to: string };
  granularity: "hour" | "day";
  hourAllowed: boolean;
  totals: { requests: number; spend: number; inputTokens: number; outputTokens: number; cachedTokens: number; errors: number; avgLatencyMs: number; official: number; comparable: number };
  series: UsageSeriesPoint[];
  byModel: UsageBreakdownRow[];
  byKey: UsageBreakdownRow[];
  byEndpoint: UsageBreakdownRow[];
}

type Metric = "cost" | "tokens";

export function UsageClient(props: UsageClientProps) {
  const { totals, series, byModel, byKey, byEndpoint, granularity } = props;
  const router = useRouter();
  const pathname = usePathname();
  const [metric, setMetric] = useState<Metric>("cost");
  const range: DateRangeValue = useMemo(() => ({ preset: props.range.preset, from: new Date(props.range.from), to: new Date(props.range.to) }), [props.range]);

  function navigate(r: DateRangeValue, gran: "hour" | "day" | undefined = granularity) {
    const p = new URLSearchParams({ ...rangeToParams(r), ...(gran ? { gran } : {}) });
    router.push(`${pathname}?${p.toString()}`);
  }
  const exportHref = `${pathname}/export?${new URLSearchParams({ ...rangeToParams(range), gran: granularity }).toString()}`;

  const empty = totals.requests === 0;
  const savings = summarizeSavings(totals.official, totals.comparable);
  const hasSavingsData = totals.official > 0;
  const valueFmt = metric === "cost" ? (v: number) => formatUSD(v) : (v: number) => formatCompact(v);
  const timeRows = series.map((p) => ({ x: p.bucket, cost: p.spend, official: p.official > 0 ? p.official + (p.spend - p.comparable) : p.spend, input: Math.max(0, p.inputTokens - (p.cachedTokens ?? 0)), output: p.outputTokens }));
  // fresh input + output: cache reads are billed at a fraction of input and would inflate the figure
  const tokens = (r: UsageBreakdownRow) => Math.max(0, r.inputTokens - r.cachedTokens) + r.outputTokens;
  const barRows = (rows: UsageBreakdownRow[]) =>
    rows
      .map((r) => ({ name: r.name, value: metric === "cost" ? r.spend : tokens(r) }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  const xFmt = (v: string | number) => format(new Date(String(v)), granularity === "hour" ? "MMM d, HH:mm" : "MMM d");

  const columns = useMemo<ColumnDef<UsageBreakdownRow>[]>(
    () => [
      { accessorKey: "name", header: "Model", cell: ({ row }) => <span className="font-mono text-xs">{row.original.name}</span> },
      { accessorKey: "requests", header: "Requests", cell: ({ row }) => formatNumber(row.original.requests), meta: { className: "text-right" } },
      { accessorKey: "inputTokens", header: "Input tokens", cell: ({ row }) => formatNumber(row.original.inputTokens), meta: { className: "text-right" } },
      { accessorKey: "outputTokens", header: "Output tokens", cell: ({ row }) => formatNumber(row.original.outputTokens), meta: { className: "text-right" } },
      { accessorKey: "cachedTokens", header: "Cached tokens", cell: ({ row }) => formatNumber(row.original.cachedTokens), meta: { className: "text-right" } },
      { accessorKey: "spend", header: "Cost", cell: ({ row }) => <MoneyText value={row.original.spend} />, meta: { className: "text-right" } },
      {
        id: "saved",
        header: "Saved vs official",
        accessorFn: (r) => r.official - r.comparable,
        cell: ({ row }) => (row.original.official > 0 ? <MoneyText value={row.original.official - row.original.comparable} colorize signed /> : <span className="text-muted-foreground">-</span>),
        meta: { className: "text-right" },
      },
      { accessorKey: "avgLatencyMs", header: "Avg latency", cell: ({ row }) => formatDuration(row.original.avgLatencyMs), meta: { className: "text-right" } },
      {
        accessorKey: "errors",
        header: "Errors",
        cell: ({ row }) => (row.original.errors ? <span className="text-red-500">{formatNumber(row.original.errors)}</span> : <span className="text-muted-foreground">0</span>),
        meta: { className: "text-right" },
      },
    ],
    [],
  );

  const metricToggle = (
    <ToggleGroup type="single" variant="outline" size="sm" value={metric} onValueChange={(v) => v && setMetric(v as Metric)} aria-label="Metric">
      <ToggleGroupItem value="cost">Cost</ToggleGroupItem>
      <ToggleGroupItem value="tokens">Tokens</ToggleGroupItem>
    </ToggleGroup>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <DateRangePicker value={range} onChange={(r) => navigate(r, undefined)} />
        <ToggleGroup type="single" variant="outline" size="sm" value={granularity} onValueChange={(v) => v && navigate(range, v as "hour" | "day")} aria-label="Granularity">
          <ToggleGroupItem value="hour" disabled={!props.hourAllowed}>
            Hourly
          </ToggleGroupItem>
          <ToggleGroupItem value="day">Daily</ToggleGroupItem>
        </ToggleGroup>
        <Button asChild variant="outline" size="sm" className="ml-auto">
          <a href={exportHref} download>
            <Download className="size-4" /> Export CSV
          </a>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Spend" icon={Coins} value={<MoneyText value={totals.spend} />} />
        <StatCard
          label={savings.kind === "paid_more" ? "Paid more than official" : "Saved vs official prices"}
          icon={PiggyBank}
          value={hasSavingsData ? <span className={savings.kind === "saved" ? "text-emerald-600 dark:text-emerald-400" : savings.kind === "paid_more" ? "text-amber-600 dark:text-amber-400" : undefined}>{savings.value}</span> : "-"}
          hint={hasSavingsData ? <>official price <MoneyText value={totals.official} /></> : "No priced requests yet"}
        />
        <StatCard label="Requests" icon={Activity} value={formatNumber(totals.requests)} />
        <StatCard label="Tokens" icon={Hash} value={formatCompact(Math.max(0, totals.inputTokens - totals.cachedTokens) + totals.outputTokens)} hint={`${formatCompact(Math.max(0, totals.inputTokens - totals.cachedTokens))} in / ${formatCompact(totals.outputTokens)} out`} />
        <StatCard label="Cached tokens" icon={Layers} value={formatCompact(totals.cachedTokens)} hint={totals.inputTokens ? `${formatPercent(totals.cachedTokens / totals.inputTokens)} of input` : undefined} />
        <StatCard label="Error rate" icon={AlertCircle} value={formatPercent(totals.requests ? totals.errors / totals.requests : 0)} hint={`${formatNumber(totals.errors)} failed`} />
        <StatCard label="Avg latency" icon={Clock} value={totals.requests ? formatDuration(totals.avgLatencyMs) : "-"} />
        <StatCard label="Avg cost / request" icon={Coins} value={<MoneyText value={totals.requests ? totals.spend / totals.requests : 0} />} />
      </div>

      <ChartCard title={metric === "cost" ? "Spend vs official prices over time" : "Tokens over time"} action={metricToggle} empty={empty} emptyText="No requests in this period">
        {metric === "cost" ? (
          <AreaChart
            data={timeRows}
            xKey="x"
            series={[
              { key: "official", label: "At official prices", color: "var(--chart-3)" },
              { key: "cost", label: "You paid", color: "var(--chart-1)" },
            ]}
            valueFormatter={valueFmt}
            xFormatter={xFmt}
          />
        ) : (
          <AreaChart
            data={timeRows}
            xKey="x"
            stacked
            series={[
              { key: "input", label: "Input tokens" },
              { key: "output", label: "Output tokens" },
            ]}
            valueFormatter={valueFmt}
            xFormatter={xFmt}
          />
        )}
      </ChartCard>


      <div className="grid gap-4 lg:grid-cols-3">
        {(
          [
            ["By model", byModel],
            ["By API key", byKey],
            ["By endpoint", byEndpoint],
          ] as const
        ).map(([title, rows], i) => {
          const data = barRows(rows);
          return (
            <ChartCard key={title} title={title} description={metric === "cost" ? "Spend" : "Tokens"} empty={data.length === 0} emptyText="No data">
              <BarChart data={data} xKey="name" horizontal series={[{ key: "value", label: metric === "cost" ? "Spend" : "Tokens", color: `var(--chart-${(i % 5) + 1})` }]} valueFormatter={valueFmt} xFormatter={(v) => truncate(String(v), 16)} height={Math.max(180, data.length * 34 + 30)} />
            </ChartCard>
          );
        })}
      </div>

      <div className="space-y-3">
        <h2 className="text-base font-semibold">Usage by model</h2>
        <DataTable columns={columns} data={byModel} searchKey="name" searchPlaceholder="Filter models..." exportFilename="usage-by-model" initialSorting={[{ id: "spend", desc: true }]} emptyTitle="No usage in this period" hideColumnToggle />
      </div>
    </div>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
