"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Bot, Check, Loader2, RefreshCw, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAction } from "@/components/admin/use-action";
import { applyPriceSyncAction, runPriceSyncAction, savePriceSyncConfigAction, setPriceSyncModelSourceAction } from "@/server/admin/price-sync-actions";
import type { PriceSyncPanel } from "@/server/admin/price-sync-queries";
import type { Proposal } from "@/server/pricing/price-sync/engine";

const UNIT_LABEL: Record<string, string> = { input: "In", output: "Out", cachedInput: "Cached", cacheWrite: "Cache write", cacheWrite1h: "Write 1h", image: "Image" };
const STATUS: Record<Proposal["status"], { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  update: { label: "Update", variant: "default" },
  review: { label: "Review", variant: "destructive" },
  same: { label: "Matches", variant: "secondary" },
  missing: { label: "Not on page", variant: "outline" },
  excluded: { label: "Excluded", variant: "outline" },
};
const usd = (v: string | null | undefined) => (v === null || v === undefined ? "-" : `$${Number(Number(v).toPrecision(8))}`);
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "") + new URL(u).pathname.replace(/\/$/, "");
  } catch {
    return u;
  }
};

/**
 * Provider page: "Price sync". The provider's pricing pages are read by an AI (one of our pools, billed at our own
 * cost) and turned into proposals; nothing changes until an admin applies them, or - with automatic updates on -
 * the clean ones (every number found on the page, no promotion, within the change limit) are applied by themselves.
 */
