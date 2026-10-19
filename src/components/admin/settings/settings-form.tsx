"use client";

import { useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAction } from "@/components/admin/use-action";
import { saveSettings } from "@/server/admin/settings-actions";

export interface SettingField {
  key: string;
  label: string;
  description: string;
  group: string;
  type: "boolean" | "number" | "string";
  value: boolean | number | string;
  default: boolean | number | string;
}

const GROUPS: Array<{ id: string; title: string; description: string }> = [
  { id: "general", title: "General", description: "Branding and contact details." },
  { id: "access", title: "Access", description: "Who can sign up and how they verify." },
  { id: "billing", title: "Billing", description: "Trial credit, top-up limits and balance rules." },
  { id: "gateway", title: "Gateway", description: "Routing, retries, concurrency and logging." },
  { id: "monitoring", title: "Monitoring and background work", description: "Off by default: the server only does work while it handles calls, so an idle deployment costs (almost) nothing. Turn these on for 24/7 uptime checks and timed jobs." },
];

export function SettingsForm({ fields, canEdit }: { fields: SettingField[]; canEdit: boolean }) {
  const init = Object.fromEntries(fields.map((f) => [f.key, f.type === "number" ? String(f.value) : f.value])) as Record<string, string | boolean>;
  const [values, setValues] = useState<Record<string, string | boolean>>(init);
  const { run, pending, fieldErrors } = useAction();
  const dirtyKeys = fields.filter((f) => String(values[f.key]) !== String(init[f.key])).map((f) => f.key);
  const dirty = dirtyKeys.length > 0;

  // client-side hint for obviously bad numbers; the server validates against each key's zod schema
  const localError = (f: SettingField): string | undefined => {
    if (f.type !== "number") return undefined;
    const v = values[f.key] as string;
    if (v.trim() === "" || Number.isNaN(Number(v))) return "Must be a number";
    return undefined;
  };
  const hasLocalErrors = fields.some((f) => localError(f));

  async function save() {
    const payload = Object.fromEntries(dirtyKeys.map((k) => [k, values[k]]));
    await run(() => saveSettings(payload));
  }

  return (
    <div className="space-y-6">
      {GROUPS.map((g) => {
        const gf = fields.filter((f) => f.group === g.id);
        if (!gf.length) return null;
        return (
          <Card key={g.id}>
            <CardHeader>
              <CardTitle className="text-base">{g.title}</CardTitle>
              <CardDescription>{g.description}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              {gf.map((f) => {
                const err = fieldErrors[f.key] ?? (String(values[f.key]) !== String(init[f.key]) ? localError(f) : undefined);
                if (f.type === "boolean") {
                  return (
                    <div key={f.key} className="flex items-start justify-between gap-3 rounded-lg border p-3 sm:col-span-1">
                      <div className="space-y-0.5">
                        <label htmlFor={`s-${f.key}`} className="text-sm font-medium leading-none">
                          {f.label}
                        </label>
                        <p className="text-xs text-muted-foreground">{f.description}</p>
                        {err && <p className="text-xs text-destructive">{err}</p>}
                      </div>
                      <Switch id={`s-${f.key}`} checked={Boolean(values[f.key])} onCheckedChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} disabled={!canEdit || pending} />
                    </div>
                  );
                }
                return (
                  <Field key={f.key} data-invalid={!!err}>
                    <FieldLabel htmlFor={`s-${f.key}`}>{f.label}</FieldLabel>
                    <Input
                      id={`s-${f.key}`}
                      type={f.type === "number" ? "number" : "text"}
                      step="any"
                      value={String(values[f.key])}
                      onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
                      disabled={!canEdit || pending}
                      aria-invalid={!!err}
                      className={f.type === "number" ? "tabular-nums" : undefined}
                    />
                    {err ? <FieldError role="alert">{err}</FieldError> : <FieldDescription>{f.description}</FieldDescription>}
                  </Field>
                );
              })}
            </CardContent>
          </Card>
        );
      })}
      {canEdit ? (
        <div className="sticky bottom-4 z-10 flex items-center justify-end gap-3 rounded-xl border bg-background/95 p-3 shadow-sm backdrop-blur">
          <span className="text-sm text-muted-foreground">{dirty ? `${dirtyKeys.length} unsaved change${dirtyKeys.length === 1 ? "" : "s"}` : "All changes saved"}</span>
          <Button variant="outline" disabled={!dirty || pending} onClick={() => setValues(init)}>
            Discard
          </Button>
          <Button disabled={!dirty || pending || hasLocalErrors} onClick={save}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save settings
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Only administrators can change settings.</p>
      )}
    </div>
  );
}
