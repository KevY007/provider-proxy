"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/common/data-table";
import { StatusBadge } from "@/components/common/status-badge";
import { MoneyText } from "@/components/common/money-text";
import type { ProviderDetail } from "@/server/admin/providers-queries";
import { truncate } from "@/lib/utils";

type Check = ProviderDetail["checks"][number];
type Route = ProviderDetail["routes"][number];

const checkCols: ColumnDef<Check>[] = [
  { accessorKey: "createdAt", header: "When", cell: ({ row }) => <span className="whitespace-nowrap text-xs" suppressHydrationWarning>{new Date(row.original.createdAt).toLocaleString()}</span> },
  { accessorKey: "keyLabel", header: "Target" },
  { id: "ok", header: "Result", accessorFn: (r) => (r.ok ? "OK" : "FAILED"), cell: ({ row }) => <StatusBadge status={row.original.ok ? "OK" : "FAILED"} /> },
  { accessorKey: "latencyMs", header: "Latency", cell: ({ row }) => (row.original.latencyMs != null ? `${row.original.latencyMs}ms` : "-") },
  { accessorKey: "error", header: "Error", cell: ({ row }) => <span className="text-xs text-muted-foreground" title={row.original.error ?? ""}>{row.original.error ? truncate(row.original.error, 90) : ""}</span> },
];

const routeCols: ColumnDef<Route>[] = [
  {
    accessorKey: "modelSlug",
    header: "Public model",
    cell: ({ row }) => (
      <Link href={`/admin/models/${row.original.modelId}`} className="font-medium hover:underline">
        {row.original.modelSlug}
        <span className="block text-xs font-normal text-muted-foreground">{row.original.modelName}</span>
      </Link>
    ),
  },
  { accessorKey: "upstreamModel", header: "Real upstream model", cell: ({ row }) => <span className="font-mono text-xs">{row.original.upstreamModel}</span> },
  { accessorKey: "enabled", header: "Enabled", cell: ({ row }) => <StatusBadge status={row.original.enabled ? "ACTIVE" : "DISABLED"} /> },
  { accessorKey: "priority", header: "Prio / weight", cell: ({ row }) => <span className="tabular-nums">{row.original.priority} / {row.original.weight}</span> },
  {
    id: "groups",
    header: "Groups",
    accessorFn: (r) => r.groupSlugs.join(","),
    cell: ({ row }) => (row.original.groupSlugs.length ? <span className="flex flex-wrap gap-1">{row.original.groupSlugs.map((g) => <Badge key={g} variant="outline">{g}</Badge>)}</span> : <span className="text-xs text-muted-foreground">all</span>),
  },
  { id: "cost", header: "Cost in / out (per 1M)", accessorFn: (r) => r.inputCost, cell: ({ row }) => <span className="text-xs"><MoneyText value={row.original.inputCost} /> / <MoneyText value={row.original.outputCost} /></span> },
];

export function ProviderSidePanels({ checks, routes }: { checks: Check[]; routes: Route[] }) {
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Routes using this provider</CardTitle>
          <CardDescription>Public models that can be served by this upstream. Edit them on the model page.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={routeCols} data={routes} pageSize={10} hideColumnToggle emptyTitle="No routes" emptyDescription="No model routes point at this provider yet. Create one from a model's page." />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent health checks</CardTitle>
          <CardDescription>Last 25 checks for the provider and its keys.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={checkCols} data={checks} pageSize={10} hideColumnToggle emptyTitle="No health checks yet" emptyDescription='Use "Test" on a key or "Run checks now" on the Status page.' />
        </CardContent>
      </Card>
    </div>
  );
}
