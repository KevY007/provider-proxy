"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buildPriceRows, PriceTable, type PriceModel } from "@/components/marketing/price-table";
import { CAPABILITY_LABELS, vendorLabel } from "@/server/customer/labels";
import { poolSavingsLabel } from "@/server/customer/pricing";
import type { PoolOption, UserModel } from "@/server/customer/portal-data";

const ALL = "__all";

export function ModelsClient({ models, pools, currentPoolSlug }: { models: UserModel[]; pools: PoolOption[]; currentPoolSlug: string | null }) {
  const [pool, setPool] = useState(currentPoolSlug ?? pools[0]?.slug ?? "");
  const [vendor, setVendor] = useState(ALL);
  const [cap, setCap] = useState(ALL);
  const [q, setQ] = useState("");
  const poolInfo = pools.find((p) => p.slug === pool);

  const vendors = useMemo(() => [...new Set(models.map((m) => m.vendor))], [models]);
  const caps = useMemo(() => [...new Set(models.flatMap((m) => m.capabilities))], [models]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list: PriceModel[] = models
      .filter(
        (m) =>
          m.prices[pool] &&
          (vendor === ALL || m.vendor === vendor) &&
          (cap === ALL || m.capabilities.includes(cap)) &&
          (!needle || m.slug.toLowerCase().includes(needle) || m.displayName.toLowerCase().includes(needle)),
      )
      // prices[pool] already includes the pool + account multiplier, so rows are built with multiplier 1
      .map((m) => ({
        slug: m.slug,
        displayName: m.displayName,
        vendor: m.vendor,
        capabilities: m.capabilities,
        contextWindow: m.contextWindow,
        retiresAt: m.retiresAt,
        sell: m.prices[pool],
        official: m.official,
      }));
    return buildPriceRows(list, "1");
  }, [models, pool, vendor, cap, q]);

  return (
    <div className="space-y-4">
      {pools.length > 1 && (
        <div className="space-y-2">
          <Tabs value={pool} onValueChange={setPool}>
            <TabsList className="h-auto flex-wrap">
              {pools.map((p) => (
                <TabsTrigger key={p.slug} value={p.slug}>
                  {p.name}
                  {poolSavingsLabel(p.savingsPct) && <span className="ml-1 text-xs text-muted-foreground">{poolSavingsLabel(p.savingsPct)}</span>}
                  {p.slug === currentPoolSlug && <Badge className="ml-1.5 h-4 px-1.5 text-[10px]">Yours</Badge>}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {poolInfo?.description && <p className="text-sm text-muted-foreground">{poolInfo.description}</p>}
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search models" placeholder="Search models..." className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
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
      </div>
      <PriceTable rows={rows} showCapabilities />
      <p className="text-xs text-muted-foreground">These are the prices you pay. The saving column compares them with each maker&apos;s own list price.</p>
    </div>
  );
}
