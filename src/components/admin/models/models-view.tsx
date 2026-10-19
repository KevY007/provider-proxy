"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, Copy, Download, MoreHorizontal, Pencil, Percent, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataTable } from "@/components/common/data-table";
import { MoneyText } from "@/components/common/money-text";
import { PageHeader } from "@/components/common/page-header";
import { PriceExplainer, SavingsBadge } from "@/components/common/savings-badge";
import { StatusBadge } from "@/components/common/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormDialog } from "@/components/admin/misc";
import { useAction } from "@/components/admin/use-action";
import { TextField } from "@/components/common/form-fields";
import { bulkApplyPricingRule, deleteModel, duplicateModel, exportModels } from "@/server/admin/models-actions";
import { ruleSummary, compactUnits, fmtPct, marginTone, MODEL_CAPABILITIES, MODEL_STATUSES, PRICING_MODE_LABELS, type PricingModeId } from "@/server/admin/models-calc";
import type { ModelRow } from "@/server/admin/models-queries";
import { cn, formatCompact } from "@/lib/utils";
import { ModelImportDialog } from "./import-dialog";
import { RuleSelector } from "./pricing-editor";

const ALL = "__all__";

function FilterSel({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
      <SelectTrigger size="sm" className="min-w-32" aria-label={label}>
        <span className="mr-1 text-muted-foreground">{label}:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Prices({ r, pick }: { r: ModelRow; pick: "price" | "official" | "cost" }) {
  const c = compactUnits(r.units, pick);
  return c.any ? <span className="whitespace-nowrap text-xs tabular-nums">{c.text}</span> : <span className="text-xs text-muted-foreground">-</span>;
}

export function ModelsView({ rows, vendors }: { rows: ModelRow[]; vendors: string[] }) {
  const router = useRouter();
  const { run } = useAction();
  const [vendor, setVendor] = useState("");
  const [status, setStatus] = useState("");
  const [capability, setCapability] = useState("");
  const [dup, setDup] = useState<ModelRow | null>(null);
  const [dupSlug, setDupSlug] = useState("");
  const [del, setDel] = useState<ModelRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [ruleFor, setRuleFor] = useState<{ ids: string[]; clear: () => void } | null>(null);

  const filtered = useMemo(
    () => rows.filter((r) => (!vendor || r.vendor === vendor) && (!status || r.status === status) && (!capability || r.capabilities.includes(capability))),
    [rows, vendor, status, capability],
  );
  const lossCount = rows.filter((r) => r.loss).length;

  async function doExport() {
    const res = await run(() => exportModels(), { refresh: false, success: "" });
    if (res.ok && res.data) {
      const blob = new Blob([res.data.json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `models-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${res.data.count} models with routes`);
    }
  }

  const columns: ColumnDef<ModelRow>[] = [
    {
      accessorKey: "slug",
      header: "Model",
      meta: { label: "Slug" },
      cell: ({ row }) => (
        <Link href={`/admin/models/${row.original.id}`} className="block min-w-0 hover:underline">
          <span className="font-mono text-sm font-medium">{row.original.slug}</span>
          <span className="block truncate text-xs text-muted-foreground">{row.original.displayName}</span>
        </Link>
      ),
    },
    { accessorKey: "vendor", header: "Vendor" },
    {
      id: "capabilities",
      header: "Capabilities",
      accessorFn: (r) => r.capabilities.join(" "),
      cell: ({ row }) => {
        const caps = row.original.capabilities;
        return (
          <div className="flex max-w-48 flex-wrap gap-1">
            {caps.slice(0, 3).map((c) => (
              <Badge key={c} variant="secondary" className="text-[10px]">
                {c}
              </Badge>
            ))}
            {caps.length > 3 && <Badge variant="outline" className="text-[10px]">+{caps.length - 3}</Badge>}
          </div>
        );
      },
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row: { original: r } }) => (
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge status={r.status} />
          {r.retiresAt && (
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400" title={`Retires ${r.retiresAt.slice(0, 10)}`}>
              retiring {r.retiresAt.slice(0, 10)}
            </Badge>
          )}
          {r.pricingMode !== "FIXED" && (
            <Badge variant="outline" className="gap-1 text-[10px]" title={PRICING_MODE_LABELS[r.pricingMode as PricingModeId]?.label}>
              <Percent className="size-3" /> {ruleSummary(r.pricingMode, r.pricingValue, r.pricingAdjust)}
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: "official",
      header: "Official price",
      meta: { label: "Official price (in / out per 1M)" },
      accessorFn: (r) => compactUnits(r.units, "official").text,
      cell: ({ row: { original: r } }) => <Prices r={r} pick="official" />,
    },
    {
      id: "cost",
      header: "Our cost",
      meta: { label: "Our cost, best route (in / out per 1M)" },
      accessorFn: (r) => compactUnits(r.units, "cost").text,
      cell: ({ row: { original: r } }) =>
        r.routesEnabled === 0 ? <span className="text-xs text-red-500">no enabled route</span> : <Prices r={r} pick="cost" />,
    },
    {
      id: "price",
      header: "Customer price",
      meta: { label: "Customer price (in / out per 1M)" },
      accessorFn: (r) => compactUnits(r.units, "price").text,
      cell: ({ row: { original: r } }) => <Prices r={r} pick="price" />,
    },
    {
      id: "savings",
      header: "Savings",
      meta: { label: "Savings vs official %" },
      accessorFn: (r) => r.savingsPct ?? -999,
      cell: ({ row: { original: r } }) => (r.savingsPct === null ? <span className="text-xs text-muted-foreground">-</span> : <SavingsBadge official={100} price={100 - r.savingsPct} />),
    },
    {
      id: "margin",
      header: "Margin",
      meta: { label: "Margin %" },
      accessorFn: (r) => r.marginPct ?? -999,
      cell: ({ row: { original: r } }) => (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs tabular-nums">
          <span className={marginTone(r.marginPct)}>{fmtPct(r.marginPct, 1)}</span>
          {r.loss && (
            <Badge variant="outline" className="gap-1 border-red-500/40 bg-red-500/10 text-[10px] font-semibold text-red-600 dark:text-red-400">
              <AlertTriangle className="size-3" /> loss
            </Badge>
          )}
        </span>
      ),
    },
    {
      id: "routes",
      header: "Routes",
      accessorFn: (r) => r.routesEnabled,
      cell: ({ row: { original: r } }) => (
        <span className={r.routesEnabled === 0 && r.status === "ACTIVE" ? "text-red-500" : undefined}>
          {r.routesEnabled}/{r.routesTotal}
        </span>
      ),
    },
    {
      id: "usage",
      header: "24h usage",
      accessorFn: (r) => r.requests24h,
      cell: ({ row: { original: r } }) => (
        <span className="whitespace-nowrap text-xs">
          {formatCompact(r.requests24h)} req · <MoneyText value={r.revenue24h} />
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      meta: { noExport: true, className: "w-10" },
      cell: ({ row: { original: r } }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${r.slug}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => router.push(`/admin/models/${r.id}`)}>
              <Pencil className="size-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                setDupSlug(`${r.slug}-copy`);
                setDup(r);
              }}
            >
              <Copy className="size-4" /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setDel(r)}>
              <Trash2 className="size-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Models"
        description="The public catalog customers call. Each model has an Official price (what the original provider charges), your Customer price, and Our cost (what your supplier charges)."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="size-4" /> Import
            </Button>
            <Button variant="outline" size="sm" onClick={doExport}>
              <Download className="size-4" /> Export JSON
            </Button>
            <Button size="sm" asChild>
              <Link href="/admin/models/new">
                <Plus className="size-4" /> Add model
              </Link>
            </Button>
          </>
        }
      />
      <PriceExplainer audience="admin" className="mb-4" />
      {lossCount > 0 && (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400" role="alert">
          <AlertTriangle className="size-4 shrink-0" /> {lossCount} model{lossCount === 1 ? " is" : "s are"} priced below our cost. Every request on {lossCount === 1 ? "it" : "them"} loses money. Look for the red <strong>loss</strong> badge.
        </p>
      )}
      <DataTable
        columns={columns}
        data={filtered}
        searchKey="slug"
        searchPlaceholder="Search slug..."
        exportFilename="models"
        pageSize={25}
        getRowId={(r) => r.id}
        initialColumnVisibility={{ vendor: false, usage: false }}
        emptyTitle="No models"
        emptyDescription={rows.length ? "No models match the current filters." : "Add your first model with the guided flow, or import a JSON catalog."}
        emptyAction={
          rows.length ? undefined : (
            <Button size="sm" asChild>
              <Link href="/admin/models/new">
                <Plus className="size-4" /> Add model
              </Link>
            </Button>
          )
        }
        toolbar={
          <>
            <FilterSel label="Vendor" value={vendor} onChange={setVendor} options={vendors} />
            <FilterSel label="Status" value={status} onChange={setStatus} options={[...MODEL_STATUSES]} />
            <FilterSel label="Capability" value={capability} onChange={setCapability} options={[...MODEL_CAPABILITIES]} />
          </>
        }
        bulkActions={({ selected, clear }) => (
          <Button size="sm" variant="secondary" onClick={() => setRuleFor({ ids: selected.map((s) => s.id), clear })}>
            <Percent className="size-4" /> Apply pricing rule
          </Button>
        )}
      />

      <ModelImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <ApplyRuleDialog target={ruleFor} onClose={() => setRuleFor(null)} />

      <FormDialog
        open={!!dup}
        onOpenChange={(o) => !o && setDup(null)}
        title={`Duplicate ${dup?.slug ?? ""}`}
        description="Copies all prices and routes into a new HIDDEN model so you can adjust it before publishing."
        submitLabel="Duplicate"
        submitDisabled={!dupSlug.trim()}
        onSubmit={async () => {
          if (!dup) return false;
          const res = await run(() => duplicateModel(dup.id, dupSlug.trim()), { refresh: false });
          if (res.ok && res.data) router.push(`/admin/models/${res.data.id}`);
          return res.ok;
        }}
      >
        <TextField label="New slug" value={dupSlug} onChange={(e) => setDupSlug(e.target.value)} autoFocus />
      </FormDialog>

      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete ${del?.slug ?? "model"}?`}
        description={`This permanently deletes the model and its ${del?.routesTotal ?? 0} route(s). Customers calling this model will get model_not_found. Request logs are kept.`}
        confirmLabel="Delete model"
        destructive
        onConfirm={async () => {
          if (!del) return;
          const res = await run(() => deleteModel(del.id));
          if (!res.ok) throw new Error(res.error);
        }}
      />
    </>
  );
}

/** Bulk: set the same pricing rule on every selected model; prices are recomputed immediately. */
function ApplyRuleDialog({ target, onClose }: { target: { ids: string[]; clear: () => void } | null; onClose: () => void }) {
  const { run, fieldErrors, pending } = useAction();
  const [mode, setMode] = useState<PricingModeId>("PERCENT_OF_OFFICIAL");
  const [value, setValue] = useState("70");
  const n = target?.ids.length ?? 0;
  return (
    <FormDialog
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      wide
      title={`Apply pricing rule to ${n} model${n === 1 ? "" : "s"}`}
      description="Customer prices of the selected models are recalculated right away, and stay in sync when official prices or our costs change."
      submitLabel="Apply rule"
      pending={pending}
      onSubmit={async () => {
        if (!target) return false;
        const res = await run(() => bulkApplyPricingRule(target.ids, { mode, value }), { onOk: () => target.clear() });
        return res.ok;
      }}
    >
      <RuleSelector mode={mode} value={value} onMode={(m) => { setMode(m); if (m === "PERCENT_OF_OFFICIAL" && !value) setValue("100"); if (m === "MARKUP_OVER_COST" && !value) setValue("30"); if (m === "PERCENT_OF_COST" && !value) setValue("100"); }} onValue={setValue} valueError={fieldErrors.value} />
      <p className={cn("text-xs text-muted-foreground", mode === "FIXED" && "text-amber-700 dark:text-amber-400")}>
        {mode === "FIXED" ? "Fixed keeps today's prices as they are and stops automatic updates." : "Models without an official price (or without a route cost for markup) keep their current prices."}
      </p>
    </FormDialog>
  );
}