export function PriceSyncCard({ providerId, providerName, initial, canEdit }: { providerId: string; providerName: string; initial: PriceSyncPanel; canEdit: boolean }) {
  const [panel, setPanel] = useState(initial);
  const cfg = panel.config;
  const [sources, setSources] = useState(cfg.sources.map((s) => s.url).join("\n"));
  const [basis, setBasis] = useState(cfg.basis);
  const [poolName, setPoolName] = useState(cfg.poolName ?? "");
  const [auto, setAuto] = useState(cfg.auto);
  const [maxChange, setMaxChange] = useState(String(cfg.maxAutoChangePct));
  const run = panel.run;
  const selectable = useMemo(() => (run?.proposals ?? []).filter((p) => p.status === "update" || p.status === "review"), [run]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(selectable.filter((p) => p.status === "update").map((p) => p.routeId)));
  const save = useAction();
  const check = useAction();
  const apply = useAction();
  const src = useAction();
  const applied = new Set((run?.applied?.items ?? []).map((i) => i.routeId));

  const onPanel = (p: PriceSyncPanel | undefined) => {
    if (!p) return;
    setPanel(p);
    setPicked(new Set((p.run?.proposals ?? []).filter((x) => x.status === "update").map((x) => x.routeId)));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4" /> Price sync
        </CardTitle>
        <CardDescription>
          Keeps this provider&apos;s prices in line with its pricing pages. {providerName} publishes no pricing API, so the pages are read by an AI ({panel.ai.model} through the{" "}
          <span className="font-medium">{panel.ai.pool}</span> pool, billed at our own cost as the customer &quot;Pricing fetch AI&quot;;{" "}
          <Link href="/admin/settings" className="underline underline-offset-2">
            change in Settings
          </Link>
          ). Every price it reports must be written on the page, promotions are ignored, and nothing changes until you apply it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* ---------------------------------------------------------------- settings */}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5 md:row-span-2">
            <Label htmlFor="ps-sources">Pricing pages (one URL per line)</Label>
            <Textarea id="ps-sources" rows={4} value={sources} onChange={(e) => setSources(e.target.value)} disabled={!canEdit} className="font-mono text-xs" />
            <p className="text-xs text-muted-foreground">Markdown versions (.md) read best. A model can be pinned to one page below.</p>
            {save.fieldErrors.sources && <p className="text-xs text-destructive">{save.fieldErrors.sources}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>What the page lists</Label>
            <Select value={basis} onValueChange={(v) => setBasis(v as typeof basis)} disabled={!canEdit}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="official">This provider&apos;s own prices (our cost = the price on the page)</SelectItem>
                <SelectItem value="pool">A reseller pool billing a % of the official price</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {basis === "pool" && (
            <div className="space-y-1.5">
              <Label htmlFor="ps-pool">Pool name, as the page writes it</Label>
              <Input id="ps-pool" value={poolName} onChange={(e) => setPoolName(e.target.value)} disabled={!canEdit} placeholder="Pro Pool" />
              <p className="text-xs text-muted-foreground">Our cost = official list price x the pool&apos;s percentage on the page.</p>
              {save.fieldErrors.poolName && <p className="text-xs text-destructive">{save.fieldErrors.poolName}</p>}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-4 md:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={auto} onCheckedChange={setAuto} disabled={!canEdit} /> Update automatically
            </label>
            <span className="text-sm">
              (every {panel.schedule.hours} h
              {!panel.schedule.enabled && <span className="text-destructive">, but automatic updates are off</span>} -{" "}
              <Link href="/admin/settings" className="underline underline-offset-2">
                Settings &gt; Monitoring
              </Link>
              ), applying changes up to
            </span>
            <Input className="w-20" type="number" min={1} value={maxChange} onChange={(e) => setMaxChange(e.target.value)} disabled={!canEdit} aria-label="Largest automatic change in percent" />
            <span className="text-sm">% (bigger ones wait for review)</span>
          </div>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={save.pending}
              onClick={() =>
                void save.run(() => savePriceSyncConfigAction({ providerId, sources, basis, poolName: poolName || null, auto, intervalHours: cfg.intervalHours, maxAutoChangePct: maxChange }), { refresh: false, onOk: onPanel })
              }
            >
              {save.pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save settings
            </Button>
            <Button disabled={check.pending || !cfg.sources.length} onClick={() => void check.run(() => runPriceSyncAction({ providerId }), { refresh: false, onOk: onPanel })} title={cfg.sources.length ? "" : "Save at least one pricing page first"}>
              {check.pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {check.pending ? "Reading the pages..." : "Check prices now"}
            </Button>
          </div>
        )}
        {!cfg.saved && <p className="text-xs text-muted-foreground">Suggested settings for this provider; nothing is stored until you save or check.</p>}

        {/* ---------------------------------------------------------------- latest run */}
        {run && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Last check</span>
              <span className="text-muted-foreground" suppressHydrationWarning>
                {new Date(run.createdAt).toLocaleString()} ({run.trigger})
              </span>
              <Badge variant={run.status === "ok" ? "secondary" : run.status === "failed" ? "destructive" : "outline"}>{run.status}</Badge>
              <span className="text-xs text-muted-foreground">AI cost to us: ${run.costUsd.toFixed(4)}</span>
            </div>
            {run.error && <p className="text-sm text-destructive">{run.error}</p>}
            {run.sources.some((s) => !s.ok) && (
              <ul className="text-xs text-destructive">
                {run.sources.filter((s) => !s.ok).map((s) => (
                  <li key={s.url}>
                    {host(s.url)}: {s.error}
                  </li>
                ))}
              </ul>
            )}
            {run.pool && (
              <p className="text-sm">
                Pool on the page: <span className="font-medium">{run.pool.name || "?"}</span> bills <span className="font-medium">{run.pool.percent ?? "?"}% of the official price</span>
                {run.pool.chargesCacheWrites === false ? ", no cache-write charge" : run.pool.chargesCacheWrites ? ", cache writes charged" : ""}
                {run.pool.imagePrice !== null ? `, images $${run.pool.imagePrice} each` : ""}. {run.pool.verified ? <span className="text-emerald-600">Found on the page.</span> : <span className="text-destructive">Not found word for word on the page: check before applying.</span>}
              </p>
            )}
            {run.proposals.length > 0 && (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="w-8 p-2" />
                      <th className="p-2 text-left font-medium">Model</th>
                      <th className="p-2 text-left font-medium">Status</th>
                      <th className="p-2 text-left font-medium">Our cost now -&gt; from the page (USD / 1M tokens)</th>
                      <th className="p-2 text-left font-medium">Read from</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.proposals.map((p) => {
                      const canPick = canEdit && (p.status === "update" || p.status === "review") && !applied.has(p.routeId);
                      const changed = p.units.filter((u) => u.next !== null || u.nextOfficial);
                      return (
                        <tr key={p.routeId} className="border-t align-top">
                          <td className="p-2">
                            {canPick && (
                              <Checkbox
                                checked={picked.has(p.routeId)}
                                onCheckedChange={(v) =>
                                  setPicked((s) => {
                                    const n = new Set(s);
                                    if (v) n.add(p.routeId);
                                    else n.delete(p.routeId);
                                    return n;
                                  })
                                }
                                aria-label={`Apply ${p.modelSlug}`}
                              />
                            )}
                            {applied.has(p.routeId) && <Check className="size-4 text-emerald-600" />}
                          </td>
                          <td className="p-2">
                            <div className="font-medium">{p.modelSlug}</div>
                            {p.pageModel && p.pageModel !== p.upstreamModel && <div className="text-xs text-muted-foreground">page: {p.pageModel}</div>}
                          </td>
                          <td className="p-2">
                            <Badge variant={STATUS[p.status].variant}>{applied.has(p.routeId) ? "Applied" : STATUS[p.status].label}</Badge>
                            {p.reasons.map((r) => (
                              <div key={r} className="mt-1 max-w-56 text-xs text-muted-foreground">
                                {r}
                              </div>
                            ))}
                          </td>
                          <td className="p-2 text-xs">
                            {changed.length ? (
                              <ul className="space-y-0.5">
                                {changed.map((u) => (
                                  <li key={u.unit} className="tabular-nums">
                                    <span className="text-muted-foreground">{UNIT_LABEL[u.unit]}:</span> {u.next !== null ? <>{usd(u.current)} -&gt; <span className="font-medium">{usd(u.next)}</span></> : "cost unchanged"}
                                    {u.nextOfficial ? <span className="text-muted-foreground"> (official list {usd(u.currentOfficial)} -&gt; {usd(u.nextOfficial)})</span> : null}
                                    {u.changePct !== null && u.changePct > 0 && <span className="text-muted-foreground"> {u.changePct}%</span>}
                                    {!u.verified && <span className="text-destructive"> not on page</span>}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-muted-foreground">{p.units.length ? "no change" : "-"}</span>
                            )}
                          </td>
                          <td className="p-2 text-xs">
                            {canEdit && cfg.sources.length > 0 ? (
                              <Select
                                value={cfg.modelSources[p.routeId] ?? "all"}
                                onValueChange={(v) => void src.run(() => setPriceSyncModelSourceAction({ providerId, routeId: p.routeId, source: v === "all" ? "" : v }), { refresh: false, onOk: (x) => x && setPanel((cur) => ({ ...cur, config: x.config })) })}
                              >
                                <SelectTrigger className="h-8 w-44 text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="all">Any configured page</SelectItem>
                                  {cfg.sources.map((s) => (
                                    <SelectItem key={s.url} value={s.url}>
                                      Only {host(s.url)}
                                    </SelectItem>
                                  ))}
                                  <SelectItem value="off">Don&apos;t sync this model</SelectItem>
                                </SelectContent>
                              </Select>
                            ) : (
                              <span className="text-muted-foreground">{p.source ? host(p.source) : "-"}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {canEdit && selectable.length > 0 && (
              <div className="flex flex-wrap items-center gap-3">
                <Button disabled={apply.pending || !picked.size} onClick={() => void apply.run(() => applyPriceSyncAction({ runId: run.id, routeIds: [...picked] }), { onOk: onPanel })}>
                  {apply.pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Apply {picked.size} selected
                </Button>
                <span className="text-xs text-muted-foreground">Updates our cost{basis === "official" ? " and the official list price" : ""}; customer prices set as a % follow automatically.</span>
              </div>
            )}
          </div>
        )}
        {panel.history.length > 1 && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Earlier checks</summary>
            <ul className="mt-2 space-y-1">
              {panel.history.slice(1).map((h) => (
                <li key={h.id} suppressHydrationWarning>
                  {new Date(h.createdAt).toLocaleString()}: {h.trigger}, {h.status}, {h.changes} change(s), {h.applied} applied, AI ${h.costUsd.toFixed(4)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
