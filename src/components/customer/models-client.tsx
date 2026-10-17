"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton } from "@/components/common/copy-button";
import { DataTable } from "@/components/common/data-table";
import { formatPricePerMillion, formatUSD } from "@/lib/money";
import { formatCompact } from "@/lib/utils";
import { CAPABILITY_LABELS, vendorLabel } from "@/server/customer/labels";
import { formatMultiplier } from "@/server/customer/pricing";
import type { PoolOption, UserModel } from "@/server/customer/portal-data";

const ALL = "__all";

export function ModelsClient({ models, pools, currentPoolSlug }: { models: UserModel[]; pools: PoolOption[]; currentPoolSlug: string | null }) {
  const [pool, setPool] = useState(currentPoolSlug ?? pools[0]?.slug ?? "");
  const [vendor, setVendor] = useState(ALL);
  const [cap, setCap] = useState(ALL);
  const poolInfo = pools.find((p) => p.slug === pool);

  const vendors = useMemo(() => [...new Set(models.map((m) => m.vendor))], [models]);
  const caps = useMemo(() => [...new Set(models.flatMap((m) => m.capabilities))], [models]);
  const data = useMemo(
    () => models.filter((m) => m.prices[pool] && (vendor === ALL || m.vendor === vendor) && (cap === ALL || m.capabilities.includes(cap))),
    [models, pool, vendor, cap],
  );

  const columns = useMemo<ColumnDef<UserModel>[]>(
    () => [
      {
        id: "model",
        header: "Model",
        accessorFn: (m) => `${m.displayName} ${m.slug}`,
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="font-medium">{row.original.displayName}</p>
            <div className="flex items-center gap-0.5">
              <code className="font-mono text-xs text-muted-foreground">{row.original.slug}</code>
              <CopyButton value={row.original.slug} size="icon-xs" toastMessage="Model id copied" />
            </div>
          </div>
        ),
      },
      { id: "vendor", header: "Vendor", accessorFn: (m) => vendorLabel(m.vendor), cell: ({ row }) => <Badge variant="outline">{vendorLabel(row.original.vendor)}</Badge> },
      {
        id: "capabilities",
        header: "Capabilities",
        enableSorting: false,
        accessorFn: (m) => m.capabilities.join(" "),
        cell: ({ row }) => (
          <div className="flex min-w-44 flex-wrap gap-1" title={row.original.capabilities.map((c) => CAPABILITY_LABELS[c] ?? c).join(", ")}>
            {row.original.capabilities.slice(0, 3).map((c) => (
              <Badge key={c} variant="secondary" className="font-normal">
                {CAPABILITY_LABELS[c] ?? c}
              </Badge>
            ))}
            {row.original.capabilities.length > 3 && (
              <Badge variant="outline" className="font-normal">
                +{row.original.capabilities.length - 3}
              </Badge>
            )}
          </div>
        ),
      },
      { id: "context", header: "Context", accessorFn: (m) => m.contextWindow ?? 0, cell: ({ row }) => (row.original.contextWindow ? formatCompact(row.original.contextWindow) : "-"), meta: { className: "text-right" } },
      {
        id: "input",
        header: "Input / 1M",
        accessorFn: (m) => Number(m.prices[pool]?.input ?? 0),
        cell: ({ row }) => <Price model={row.original} pool={pool} field="input" />,
        meta: { className: "text-right" },
      },
      {
        id: "output",
        header: "Output / 1M",
        accessorFn: (m) => Number(m.prices[pool]?.output ?? 0),
        cell: ({ row }) => <Price model={row.original} pool={pool} field="output" />,
        meta: { className: "text-right" },
      },
      {
        id: "cached",
        header: "Cached / 1M",
        accessorFn: (m) => Number(m.prices[pool]?.cachedInput ?? 0),
        cell: ({ row }) => <Price model={row.original} pool={pool} field="cachedInput" />,
        meta: { className: "text-right" },
      },
      {
        id: "image",
        header: "Per image",
        accessorFn: (m) => Number(m.prices[pool]?.image ?? 0),
        cell: ({ row }) => {
          const v = row.original.prices[pool]?.image;
          return v ? <span className="tabular-nums">{formatUSD(v)}</span> : <span className="text-muted-foreground">-</span>;
        },
        meta: { className: "text-right" },
      },
    ],
    [pool],
  );

  return (
    <div className="space-y-4">
      {pools.length > 1 && (
        <div className="space-y-2">
          <Tabs value={pool} onValueChange={setPool}>
            <TabsList className="h-auto flex-wrap">
              {pools.map((p) => (
                <TabsTrigger key={p.slug} value={p.slug}>
                  {p.name} {formatMultiplier(p.multiplier)}
                  {p.slug === currentPoolSlug && <Badge className="ml-1.5 h-4 px-1.5 text-[10px]">Yours</Badge>}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {poolInfo?.description && <p className="text-sm text-muted-foreground">{poolInfo.description}</p>}
        </div>
      )}
      <DataTable
        columns={columns}
        data={data}
        searchKey="model"
        searchPlaceholder="Search models..."
        pageSize={50}
        exportFilename={`model-prices-${pool}`}
        hideColumnToggle
        getRowId={(m) => m.slug}
        emptyTitle="No models match"
        toolbar={
          <>
            <Select value={vendor} onValueChange={setVendor}>
              <SelectTrigger size="sm" className="w-auto min-w-28" aria-label="Vendor">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All vendors</SelectItem>
                {vendors.map((v) => (
                  <SelectItem key={v} value={v}>
                    {vendorLabel(v)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={cap} onValueChange={setCap}>
              <SelectTrigger size="sm" className="w-auto min-w-28" aria-label="Capability">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All capabilities</SelectItem>
                {caps.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CAPABILITY_LABELS[c] ?? c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      <p className="text-xs text-muted-foreground">
        Prices are in USD per 1M tokens (images per image) and already include your pool multiplier{poolInfo ? ` (${formatMultiplier(poolInfo.multiplier)})` : ""}. Cached input is billed at the cached rate when a prompt prefix is reused.
      </p>
    </div>
  );
}

function Price({ model, pool, field }: { model: UserModel; pool: string; field: "input" | "output" | "cachedInput" }) {
  const v = model.prices[pool]?.[field];
  if (v === null || v === undefined) return <span className="text-muted-foreground">-</span>;
  return <span className="tabular-nums">{formatPricePerMillion(v)}</span>;
}
