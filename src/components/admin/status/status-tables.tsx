"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/common/data-table";
import { StatusBadge } from "@/components/common/status-badge";
import { useAction } from "@/components/admin/use-action";
import { runChecksNow } from "@/server/admin/status-actions";
import { availabilityTone } from "@/server/admin/status-utils";
import type { RecentFailure, StatusKeyRow, StatusProviderRow } from "@/server/admin/status-queries";
import { formatNumber, truncate } from "@/lib/utils";
import { cn } from "@/lib/utils";

export function RunChecksButton() {
  const { run, pending } = useAction();
  return (
    <Button onClick={() => run(() => runChecksNow())} disabled={pending}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Run checks now
    </Button>
  );
}

const TONE = { success: "text-emerald-500", warning: "text-amber-500", danger: "text-red-500", neutral: "text-muted-foreground" } as const;

function Avail({ pct, samples }: { pct: number | null; samples?: number }) {
  return (
    <span className={cn("tabular-nums font-medium", TONE[availabilityTone(pct)])} title={samples != null ? `${samples} checks in the last 24h` : undefined}>
      {pct === null ? "no data" : `${pct.toFixed(pct === 100 ? 0 : 2)}%`}
    </span>
  );
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

const providerCols: ColumnDef<StatusProviderRow>[] = [
  {
    accessorKey: "name",
    header: "Provider",
    cell: ({ row }) => (
      <Link href={`/admin/providers/${row.original.id}`} className="font-medium hover:underline">
        {row.original.name}
      </Link>
    ),
  },
  { accessorKey: "status", header: "Config", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
  { accessorKey: "healthStatus", header: "Health", cell: ({ row }) => <StatusBadge status={row.original.healthStatus} /> },
  { accessorKey: "avail24h", header: "Availability 24h", cell: ({ row }) => <Avail pct={row.original.avail24h} samples={row.original.checks24h} /> },
  { accessorKey: "avail7d", header: "Availability 7d", cell: ({ row }) => <Avail pct={row.original.avail7d} /> },
  { accessorKey: "lastLatencyMs", header: "Latency", cell: ({ row }) => (row.original.lastLatencyMs != null ? `${row.original.lastLatencyMs}ms` : "-") },
  {
    id: "traffic",
    header: "Traffic errors 24h",
    accessorFn: (r) => r.err24h,
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">
        <span className={row.original.err24h ? "text-red-500" : ""}>{formatNumber(row.original.err24h)}</span> / {formatNumber(row.original.req24h)}
      </span>
    ),
  },
  { accessorKey: "lastCheckAt", header: "Last check", cell: ({ row }) => <span className="whitespace-nowrap text-xs text-muted-foreground">{when(row.original.lastCheckAt)}</span> },
];

const keyCols: ColumnDef<StatusKeyRow>[] = [
  { accessorKey: "providerName", header: "Provider", cell: ({ row }) => <Link href={`/admin/providers/${row.original.providerId}`} className="hover:underline">{row.original.providerName}</Link> },
  {
    accessorKey: "label",
    header: "Key",
    cell: ({ row }) => (
      <span className="font-medium">
        {row.original.label} <span className="font-mono text-xs font-normal text-muted-foreground">••••{row.original.secretHint}</span>
      </span>
    ),
  },
  { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
  {
    id: "last",
    header: "Last check",
    accessorFn: (r) => (r.lastCheckOk === null ? "" : r.lastCheckOk ? "OK" : "FAILED"),
    cell: ({ row }) =>
      row.original.lastCheckOk === null ? (
        <span className="text-xs text-muted-foreground">none</span>
      ) : (
        <span className="flex items-center gap-2">
          <StatusBadge status={row.original.lastCheckOk ? "OK" : "FAILED"} />
          <span className="text-xs text-muted-foreground">{row.original.lastLatencyMs != null ? `${row.original.lastLatencyMs}ms` : ""}</span>
        </span>
      ),
  },
  { accessorKey: "avail24h", header: "Avail 24h", cell: ({ row }) => <Avail pct={row.original.avail24h} samples={row.original.checks24h} /> },
  { accessorKey: "avail7d", header: "Avail 7d", cell: ({ row }) => <Avail pct={row.original.avail7d} /> },
  { accessorKey: "fails24h", header: "Failed 24h", cell: ({ row }) => <span className={cn("tabular-nums", row.original.fails24h ? "text-red-500" : "text-muted-foreground")}>{row.original.fails24h}</span> },
  {
    accessorKey: "lastError",
    header: "Last error",
    cell: ({ row }) => <span className="text-xs text-muted-foreground" title={row.original.lastError ?? ""}>{row.original.lastError ? truncate(row.original.lastError, 70) : ""}</span>,
  },
];

const failureCols: ColumnDef<RecentFailure>[] = [
  { accessorKey: "createdAt", header: "When", cell: ({ row }) => <span className="whitespace-nowrap text-xs">{when(row.original.createdAt)}</span> },
  { accessorKey: "providerName", header: "Provider" },
  { accessorKey: "keyLabel", header: "Key", cell: ({ row }) => row.original.keyLabel ?? "provider" },
  { accessorKey: "latencyMs", header: "Latency", cell: ({ row }) => (row.original.latencyMs != null ? `${row.original.latencyMs}ms` : "-") },
  { accessorKey: "error", header: "Error", cell: ({ row }) => <span className="text-xs text-muted-foreground" title={row.original.error ?? ""}>{row.original.error ? truncate(row.original.error, 120) : ""}</span> },
];

export function StatusTables({ providers, keys, failures }: { providers: StatusProviderRow[]; keys: StatusKeyRow[]; failures: RecentFailure[] }) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Provider health</CardTitle>
          <CardDescription>Availability = successful health checks / all checks. Traffic errors come from real requests.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={providerCols} data={providers} pageSize={15} hideColumnToggle exportFilename="provider-health" emptyTitle="No providers" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Key / account health</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable columns={keyCols} data={keys} searchKey="label" searchPlaceholder="Search keys..." pageSize={15} exportFilename="key-health" emptyTitle="No provider keys" emptyDescription="Add keys on a provider page to start monitoring them." />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent failed checks</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable columns={failureCols} data={failures} pageSize={10} hideColumnToggle emptyTitle="No failed checks" emptyDescription="Nothing has failed recently." />
        </CardContent>
      </Card>
    </div>
  );
}
