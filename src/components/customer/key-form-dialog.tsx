"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton, TextField } from "@/components/common/form-fields";
import { createKeyAction, updateKeyAction, type CreatedKey } from "@/server/customer/keys";
import { parseIpList } from "@/server/customer/key-schemas";
import { formatMultiplier } from "@/server/customer/pricing";
import type { KeyRow, PoolOption } from "@/server/customer/portal-data";
import { ModelMultiSelect } from "./model-multi-select";
import type { ModelOption } from "./snippet-tabs";

const DEFAULT_POOL = "__default";

interface FormState {
  name: string;
  groupId: string;
  allowedModels: string[];
  rpm: string;
  tpm: string;
  conc: string;
  spend: string;
  expires: string; // yyyy-mm-dd
  ips: string;
}

function initial(k?: KeyRow | null): FormState {
  return {
    name: k?.name ?? "",
    groupId: k?.groupId ?? DEFAULT_POOL,
    allowedModels: k?.allowedModels ?? [],
    rpm: k?.rpmLimit?.toString() ?? "",
    tpm: k?.tpmLimit?.toString() ?? "",
    conc: k?.maxConcurrency?.toString() ?? "",
    spend: k?.spendLimit ? trimNum(k.spendLimit) : "",
    expires: k?.expiresAt ? k.expiresAt.slice(0, 10) : "",
    ips: k?.ipAllowlist.join("\n") ?? "",
  };
}

const trimNum = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

function numOrNull(s: string): number | null | "invalid" {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : "invalid";
}

export interface KeyFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create mode. */
  editing: KeyRow | null;
  pools: PoolOption[];
  currentPool: PoolOption | null;
  models: ModelOption[];
  onCreated: (key: CreatedKey, meta: { name: string; allowedModels: string[] }) => void;
}

export function KeyFormDialog({ open, onOpenChange, editing, pools, currentPool, models, onCreated }: KeyFormDialogProps) {
  // Remount the body whenever the dialog opens/target changes so state resets without effects.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <KeyFormBody key={editing?.id ?? "new"} editing={editing} pools={pools} currentPool={currentPool} models={models} onClose={() => onOpenChange(false)} onCreated={onCreated} />}
    </Dialog>
  );
}

function KeyFormBody({ editing, pools, currentPool, models, onClose, onCreated }: Omit<KeyFormDialogProps, "open" | "onOpenChange"> & { onClose: () => void }) {
  const [f, setF] = useState<FormState>(() => initial(editing));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const rpm = numOrNull(f.rpm);
    const tpm = numOrNull(f.tpm);
    const conc = numOrNull(f.conc);
    const spend = numOrNull(f.spend);
    if (rpm === "invalid") errs.rpmLimit = "Enter a number";
    if (tpm === "invalid") errs.tpmLimit = "Enter a number";
    if (conc === "invalid") errs.maxConcurrency = "Enter a number";
    if (spend === "invalid") errs.spendLimit = "Enter a number";
    if (Object.keys(errs).length) return setErrors(errs);
    // expiry = end of the chosen day, local time
    const expiresAt = f.expires ? new Date(`${f.expires}T23:59:59`).toISOString() : null;
    const payload = {
      name: f.name,
      groupId: f.groupId === DEFAULT_POOL ? null : f.groupId,
      allowedModels: f.allowedModels,
      rpmLimit: rpm as number | null,
      tpmLimit: tpm as number | null,
      maxConcurrency: conc as number | null,
      spendLimit: spend as number | null,
      expiresAt,
      ipAllowlist: parseIpList(f.ips),
    };
    start(async () => {
      setErrors({});
      if (editing) {
        const r = await updateKeyAction({ id: editing.id, ...payload });
        if (r.ok) {
          toast.success(r.message ?? "Key updated");
          onClose();
        } else {
          setErrors(r.fieldErrors ?? {});
          toast.error(r.error);
        }
      } else {
        const r = await createKeyAction(payload);
        if (r.ok && r.data) {
          onCreated(r.data, { name: payload.name.trim(), allowedModels: payload.allowedModels });
          onClose();
        } else if (!r.ok) {
          setErrors(r.fieldErrors ?? {});
          toast.error(r.error);
        }
      }
    });
  }

  return (
    <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{editing ? "Edit API key" : "Create API key"}</DialogTitle>
        <DialogDescription>
          {editing ? "Changes apply immediately. The secret itself can't be changed." : "Limits are optional. You can edit them later."}
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-5">
        <FieldGroup className="gap-4">
          <TextField label="Name" placeholder="e.g. Production backend" value={f.name} onChange={(e) => set("name", e.target.value)} error={errors.name} maxLength={60} autoFocus required />

          <Field data-invalid={!!errors.groupId}>
            <FieldLabel>Pool</FieldLabel>
            <Select value={f.groupId} onValueChange={(v) => set("groupId", v)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_POOL}>
                  {currentPool ? `Account default - ${currentPool.name} ${formatMultiplier(currentPool.multiplier)}` : "Account default"}
                </SelectItem>
                {pools.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} pool - {formatMultiplier(p.multiplier)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Pools set the price multiplier applied to this key&apos;s usage.</FieldDescription>
            {errors.groupId && <FieldError>{errors.groupId}</FieldError>}
          </Field>

          <Field data-invalid={!!errors.allowedModels}>
            <FieldLabel>Allowed models</FieldLabel>
            <ModelMultiSelect models={models} value={f.allowedModels} onChange={(v) => set("allowedModels", v)} />
            <FieldDescription>Restrict this key to specific models. Leave empty to allow everything your pool offers.</FieldDescription>
            {errors.allowedModels && <FieldError>{errors.allowedModels}</FieldError>}
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <TextField label="Requests / min" inputMode="numeric" placeholder="Unlimited" value={f.rpm} onChange={(e) => set("rpm", e.target.value)} error={errors.rpmLimit} />
            <TextField label="Tokens / min" inputMode="numeric" placeholder="Unlimited" value={f.tpm} onChange={(e) => set("tpm", e.target.value)} error={errors.tpmLimit} />
            <TextField label="Max concurrency" inputMode="numeric" placeholder="Default" value={f.conc} onChange={(e) => set("conc", e.target.value)} error={errors.maxConcurrency} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Spend limit (USD)" inputMode="decimal" placeholder="No limit" value={f.spend} onChange={(e) => set("spend", e.target.value)} error={errors.spendLimit} description="Lifetime cap for this key." />
            <TextField label="Expires" type="date" value={f.expires} onChange={(e) => set("expires", e.target.value)} error={errors.expiresAt} min={new Date().toISOString().slice(0, 10)} description="Optional. Key stops working after this day." />
          </div>

          <Field data-invalid={!!errors.ipAllowlist}>
            <FieldLabel htmlFor="ip-allow">IP allowlist</FieldLabel>
            <Textarea id="ip-allow" rows={3} placeholder={"203.0.113.7\n10.0.0.0/8"} value={f.ips} onChange={(e) => set("ips", e.target.value)} className="font-mono text-xs" />
            <FieldDescription>One IP or CIDR per line. Empty allows any IP.</FieldDescription>
            {errors.ipAllowlist && <FieldError>{errors.ipAllowlist}</FieldError>}
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <SubmitButton pending={pending}>{editing ? "Save changes" : "Create key"}</SubmitButton>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
