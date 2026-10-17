"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Copy, Download, MoreHorizontal, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataTable } from "@/components/common/data-table";
import { MoneyText } from "@/components/common/money-text";
import { PageHeader } from "@/components/common/page-header";
import { StatusBadge } from "@/components/common/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormDialog } from "@/components/admin/misc";
import { MultiSelectField, NumberField, SelectField } from "@/components/admin/fields";
import { useAction } from "@/components/admin/use-action";
import { TextField } from "@/components/common/form-fields";
import { createModel, deleteModel, duplicateModel, exportModels } from "@/server/admin/models-actions";
import { formatMargin, marginTone, MODEL_CAPABILITIES, MODEL_STATUSES } from "@/server/admin/models-calc";
import type { ModelRow } from "@/server/admin/models-queries";
import { formatCompact } from "@/lib/utils";
import { ModelImportDialog } from "./import-dialog";

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

export function ModelsView({ rows, vendors }: { rows: ModelRow[]; vendors: string[] }) {
  const router = useRouter();
  const { run } = useAction();
  const [vendor, setVendor] = useState("");
  const [status, setStatus] = useState("");
  const [capability, setCapability] = useState("");
  const [dup, setDup] = useState<ModelRow | null>(null);
  const [dupSlug, setDupSlug] = useState("");
  const [del, setDel] = useState<ModelRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const filtered = useMemo(
    () => rows.filter((r) => (!vendor || r.vendor === vendor) && (!status || r.status === status) && (!capability || r.capabilities.includes(capability))),
    [rows, vendor, status, capability],
  );

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
    { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    {
      id: "sell",
      header: "Sell in / out / cached",
      meta: { label: "Sell in/out/cached (per 1M)" },
      accessorFn: (r) => `${r.inputPrice}/${r.outputPrice}/${r.cachedInputPrice ?? ""}`,
      cell: ({ row: { original: r } }) => (
        <span className="whitespace-nowrap text-xs">
          <MoneyText value={r.inputPrice} /> / <MoneyText value={r.outputPrice} /> /{" "}
          {r.cachedInputPrice ? <MoneyText value={r.cachedInputPrice} /> : <span className="text-muted-foreground">-</span>}
        </span>
      ),
    },
    {
      id: "cost",
      header: "Best route cost in / out",
      meta: { label: "Best cost in/out (per 1M)" },
      accessorFn: (r) => (r.bestCostIn === null ? "" : `${r.bestCostIn}/${r.bestCostOut}`),
      cell: ({ row: { original: r } }) =>
        r.bestCostIn === null ? (
          <span className="text-xs text-red-500">no enabled route</span>
        ) : (
          <span className="whitespace-nowrap text-xs">
            <MoneyText value={r.bestCostIn} /> / <MoneyText value={r.bestCostOut ?? 0} />
          </span>
        ),
    },
    {
      id: "margin",
      header: "Margin in / out",
      meta: { label: "Margin in/out %" },
      accessorFn: (r) => r.marginIn ?? -999,
      cell: ({ row: { original: r } }) => (
        <span className="whitespace-nowrap text-xs tabular-nums">
          <span className={marginTone(r.marginIn)}>{formatMargin(r.marginIn)}</span> / <span className={marginTone(r.marginOut)}>{formatMargin(r.marginOut)}</span>
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
        description="The public catalog customers call, with sell prices. Each model maps to one or more upstream routes (provider + real upstream model + your cost)."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="size-4" /> Import
            </Button>
            <Button variant="outline" size="sm" onClick={doExport}>
              <Download className="size-4" /> Export JSON
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> New model
            </Button>
          </>
        }
      />
      <DataTable
        columns={columns}
        data={filtered}
        searchKey="slug"
        searchPlaceholder="Search slug..."
        exportFilename="models"
        pageSize={25}
        getRowId={(r) => r.id}
        initialColumnVisibility={{ vendor: true }}
        emptyTitle="No models"
        emptyDescription={rows.length ? "No models match the current filters." : "Create your first model or import a JSON catalog."}
        toolbar={
          <>
            <FilterSel label="Vendor" value={vendor} onChange={setVendor} options={vendors} />
            <FilterSel label="Status" value={status} onChange={setStatus} options={[...MODEL_STATUSES]} />
            <FilterSel label="Capability" value={capability} onChange={setCapability} options={[...MODEL_CAPABILITIES]} />
          </>
        }
      />

      <CreateModelDialog open={createOpen} onOpenChange={setCreateOpen} vendors={vendors} />
      <ModelImportDialog open={importOpen} onOpenChange={setImportOpen} />

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

function CreateModelDialog({ open, onOpenChange, vendors }: { open: boolean; onOpenChange: (o: boolean) => void; vendors: string[] }) {
  const router = useRouter();
  const { run, fieldErrors, pending } = useAction();
  const [f, setF] = useState({ slug: "", displayName: "", vendor: "", capabilities: ["chat"] as string[], inputPrice: "", outputPrice: "", status: "HIDDEN" });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New model"
      description="Create the public catalog entry first, then add routes (providers + your cost) on the next screen."
      submitLabel="Create & continue"
      pending={pending}
      onSubmit={async () => {
        const res = await run(() => createModel({ ...f, aliases: [] }), { refresh: false });
        if (res.ok && res.data) router.push(`/admin/models/${res.data.id}`);
        return res.ok;
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Public slug" placeholder="gpt-6-astra" value={f.slug} onChange={(e) => set("slug", e.target.value)} error={fieldErrors.slug} description="What customers put in `model`." />
        <TextField label="Display name" placeholder="GPT-6 Astra" value={f.displayName} onChange={(e) => set("displayName", e.target.value)} error={fieldErrors.displayName} />
        <TextField label="Vendor" list="vendor-options" placeholder="openai" value={f.vendor} onChange={(e) => set("vendor", e.target.value)} error={fieldErrors.vendor} />
        <datalist id="vendor-options">
          {vendors.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
        <SelectField label="Status" value={f.status} onChange={(v) => set("status", v)} options={MODEL_STATUSES.map((s) => ({ value: s, label: s }))} description="HIDDEN = callable but not listed." />
        <NumberField label="Sell input" suffix="USD / 1M tokens" value={f.inputPrice} onChange={(v) => set("inputPrice", v)} error={fieldErrors.inputPrice} min={0} />
        <NumberField label="Sell output" suffix="USD / 1M tokens" value={f.outputPrice} onChange={(v) => set("outputPrice", v)} error={fieldErrors.outputPrice} min={0} />
      </div>
      <MultiSelectField label="Capabilities" values={f.capabilities} onChange={(v) => set("capabilities", v)} options={MODEL_CAPABILITIES.map((c) => ({ value: c, label: c }))} error={fieldErrors.capabilities} />
    </FormDialog>
  );
}
