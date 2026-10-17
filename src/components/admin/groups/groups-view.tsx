"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataTable } from "@/components/common/data-table";
import { PageHeader } from "@/components/common/page-header";
import { TextField } from "@/components/common/form-fields";
import { StatusBadge } from "@/components/common/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CheckField, MultiSelectField, NumberField, SwitchField, TagsField, TextAreaField } from "@/components/admin/fields";
import { FormDialog } from "@/components/admin/misc";
import { useAction } from "@/components/admin/use-action";
import { createGroup, deleteGroup, setDefaultGroup, updateGroup } from "@/server/admin/groups-actions";
import type { GroupRow } from "@/server/admin/groups-queries";
import { slugify } from "@/lib/utils";

interface Options {
  models: Array<{ value: string; label: string; hint?: string }>;
  providerTags: string[];
}

export function GroupsView({ rows, options }: { rows: GroupRow[]; options: Options }) {
  const { run } = useAction();
  const [editing, setEditing] = useState<GroupRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<GroupRow | null>(null);
  const [reassign, setReassign] = useState(false);

  const columns: ColumnDef<GroupRow>[] = [
    {
      accessorKey: "name",
      header: "Group",
      cell: ({ row: { original: g } }) => (
        <button type="button" className="text-left hover:underline" onClick={() => setEditing(g)}>
          <span className="flex items-center gap-2 font-medium">
            {g.name}
            {g.isDefault && (
              <Badge variant="outline" className="gap-1 text-[10px]">
                <Star className="size-3" /> default
              </Badge>
            )}
          </span>
          <span className="block font-mono text-xs text-muted-foreground">{g.slug}</span>
        </button>
      ),
    },
    { accessorKey: "priceMultiplier", header: "Multiplier", cell: ({ row }) => <span className="tabular-nums">{Number(row.original.priceMultiplier)}×</span> },
    {
      id: "visibility",
      header: "Visibility",
      accessorFn: (g) => (g.isPublic ? "public" : "private"),
      cell: ({ row }) => <StatusBadge status={row.original.isPublic ? "ACTIVE" : "DISABLED"} label={row.original.isPublic ? "Public" : "Private"} />,
    },
    {
      id: "tags",
      header: "Provider tags",
      accessorFn: (g) => g.providerTags.join(" "),
      cell: ({ row }) =>
        row.original.providerTags.length ? (
          <div className="flex max-w-48 flex-wrap gap-1">
            {row.original.providerTags.map((t) => (
              <Badge key={t} variant="secondary" className="text-[10px]">
                {t}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">any</span>
        ),
    },
    {
      id: "models",
      header: "Allowed models",
      accessorFn: (g) => g.allowedModels.length,
      cell: ({ row }) => (row.original.allowedModels.length ? `${row.original.allowedModels.length} models` : <span className="text-xs text-muted-foreground">all</span>),
    },
    { id: "rpm", header: "RPM", accessorFn: (g) => g.rpmLimit || "", cell: ({ row }) => row.original.rpmLimit || <span className="text-muted-foreground">-</span> },
    { id: "conc", header: "Concurrency", accessorFn: (g) => g.maxConcurrency || "", cell: ({ row }) => row.original.maxConcurrency || <span className="text-muted-foreground">-</span> },
    { accessorKey: "users", header: "Customers", meta: { className: "text-right" } },
    { accessorKey: "apiKeys", header: "API keys", meta: { className: "text-right" } },
    { accessorKey: "sortOrder", header: "Order" },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      meta: { noExport: true, className: "w-10" },
      cell: ({ row: { original: g } }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${g.name}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditing(g)}>
              <Pencil className="size-4" /> Edit
            </DropdownMenuItem>
            {!g.isDefault && (
              <DropdownMenuItem onSelect={() => run(() => setDefaultGroup(g.id))}>
                <Star className="size-4" /> Make default
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={g.isDefault}
              onSelect={() => {
                setReassign(false);
                setDeleting(g);
              }}
            >
              <Trash2 className="size-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const inUse = deleting ? deleting.users + deleting.apiKeys : 0;

  return (
    <>
      <PageHeader
        title="Groups"
        description="Pools / pricing tiers. A group's multiplier scales model sell prices, and it can restrict models, provider tags and rate limits."
        actions={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="size-4" /> New group
          </Button>
        }
      />
      <DataTable
        columns={columns}
        data={rows}
        searchKey="name"
        searchPlaceholder="Search groups..."
        exportFilename="groups"
        getRowId={(g) => g.id}
        emptyTitle="No groups"
        emptyDescription="Create a group to price and restrict customers."
        hideColumnToggle
      />

      {editing && <GroupDialog key={editing === "new" ? "new" : editing.id} group={editing === "new" ? null : editing} options={options} onClose={() => setEditing(null)} />}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete group ${deleting?.name ?? ""}?`}
        description={
          inUse > 0 ? (
            <div className="space-y-3">
              <p>
                {deleting?.users} customer(s) and {deleting?.apiKeys} API key(s) use this group. They must be moved to the default group before it can be deleted.
              </p>
              <CheckField label="Move them to the default group" checked={reassign} onChange={setReassign} />
            </div>
          ) : (
            "No customers or API keys use this group. Route pool restrictions that mention it are cleaned up."
          )
        }
        confirmLabel="Delete group"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const res = await run(() => deleteGroup(deleting.id, reassign));
          if (!res.ok) throw new Error(res.error);
        }}
      />
    </>
  );
}

function GroupDialog({ group, options, onClose }: { group: GroupRow | null; options: Options; onClose: () => void }) {
  const { run, fieldErrors, pending } = useAction();
  const [slugTouched, setSlugTouched] = useState(!!group);
  const [f, setF] = useState({
    name: group?.name ?? "",
    slug: group?.slug ?? "",
    description: group?.description ?? "",
    priceMultiplier: group?.priceMultiplier ?? "1",
    providerTags: group?.providerTags ?? ([] as string[]),
    allowedModels: group?.allowedModels ?? ([] as string[]),
    isDefault: group?.isDefault ?? false,
    isPublic: group?.isPublic ?? true,
    rpmLimit: group?.rpmLimit ?? "",
    maxConcurrency: group?.maxConcurrency ?? "",
    sortOrder: String(group?.sortOrder ?? 0),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title={group ? `Edit ${group.name}` : "New group"}
      description={group ? `${group.users} customers and ${group.apiKeys} API keys use this group.` : "Customers and API keys are assigned to a group (pool)."}
      submitLabel={group ? "Save group" : "Create group"}
      pending={pending}
      onSubmit={async () => (group ? await run(() => updateGroup(group.id, f)) : await run(() => createGroup(f))).ok}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          value={f.name}
          onChange={(e) => {
            set("name", e.target.value);
            if (!slugTouched) set("slug", slugify(e.target.value));
          }}
          error={fieldErrors.name}
        />
        <TextField
          label="Slug"
          className="font-mono"
          value={f.slug}
          onChange={(e) => {
            setSlugTouched(true);
            set("slug", e.target.value);
          }}
          error={fieldErrors.slug}
          description={group ? "Renaming updates route pool restrictions." : undefined}
        />
        <NumberField label="Price multiplier" suffix="×" value={f.priceMultiplier} onChange={(v) => set("priceMultiplier", v)} error={fieldErrors.priceMultiplier} description="Applied to model sell prices (0.8 = 20% off, 1.2 = 20% markup)." min={0} />
        <NumberField label="Sort order" step="1" value={f.sortOrder} onChange={(v) => set("sortOrder", v)} error={fieldErrors.sortOrder} />
        <NumberField label="RPM limit" step="1" min={1} value={f.rpmLimit} onChange={(v) => set("rpmLimit", v)} error={fieldErrors.rpmLimit} placeholder="unlimited" description="Requests per minute per customer key in this group." />
        <NumberField label="Max concurrency" step="1" min={1} value={f.maxConcurrency} onChange={(v) => set("maxConcurrency", v)} error={fieldErrors.maxConcurrency} placeholder="default" description="Concurrent request slots (blank = global default)." />
      </div>
      <TextAreaField label="Description" value={f.description} onChange={(v) => set("description", v)} rows={2} error={fieldErrors.description} />
      <TagsField
        label="Provider tags"
        values={f.providerTags}
        onChange={(v) => set("providerTags", v)}
        description={
          <>
            Only routes whose provider has any of these tags are used. Empty = any provider.
            {options.providerTags.length > 0 && <> Known tags: {options.providerTags.join(", ")}.</>}
          </>
        }
      />
      <MultiSelectField label="Allowed models" values={f.allowedModels} onChange={(v) => set("allowedModels", v)} options={options.models} placeholder="All public models" description="Empty = every public model." error={fieldErrors.allowedModels} />
      <div className="grid gap-3 sm:grid-cols-2">
        <SwitchField label="Public" checked={f.isPublic} onChange={(v) => set("isPublic", v)} description="Customers may pick it for their API keys." />
        <SwitchField
          label="Default group"
          checked={f.isDefault}
          onChange={(v) => set("isDefault", v)}
          disabled={group?.isDefault}
          description={group?.isDefault ? "To change the default, make another group the default." : "New customers land here. Replaces the current default."}
        />
      </div>
    </FormDialog>
  );
}
