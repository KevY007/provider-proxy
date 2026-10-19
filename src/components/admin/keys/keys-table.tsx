"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/common/data-table";
import { MoneyText } from "@/components/common/money-text";
import { StatusBadge } from "@/components/common/status-badge";
import { FilterInput, FilterSelect, ResetFilters, useUrlFilters } from "@/components/admin/url-filters";
import { fmtDate, timeAgo } from "@/components/admin/format";
import { Badge } from "@/components/ui/badge";
import type { ApiKeyRow } from "@/server/admin/keys-queries";
import { ApiKeyActions, RevealKey } from "./key-actions";

export function KeysTable({
  rows,
  total,
  page,
  pageSize,
  groups,
}: {
  rows: ApiKeyRow[];
  total: number;
  page: number;
  pageSize: number;
  groups: Array<{ id: string; name: string }>;
}) {
  const { set } = useUrlFilters();
  const columns = useMemo<ColumnDef<ApiKeyRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-medium">{row.original.name}</span>
            {row.original.isPlayground && <Badge variant="outline">playground</Badge>}
          </div>
        ),
      },
      {
        accessorKey: "prefix",
        header: "Prefix",
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <code className="text-xs">{row.original.prefix}…</code>
            {row.original.status !== "REVOKED" && <RevealKey id={row.original.id} name={row.original.name} compact />}
          </span>
        ),
      },
      {
        accessorKey: "email",
        header: "Owner",
        cell: ({ row }) => (
          <Link href={`/admin/customers/${row.original.userId}`} className="text-primary hover:underline">
            {row.original.email}
          </Link>
        ),
      },
      { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
      { accessorKey: "groupName", header: "Group", cell: ({ row }) => row.original.groupName ?? <span className="text-muted-foreground">inherit</span> },
      { accessorKey: "spent", header: "Spent", cell: ({ row }) => <MoneyText value={row.original.spent} />, meta: { className: "text-right" } },
      {
        accessorKey: "spendLimit",
        header: "Limit",
        cell: ({ row }) => (row.original.spendLimit ? <MoneyText value={row.original.spendLimit} /> : <span className="text-muted-foreground">none</span>),
        meta: { className: "text-right" },
      },
      { accessorKey: "rpmLimit", header: "RPM", cell: ({ row }) => row.original.rpmLimit ?? "-" },
      { accessorKey: "lastUsedAt", header: "Last used", cell: ({ row }) => <span title={row.original.lastUsedAt ?? ""} suppressHydrationWarning>{timeAgo(row.original.lastUsedAt)}</span> },
      { accessorKey: "expiresAt", header: "Expires", cell: ({ row }) => (row.original.expiresAt ? fmtDate(row.original.expiresAt) : "-") },
      { accessorKey: "createdAt", header: "Created", cell: ({ row }) => fmtDate(row.original.createdAt) },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { noExport: true, className: "text-right" },
        cell: ({ row }) => <ApiKeyActions id={row.original.id} name={row.original.name} status={row.original.status} />,
      },
    ],
    [],
  );

  return (
    <DataTable
      columns={columns}
      data={rows}
      hideColumnToggle
      pageSize={pageSize}
      getRowId={(r) => r.id}
      emptyTitle="No API keys match"
      emptyDescription="Try clearing the filters."
      serverPagination={{ page, pageSize, total, onPageChange: (p) => set("page", p ? String(p) : null, { keepPage: true }) }}
      toolbar={
        <>
          <FilterInput param="q" placeholder="Owner email or key name" className="w-56" />
          <FilterInput param="prefix" placeholder="Key prefix (sk-pp-…)" className="w-44" />
          <FilterSelect
            param="status"
            label="Status"
            options={[
              { value: "ACTIVE", label: "Active" },
              { value: "DISABLED", label: "Disabled" },
              { value: "REVOKED", label: "Revoked" },
            ]}
          />
          <FilterSelect param="group" label="Group" options={[{ value: "none", label: "(inherit)" }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
          <ResetFilters keys={["q", "prefix", "status", "group"]} />
        </>
      }
    />
  );
}
