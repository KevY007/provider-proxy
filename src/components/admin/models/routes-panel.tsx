"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Copy, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState } from "@/components/common/empty-state";
import { MoneyText } from "@/components/common/money-text";
import { StatusBadge } from "@/components/common/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { JsonField, MultiSelectField, NumberField, SelectField, SwitchField, jsonObjectError } from "@/components/admin/fields";
import { FormDialog } from "@/components/admin/misc";
import { useAction } from "@/components/admin/use-action";
import { createRoute, deleteRoute, duplicateRoute, syncRouteCostNow, toggleRoute, updateRoute } from "@/server/admin/models-actions";
import { compactUnits, fmtPct, formatMargin, MODEL_PRICE_PAIRS, marginTone, pairMargin, routeMargins, rowUnits, summarizeRow, toNum, trafficShares } from "@/server/admin/models-calc";
import type { RouteRow, WizardProvider } from "@/server/admin/models-queries";
import { AddRouteWizard } from "./add-route-wizard";
import { ToolPriceTable } from "./pricing-editor";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export type SellValues = Record<string, string>;
export interface ProviderOption {
  id: string;
  name: string;
  slug: string;
  status: string;
}
export interface GroupOption {
  slug: string;
  name: string;
  /** pool pricing, for the model page's economics preview */
  multiplier?: number;
  basis?: "model" | "cost";
  /** the pool lets this model through */
  allowed?: boolean;
}

function Margin({ v }: { v: number | null }) {
  return <span className={cn("tabular-nums", marginTone(v))}>{formatMargin(v)}</span>;
}

