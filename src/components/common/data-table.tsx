"use client";

import { useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Columns3, Download, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { EmptyState } from "./empty-state";

/** Optional per-column metadata (set via `meta` in a ColumnDef). */
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    /** Header text used for CSV export and the column-visibility menu (defaults to the string header or id). */
    label?: string;
    /** Exclude from CSV export. */
    noExport?: boolean;
    /** Extra classes for the cell and header (e.g. "text-right w-24"). */
    className?: string;
  }
}

export interface ServerPagination {
  /** 0-based page index. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  /** Column id to bind the search box to (client-side filter). Omit to hide the search box. */
  searchKey?: string;
  searchPlaceholder?: string;
  /** Rows per page for client-side pagination (default 20). */
  pageSize?: number;
  /** Provide for server-side pagination (data is then just the current page). */
  serverPagination?: ServerPagination;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: React.ReactNode;
  emptyAction?: React.ReactNode;
  /** Shows an "Export CSV" button; value is the filename without extension. */
  exportFilename?: string;
  /** Extra controls rendered in the toolbar (filters, buttons). */
  toolbar?: React.ReactNode;
  initialSorting?: SortingState;
  initialColumnVisibility?: VisibilityState;
  onRowClick?: (row: TData) => void;
  getRowId?: (row: TData, index: number) => string;
  /** Hide the column-visibility menu. */
  hideColumnToggle?: boolean;
  /**
   * Adds a checkbox column. While at least one row is selected the returned node is shown in a bar above the table
   * (bulk actions). Needs `getRowId` so selection survives sorting/filtering.
   */
  bulkActions?: (ctx: { selected: TData[]; clear: () => void }) => React.ReactNode;
  className?: string;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === "object") s = typeof (v as { toString?: unknown }).toString === "function" && Object.prototype.toString.call(v) !== "[object Object]" ? String(v) : JSON.stringify(v);
  else s = String(v);
  // neutralise spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Generic table built on TanStack Table v8 + shadcn Table: sortable headers, column visibility menu,
 * search box, client or server pagination, loading skeleton, empty state and CSV export of the
 * (filtered, sorted) rows using each column's accessor value.
 *
 *   const columns: ColumnDef<Row>[] = [
 *     { accessorKey: "name", header: "Name" },
 *     { accessorKey: "price", header: "Price", cell: ({ row }) => <MoneyText value={row.original.price} />, meta: { className: "text-right" } },
 *   ];
 *   <DataTable columns={columns} data={rows} searchKey="name" exportFilename="models" />
 *
 * Pass plain serializable data from server components (convert Decimal -> string, Date is fine).
 */
