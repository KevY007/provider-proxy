"use client";

import { useState } from "react";
import { Megaphone, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState } from "@/components/common/empty-state";
import { TextField } from "@/components/common/form-fields";
import { SelectField, SwitchField, TextAreaField } from "@/components/admin/fields";
import { FormDialog } from "@/components/admin/misc";
import { useAction } from "@/components/admin/use-action";
import { createAnnouncement, deleteAnnouncement, setAnnouncementActive, updateAnnouncement } from "@/server/admin/settings-actions";
import { cn } from "@/lib/utils";

export interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  level: string;
  active: boolean;
  createdAt: string;
}

const LEVELS = [
  { value: "info", label: "Info" },
  { value: "success", label: "Success" },
  { value: "warning", label: "Warning" },
  { value: "error", label: "Error" },
];
const DOT: Record<string, string> = { info: "bg-sky-500", success: "bg-emerald-500", warning: "bg-amber-500", error: "bg-red-500" };

export function Announcements({ rows, canEdit }: { rows: AnnouncementRow[]; canEdit: boolean }) {
  const { run } = useAction();
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="size-4" /> Announcements
          </CardTitle>
          <CardDescription>Active announcements appear in the notification bell for every customer and admin.</CardDescription>
        </div>
        {canEdit && <AnnouncementDialog />}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState icon={Megaphone} title="No announcements" description="Post a maintenance notice or product update." className="py-8" />
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((a) => (
              <li key={a.id} className="flex items-start gap-3 p-3">
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[a.level] ?? "bg-muted-foreground", !a.active && "opacity-30")} />
                <div className={cn("min-w-0 flex-1", !a.active && "opacity-60")}>
                  <p className="text-sm font-medium">{a.title}</p>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{a.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground" suppressHydrationWarning>{new Date(a.createdAt).toLocaleString()}</p>
                </div>
                {canEdit && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch aria-label={a.active ? "Hide announcement" : "Show announcement"} checked={a.active} onCheckedChange={(v) => run(() => setAnnouncementActive(a.id, v))} />
                    <AnnouncementDialog row={a} />
                    <ConfirmDialog
                      destructive
                      title="Delete announcement?"
                      description={`"${a.title}" will be removed for everyone.`}
                      confirmLabel="Delete"
                      onConfirm={async () => {
                        const r = await run(() => deleteAnnouncement(a.id));
                        if (!r.ok) throw new Error(r.error);
                      }}
                      trigger={
                        <Button size="icon-sm" variant="ghost" aria-label="Delete announcement">
                          <Trash2 className="size-4" />
                        </Button>
                      }
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AnnouncementDialog({ row }: { row?: AnnouncementRow }) {
  const blank = { title: "", body: "", level: "info", active: true };
  const from = () => (row ? { title: row.title, body: row.body, level: row.level, active: row.active } : blank);
  const [state, setState] = useState(from);
  const [open, setOpen] = useState(false);
  const { run, pending, fieldErrors } = useAction();
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setState(from());
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        row ? (
          <Button size="icon-sm" variant="ghost" aria-label="Edit announcement">
            <Pencil className="size-4" />
          </Button>
        ) : (
          <Button size="sm">
            <Plus className="size-4" /> New announcement
          </Button>
        )
      }
      title={row ? "Edit announcement" : "New announcement"}
      submitLabel={row ? "Save" : "Publish"}
      pending={pending}
      onSubmit={async () => (await run(() => (row ? updateAnnouncement(row.id, state) : createAnnouncement(state)))).ok}
    >
      <TextField label="Title" value={state.title} onChange={(e) => setState((s) => ({ ...s, title: e.target.value }))} error={fieldErrors.title} required />
      <TextAreaField label="Message" value={state.body} onChange={(v) => setState((s) => ({ ...s, body: v }))} error={fieldErrors.body} rows={4} />
      <SelectField label="Level" value={state.level} onChange={(v) => setState((s) => ({ ...s, level: v }))} options={LEVELS} />
      <SwitchField label="Active" checked={state.active} onChange={(v) => setState((s) => ({ ...s, active: v }))} description="Inactive announcements are hidden but kept." />
    </FormDialog>
  );
}
