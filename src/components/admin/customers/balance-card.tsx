"use client";

import { useState } from "react";
import { Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUSD } from "@/lib/money";
import { MoneyText } from "@/components/common/money-text";
import { TextField } from "@/components/common/form-fields";
import { TextAreaField } from "@/components/admin/fields";
import { FormDialog, KV } from "@/components/admin/misc";
import { useAction } from "@/components/admin/use-action";
import { parseAdjustmentAmount } from "@/server/admin/customers-calc";
import { adjustCustomerBalance } from "@/server/admin/customers-actions";
import type { CustomerDetail } from "@/server/admin/customers-queries";
import { AddCreditDialog } from "./credit-dialogs";

export function BalanceCard({ user, isAdmin }: { user: CustomerDetail["user"]; isAdmin: boolean }) {
  const { run, pending, fieldErrors } = useAction();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const parsed = amount.trim() ? parseAdjustmentAmount(amount) : null;
  const amountError = parsed && !parsed.ok ? parsed.error : fieldErrors.amount;
  const valid = parsed?.ok === true && reason.trim().length >= 3;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Balance</CardTitle>
        <CardDescription>Adjustments are recorded in the ledger with your name and reason.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-3xl font-semibold tracking-tight">
          <MoneyText value={user.balance} colorize />
        </p>
        <div className="divide-y text-sm">
          <KV label="Billing mode">{user.billingMode === "POSTPAID" ? "Postpaid" : "Prepaid"}</KV>
          <KV label="Credit limit">
            <MoneyText value={user.creditLimit} />
          </KV>
          <KV label="Monthly spend limit">{user.monthlySpendLimit ? <MoneyText value={user.monthlySpendLimit} /> : "none"}</KV>
          <KV label="Auto-recharge">{user.autoRechargeEnabled ? "on" : "off"}</KV>
          <KV label="Stripe customer">{user.stripeCustomerId ? <code className="text-xs">{user.stripeCustomerId}</code> : "-"}</KV>
        </div>
        <AddCreditDialog userId={user.id} email={user.email} balance={user.balance} disabled={!isAdmin} />
        <FormDialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) {
              setAmount("");
              setReason("");
            }
          }}
          title="Adjust balance"
          description={`Positive amounts credit the account, negative amounts debit it. Current balance: ${formatUSD(user.balance)}`}
          submitLabel="Apply adjustment"
          pending={pending}
          submitDisabled={!valid}
          trigger={
            <Button variant="outline" className="w-full" disabled={!isAdmin}>
              <Scale className="size-4" /> Adjust balance
            </Button>
          }
          onSubmit={async () => {
            const r = await run(() => adjustCustomerBalance({ userId: user.id, amount, reason }));
            return r.ok;
          }}
        >
          <TextField label="Amount (USD)" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 25 or -10.50" inputMode="decimal" error={amountError} autoFocus />
          <TextAreaField label="Reason (required)" value={reason} onChange={setReason} rows={3} placeholder="Why is this adjustment being made?" error={fieldErrors.reason} />
        </FormDialog>
        {!isAdmin && <p className="text-xs text-muted-foreground">Only admins can adjust balances.</p>}
      </CardContent>
    </Card>
  );
}
