"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Copy, Save, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { MoneyText } from "@/components/common/money-text";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { StatusBadge } from "@/components/common/status-badge";
import { TextField } from "@/components/common/form-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MultiSelectField, NumberField, SelectField, SwitchField, TagsField, TextAreaField } from "@/components/admin/fields";
import { FormDialog } from "@/components/admin/misc";
import { useAction } from "@/components/admin/use-action";
import { deleteModel, duplicateModel, updateModel } from "@/server/admin/models-actions";
import { previewToolPrices, primaryEnabledRoute, MODEL_CAPABILITIES, MODEL_PRICE_PAIRS, MODEL_STATUSES } from "@/server/admin/models-calc";
import type { ModelForm, RouteRow, WizardProvider } from "@/server/admin/models-queries";
import type { PriceUnitKey } from "@/server/pricing/preview";
import { formatCompact, formatPercent } from "@/lib/utils";
import { ModelExplainer } from "./explainer";
import { PriceExplainer, PriceGrid, RuleSelector, ToolPriceTable, usePricingPreview } from "./pricing-editor";
import { RoutesPanel, type GroupOption, type ProviderOption } from "./routes-panel";

type Usage = { requests: number; revenue: number; cost: number; profit: number; errorRate: number } | null;

export function ModelWorkspace({
  model,
  routes,
  providers,
  groups,
  wizardProviders,
  usage,
}: {
  model: ModelForm;
  routes: RouteRow[];
  providers: ProviderOption[];
  groups: GroupOption[];
  wizardProviders: WizardProvider[];
  usage: Usage;
}) {
  const router = useRouter();
  const { run, fieldErrors, pending } = useAction();
  const [initial, setInitial] = useState(model);
  const [f, setF] = useState<ModelForm>(model);
  const [delOpen, setDelOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [dupSlug, setDupSlug] = useState(`${model.slug}-copy`);
  const dirty = useMemo(() => JSON.stringify(f) !== JSON.stringify(initial), [f, initial]);
  const set = <K extends keyof ModelForm>(k: K, v: ModelForm[K]) => setF((s) => ({ ...s, [k]: v }));
  const setStr = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  // Our cost = the cheapest enabled route; the price grid reads cost fields from it.
  const costRoute = useMemo(() => primaryEnabledRoute(routes), [routes]);
  const gridValues = useMemo(() => ({ ...(f as unknown as Record<string, string>), ...((costRoute as unknown as Record<string, string> | null) ?? {}) }), [f, costRoute]);
  const focusUnits = useMemo<PriceUnitKey[]>(() => {
    const u: PriceUnitKey[] = [];
    if (f.capabilities.includes("images")) u.push("image");
    if (f.capabilities.includes("video")) u.push("perSecond");
    if (f.capabilities.includes("audio_speech")) u.push("perMillionChars");
    if (f.capabilities.includes("audio_transcription")) u.push("perMinute");
    return u;
  }, [f.capabilities]);
  // What customers actually pay (derived when a rule is active) feeds the route margin previews.
  const preview = usePricingPreview(gridValues, f.pricingMode, f.pricingValue, 1, f.pricingAdjust);
  const effectiveSell = useMemo<Record<string, string>>(() => {
    const rec = { ...(f as unknown as Record<string, string>) };
    if (f.pricingMode !== "FIXED") {
      for (const p of MODEL_PRICE_PAIRS) {
        const v = p.unitKey ? preview.customer[p.unitKey] : null;
        if (v !== null && v !== undefined) rec[p.sell] = String(v);
      }
    }
    return rec;
  }, [f, preview]);

  // Server tools: what customers pay per tool (derived from official / our cost when a rule is active).
  const toolSell = useMemo(
    () => previewToolPrices(f.pricingMode, f.pricingValue, f.officialToolPrices, costRoute?.toolCosts ?? {}, f.toolPrices),
    [f.pricingMode, f.pricingValue, f.officialToolPrices, f.toolPrices, costRoute],
  );
  const setTool = (col: "toolPrices" | "officialToolPrices", key: string, v: string) => setF((s) => ({ ...s, [col]: { ...s[col], [key]: v } }));
  const removeTool = (key: string) =>
    setF((s) => {
      const toolPrices = { ...s.toolPrices };
      const officialToolPrices = { ...s.officialToolPrices };
      delete toolPrices[key];
      delete officialToolPrices[key];
      return { ...s, toolPrices, officialToolPrices };
    });
  const toolErrors = Object.fromEntries(["officialToolPrices", "toolPrices"].filter((k) => fieldErrors[k]).map((k) => [k === "toolPrices" ? "Customer price" : "Official price", fieldErrors[k]]));

  // Rule-driven prices are recomputed server-side when official prices / route costs change: pull them in without losing other edits.
  const sellSig = MODEL_PRICE_PAIRS.map((p) => (model as unknown as Record<string, string>)[p.sell]).join("|") + JSON.stringify(model.toolPrices);
  const [seenSig, setSeenSig] = useState(sellSig);
  if (seenSig !== sellSig) {
    setSeenSig(sellSig);
    if (model.pricingMode !== "FIXED") {
      const patch: Record<string, string> = {};
      for (const p of MODEL_PRICE_PAIRS) patch[p.sell] = (model as unknown as Record<string, string>)[p.sell];
      setInitial((s) => ({ ...s, ...patch, toolPrices: model.toolPrices }));
      setF((s) => (s.pricingMode === model.pricingMode ? { ...s, ...patch, toolPrices: model.toolPrices } : s));
    }
  }

  async function save() {
    const res = await run(() => updateModel(model.id, f), {
      onOk: () => setInitial(f),
    });
    return res.ok;
  }

  return (
    <>
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
        <Link href="/admin/models">
          <ArrowLeft className="size-4" /> Models
        </Link>
      </Button>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {initial.displayName}
            <StatusBadge status={initial.status} />
            {initial.retiresAt && (
              <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                Retiring {initial.retiresAt}
              </Badge>
            )}
          </span>
        }
        description={<span className="font-mono">{initial.slug}</span>}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setDupOpen(true)}>
              <Copy className="size-4" /> Duplicate
            </Button>
            <Button variant="outline" size="sm" className="text-red-500 hover:text-red-500" onClick={() => setDelOpen(true)}>
              <Trash2 className="size-4" /> Delete
            </Button>
            <Button size="sm" onClick={save} disabled={!dirty || pending}>
              <Save className="size-4" /> {dirty ? "Save changes" : "Saved"}
            </Button>
          </>
        }
      />

      {usage && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Requests (24h)" value={formatCompact(usage.requests)} hint={`${formatPercent(usage.errorRate)} errors`} />
          <StatCard label="Revenue (24h)" value={<MoneyText value={usage.revenue} />} />
          <StatCard label="Cost (24h)" value={<MoneyText value={usage.cost} />} />
          <StatCard label="Profit (24h)" value={<MoneyText value={usage.profit} colorize />} />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Identity</CardTitle>
              <CardDescription>What customers see in the catalog and put in the `model` field.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <TextField label="Public slug (what customers call)" className="font-mono" value={f.slug} onChange={(e) => set("slug", e.target.value)} error={fieldErrors.slug} description="Renaming also updates group and API key allow-lists." />
              <TextField label="Display name" value={f.displayName} onChange={(e) => set("displayName", e.target.value)} error={fieldErrors.displayName} />
              <TextField label="Vendor" value={f.vendor} onChange={(e) => set("vendor", e.target.value)} error={fieldErrors.vendor} />
              <SelectField label="Status" value={f.status} onChange={(v) => set("status", v)} options={MODEL_STATUSES.map((s) => ({ value: s, label: s }))} description="HIDDEN: callable by name but not listed. DISABLED: rejected." />
              <TagsField className="sm:col-span-2" label="Aliases" values={f.aliases} onChange={(v) => set("aliases", v)} description="Other names that resolve to this model." />
              <TextAreaField className="sm:col-span-2" label="Description" value={f.description} onChange={(v) => set("description", v)} rows={2} error={fieldErrors.description} />
              <MultiSelectField className="sm:col-span-2" label="Capabilities" values={f.capabilities} onChange={(v) => set("capabilities", v)} options={MODEL_CAPABILITIES.map((c) => ({ value: c, label: c }))} error={fieldErrors.capabilities} />
              <NumberField label="Context window" suffix="tokens" step="1" min={1} value={f.contextWindow} onChange={(v) => set("contextWindow", v)} error={fieldErrors.contextWindow} />
              <NumberField label="Max output" suffix="tokens" step="1" min={1} value={f.maxOutput} onChange={(v) => set("maxOutput", v)} error={fieldErrors.maxOutput} />
              <NumberField label="Sort order" step="1" value={f.sortOrder} onChange={(v) => set("sortOrder", v)} error={fieldErrors.sortOrder} description="Lower first in catalogs." />
              <SwitchField
                label="Mask upstream model"
                checked={f.maskUpstreamModel}
                onChange={(v) => set("maskUpstreamModel", v)}
                description="Rewrite `model` in responses and stream chunks to the public slug."
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pricing</CardTitle>
              <CardDescription>
                Choose how the <strong>Customer price</strong> is set. The table updates live: <strong>Official price</strong> (reference), <strong>Our cost</strong> (primary route), what customers pay, their <strong>Savings</strong> and our <strong>Margin</strong>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <PriceExplainer audience="admin" />
              <RuleSelector
                mode={f.pricingMode}
                value={f.pricingValue}
                onMode={(m) => setF((s) => ({ ...s, pricingMode: m, pricingValue: m === "FIXED" ? s.pricingValue : s.pricingValue || (m === "MARKUP_OVER_COST" ? "30" : "100") }))}
                onValue={(v) => set("pricingValue", v)}
                valueError={fieldErrors.pricingValue}
                adjust={f.pricingAdjust}
                onAdjust={(v) => set("pricingAdjust", v)}
                adjustError={fieldErrors.pricingAdjust}
              />
              {costRoute ? (
                <p className="text-xs text-muted-foreground">
                  Our cost comes from the primary route (highest priority, enabled): <span className="font-mono">{costRoute.upstreamModel}</span> on {costRoute.providerName}.
                </p>
              ) : (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">No enabled route yet, so margins can&apos;t be calculated. Add a route below.</p>
              )}
              <PriceGrid
                values={gridValues}
                mode={f.pricingMode}
                ruleValue={f.pricingValue}
                onChange={setStr}
                errors={fieldErrors}
                cols={{ official: "edit", cost: "show", customer: "edit", savings: true, margin: true }}
                focusUnits={focusUnits}
              />
              {f.pricingMode !== "FIXED" && (
                <p className="text-xs text-muted-foreground">Customer prices follow the rule and are recomputed whenever the official price or a route cost changes. Switch to Fixed prices to type them yourself.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Server tools</CardTitle>
              <CardDescription>
                Tools the provider runs for a request and bills per use (web search, code execution, file search), in USD per unit. Billed on top of tokens; the group/customer multiplier applies to the
                customer price, never to our cost.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ToolPriceTable
                cols={[
                  { label: "Official price", values: f.officialToolPrices, onChange: (k, v) => setTool("officialToolPrices", k, v) },
                  { label: "Our cost", values: costRoute?.toolCosts ?? {} },
                  f.pricingMode === "FIXED" ? { label: "Customer price", values: f.toolPrices, onChange: (k, v) => setTool("toolPrices", k, v) } : { label: "Customer price", values: toolSell },
                ]}
                onRemove={removeTool}
                errors={toolErrors}
              />
              <NumberField
                className="max-w-xs"
                label="Batch API discount"
                suffix="%"
                min={0}
                value={f.batchDiscountPct}
                onChange={(v) => set("batchDiscountPct", v)}
                error={fieldErrors.batchDiscountPct}
                placeholder="50"
                description="Taken off the token price of Batch API results (not tools or flat fees). Blank = 50, like the vendors."
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>More price settings</CardTitle>
              <CardDescription>Cache write (1h), long-context surcharge and the upstream retirement date.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <NumberField label="Cache write (1h)" value={f.cacheWrite1hPrice} onChange={(v) => set("cacheWrite1hPrice", v)} error={fieldErrors.cacheWrite1hPrice} description="USD / 1M tokens (customer price)" min={0} />
              <NumberField label="Long-context threshold" suffix="input tokens" step="1" min={1} value={f.longContextThreshold} onChange={(v) => set("longContextThreshold", v)} error={fieldErrors.longContextThreshold} description="Above this many input tokens the multiplier applies." />
              <NumberField label="Long-context multiplier" suffix="x" value={f.longContextMultiplier} onChange={(v) => set("longContextMultiplier", v)} error={fieldErrors.longContextMultiplier} description="Applied to price and cost, e.g. 2" min={0} />
              <Field data-invalid={!!fieldErrors.retiresAt}>
                <FieldLabel htmlFor="retires-at">Retires on</FieldLabel>
                <Input id="retires-at" type="date" value={f.retiresAt} onChange={(e) => set("retiresAt", e.target.value)} aria-invalid={!!fieldErrors.retiresAt} />
                <FieldDescription className={fieldErrors.retiresAt ? "text-destructive" : undefined}>
                  {fieldErrors.retiresAt ?? "The date the provider shuts this model down. Shows a “retiring” badge to you and customers."}
                </FieldDescription>
              </Field>
            </CardContent>
          </Card>
        </div>

        <div className="xl:sticky xl:top-4 xl:self-start">
          <ModelExplainer slug={f.slug || initial.slug} masked={f.maskUpstreamModel} routes={routes} />
        </div>
      </div>

      <div className="mt-6">
        <RoutesPanel modelId={model.id} publicSlug={f.slug || initial.slug} sell={effectiveSell} sellTools={toolSell} model={f} routes={routes} providers={providers} wizardProviders={wizardProviders} groups={groups} />
      </div>

      {dirty && (
        <div className="sticky bottom-4 z-10 mt-6 flex items-center justify-between gap-3 rounded-lg border bg-popover/95 p-3 shadow-lg backdrop-blur">
          <span className="text-sm text-muted-foreground">Unsaved changes (margin previews above use the values you are typing).</span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setF(initial)}>
              Discard
            </Button>
            <Button size="sm" onClick={save} disabled={pending}>
              <Save className="size-4" /> Save changes
            </Button>
          </div>
        </div>
      )}

      <FormDialog
        open={dupOpen}
        onOpenChange={setDupOpen}
        title={`Duplicate ${model.slug}`}
        description="Copies prices and routes into a new HIDDEN model."
        submitLabel="Duplicate"
        submitDisabled={!dupSlug.trim()}
        onSubmit={async () => {
          const res = await run(() => duplicateModel(model.id, dupSlug.trim()), { refresh: false });
          if (res.ok && res.data) router.push(`/admin/models/${res.data.id}`);
          return res.ok;
        }}
      >
        <TextField label="New slug" value={dupSlug} onChange={(e) => setDupSlug(e.target.value)} autoFocus />
      </FormDialog>

      <ConfirmDialog
        open={delOpen}
        onOpenChange={setDelOpen}
        title={`Delete ${model.slug}?`}
        description={`This permanently deletes the model and its ${routes.length} route(s). Customers calling it will get model_not_found. Request logs are kept.`}
        confirmLabel="Delete model"
        destructive
        onConfirm={async () => {
          const res = await run(() => deleteModel(model.id), { refresh: false });
          if (!res.ok) throw new Error(res.error);
          router.push("/admin/models");
        }}
      />
    </>
  );
}
