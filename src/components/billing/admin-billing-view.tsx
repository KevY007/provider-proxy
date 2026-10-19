"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Ban, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { CopyButton } from "@/components/common/copy-button";
import { DataTable } from "@/components/common/data-table";
import { MoneyText } from "@/components/common/money-text";
import { StatusBadge } from "@/components/common/status-badge";
import { deleteCodeAction, disableCodeAction } from "@/server/billing/admin-actions";
import type { LedgerRow, PaymentRow, RedeemCodeRow } from "@/server/billing/types";
import { GenerateCodesDialog } from "./admin-dialogs";
import { LedgerTable, PaymentsTable } from "./history-tables";
import { DateTime, KIND_LABELS, LEDGER_LABELS, PAYMENT_STATUSES } from "./shared";

export interface AdminFilters {
  tab: "payments" | "ledger" | "codes";
  status?: string;
  kind?: string;
  ltype?: string;
  q?: string;
}

function SearchBox({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [q, setQ] = useState(initial);
  return (
    <form
      className="relative"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(q.trim());
      }}
      role="search"
    >
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer email or ID..." className="h-8 w-60 pl-8" aria-label="Filter by customer" />
    </form>
  );
}

function FilterBar({ filters }: { filters: AdminFilters }) {
  const router = useRouter();
  const pathname = usePathname();
  function push(patch: Partial<Record<keyof AdminFilters, string | undefined>>) {
    const next = { ...filters, ...patch };
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v && v !== "ALL" && !(k === "tab" && v === "payments")) sp.set(k, v);
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const hasFilters = !!(filters.status || filters.kind || filters.ltype || filters.q);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* key => the box resets when the URL filter changes (back button, "Clear filters") */}
      <SearchBox key={filters.q ?? ""} initial={filters.q ?? ""} onSearch={(q) => push({ q: q || undefined })} />
      {filters.tab === "payments" && (
        <>
          <Select value={filters.status ?? "ALL"} onValueChange={(v) => push({ status: v })}>
            <SelectTrigger size="sm" className="w-36" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {PAYMENT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filters.kind ?? "ALL"} onValueChange={(v) => push({ kind: v })}>
            <SelectTrigger size="sm" className="w-44" aria-label="Filter by kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All kinds</SelectItem>
              {Object.entries(KIND_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
      {filters.tab === "ledger" && (
        <Select value={filters.ltype ?? "ALL"} onValueChange={(v) => push({ ltype: v })}>
          <SelectTrigger size="sm" className="w-48" aria-label="Filter by ledger type">
            <SelectValue />
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
      )}
      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={() => push({ status: undefined, kind: undefined, ltype: undefined, q: undefined })}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

function CodesTable({ rows, canMutate }: { rows: RedeemCodeRow[]; canMutate: boolean }) {
  const router = useRouter();

  async function run(fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    const res = await fn();
    if (res.ok) {
      toast.success(res.message ?? "Done");
      router.refresh();
    } else {
      toast.error(res.error ?? "Failed");
      throw new Error(res.error);
    }
  }

  const columns = useMemo<ColumnDef<RedeemCodeRow>[]>(
    () => [
      {
        accessorKey: "code",
        header: "Code",
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1">
            <code className="font-mono text-xs">{row.original.code}</code>
            <CopyButton value={row.original.code} size="icon-xs" toastMessage="Code copied" />
          </span>
        ),
        meta: { label: "Code" },
      },
      {
        accessorKey: "amount",
        header: "Value",
        cell: ({ row }) => <MoneyText value={row.original.amount} className="font-medium" />,
        meta: { label: "Value (USD)", className: "text-right" },
      },
      {
        id: "uses",
        header: "Uses",
        accessorFn: (r) => `${r.uses}/${r.maxUses}`,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.uses} / {row.original.maxUses}
          </span>
        ),
        meta: { label: "Uses" },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <StatusBadge
            status={row.original.status}
            tone={row.original.status === "active" ? "success" : row.original.status === "expired" ? "neutral" : "warning"}
            label={row.original.status === "active" ? "Active" : row.original.status === "expired" ? "Expired / disabled" : "Fully used"}
          />
        ),
        meta: { label: "Status" },
      },
      {
        accessorKey: "expiresAt",
        header: "Expires",
        cell: ({ row }) => (row.original.expiresAt ? <DateTime iso={row.original.expiresAt} className="text-muted-foreground" /> : <span className="text-muted-foreground">Never</span>),
        meta: { label: "Expires" },
      },
      { accessorKey: "note", header: "Note", cell: ({ row }) => <span className="text-muted-foreground">{row.original.note ?? "-"}</span>, meta: { label: "Note" } },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => <DateTime iso={row.original.createdAt} className="text-muted-foreground" />,
        meta: { label: "Created" },
      },
      ...(canMutate
        ? ([
            {
              id: "actions",
              header: "",
              enableSorting: false,
              meta: { noExport: true, className: "text-right" },
              cell: ({ row }) => (
                <div className="flex justify-end gap-1">
                  {row.original.status === "active" && (
                    <ConfirmDialog
                      title="Disable this code?"
                      description="It will stop working immediately. Existing redemptions are kept."
                      confirmLabel="Disable"
                      onConfirm={() => run(() => disableCodeAction(row.original.id))}
                      trigger={
                        <Button variant="ghost" size="icon" aria-label={`Disable ${row.original.code}`}>
                          <Ban className="size-4" />
                        </Button>
                      }
                    />
                  )}
                  <ConfirmDialog
                    destructive
                    title="Delete this code?"
                    description={row.original.uses > 0 ? "Its redemption history is removed. Credits already granted stay on customers' accounts." : "This cannot be undone."}
                    confirmLabel="Delete"
                    onConfirm={() => run(() => deleteCodeAction(row.original.id))}
                    trigger={
                      <Button variant="ghost" size="icon" aria-label={`Delete ${row.original.code}`} className="text-muted-foreground hover:text-destructive">
                        <Trash2 className="size-4" />
                      </Button>
                    }
                  />
                </div>
              ),
            },
          ] satisfies ColumnDef<RedeemCodeRow>[])
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canMutate],
  );

  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      searchKey="code"
      searchPlaceholder="Search codes..."
      exportFilename="redeem-codes"
      emptyTitle="No redeem codes yet"
      emptyDescription="Generate codes to hand out credit for promotions or support."
      emptyAction={canMutate ? <GenerateCodesDialog /> : undefined}
      initialSorting={[{ id: "createdAt", desc: true }]}
      toolbar={canMutate ? <GenerateCodesDialog /> : undefined}
    />
  );
}

