"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, Download, Zap } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { MoneyText } from "@/components/common/money-text";
import { CopyButton } from "@/components/common/copy-button";
import { StatusBadge } from "@/components/common/status-badge";
import { logStatusInfo } from "@/server/customer/log-status";
import { fmtDateTime } from "@/components/admin/format";
import { FilterInput, FilterSelect, ResetFilters, UrlRangePicker, useUrlFilters } from "@/components/admin/url-filters";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn, formatNumber } from "@/lib/utils";
import type { LogRow } from "@/server/admin/logs-queries";
import { LogDetailSheet } from "./log-detail-sheet";

export interface LogsTableProps {
  rows: LogRow[];
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor: string | null;
  newerCursor: string | null;
  range: { preset: "24h" | "7d" | "30d" | "90d" | "custom"; from: string; to: string };
  providers: Array<{ id: string; name: string }>;
  exportQuery: string;
  initialLogId?: string;
}

export function LogsTable({ rows, hasOlder, hasNewer, olderCursor, newerCursor, range, providers, exportQuery, initialLogId }: LogsTableProps) {
  const { setMany, get, pending } = useUrlFilters();
  const [openId, setOpenId] = useState<string | null>(initialLogId ?? null);
  const atNewest = !get("cursor");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <UrlRangePicker initial={range} />
        <FilterInput param="user" placeholder="Customer email or id" className="w-52" />
        <FilterInput param="key" placeholder="Key id or sk-pp- prefix" className="w-48" />
        <FilterInput param="model" placeholder="Model slug" className="w-40" />
        <FilterSelect param="provider" label="Provider" options={providers.map((p) => ({ value: p.id, label: p.name }))} />
        <FilterInput param="providerKey" placeholder="Provider key id" className="w-40" />
        <FilterSelect
          param="status"
          label="Status"
          options={["SUCCESS", "CLIENT_ERROR", "UPSTREAM_ERROR", "GATEWAY_ERROR", "CANCELLED"].map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase() }))}
        />
        <FilterInput param="errorCode" placeholder="Error code" className="w-36" />
        <FilterSelect param="stream" label="Stream" options={[{ value: "yes", label: "Streaming" }, { value: "no", label: "Non-stream" }]} />
        <FilterInput param="endpoint" placeholder="Endpoint" className="w-40" />
        <FilterInput param="minLatency" placeholder="Min latency ms" type="number" className="w-36" />
        <ResetFilters keys={["user", "key", "model", "provider", "providerKey", "status", "errorCode", "stream", "endpoint", "minLatency"]} />
        <Button variant="outline" size="sm" className="ml-auto" asChild>
          <a href={`/admin/logs/export${exportQuery ? `?${exportQuery}` : ""}`}>
            <Download className="size-4" /> Export CSV
          </a>
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No requests found" description="Nothing matches these filters in the selected date range. Widen the range or clear filters." />
      ) : (
        <div className={cn("overflow-x-auto rounded-lg border transition-opacity", pending && "opacity-60")}>
          <Table className="[&_td]:px-1.5 [&_th]:px-1.5">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Time (UTC)</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Model → upstream</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tokens in/out</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Profit</TableHead>
                <TableHead className="text-right" title="Total latency; time spent queued for a free slot below it">Latency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => setOpenId(r.id)}>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {fmtDateTime(r.createdAt)}
                    <span className="flex items-center gap-0.5 font-mono text-[10px] text-muted-foreground" onClick={(e) => e.stopPropagation()}>
                      {r.id.slice(0, 10)}…
                      <CopyButton value={r.id} size="icon-xs" toastMessage="Request id copied" className="size-5" />
                    </span>
                  </TableCell>
                  <TableCell>
                    {r.userId ? (
                      <Link href={`/admin/customers/${r.userId}`} title={r.email ?? undefined} className="block max-w-[10rem] truncate text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
                        {r.email}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>{r.keyPrefix ? <code className="text-xs">{r.keyPrefix}…</code> : "-"}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.modelSlug ?? "-"}
                    {r.upstreamModel && r.upstreamModel !== r.modelSlug && (
                      <span title={r.upstreamModel} className="block max-w-[15rem] truncate text-muted-foreground">
                        → {r.upstreamModel}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {r.providerName ?? "-"}
                    {r.providerKeyLabel && <span className="block text-muted-foreground">{r.providerKeyLabel}</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <span className="flex max-w-[11rem] items-center" title={r.endpoint}>
                      <span className="truncate">{r.endpoint}</span>
                      {r.stream && <Zap className="ml-1 inline size-3 shrink-0 text-amber-500" aria-label="streaming" />}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {(() => {
                      const st = logStatusInfo(r.status, r.httpStatus);
                      return <StatusBadge status={r.status} label={st.label} tone={st.tone} />;
                    })()}
                    <span className="mt-0.5 block text-xs text-muted-foreground" title={r.errorCode ? "Open the row for an explanation" : undefined}>
                      {r.httpStatus}
                      {r.errorCode ? ` ${r.errorCode}` : ""}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(r.inputTokens)} / {formatNumber(r.outputTokens)}
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyText value={r.price} />
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyText value={r.cost} />
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyText value={r.profit} colorize />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    {r.latencyMs}ms
                    {r.queueMs ? <span className="block text-xs text-muted-foreground">queued {r.queueMs}ms</span> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>{rows.length} rows shown · newest first</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={atNewest} onClick={() => setMany({ cursor: null, dir: null }, { keepPage: true })}>
            <ChevronsLeft className="size-4" /> Newest
          </Button>
          <Button variant="outline" size="sm" disabled={!hasNewer} onClick={() => setMany({ cursor: newerCursor, dir: "newer" }, { keepPage: true })}>
            <ChevronLeft className="size-4" /> Newer
          </Button>
          <Button variant="outline" size="sm" disabled={!hasOlder} onClick={() => setMany({ cursor: olderCursor, dir: "older" }, { keepPage: true })}>
            Older <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <LogDetailSheet id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
