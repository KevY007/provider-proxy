"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Download, Gift } from "lucide-react";
import { DataTable } from "@/components/common/data-table";
import { MoneyText } from "@/components/common/money-text";
import { StatusBadge } from "@/components/common/status-badge";
import { FilterInput, FilterSelect, ResetFilters, useUrlFilters } from "@/components/admin/url-filters";
import { fmtDate, timeAgo } from "@/components/admin/format";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/utils";
import type { CustomerRow } from "@/server/admin/customers-queries";
import { GrantCreditDialog } from "./credit-dialogs";
import { CreateUserDialog } from "./user-dialogs";

export function CustomersTable({
  isAdmin = true,
  rows,
  total,
  page,
  pageSize,
  groups,
  exportQuery,
}: {
  /** Only admins (not support staff) can grant credit. */
  isAdmin?: boolean;
  rows: CustomerRow[];
  total: number;
  page: number;
  pageSize: number;
  groups: Array<{ id: string; name: string }>;
  exportQuery: string;
}) {
  const { set, get } = useUrlFilters();
  const router = useRouter();
  const [grant, setGrant] = useState<{ ids: string[]; clear: () => void } | null>(null);
  const columns = useMemo<ColumnDef<CustomerRow>[]>(
    () => [
      {
        accessorKey: "email",
        header: "Email",
        cell: ({ row }) => (
          <Link href={`/admin/customers/${row.original.id}`} className="font-medium text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
            {row.original.email}
          </Link>
        ),
      },
      { accessorKey: "name", header: "Name", cell: ({ row }) => row.original.name ?? <span className="text-muted-foreground">-</span> },
      { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
      { accessorKey: "role", header: "Role", cell: ({ row }) => (row.original.role === "CUSTOMER" ? <span className="text-muted-foreground">Customer</span> : <StatusBadge status={row.original.role} dot={false} />) },
      { accessorKey: "groupName", header: "Group", cell: ({ row }) => row.original.groupName ?? <span className="text-muted-foreground">-</span> },
      { accessorKey: "balance", header: "Balance", cell: ({ row }) => <MoneyText value={row.original.balance} colorize />, meta: { className: "text-right" } },
      { accessorKey: "creditLimit", header: "Credit limit", cell: ({ row }) => <MoneyText value={row.original.creditLimit} />, meta: { className: "text-right" } },
      { accessorKey: "spend30d", header: "30d spend", cell: ({ row }) => <MoneyText value={row.original.spend30d} />, meta: { className: "text-right" } },
      { accessorKey: "requests30d", header: "30d requests", cell: ({ row }) => formatNumber(row.original.requests30d), meta: { className: "text-right" } },
      { accessorKey: "lastActive", header: "Last active", cell: ({ row }) => <span title={row.original.lastActive ?? ""} suppressHydrationWarning>{timeAgo(row.original.lastActive)}</span> },
      { accessorKey: "createdAt", header: "Created", cell: ({ row }) => fmtDate(row.original.createdAt) },
    ],
    [],
  );

  return (
    <>
    <DataTable
      columns={columns}
      data={rows}
      pageSize={pageSize}
      hideColumnToggle
      getRowId={(r) => r.id}
      bulkActions={
        isAdmin
          ? ({ selected, clear }) => (
              <Button size="sm" variant="secondary" onClick={() => setGrant({ ids: selected.map((s) => s.id), clear })}>
                <Gift className="size-4" /> Grant credit
              </Button>
            )
          : undefined
      }
      onRowClick={(r) => router.push(`/admin/customers/${r.id}`)}
      emptyTitle="No customers match"
      emptyDescription="Try a different search or clear the filters."
      serverPagination={{ page, pageSize, total, onPageChange: (p) => set("page", p ? String(p) : null, { keepPage: true }) }}
      toolbar={
        <>
          <FilterInput param="q" placeholder="Search email, name or id" className="w-64" />
          <FilterSelect
            param="status"
            label="Status"
            options={[
              { value: "ACTIVE", label: "Active" },
              { value: "PENDING_VERIFICATION", label: "Pending verification" },
              { value: "SUSPENDED", label: "Suspended" },
            ]}
          />
          <FilterSelect
            param="role"
            label="Role"
            options={[
              { value: "CUSTOMER", label: "Customer" },
              { value: "SUPPORT", label: "Support" },
              { value: "ADMIN", label: "Admin" },
            ]}
          />
          <FilterSelect param="group" label="Group" options={[{ value: "none", label: "(none)" }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
          <FilterSelect
            param="sort"
            label="Sort"
            allLabel="Newest"
            options={[
              { value: "balance", label: "Balance" },
              { value: "spend", label: "30d spend" },
              { value: "active", label: "Last active" },
            ]}
          />
          {get("sort") === "balance" && (
            <FilterSelect param="dir" label="Order" allLabel="Highest first" options={[{ value: "asc", label: "Lowest first" }]} />
          )}
          <ResetFilters keys={["q", "status", "role", "group", "sort", "dir"]} />
          {isAdmin && <CreateUserDialog groups={groups} />}
          <Button variant="outline" size="sm" asChild>
            <a href={`/admin/customers/export${exportQuery ? `?${exportQuery}` : ""}`}>
              <Download className="size-4" /> Export CSV
            </a>
          </Button>
        </>
      }
    />
    <GrantCreditDialog userIds={grant?.ids ?? []} open={!!grant} onOpenChange={(o) => !o && setGrant(null)} onDone={() => grant?.clear()} />
    </>
  );
}
