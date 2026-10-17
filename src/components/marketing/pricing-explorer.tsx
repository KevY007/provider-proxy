"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { formatMultiplier } from "@/server/customer/pricing";
import { CAPABILITY_LABELS, vendorLabel } from "@/server/customer/labels";
import { buildPriceRows, PriceTable, type PriceModel } from "./price-table";

export interface PricingGroup {
  slug: string;
  name: string;
  description: string | null;
  priceMultiplier: string;
  isDefault: boolean;
}

const CAP_FILTERS = ["chat", "vision", "tools", "reasoning", "images", "embeddings"];

/** Interactive public pricing table: pick a pool, filter by vendor / capability, search. */
export function PricingExplorer({ models, groups }: { models: PriceModel[]; groups: PricingGroup[] }) {
  const [group, setGroup] = useState(groups.find((g) => g.isDefault)?.slug ?? groups[0]?.slug ?? "");
  const [vendor, setVendor] = useState("all");
  const [cap, setCap] = useState("all");
  const [q, setQ] = useState("");

  const vendors = useMemo(() => [...new Set(models.map((m) => m.vendor))], [models]);
  const caps = useMemo(() => CAP_FILTERS.filter((c) => models.some((m) => m.capabilities.includes(c))), [models]);
  const g = groups.find((x) => x.slug === group);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = models.filter(
      (m) =>
        (vendor === "all" || m.vendor === vendor) &&
        (cap === "all" || m.capabilities.includes(cap)) &&
        (!needle || m.slug.toLowerCase().includes(needle) || m.displayName.toLowerCase().includes(needle)),
    );
    return buildPriceRows(filtered, g?.priceMultiplier ?? "1");
  }, [models, vendor, cap, q, g]);

  return (
    <div className="space-y-5">
      {groups.length > 0 && (
        <div className="space-y-2">
          <Tabs value={group} onValueChange={setGroup}>
            <TabsList className="h-auto flex-wrap">
              {groups.map((x) => (
                <TabsTrigger key={x.slug} value={x.slug} className="gap-2">
                  {x.name}
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{formatMultiplier(x.priceMultiplier)}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {g?.description && <p className="text-sm text-muted-foreground">{g.description}</p>}
        </div>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative w-full lg:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search models" placeholder="Search models..." className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-2">
          <ToggleGroup type="single" variant="outline" size="sm" value={vendor} onValueChange={(v) => setVendor(v || "all")} className="flex-wrap">
            <ToggleGroupItem value="all">All vendors</ToggleGroupItem>
            {vendors.map((v) => (
              <ToggleGroupItem key={v} value={v}>
                {vendorLabel(v)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="flex flex-wrap gap-2">
          <ToggleGroup type="single" variant="outline" size="sm" value={cap} onValueChange={(v) => setCap(v || "all")} className="flex-wrap">
            <ToggleGroupItem value="all">Any capability</ToggleGroupItem>
            {caps.map((c) => (
              <ToggleGroupItem key={c} value={c}>
                {CAPABILITY_LABELS[c] ?? c}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      <PriceTable rows={rows} showCapabilities />

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card/40 p-5">
        <div>
          <p className="font-medium">Pay only for what you use. No subscription, no minimums.</p>
          <p className="text-sm text-muted-foreground">Add balance by card, set spend limits, and watch costs per request.</p>
        </div>
        <Button asChild>
          <Link href="/signup">Create free account</Link>
        </Button>
      </div>
    </div>
  );
}
