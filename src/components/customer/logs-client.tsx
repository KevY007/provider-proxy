"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeft, ArrowRight, Download, ExternalLink, FilterX, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CopyButton } from "@/components/common/copy-button";
import { DataTable } from "@/components/common/data-table";
import { DateRangePicker } from "@/components/common/date-range-picker";
import { MoneyText } from "@/components/common/money-text";
import { StatusBadge } from "@/components/common/status-badge";
import { rangeToParams, type DateRangeValue } from "@/lib/date-range";
import { formatDuration, formatNumber } from "@/lib/utils";
import { describeErrorCode } from "@/server/customer/error-codes";
import type { LogRow } from "@/server/customer/logs";
import { LocalTime } from "./local-time";

export interface LogsClientProps {
  rows: LogRow[];
  nextCursor: string | null;
  hasCursor: boolean;
  range: { preset: DateRangeValue["preset"]; from: string; to: string };
  options: { keys: Array<{ id: string; name: string; prefix: string }>; models: string[]; errorCodes: string[] };
}

const ALL = "__all";

export function LogsClient({ rows, nextCursor, hasCursor, range: rangeProp, options }: LogsClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [selected, setSelected] = useState<LogRow | null>(null);
  const range: DateRangeValue = useMemo(() => ({ preset: rangeProp.preset, from: new Date(rangeProp.from), to: new Date(rangeProp.to) }), [rangeProp]);

  function update(patch: Record<string, string | undefined>) {
    const next = new URLSearchParams(sp.toString());
    next.delete("cursor");
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === ALL || v === "") next.delete(k);
      else next.set(k, v);
    }
    router.push(`${pathname}?${next.toString()}`);
  }
  const cursorHref = (c: string) => {
    const next = new URLSearchParams(sp.toString());
    next.set("cursor", c);
    return `${pathname}?${next.toString()}`;
  };
  const firstHref = (() => {
    const next = new URLSearchParams(sp.toString());
    next.delete("cursor");
    return `${pathname}?${next.toString()}`;
  })();
  const exportParams = new URLSearchParams(sp.toString());
  exportParams.delete("cursor");
  const filtersActive = ["key", "model", "status", "code"].some((k) => sp.has(k));

  const columns = useMemo<ColumnDef<LogRow>[]>(
    () => [
      { id: "time", header: "Time", accessorFn: (r) => r.createdAt, cell: ({ row }) => <LocalTime iso={row.original.createdAt} className="whitespace-nowrap" />, enableSorting: false },
      { id: "key", header: "Key", accessorFn: (r) => r.keyName ?? "", cell: ({ row }) => <span className="whitespace-nowrap">{row.original.keyName ?? <span className="text-muted-foreground">-</span>}</span>, enableSorting: false },
      { id: "model", header: "Model", accessorFn: (r) => r.modelSlug ?? "", cell: ({ row }) => <span className="font-mono text-xs">{row.original.modelSlug ?? "-"}</span>, enableSorting: false },
      {
        id: "endpoint",
        header: "Endpoint",
        accessorFn: (r) => r.endpoint,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 font-mono text-xs">
            {row.original.endpoint}
            {row.original.stream && (
              <span title="Streaming">
                <Radio className="size-3 text-primary" />
              </span>
            )}
          </span>
        ),
        enableSorting: false,
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (r) => `${r.status} ${r.httpStatus}`,
        cell: ({ row }) => (
          <div className="flex items-center gap-2 whitespace-nowrap">
            <StatusBadge status={row.original.status} dot={false} />
            <span className="font-mono text-xs text-muted-foreground">{row.original.httpStatus}</span>
          </div>
        ),
        enableSorting: false,
      },
      { id: "in", header: "In", accessorFn: (r) => r.inputTokens, cell: ({ row }) => formatNumber(row.original.inputTokens), meta: { className: "text-right" }, enableSorting: false },
      { id: "out", header: "Out", accessorFn: (r) => r.outputTokens, cell: ({ row }) => formatNumber(row.original.outputTokens), meta: { className: "text-right" }, enableSorting: false },
      { id: "cached", header: "Cached", accessorFn: (r) => r.cachedTokens, cell: ({ row }) => formatNumber(row.original.cachedTokens), meta: { className: "text-right" }, enableSorting: false },
      { id: "cost", header: "Cost", accessorFn: (r) => r.price, cell: ({ row }) => <MoneyText value={row.original.price} />, meta: { className: "text-right" }, enableSorting: false },
      { id: "latency", header: "Latency", accessorFn: (r) => r.latencyMs, cell: ({ row }) => formatDuration(row.original.latencyMs), meta: { className: "text-right" }, enableSorting: false },
      { id: "ttft", header: "TTFT", accessorFn: (r) => r.ttftMs ?? "", cell: ({ row }) => (row.original.ttftMs != null ? formatDuration(row.original.ttftMs) : <span className="text-muted-foreground">-</span>), meta: { className: "text-right" }, enableSorting: false },
    ],
    [],
  );

  const filters = (
    <>
      <FilterSelect label="Key" value={sp.get("key") ?? ALL} onChange={(v) => update({ key: v })} items={options.keys.map((k) => ({ value: k.id, label: `${k.name} (${k.prefix}…)` }))} allLabel="All keys" />
      <FilterSelect label="Model" value={sp.get("model") ?? ALL} onChange={(v) => update({ model: v })} items={options.models.map((m) => ({ value: m, label: m }))} allLabel="All models" />
      <FilterSelect
        label="Status"
        value={sp.get("status") ?? ALL}
        onChange={(v) => update({ status: v })}
        items={[
          { value: "success", label: "Success" },
          { value: "error", label: "Any error" },
          { value: "CLIENT_ERROR", label: "Client error" },
          { value: "UPSTREAM_ERROR", label: "Upstream error" },
          { value: "GATEWAY_ERROR", label: "Gateway error" },
          { value: "CANCELLED", label: "Cancelled" },
        ]}
        allLabel="All statuses"
      />
      <FilterSelect label="Error code" value={sp.get("code") ?? ALL} onChange={(v) => update({ code: v })} items={options.errorCodes.map((c) => ({ value: c, label: c }))} allLabel="All error codes" />
      {filtersActive && (
        <Button variant="ghost" size="sm" onClick={() => update({ key: undefined, model: undefined, status: undefined, code: undefined })}>
          <FilterX className="size-4" /> Clear
        </Button>
      )}
    </>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <DateRangePicker value={range} onChange={(r) => update({ range: undefined, from: undefined, to: undefined, ...rangeToParams(r) })} />
        <Button asChild variant="outline" size="sm" className="ml-auto">
          <a href={`${pathname}/export?${exportParams.toString()}`} download>
            <Download className="size-4" /> Export CSV
          </a>
        </Button>
      </div>
      <DataTable
        columns={columns}
        data={rows}
        pageSize={50}
        toolbar={<div className="flex flex-wrap items-center gap-2">{filters}</div>}
        onRowClick={setSelected}
        getRowId={(r) => r.id}
        emptyTitle="No requests found"
        emptyDescription="Requests made with your API keys appear here. Try widening the date range or clearing filters."
        hideColumnToggle
      />
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>Showing {rows.length} request{rows.length === 1 ? "" : "s"}{nextCursor ? " (more available)" : ""}</span>
        <div className="flex items-center gap-2">
          {hasCursor && (
            <Button asChild variant="outline" size="sm">
              <Link href={firstHref}>
                <ArrowLeft className="size-4" /> Newest
              </Link>
            </Button>
          )}
          {nextCursor && (
            <Button asChild variant="outline" size="sm">
              <Link href={cursorHref(nextCursor)}>
                Older <ArrowRight className="size-4" />
              </Link>
            </Button>
          )}
        </div>
      </div>
      <LogSheet row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function FilterSelect({ label, value, onChange, items, allLabel }: { label: string; value: string; onChange: (v: string) => void; items: Array<{ value: string; label: string }>; allLabel: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-auto min-w-32 max-w-56" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2 text-sm last:border-0">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function LogSheet({ row, onClose }: { row: LogRow | null; onClose: () => void }) {
  const info = describeErrorCode(row?.errorCode);
  return (
    <Sheet open={!!row} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {row && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                Request details <StatusBadge status={row.status} />
              </SheetTitle>
              <SheetDescription>Share the request id with support if something looks wrong.</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-6">
              <div className="flex items-center gap-1 rounded-lg border bg-muted/40 py-1.5 pl-3 pr-1">
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{row.id}</code>
                <CopyButton value={row.id} toastMessage="Request id copied" />
              </div>

              {(row.errorCode || row.errorMessage) && (
                <div className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm">
                  <div className="flex items-center gap-2">
                    {row.errorCode && <Badge variant="destructive" className="font-mono">{row.errorCode}</Badge>}
                    <span className="font-mono text-xs text-muted-foreground">HTTP {row.httpStatus}</span>
                  </div>
                  {row.errorMessage && <p>{row.errorMessage}</p>}
                  {info && (
                    <p className="text-muted-foreground">
                      <span className="font-medium text-foreground">What it means:</span> {info.meaning}
                      <br />
                      <span className="font-medium text-foreground">How to fix:</span> {info.fix.replace(/`/g, "")}
                    </p>
                  )}
                  {row.errorCode && (
                    <Link href={`/docs/errors#${row.errorCode}`} target="_blank" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                      Error reference <ExternalLink className="size-3" />
                    </Link>
                  )}
                </div>
              )}

              <dl>
                <Row label="Time"><LocalTime iso={row.createdAt} /></Row>
                <Row label="API key">{row.keyName ? `${row.keyName} (${row.keyPrefix}…)` : "-"}</Row>
                <Row label="Model"><span className="font-mono text-xs">{row.modelSlug ?? "-"}</span></Row>
                <Row label="Endpoint"><span className="font-mono text-xs">{row.endpoint}</span></Row>
                <Row label="Streaming">{row.stream ? "Yes" : "No"}</Row>
                <Row label="HTTP status"><span className="font-mono">{row.httpStatus}</span></Row>
                <Row label="Input tokens">{formatNumber(row.inputTokens)}</Row>
                <Row label="Output tokens">{formatNumber(row.outputTokens)}</Row>
                <Row label="Cached tokens">{formatNumber(row.cachedTokens)}</Row>
                {row.reasoningTokens > 0 && <Row label="Reasoning tokens">{formatNumber(row.reasoningTokens)}</Row>}
                {row.imageCount > 0 && <Row label="Images">{formatNumber(row.imageCount)}</Row>}
                {row.usageEstimated && <Row label="Usage">Estimated</Row>}
                <Row label="Cost"><MoneyText value={row.price} /></Row>
                <Row label="Latency">{formatDuration(row.latencyMs)}</Row>
                <Row label="Time to first token">{row.ttftMs != null ? formatDuration(row.ttftMs) : "-"}</Row>
                <Row label="Attempts">{row.attempts || 1}</Row>
              </dl>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