export function RoutesPanel({
  modelId,
  publicSlug,
  sell,
  sellTools = {},
  model,
  routes,
  providers,
  wizardProviders,
  groups,
}: {
  modelId: string;
  publicSlug: string;
  /** Effective customer prices (derived when a pricing rule is active). */
  sell: SellValues;
  /** Effective customer price per server tool (USD per unit). */
  sellTools?: Record<string, number | null>;
  /** The model form (official prices + capabilities) for the Add route flow. */
  model: Record<string, unknown> & { capabilities: string[] };
  routes: RouteRow[];
  providers: ProviderOption[];
  wizardProviders: WizardProvider[];
  groups: GroupOption[];
}) {
  const { run } = useAction();
  const [editing, setEditing] = useState<RouteRow | "new" | null>(null);
  const [wizard, setWizard] = useState(false);
  const [deleting, setDeleting] = useState<RouteRow | null>(null);
  const shares = useMemo(() => trafficShares(routes), [routes]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle>Routes</CardTitle>
          <CardDescription>
            Where <span className="font-mono">{publicSlug}</span> is actually sent, and what each route costs you. Higher priority is tried first; routes with the same priority
            share traffic by weight. Failed attempts fall through to the next route.
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" onClick={() => setWizard(true)} disabled={providers.length === 0}>
            <Plus className="size-4" /> Add route
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="More ways to add a route" disabled={providers.length === 0}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEditing("new")}>Add manually (all fields)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent>
        {routes.length === 0 ? (
          <EmptyState
            title="No routes yet"
            description={providers.length ? "Without an enabled route this model returns no_available_provider. Add a route to a provider." : "Create a provider first, then add a route here."}
            action={
              providers.length ? (
                <Button size="sm" onClick={() => setWizard(true)}>
                  <Plus className="size-4" /> Add route
                </Button>
              ) : (
                <Button size="sm" asChild>
                  <Link href="/admin/providers">Go to providers</Link>
                </Button>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow className="hover:bg-transparent">
                  <TableHead>On</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Real upstream model</TableHead>
                  <TableHead className="text-right">Prio</TableHead>
                  <TableHead className="text-right">Traffic</TableHead>
                  <TableHead>Pools</TableHead>
                  <TableHead className="text-right">Our cost</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {routes.map((r) => {
                  const units = rowUnits(sell, r as unknown as Record<string, string>);
                  const costText = compactUnits(units, "cost");
                  const sum = summarizeRow(units);
                  const s = shares[r.id];
                  return (
                    <TableRow key={r.id} className={cn(!r.enabled && "opacity-60")}>
                      <TableCell>
                        <Switch
                          checked={r.enabled}
                          aria-label={`Enable route ${r.upstreamModel}`}
                          onCheckedChange={(v) => run(() => toggleRoute(r.id, v), { success: v ? "Route enabled" : "Route disabled" })}
                        />
                      </TableCell>
                      <TableCell>
                        <Link href={`/admin/providers/${r.providerId}`} className="font-medium hover:underline">
                          {r.providerName}
                        </Link>
                        <div className="mt-0.5 flex gap-1">
                          {r.providerStatus !== "ACTIVE" && <StatusBadge status={r.providerStatus} dot={false} className="text-[10px]" />}
                          {r.providerHealth !== "OPERATIONAL" && r.providerHealth !== "UNKNOWN" && <StatusBadge status={r.providerHealth} dot={false} className="text-[10px]" />}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs">{r.upstreamModel}</span>
                        {r.label && <span className="block text-xs text-muted-foreground">{r.label}</span>}
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {r.maxOutputTokens && <Badge variant="outline" className="text-[10px]">clamp {r.maxOutputTokens}</Badge>}
                          {r.paramOverrides.trim() !== "{}" && <Badge variant="outline" className="text-[10px]">overrides</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.priority}
                        {s?.tier > 0 && <span className="block text-[10px] text-muted-foreground">tier {s.tier}</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.enabled ? `${s.sharePct.toFixed(0)}%` : "-"}
                        <span className="block text-[10px] text-muted-foreground">w{r.weight}</span>
                      </TableCell>
                      <TableCell>
                        {r.groupSlugs.length === 0 ? (
                          <span className="text-xs text-muted-foreground">all</span>
                        ) : (
                          <div className="flex max-w-40 flex-wrap gap-1">
                            {r.groupSlugs.map((g) => (
                              <Badge key={g} variant="secondary" className="text-[10px]">
                                {g}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-xs">{costText.text}</TableCell>
                      <TableCell className="whitespace-nowrap text-right text-xs">
                        <span className={cn("tabular-nums", marginTone(sum.marginPct))}>{fmtPct(sum.marginPct, 1)}</span>
                        {sum.loss && <span className="ml-1 rounded bg-red-500/15 px-1 text-[10px] font-semibold uppercase text-red-500">loss</span>}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8" aria-label="Route actions">
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setEditing(r)}>
                              <Pencil className="size-4" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => run(() => duplicateRoute(r.id))}>
                              <Copy className="size-4" /> Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(r)}>
                              <Trash2 className="size-4" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {wizard && (
        <AddRouteWizard
          modelId={modelId}
          publicSlug={publicSlug}
          model={{ ...(model as unknown as Record<string, string>), ...sell }}
          providers={wizardProviders}
          capabilities={model.capabilities}
          onClose={() => setWizard(false)}
        />
      )}

      {editing && (
        <RouteDialog
          key={editing === "new" ? "new" : editing.id}
          modelId={modelId}
          publicSlug={publicSlug}
          route={editing === "new" ? null : editing}
          sell={sell}
          sellTools={sellTools}
          official={model}
          providers={providers}
          groups={groups}
          onClose={() => setEditing(null)}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this route?"
        description={
          <>
            Traffic for <span className="font-mono">{publicSlug}</span> will no longer go to <span className="font-mono">{deleting?.upstreamModel}</span> on {deleting?.providerName}.
          </>
        }
        confirmLabel="Delete route"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const res = await run(() => deleteRoute(deleting.id));
          if (!res.ok) throw new Error(res.error);
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------

type RouteForm = {
  providerId: string;
  upstreamModel: string;
  label: string;
  enabled: boolean;
  priority: string;
  weight: string;
  groupSlugs: string[];
  paramOverrides: string;
  maxOutputTokens: string;
  toolCosts: Record<string, string>;
  batchCostDiscountPct: string;
  autoCostSync: boolean;
  autoCostSourceModel: string;
} & Record<string, string | boolean | string[] | Record<string, string>>;

const PRIMARY_SELL = new Set(["inputPrice", "outputPrice", "cachedInputPrice", "cacheWritePrice", "cacheWrite1hPrice"]);

function RouteDialog({
  modelId,
  publicSlug,
  route,
  sell,
  sellTools,
  official,
  providers,
  groups,
  onClose,
}: {
  modelId: string;
  publicSlug: string;
  route: RouteRow | null;
  sell: SellValues;
  sellTools: Record<string, number | null>;
  /** the model form: its official list prices show each cost as a % of official */
  official: Record<string, unknown>;
  providers: ProviderOption[];
  groups: GroupOption[];
  onClose: () => void;
}) {
  const { run, fieldErrors, pending } = useAction();
  const [f, setF] = useState<RouteForm>(() => {
    const base: RouteForm = {
      providerId: route?.providerId ?? providers.find((p) => p.status === "ACTIVE")?.id ?? providers[0]?.id ?? "",
      upstreamModel: route?.upstreamModel ?? publicSlug,
      label: route?.label ?? "",
      enabled: route?.enabled ?? true,
      priority: String(route?.priority ?? 0),
      weight: String(route?.weight ?? 1),
      groupSlugs: route?.groupSlugs ?? [],
      paramOverrides: route ? route.paramOverrides : "{}",
      maxOutputTokens: route?.maxOutputTokens ?? "",
      toolCosts: route?.toolCosts ?? {},
      batchCostDiscountPct: route?.batchCostDiscountPct ?? "50",
      autoCostSync: route?.autoCostSync ?? false,
      autoCostSourceModel: route?.autoCostSourceModel ?? "",
    };
    for (const p of MODEL_PRICE_PAIRS) base[p.cost] = route ? String((route as unknown as Record<string, string>)[p.cost] ?? "") : "";
    return base;
  });
  const set = (k: string, v: string | boolean | string[]) => setF((s) => ({ ...s, [k]: v }));
  const setToolCost = (k: string, v: string) => setF((s) => ({ ...s, toolCosts: { ...s.toolCosts, [k]: v } }));
  const removeToolCost = (k: string) =>
    setF((s) => {
      const toolCosts = { ...s.toolCosts };
      delete toolCosts[k];
      return { ...s, toolCosts };
    });
  const costs = f as unknown as Record<string, string>;
  const [showAll, setShowAll] = useState(() => MODEL_PRICE_PAIRS.some((p) => !PRIMARY_SELL.has(p.sell) && (!!costs[p.cost] || (toNum(sell[p.sell]) ?? 0) > 0)));
  const margins = routeMargins(
    { inputPrice: sell.inputPrice, outputPrice: sell.outputPrice, cachedInputPrice: sell.cachedInputPrice },
    { inputCost: costs.inputCost, outputCost: costs.outputCost, cachedInputCost: costs.cachedInputCost },
  );
  const jsonErr = jsonObjectError(f.paramOverrides);

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title={route ? "Edit route" : "Add route"}
      description={
        <>
          Public slug (what customers call): <span className="font-mono text-foreground">{publicSlug}</span>
        </>
      }
      submitLabel={route ? "Save route" : "Add route"}
      pending={pending}
      submitDisabled={!!jsonErr}
      onSubmit={async () => {
        const payload = { ...f };
        const res = route ? await run(() => updateRoute(route.id, payload)) : await run(() => createRoute(modelId, payload));
        return res.ok;
      }}
    >
      <section className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Provider"
          value={f.providerId}
          onChange={(v) => set("providerId", v)}
          options={providers.map((p) => ({ value: p.id, label: p.status === "ACTIVE" ? p.name : `${p.name} (${p.status.toLowerCase()})` }))}
          error={fieldErrors.providerId}
        />
        <Field data-invalid={!!fieldErrors.upstreamModel}>
          <FieldLabel htmlFor="route-upstream">Real upstream model (sent to the provider)</FieldLabel>
          <Input id="route-upstream" className="font-mono" value={f.upstreamModel} onChange={(e) => set("upstreamModel", e.target.value)} aria-invalid={!!fieldErrors.upstreamModel} spellCheck={false} />
          <FieldDescription className={fieldErrors.upstreamModel ? "text-destructive" : undefined}>
            {fieldErrors.upstreamModel ?? "Customers never see this if masking is on. It replaces `model` in the upstream request."}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="route-label">Label (internal)</FieldLabel>
          <Input id="route-label" value={f.label} onChange={(e) => set("label", e.target.value)} placeholder="e.g. cheap pool" />
        </Field>
        <SwitchField label="Enabled" checked={f.enabled} onChange={(v) => set("enabled", v)} description="Disabled routes are never selected." />
        <NumberField label="Priority" step="1" value={f.priority} onChange={(v) => set("priority", v)} error={fieldErrors.priority} description="Higher is tried first." />
        <NumberField label="Weight" step="1" min={0} value={f.weight} onChange={(v) => set("weight", v)} error={fieldErrors.weight} description="Traffic split among routes of the same priority." />
        <MultiSelectField
          label="Restrict to pools (groups)"
          values={f.groupSlugs}
          onChange={(v) => set("groupSlugs", v)}
          options={groups.map((g) => ({ value: g.slug, label: g.slug, hint: g.name }))}
          placeholder="All pools"
          description="Empty = available to every pool."
        />
        <NumberField label="Max output tokens (clamp)" step="1" min={1} value={f.maxOutputTokens} onChange={(v) => set("maxOutputTokens", v)} error={fieldErrors.maxOutputTokens} placeholder="no clamp" description="Caps max_tokens sent upstream." />
      </section>

      <JsonField
        label="Param overrides (JSON)"
        value={f.paramOverrides}
        onChange={(v) => set("paramOverrides", v)}
        error={fieldErrors.paramOverrides}
        rows={4}
        description={
          <>
            Deep-merged into the upstream request body, e.g. <code>{`{"reasoning_effort":"low"}`}</code>. A <code>null</code> value deletes that field.
          </>
        }
      />

      <section className="space-y-2 rounded-md border bg-muted/20 p-3">
        <SwitchField
          label="Auto-update the cost from the provider's published price"
          checked={f.autoCostSync}
          onChange={(v) => set("autoCostSync", v)}
          description="Re-read lazily during calls on this route (every few hours or N calls, see Settings - never on a timer). Combine with the model's '% of our cost' rule and a +/- adjustment to price relative to the provider."
        />
        {f.autoCostSync && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="auto-src">Provider&apos;s model id (optional)</FieldLabel>
              <Input id="auto-src" value={f.autoCostSourceModel} onChange={(e) => set("autoCostSourceModel", e.target.value)} placeholder={f.upstreamModel} />
              <FieldDescription>Only when the price list names the model differently from the upstream model.</FieldDescription>
            </Field>
            {route && (
              <div className="space-y-1 text-sm">
                <p className="text-muted-foreground">
                  Last sync: {route.autoCostSyncedAt ? new Date(route.autoCostSyncedAt).toLocaleString() : "never"}
                  {route.autoCostStatus ? ` (${route.autoCostStatus})` : ""}
                </p>
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void run(() => syncRouteCostNow(route.id))}>
                  Sync now
                </Button>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Your cost vs. sell price</h3>
          <div className="flex gap-3 text-xs">
            <span>
              Input <Margin v={margins.input} />
            </span>
            <span>
              Output <Margin v={margins.output} />
            </span>
            <span>
              Cached <Margin v={margins.cached} />
            </span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Cost = what this supplier charges us. Official = the vendor&apos;s list price (what OpenAI / Anthropic charge anyone directly). Sell = the model price before the pool&apos;s percentage. Margin = (sell − cost) / sell. Blank cached / cache-write fall back to the input price on both sides.
        </p>
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead>Dimension</TableHead>
                <TableHead className="w-28 text-right">Sell</TableHead>
                <TableHead className="w-36">Cost</TableHead>
                <TableHead className="w-20 text-right">Margin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {MODEL_PRICE_PAIRS.filter((p) => showAll || PRIMARY_SELL.has(p.sell)).map((p) => (
                <TableRow key={p.cost}>
                  <TableCell>
                    <span className="text-sm">{p.label}</span>
                    <span className="block text-[10px] text-muted-foreground">{p.unit}</span>
                  </TableCell>
                  <TableCell className="text-right text-xs">{sell[p.sell] ? <MoneyText value={sell[p.sell]} /> : <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      step="any"
                      min={0}
                      inputMode="decimal"
                      aria-label={`${p.label} cost`}
                      aria-invalid={!!fieldErrors[p.cost]}
                      value={costs[p.cost]}
                      onChange={(e) => set(p.cost, e.target.value)}
                      className="h-7 tabular-nums"
                    />
                    {fieldErrors[p.cost] && <span className="text-xs text-destructive">{fieldErrors[p.cost]}</span>}
                    <OfficialShare cost={costs[p.cost]} official={p.official ? (official[p.official] as string | null | undefined) : null} />
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    <Margin v={pairMargin(p, sell, costs)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((s) => !s)}>
          {showAll ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          {showAll ? "Hide" : "Show"} image, video (per second), audio, per-request and other costs
        </Button>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Server tools</h3>
        <p className="text-xs text-muted-foreground">What this provider charges per server-tool use (USD per search / container hour / call), same keys as the model&apos;s tool prices.</p>
        <ToolPriceTable
          cols={[
            { label: "Sell", values: sellTools },
            { label: "Cost", values: f.toolCosts, onChange: setToolCost },
          ]}
          onRemove={removeToolCost}
          errors={fieldErrors.toolCosts ? { Cost: fieldErrors.toolCosts } : {}}
        />
        <NumberField
          className="max-w-xs"
          label="Batch API cost discount"
          suffix="%"
          min={0}
          value={f.batchCostDiscountPct}
          onChange={(v) => set("batchCostDiscountPct", v)}
          error={fieldErrors.batchCostDiscountPct}
          placeholder="50"
          description="What this provider takes off its token prices for Batch API results. Blank = 50."
        />
      </section>
    </FormDialog>
  );
}

/** "= 5% of official" under a route cost (the supplier's discount, at a glance). */
function OfficialShare({ cost, official }: { cost: string | undefined; official: string | null | undefined }) {
  const c = toNum(cost ?? null);
  const o = toNum(official ?? null);
  if (c === null || o === null || o === 0) return null;
  const pct = Math.round((c / o) * 10000) / 100;
  return <span className="block text-[10px] text-muted-foreground">= {pct}% of official</span>;
}