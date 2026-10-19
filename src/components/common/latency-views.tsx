"use client";

import { useMemo } from "react";
import { format } from "date-fns";
import type { ColumnDef } from "@tanstack/react-table";
import { BarChart, ChartCard } from "@/components/common/chart-card";
import { DataTable } from "@/components/common/data-table";
import { formatDuration, formatNumber } from "@/lib/utils";

/** Mirrors server/analytics/latency (kept structural so client code never imports server-only modules). */
export interface LatencyRowView {
  key: string;
  label: string;
  calls: number;
  errors: number;
  p50Ms: number | null;
  p95Ms: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  queueP95Ms: number | null;
  lastMs: number | null;
  lastAt: string | null;
}

export interface LatencyPointView {
  t: string;
  calls: number;
  p50Ms: number | null;
  p95Ms: number | null;
  ttftP50Ms: number | null;
}

/** p50 / p95 / time-to-first-token over time, from real calls (empty buckets = no calls, not "0 ms"). */
export function LatencyHistoryChart({ data, gran, title = "Latency history" }: { data: LatencyPointView[]; gran: string; title?: string }) {
  const rows = useMemo(() => data.map((p) => ({ x: p.t, p50: p.p50Ms, p95: p.p95Ms, ttft: p.ttftP50Ms })), [data]);
  const empty = !data.some((p) => p.calls > 0);
  const xFmt = (v: string | number) => format(new Date(String(v)), gran === "hour" ? "MMM d, HH:mm" : "MMM d");
  return (
    <ChartCard title={title} description="Measured on real calls only - nothing is pinged on a timer. Periods without calls stay empty." empty={empty} emptyText="No calls in this period">
      {/* bars, not areas: a single bucket with calls is still visible and empty buckets stay visibly empty */}
      <BarChart
        data={rows}
        xKey="x"
        series={[
          { key: "ttft", label: "p50 first token" },
          { key: "p50", label: "p50 total" },
          { key: "p95", label: "p95 total" },
        ]}
        valueFormatter={(v) => formatDuration(v)}
        xFormatter={xFmt}
      />
    </ChartCard>
  );
}

const ago = (iso: string | null): string => {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

/** Latency per provider / key / model. `showErrors` and `showQueue` are admin-only columns. */
export function LatencyTable({ rows, nameHeader, showErrors = false, showQueue = false, emptyTitle = "No calls in this period" }: { rows: LatencyRowView[]; nameHeader: string; showErrors?: boolean; showQueue?: boolean; emptyTitle?: string }) {
  const columns = useMemo<ColumnDef<LatencyRowView>[]>(() => {
    const cols: ColumnDef<LatencyRowView>[] = [
      { accessorKey: "label", header: nameHeader, cell: ({ row }) => <span className="font-mono text-xs">{row.original.label}</span> },
      { accessorKey: "calls", header: "Calls", cell: ({ row }) => formatNumber(row.original.calls), meta: { className: "text-right" } },
      { accessorKey: "lastMs", header: "Last call", cell: ({ row }) => <span title={row.original.lastAt ?? ""}>{formatDuration(row.original.lastMs)} <span className="text-xs text-muted-foreground">{ago(row.original.lastAt)}</span></span> },
      { accessorKey: "p50Ms", header: "p50", cell: ({ row }) => formatDuration(row.original.p50Ms), meta: { className: "text-right" } },
      { accessorKey: "p95Ms", header: "p95", cell: ({ row }) => formatDuration(row.original.p95Ms), meta: { className: "text-right" } },
      { accessorKey: "ttftP50Ms", header: "First token p50", cell: ({ row }) => formatDuration(row.original.ttftP50Ms), meta: { className: "text-right" } },
      { accessorKey: "ttftP95Ms", header: "First token p95", cell: ({ row }) => formatDuration(row.original.ttftP95Ms), meta: { className: "text-right" } },
    ];
    if (showQueue) cols.push({ accessorKey: "queueP95Ms", header: "Queue p95", cell: ({ row }) => formatDuration(row.original.queueP95Ms), meta: { className: "text-right" } });
    if (showErrors) cols.push({ accessorKey: "errors", header: "Upstream errors", cell: ({ row }) => formatNumber(row.original.errors), meta: { className: "text-right" } });
    return cols;
  }, [nameHeader, showErrors, showQueue]);
  return <DataTable columns={columns} data={rows} searchKey="label" searchPlaceholder={`Search ${nameHeader.toLowerCase()}...`} emptyTitle={emptyTitle} pageSize={10} />;
}
