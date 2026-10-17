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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MultiSelectField, NumberField, SelectField, SwitchField, TagsField, TextAreaField } from "@/components/admin/fields";
import { FormDialog } from "@/components/admin/misc";
import { useAction } from "@/components/admin/use-action";
import { deleteModel, duplicateModel, updateModel } from "@/server/admin/models-actions";
import { MODEL_CAPABILITIES, MODEL_PRICE_PAIRS, MODEL_STATUSES, OFFICIAL_PRICE_FIELDS } from "@/server/admin/models-calc";
import type { ModelForm, RouteRow } from "@/server/admin/models-queries";
import { formatCompact, formatPercent } from "@/lib/utils";
import { ModelExplainer } from "./explainer";
import { RoutesPanel, type GroupOption, type ProviderOption } from "./routes-panel";

type Usage = { requests: number; revenue: number; cost: number; profit: number; errorRate: number } | null;

export function ModelWorkspace({
  model,
  routes,
  providers,
  groups,
  usage,
}: {
  model: ModelForm;
  routes: RouteRow[];
  providers: ProviderOption[];
  groups: GroupOption[];
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
  const rec = f as unknown as Record<string, string>;
  const set = <K extends keyof ModelForm>(k: K, v: ModelForm[K]) => setF((s) => ({ ...s, [k]: v }));
  const setStr = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

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
              <CardTitle>Sell prices</CardTitle>
              <CardDescription>What customers pay before group and customer multipliers. Blank optional fields fall back as noted.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {MODEL_PRICE_PAIRS.map((p) => (
                <NumberField
                  key={p.sell}
                  label={p.label}
                  value={rec[p.sell] ?? ""}
                  onChange={(v) => setStr(p.sell, v)}
                  error={fieldErrors[p.sell]}
                  description={p.unit}
                  min={0}
                />
              ))}
              <NumberField label="Long-context threshold" suffix="input tokens" step="1" min={1} value={f.longContextThreshold} onChange={(v) => set("longContextThreshold", v)} error={fieldErrors.longContextThreshold} description="Above this many input tokens the multiplier applies." />
              <NumberField label="Long-context multiplier" suffix="x" value={f.longContextMultiplier} onChange={(v) => set("longContextMultiplier", v)} error={fieldErrors.longContextMultiplier} description="Applied to price and cost, e.g. 2" min={0} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Official prices</CardTitle>
              <CardDescription>Reference prices for the marketing &ldquo;savings&rdquo; display only. Never used for billing.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              {OFFICIAL_PRICE_FIELDS.map((p) => (
                <NumberField key={p.key} label={p.label} value={rec[p.key] ?? ""} onChange={(v) => setStr(p.key, v)} error={fieldErrors[p.key]} description={p.unit} min={0} />
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="xl:sticky xl:top-4 xl:self-start">
          <ModelExplainer slug={f.slug || initial.slug} masked={f.maskUpstreamModel} routes={routes} />
        </div>
      </div>

      <div className="mt-6">
        <RoutesPanel modelId={model.id} publicSlug={f.slug || initial.slug} sell={rec} routes={routes} providers={providers} groups={groups} />
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
