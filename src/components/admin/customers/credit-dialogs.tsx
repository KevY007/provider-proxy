"use client";

import { useState } from "react";
import { Gift } from "lucide-react";
import { TextField } from "@/components/common/form-fields";
import { Button } from "@/components/ui/button";
import { SelectField, TextAreaField } from "@/components/admin/fields";
import { FormDialog } from "@/components/admin/misc";
import { useAction } from "@/components/admin/use-action";
import { formatUSD } from "@/lib/money";
import { addCustomerCredit, grantCreditToCustomers } from "@/server/admin/customers-actions";
import { parseAdjustmentAmount } from "@/server/admin/customers-calc";
import { CREDIT_KIND_INFO, type CreditKind } from "@/server/admin/credits";

function useCreditForm(kinds: CreditKind[]) {
  const [kind, setKind] = useState<CreditKind>(kinds[0]);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const parsed = amount.trim() ? parseAdjustmentAmount(amount) : null;
  const signed = CREDIT_KIND_INFO[kind].signed;
  let amountError: string | undefined;
  if (parsed && !parsed.ok) amountError = parsed.error;
  else if (parsed?.ok && !signed && Number(parsed.amount) < 0) amountError = "Enter a positive amount (only a Correction can be negative)";
  const valid = parsed?.ok === true && !amountError && reason.trim().length >= 3;
  const reset = () => {
    setKind(kinds[0]);
    setAmount("");
    setReason("");
  };
  return { kind, setKind, amount, setAmount, reason, setReason, amountError, valid, reset, signed };
}

const kindOptions = (kinds: CreditKind[]) => kinds.map((k) => ({ value: k, label: CREDIT_KIND_INFO[k].label }));

/** Customer detail page: add credit with a type, an amount and a reason. */
export function AddCreditDialog({ userId, email, balance, disabled }: { userId: string; email: string; balance: string | number; disabled?: boolean }) {
  const { run, pending, fieldErrors } = useAction();
  const f = useCreditForm(["promotional", "refund", "correction"]);
  const [open, setOpen] = useState(false);
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) f.reset();
      }}
      title="Add credit"
      description={`For ${email}. Current balance: ${formatUSD(balance)}. The customer sees this in their billing history.`}
      submitLabel="Add credit"
      pending={pending}
      submitDisabled={!f.valid}
      trigger={
        <Button className="w-full" disabled={disabled}>
          <Gift className="size-4" /> Add credit
        </Button>
      }
      onSubmit={async () => {
        const r = await run(() => addCustomerCredit({ userId, kind: f.kind, amount: f.amount, reason: f.reason }));
        return r.ok;
      }}
    >
      <SelectField label="Type" value={f.kind} onChange={(v) => f.setKind(v as CreditKind)} options={kindOptions(["promotional", "refund", "correction"])} description={CREDIT_KIND_INFO[f.kind].hint} error={fieldErrors.kind} />
      <TextField label="Amount (USD)" value={f.amount} onChange={(e) => f.setAmount(e.target.value)} placeholder={f.signed ? "e.g. 25 or -10.50" : "e.g. 25"} inputMode="decimal" error={f.amountError ?? fieldErrors.amount} autoFocus />
      <TextAreaField label="Reason (required)" value={f.reason} onChange={f.setReason} rows={3} placeholder="Why is this credit being added?" error={fieldErrors.reason} />
    </FormDialog>
  );
}

/** Customers table bulk action: grant the same credit to every selected customer. */
export function GrantCreditDialog({ userIds, open, onOpenChange, onDone }: { userIds: string[]; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const { run, pending, fieldErrors } = useAction();
  const f = useCreditForm(["promotional", "refund"]);
  const n = userIds.length;
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) f.reset();
      }}
      title={`Grant credit to ${n} customer${n === 1 ? "" : "s"}`}
      description="Each selected customer receives the same amount. It appears in their billing history with the type and reason."
      submitLabel={`Grant to ${n}`}
      pending={pending}
      submitDisabled={!f.valid}
      onSubmit={async () => {
        const r = await run(() => grantCreditToCustomers({ userIds, kind: f.kind, amount: f.amount, reason: f.reason }), {
          onOk: () => onDone(),
        });
        return r.ok;
      }}
    >
      <SelectField label="Type" value={f.kind} onChange={(v) => f.setKind(v as CreditKind)} options={kindOptions(["promotional", "refund"])} description={CREDIT_KIND_INFO[f.kind].hint} error={fieldErrors.kind} />
      <TextField label="Amount per customer (USD)" value={f.amount} onChange={(e) => f.setAmount(e.target.value)} placeholder="e.g. 10" inputMode="decimal" error={f.amountError ?? fieldErrors.amount} autoFocus />
      <TextAreaField label="Reason (required)" value={f.reason} onChange={f.setReason} rows={3} placeholder="e.g. Launch week bonus" error={fieldErrors.reason ?? fieldErrors.userIds} />
    </FormDialog>
  );
}
