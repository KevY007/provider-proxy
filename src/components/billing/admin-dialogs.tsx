"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, Plus, Scale } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { CopyButton } from "@/components/common/copy-button";
import { SubmitButton, TextField } from "@/components/common/form-fields";
import { adjustBalanceAction, generateCodesAction } from "@/server/billing/admin-actions";

function downloadText(filename: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function GenerateCodesDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({ amount: "10", count: "1", maxUses: "1", expires: "", prefix: "", note: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<string[] | null>(null);
  const [pending, start] = useTransition();

  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [k]: e.target.value }));

  function reset() {
    setCreated(null);
    setErrors({});
    setFormError(null);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    start(async () => {
      const res = await generateCodesAction({
        amount: values.amount,
        count: values.count,
        maxUses: values.maxUses,
        expiresAt: values.expires ? `${values.expires}T23:59:59Z` : null,
        prefix: values.prefix || undefined,
        note: values.note || undefined,
      });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        setFormError(res.error);
        return;
      }
      setCreated(res.data?.codes ?? []);
      toast.success(res.message ?? "Codes generated");
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> Generate codes
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{created ? `${created.length} code${created.length === 1 ? "" : "s"} generated` : "Generate redeem codes"}</DialogTitle>
          <DialogDescription>
            {created ? "Copy them now or download a CSV. You can also find them in the list." : "Each code adds the amount to a customer's balance when redeemed."}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3">
            <Textarea readOnly value={created.join("\n")} rows={Math.min(10, Math.max(3, created.length))} className="font-mono text-xs" aria-label="Generated codes" />
            <div className="flex flex-wrap justify-end gap-2">
              <CopyButton value={created.join("\n")} label="Copy all" variant="outline" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => downloadText("redeem-codes.csv", `code,amount,max_uses\n${created.map((c) => `${c},${values.amount},${values.maxUses}`).join("\n")}\n`)}
              >
                <Download className="size-4" /> Download CSV
              </Button>
              <Button size="sm" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="space-y-4" aria-label="Generate redeem codes">
            {formError && !Object.keys(errors).length && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-3">
                <TextField label="Amount (USD)" inputMode="decimal" value={values.amount} onChange={set("amount")} error={errors.amount} />
                <TextField label="How many codes" inputMode="numeric" value={values.count} onChange={set("count")} error={errors.count} />
                <TextField label="Max uses each" inputMode="numeric" value={values.maxUses} onChange={set("maxUses")} error={errors.maxUses} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label="Expires (optional)" type="date" value={values.expires} onChange={set("expires")} error={errors.expiresAt} />
                <TextField label="Prefix (optional)" value={values.prefix} onChange={set("prefix")} placeholder="WELCOME" maxLength={12} error={errors.prefix} />
              </div>
              <TextField label="Note (optional)" value={values.note} onChange={set("note")} placeholder="Launch giveaway" maxLength={200} error={errors.note} />
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <SubmitButton pending={pending}>Generate</SubmitButton>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AdjustBalanceDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ customer: "", amount: "", reason: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    start(async () => {
      const res = await adjustBalanceAction(v);
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        setFormError(res.error);
        return;
      }
      toast.success(res.message ?? "Balance adjusted");
      setOpen(false);
      setV({ customer: "", amount: "", reason: "" });
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Scale className="size-4" /> Adjust balance
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manual balance adjustment</DialogTitle>
          <DialogDescription>Creates an ADJUSTMENT ledger entry and an audit log record. The customer sees the reason.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-4" aria-label="Adjust balance">
          {formError && !Object.keys(errors).length && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
          <FieldGroup>
            <TextField label="Customer email or ID" value={v.customer} onChange={(e) => setV({ ...v, customer: e.target.value })} placeholder="customer@example.com" autoComplete="off" error={errors.customer} />
            <TextField
              label="Amount (USD)"
              inputMode="decimal"
              value={v.amount}
              onChange={(e) => setV({ ...v, amount: e.target.value.replace(/[^\d.-]/g, "") })}
              placeholder="10.00 or -5.00"
              description="Positive adds credit, negative removes it."
              error={errors.amount}
            />
            <Field data-invalid={!!errors.reason}>
              <FieldLabel htmlFor="adjust-reason">Reason</FieldLabel>
              <Textarea id="adjust-reason" rows={3} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} placeholder="Goodwill credit for the March outage" aria-invalid={!!errors.reason} />
              {errors.reason ? <FieldError role="alert">{errors.reason}</FieldError> : <FieldDescription>Required. Stored in the ledger and audit log.</FieldDescription>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <SubmitButton pending={pending}>Apply adjustment</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
