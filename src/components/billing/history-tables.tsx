"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";
import { DataTable } from "@/components/common/data-table";
import { MoneyText } from "@/components/common/money-text";
import { StatusBadge } from "@/components/common/status-badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toDecimal } from "@/lib/money";
import type { LedgerRow, PaymentRow } from "@/server/billing/types";
import { DateTime, KIND_LABELS, LEDGER_LABELS, LedgerTypeBadge } from "./shared";

function CustomerLink({ id, email }: { id?: string; email?: string }) {
  if (!email) return null;
  return id ? (
    <Link href={`/admin/customers/${id}`} className="text-primary underline-offset-4 hover:underline">
      {email}
    </Link>
  ) : (
    <span>{email}</span>
  );
}

/** Ledger (balance movements). `admin` adds a Customer column; filtering by type is client-side. */
export function LedgerTable({
  rows,
  admin,
  exportName = "transactions",
  hideTypeFilter,
}: {
  rows: LedgerRow[];
  admin?: boolean;
  exportName?: string;
  hideTypeFilter?: boolean;
}) {
  const [type, setType] = useState("ALL");
  const data = useMemo(() => (type === "ALL" ? rows : rows.filter((r) => r.type === type)), [rows, type]);

  const columns = useMemo<ColumnDef<LedgerRow>[]>(
    () => [
      {
        accessorKey: "createdAt",
        header: "Date",
        cell: ({ row }) => <DateTime iso={row.original.createdAt} className="whitespace-nowrap text-muted-foreground" />,
        meta: { label: "Date" },
      },
      ...(admin
        ? ([
            {
              accessorKey: "userEmail",
              header: "Customer",
              cell: ({ row }) => <CustomerLink id={row.original.userId} email={row.original.userEmail} />,
              meta: { label: "Customer" },
            },
          ] satisfies ColumnDef<LedgerRow>[])
        : []),
      {
        accessorKey: "type",
        header: "Type",
        cell: ({ row }) => <LedgerTypeBadge type={row.original.type} description={row.original.description} />,
        meta: { label: "Type" },
      },
      {
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => <span className="line-clamp-2 max-w-[28rem]">{row.original.description}</span>,
        meta: { label: "Description" },
      },
      {
        accessorKey: "amount",
        header: "Amount",
        sortingFn: (a, b) => toDecimal(a.original.amount).cmp(toDecimal(b.original.amount)),
        cell: ({ row }) => <MoneyText value={row.original.amount} signed colorize className="font-medium" />,
        meta: { label: "Amount (USD)", className: "text-right" },
      },
      {
        accessorKey: "balanceAfter",
        header: "Balance",
        cell: ({ row }) => <MoneyText value={row.original.balanceAfter} className="text-muted-foreground" />,
        meta: { label: "Balance after (USD)", className: "text-right" },
      },
    ],
    [admin],
  );

  return (
    <DataTable
      columns={columns}
      data={data}
      getRowId={(r) => r.id}
      searchKey="description"
      searchPlaceholder="Search description..."
      exportFilename={exportName}
      emptyTitle="No transactions yet"
      emptyDescription="Top-ups, credits, refunds and adjustments will appear here."
      initialSorting={[{ id: "createdAt", desc: true }]}
      toolbar={
        hideTypeFilter ? undefined : (
        <Select value={type} onValueChange={setType}>
          <SelectTrigger size="sm" className="w-44" aria-label="Filter by type">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All types</SelectItem>
            {Object.entries(LEDGER_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        )
      }
    />
  );
}

/** Payments (card charges) with status badge and Stripe receipt link. */
export function PaymentsTable({ rows, admin, exportName = "payments" }: { rows: PaymentRow[]; admin?: boolean; exportName?: string }) {
  const columns = useMemo<ColumnDef<PaymentRow>[]>(
    () => [
      {
        accessorKey: "createdAt",
        header: "Date",
        cell: ({ row }) => <DateTime iso={row.original.createdAt} className="whitespace-nowrap text-muted-foreground" />,
        meta: { label: "Date" },
      },
      ...(admin
        ? ([
            {
              accessorKey: "userEmail",
              header: "Customer",
              cell: ({ row }) => <CustomerLink id={row.original.userId} email={row.original.userEmail} />,
              meta: { label: "Customer" },
            },
          ] satisfies ColumnDef<PaymentRow>[])
        : []),
      {
        accessorKey: "kind",
        header: "Type",
        cell: ({ row }) => KIND_LABELS[row.original.kind] ?? row.original.kind,
        meta: { label: "Type" },
      },
      {
        accessorKey: "amount",
        header: "Amount",
        sortingFn: (a, b) => toDecimal(a.original.amount).cmp(toDecimal(b.original.amount)),
        cell: ({ row }) => <MoneyText value={row.original.amount} className="font-medium" />,
        meta: { label: "Amount (USD)", className: "text-right" },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1">
            <StatusBadge status={row.original.status} />
            {row.original.failureReason && row.original.status !== "SUCCEEDED" && (
              <span className="max-w-[16rem] truncate text-xs text-muted-foreground" title={row.original.failureReason}>
                {row.original.failureReason}
              </span>
            )}
          </div>
        ),
        meta: { label: "Status" },
      },
      ...(admin
        ? ([
            {
              accessorKey: "stripePaymentIntentId",
              header: "Stripe ID",
              cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.stripePaymentIntentId ?? "-"}</span>,
              meta: { label: "Stripe PaymentIntent" },
            },
          ] satisfies ColumnDef<PaymentRow>[])
        : []),
      {
        id: "receipt",
        header: "Receipt",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.receiptUrl ? (
            <a
              href={row.original.receiptUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
            >
              View <ExternalLink className="size-3" />
            </a>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
        meta: { noExport: true },
      },
    ],
    [admin],
  );

  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      exportFilename={exportName}
      emptyTitle="No payments yet"
      emptyDescription="Card payments and their receipts will appear here."
      initialSorting={[{ id: "createdAt", desc: true }]}
    />
  );
}
