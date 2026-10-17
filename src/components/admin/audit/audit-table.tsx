"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DataTable } from "@/components/common/data-table";
import { CopyButton } from "@/components/common/copy-button";
import { JsonView, KV } from "@/components/admin/misc";
import type { AuditRow } from "@/server/admin/audit-queries";

const columns: ColumnDef<AuditRow>[] = [
  { accessorKey: "createdAt", header: "When", cell: ({ row }) => <span className="whitespace-nowrap text-xs" suppressHydrationWarning>{new Date(row.original.createdAt).toLocaleString()}</span> },
  { accessorKey: "action", header: "Action", cell: ({ row }) => <Badge variant="secondary" className="font-mono">{row.original.action}</Badge> },
  { id: "actor", header: "Actor", accessorFn: (r) => r.actorEmail ?? r.actorId ?? "system", cell: ({ row }) => <span className="text-sm">{row.original.actorEmail ?? row.original.actorId ?? <span className="text-muted-foreground">system</span>}</span> },
  {
    id: "target",
    header: "Target",
    accessorFn: (r) => (r.targetType ? `${r.targetType}:${r.targetId ?? ""}` : ""),
    cell: ({ row }) =>
      row.original.targetType ? (
        <span className="text-xs">
          {row.original.targetType}
          {row.original.targetId && <span className="ml-1 font-mono text-muted-foreground">{row.original.targetId.slice(0, 14)}</span>}
        </span>
      ) : (
        ""
      ),
  },
  { accessorKey: "ip", header: "IP", cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.ip ?? ""}</span> },
  { id: "open", header: "", enableSorting: false, meta: { noExport: true, className: "w-8" }, cell: () => <ChevronRight className="size-4 text-muted-foreground" /> },
];

export function AuditTable({ rows, nextCursor }: { rows: AuditRow[]; nextCursor: string | null }) {
  const [open, setOpen] = useState<AuditRow | null>(null);
  const pathname = usePathname();
  const sp = useSearchParams();
  const cursor = sp.get("cursor");
  const withCursor = (c: string | null) => {
    const n = new URLSearchParams(sp.toString());
    if (c) n.set("cursor", c);
    else n.delete("cursor");
    const qs = n.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  return (
    <>
      <DataTable
        columns={columns}
        data={rows}
        pageSize={50}
        hideColumnToggle
        exportFilename="audit-log"
        onRowClick={setOpen}
        getRowId={(r) => r.id}
        emptyTitle="No audit entries"
        emptyDescription="Nothing matches these filters in the selected period."
      />
      <div className="mt-3 flex items-center justify-end gap-2">
        {cursor && (
          <Button asChild variant="outline" size="sm">
            <Link href={withCursor(null)}>Back to newest</Link>
          </Button>
        )}
        {nextCursor && (
          <Button asChild variant="outline" size="sm">
            <Link href={withCursor(nextCursor)}>Older entries</Link>
          </Button>
        )}
      </div>
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle className="font-mono">{open.action}</SheetTitle>
                <SheetDescription>{new Date(open.createdAt).toLocaleString()}</SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 pb-6">
                <div className="divide-y">
                  <KV label="Actor">{open.actorEmail ?? open.actorId ?? "system"}</KV>
                  <KV label="Target type">{open.targetType ?? "-"}</KV>
                  <KV label="Target id">
                    <span className="inline-flex items-center gap-1 font-mono text-xs">
                      {open.targetId ?? "-"}
                      {open.targetId && <CopyButton value={open.targetId} size="icon-xs" />}
                    </span>
                  </KV>
                  <KV label="IP">{open.ip ?? "-"}</KV>
                  <KV label="Entry id">
                    <span className="font-mono text-xs">{open.id}</span>
                  </KV>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-medium">Data</h3>
                  <JsonView value={open.data} maxHeight={480} />
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