export function AdminBillingView({
  filters,
  payments,
  ledger,
  codes,
  canMutate,
}: {
  filters: AdminFilters;
  payments: PaymentRow[];
  ledger: LedgerRow[];
  codes: RedeemCodeRow[];
  canMutate: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();

  function onTab(tab: string) {
    const sp = new URLSearchParams();
    if (tab !== "payments") sp.set("tab", tab);
    if (filters.q) sp.set("q", filters.q);
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <Tabs value={filters.tab} onValueChange={onTab}>
      <TabsList>
        <TabsTrigger value="payments">Payments</TabsTrigger>
        <TabsTrigger value="ledger">Ledger</TabsTrigger>
        <TabsTrigger value="codes">Redeem codes</TabsTrigger>
      </TabsList>
      {filters.tab !== "codes" && (
        <div className="pt-4">
          <FilterBar filters={filters} />
        </div>
      )}
      <TabsContent value="payments" className="pt-2">
        <PaymentsTable rows={payments} admin exportName="payments" />
      </TabsContent>
      <TabsContent value="ledger" className="pt-2">
        <LedgerTable rows={ledger} admin hideTypeFilter exportName="ledger" />
      </TabsContent>
      <TabsContent value="codes" className="pt-4">
        <CodesTable rows={codes} canMutate={canMutate} />
      </TabsContent>
    </Tabs>
  );
}
