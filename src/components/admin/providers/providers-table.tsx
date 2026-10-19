"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/common/data-table";
import { MoneyText } from "@/components/common/money-text";
import { StatusBadge } from "@/components/common/status-badge";
import { SelectField } from "@/components/admin/fields";
import { FormDialog, SlotBar } from "@/components/admin/misc";
import { useSlotSnapshot } from "@/components/admin/live-slots";
import { useAction } from "@/components/admin/use-action";
import { createProvider } from "@/server/admin/providers-actions";
import type { ProviderListRow } from "@/server/admin/providers-queries";
import type { ProviderPreset } from "@/gateway/providers/presets";
import type { SlotSnapshot } from "@/gateway/slots";
import { formatNumber, formatPercent } from "@/lib/utils";
import { emptyProviderForm, ProviderFormFields, providerPayload, type ProviderFormState } from "./provider-form";
import { ProviderProbe } from "./provider-probe";

export function ProvidersTable({ rows, presets, initialSlots, canEdit }: { rows: ProviderListRow[]; presets: ProviderPreset[]; initialSlots: SlotSnapshot; canEdit: boolean }) {
  const { snapshot } = useSlotSnapshot(initialSlots);
  const slotByProvider = useMemo(() => new Map(snapshot.providers.map((p) => [p.id, p])), [snapshot]);
  const keySlotSum = useMemo(() => {
    const m = new Map<string, { inUse: number; max: number | null }>();
    for (const k of snapshot.providerKeys) {
      const cur = m.get(k.providerId) ?? { inUse: 0, max: 0 };
      m.set(k.providerId, { inUse: cur.inUse + k.inUse, max: cur.max === null || k.max === null ? null : cur.max + k.max });
    }
    return m;
  }, [snapshot]);

  const columns: ColumnDef<ProviderListRow>[] = [
    {
      accessorKey: "name",
      header: "Provider",
      cell: ({ row }) => (
        <Link href={`/admin/providers/${row.original.id}`} className="font-medium hover:underline">
          {row.original.name}
          <span className="block font-mono text-xs font-normal text-muted-foreground">{row.original.slug}</span>
        </Link>
      ),
    },
    { accessorKey: "preset", header: "Preset", cell: ({ row }) => <span className="font-mono text-xs">{row.original.preset}</span> },
    { accessorKey: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    {
      accessorKey: "healthStatus",
      header: "Health",
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5">
          <StatusBadge status={row.original.healthStatus} />
          {row.original.lastLatencyMs != null && <span className="text-xs text-muted-foreground">{row.original.lastLatencyMs}ms</span>}
        </div>
      ),
    },
    {
      id: "keys",
      header: "Keys",
      accessorFn: (r) => r.keysTotal,
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.keysActive}
          <span className="text-muted-foreground"> / {row.original.keysTotal}</span>
        </span>
      ),
    },
    {
      id: "slots",
      header: "Slots",
      enableSorting: false,
      accessorFn: (r) => slotByProvider.get(r.id)?.inUse ?? keySlotSum.get(r.id)?.inUse ?? 0,
      meta: { className: "min-w-36" },
      cell: ({ row }) => {
        const p = slotByProvider.get(row.original.id);
        const k = keySlotSum.get(row.original.id);
        const inUse = p?.inUse ?? k?.inUse ?? 0;
        const max = row.original.maxConcurrency ?? p?.max ?? k?.max ?? null;
        return <SlotBar inUse={inUse} max={max} compact />;
      },
    },
    { accessorKey: "req24h", header: "Req 24h", meta: { className: "text-right" }, cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.req24h)}</span> },
    {
      accessorKey: "err24h",
      header: "Errors 24h",
      meta: { className: "text-right" },
      cell: ({ row }) => {
        const r = row.original;
        return (
          <span className={r.err24h ? "tabular-nums text-red-500" : "tabular-nums text-muted-foreground"}>
            {formatNumber(r.err24h)}
            {r.req24h > 0 && <span className="ml-1 text-xs">({formatPercent(r.err24h / r.req24h)})</span>}
          </span>
        );
      },
    },
    { accessorKey: "cost24h", header: "Cost 24h", meta: { className: "text-right" }, cell: ({ row }) => <MoneyText value={row.original.cost24h} /> },
  ];

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchKey="name"
      searchPlaceholder="Search providers..."
      exportFilename="providers"
      toolbar={canEdit ? <AddProviderDialog presets={presets} /> : undefined}
      emptyTitle="No providers yet"
      emptyDescription="Add an upstream provider, then add its API keys and route models to it."
      getRowId={(r) => r.id}
    />
  );
}

function AddProviderDialog({ presets }: { presets: ProviderPreset[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ProviderFormState>(emptyProviderForm());
  const { run, pending, fieldErrors, clearErrors } = useAction();
  const set = (patch: Partial<ProviderFormState>) => setState((s) => ({ ...s, ...patch }));

  function applyPreset(id: string) {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setState((s) => ({
      ...s,
      preset: id,
      name: s.name && s.preset !== id && s.name !== presets.find((x) => x.id === s.preset)?.name ? s.name : p.id === "custom" ? "" : p.name,
      baseUrl: p.baseUrl,
      authStyle: p.authStyle,
      formats: [...p.formats],
      settings: JSON.stringify(p.settings ?? {}, null, 2),
    }));
  }

  async function submit() {
    const res = await run(() => createProvider(providerPayload(state)), {
      refresh: false,
      onOk: (d) => {
        if (d?.id) router.push(`/admin/providers/${d.id}`);
      },
    });
    return res.ok;
  }

  const preset = presets.find((p) => p.id === state.preset);

  return (
    <FormDialog
      wide
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setState(emptyProviderForm());
          clearErrors();
        }
      }}
      trigger={
        <Button size="sm">
          <Plus className="size-4" /> Add provider
        </Button>
      }
      title="Add provider"
      description="Pick a preset to prefill the connection details, or choose Custom for any OpenAI-compatible endpoint. You add API keys on the next screen."
      submitLabel="Create provider"
      pending={pending}
      onSubmit={submit}
    >
      <SelectField
        label="Preset"
        value={state.preset}
        onChange={applyPreset}
        options={presets.map((p) => ({ value: p.id, label: p.name }))}
        description={preset?.description}
      />
      <ProviderFormFields state={state} set={set} errors={fieldErrors} />
      <ProviderProbe state={state} />
    </FormDialog>
  );
}