export function DataTable<TData, TValue>({
  columns,
  data,
  searchKey,
  searchPlaceholder = "Search...",
  pageSize = 20,
  serverPagination,
  loading,
  emptyTitle = "No results",
  emptyDescription,
  emptyAction,
  exportFilename,
  toolbar,
  initialSorting = [],
  initialColumnVisibility = {},
  onRowClick,
  getRowId,
  hideColumnToggle,
  bulkActions,
  className,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(initialColumnVisibility);
  const [globalFilter, setGlobalFilter] = useState("");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const selectColumn: ColumnDef<TData, TValue> = {
    id: "__select",
    enableSorting: false,
    enableHiding: false,
    meta: { noExport: true, className: "w-10" },
    header: ({ table: t }) => (
      <Checkbox
        aria-label="Select all rows on this page"
        checked={t.getIsAllPageRowsSelected() || (t.getIsSomePageRowsSelected() && "indeterminate")}
        onCheckedChange={(v) => t.toggleAllPageRowsSelected(!!v)}
      />
    ),
    cell: ({ row }) => <Checkbox aria-label="Select row" checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)} onClick={(e) => e.stopPropagation()} />,
  };

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns: bulkActions ? [selectColumn, ...columns] : columns,
    state: { sorting, columnVisibility, globalFilter, rowSelection },
    onRowSelectionChange: setRowSelection,
    enableRowSelection: !!bulkActions,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    ...(serverPagination ? {} : { getPaginationRowModel: getPaginationRowModel() }),
    initialState: { pagination: { pageSize } },
  });

  const rows = table.getRowModel().rows;
  const selectedRows = bulkActions ? table.getSelectedRowModel().flatRows.map((r) => r.original) : [];
  const visibleCols = table.getVisibleLeafColumns();
  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide());

  function exportCsv() {
    const cols = table
      .getVisibleLeafColumns()
      .filter((c) => !c.columnDef.meta?.noExport && (c.accessorFn !== undefined));
    const header = cols.map((c) => csvCell(c.columnDef.meta?.label ?? (typeof c.columnDef.header === "string" ? c.columnDef.header : c.id)));
    const body = table.getPrePaginationRowModel().rows.map((r) => cols.map((c) => csvCell(r.getValue(c.id))).join(","));
    const blob = new Blob([[header.join(","), ...body].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportFilename ?? "export"}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const searchCol = searchKey ? table.getColumn(searchKey) : undefined;
  const pageCount = serverPagination ? Math.max(1, Math.ceil(serverPagination.total / serverPagination.pageSize)) : table.getPageCount();
  const pageIndex = serverPagination ? serverPagination.page : table.getState().pagination.pageIndex;
  const totalRows = serverPagination ? serverPagination.total : table.getFilteredRowModel().rows.length;
  const colSpan = Math.max(1, visibleCols.length);

  const toolbarVisible = !!searchKey || !!toolbar || !!exportFilename || !hideColumnToggle;

  return (
    <div className={cn("space-y-3", className)}>
      {toolbarVisible && (
        <div className="flex flex-wrap items-center gap-2">
          {searchKey && (
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search table"
                placeholder={searchPlaceholder}
                value={searchCol ? ((searchCol.getFilterValue() as string) ?? "") : globalFilter}
                onChange={(e) => (searchCol ? searchCol.setFilterValue(e.target.value) : setGlobalFilter(e.target.value))}
                className="pl-8"
              />
            </div>
          )}
          {toolbar}
          <div className="ml-auto flex items-center gap-2">
            {exportFilename && (
              <Button variant="outline" size="sm" onClick={exportCsv} disabled={loading || data.length === 0}>
                <Download className="size-4" /> Export CSV
              </Button>
            )}
            {!hideColumnToggle && hideable.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Columns3 className="size-4" /> Columns
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {hideable.map((c) => (
                    <DropdownMenuCheckboxItem key={c.id} checked={c.getIsVisible()} onCheckedChange={(v) => c.toggleVisibility(!!v)}>
                      {c.columnDef.meta?.label ?? (typeof c.columnDef.header === "string" ? c.columnDef.header : c.id)}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      )}

      {bulkActions && selectedRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm" role="region" aria-label="Bulk actions">
          <span className="font-medium">{selectedRows.length} selected</span>
          {bulkActions({ selected: selectedRows, clear: () => setRowSelection({}) })}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setRowSelection({})}>
            Clear selection
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader className="bg-muted/40">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((header) => {
                  const sortable = header.column.getCanSort();
                  const dir = header.column.getIsSorted();
                  return (
                    <TableHead key={header.id} className={header.column.columnDef.meta?.className} aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}>
                      {header.isPlaceholder ? null : sortable ? (
                        <button
                          type="button"
                          className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-accent-foreground"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {dir === "asc" ? <ArrowUp className="size-3.5" /> : dir === "desc" ? <ArrowDown className="size-3.5" /> : <ChevronsUpDown className="size-3.5 opacity-40" />}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: Math.min(pageSize, 6) }).map((_, i) => (
                <TableRow key={i}>
                  {visibleCols.map((c) => (
                    <TableCell key={c.id}>
                      <Skeleton className="h-4 w-full max-w-[160px]" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length ? (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  className={cn(onRowClick && "cursor-pointer")}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={colSpan} className="p-4">
                  <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} className="border-0 py-8" />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>
          {totalRows.toLocaleString()} {totalRows === 1 ? "row" : "rows"}
        </span>
        {pageCount > 1 && (
          <div className="flex items-center gap-2">
            <span>
              Page {pageIndex + 1} of {pageCount}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              aria-label="Previous page"
              disabled={pageIndex <= 0}
              onClick={() => (serverPagination ? serverPagination.onPageChange(pageIndex - 1) : table.previousPage())}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              aria-label="Next page"
              disabled={pageIndex >= pageCount - 1}
              onClick={() => (serverPagination ? serverPagination.onPageChange(pageIndex + 1) : table.nextPage())}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
