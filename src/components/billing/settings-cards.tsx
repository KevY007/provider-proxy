"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Gift, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { SubmitButton } from "@/components/common/form-fields";
import { formatUSD, toDecimal } from "@/lib/money";
import { redeemCodeAction, saveAutoRechargeAction, saveSpendControlsAction } from "@/server/billing/actions";
import { MoneyInput } from "./money-input";

const trimNum = (s: string) => {
  const d = toDecimal(s);
  return d.toFixed(2).replace(/\.00$/, "");
};

export function AutoRechargeCard({
  stripeConfigured,
  hasCard,
  initial,
  limits,
}: {
  stripeConfigured: boolean;
  hasCard: boolean;
  initial: { enabled: boolean; threshold: string; amount: string };
  limits: { minTopup: number; maxTopup: number; autoRechargeMaxPerDay: number };
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [threshold, setThreshold] = useState(trimNum(initial.threshold));
  const [amount, setAmount] = useState(trimNum(initial.amount));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const usable = stripeConfigured && hasCard;

  function save(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    start(async () => {
      const res = await saveAutoRechargeAction({ enabled, threshold, amount });
      if (res.ok) {
        toast.success(res.message ?? "Saved");
        router.refresh();
      } else {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RefreshCw className="size-4 text-muted-foreground" /> Auto-recharge
        </CardTitle>
        <CardDescription>
          Never get cut off mid-request. When your balance falls below the threshold we charge your default card automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} noValidate className="space-y-4" aria-label="Auto-recharge settings">
          {!usable && (
            <Alert>
              <AlertDescription>
                {stripeConfigured ? "Add a card to turn on auto-recharge." : "Auto-recharge needs card payments, which aren't enabled on this deployment yet."}
              </AlertDescription>
            </Alert>
          )}
          <Field orientation="horizontal">
            <Switch id="ar-enabled" checked={enabled && usable} onCheckedChange={setEnabled} disabled={!usable || pending} aria-label="Enable auto-recharge" />
            <FieldLabel htmlFor="ar-enabled">{enabled && usable ? "Auto-recharge is on" : "Auto-recharge is off"}</FieldLabel>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <MoneyInput label="When balance drops below" value={threshold} onChange={setThreshold} error={errors.threshold} disabled={!usable || pending} />
            <MoneyInput
              label="Add this much"
              value={amount}
              onChange={setAmount}
              error={errors.amount}
              disabled={!usable || pending}
              description={`${formatUSD(limits.minTopup)} - ${formatUSD(limits.maxTopup)}`}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            At most {limits.autoRechargeMaxPerDay} automatic recharges per 24 hours. After 3 failed attempts in a row, auto-recharge turns itself off and we email you.
          </p>
          <SubmitButton pending={pending} disabled={!usable}>
            Save auto-recharge
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}

export function SpendControlsCard({
  monthSpend,
  initial,
}: {
  monthSpend: string;
  initial: { monthlySpendLimit: string | null; lowBalanceAlertAt: string | null };
}) {
  const router = useRouter();
  const [limit, setLimit] = useState(initial.monthlySpendLimit ? trimNum(initial.monthlySpendLimit) : "");
  const [alertAt, setAlertAt] = useState(initial.lowBalanceAlertAt ? trimNum(initial.lowBalanceAlertAt) : "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  const spent = toDecimal(monthSpend);
  const limitNum = limit ? toDecimal(limit) : null;
  const pct = limitNum && limitNum.gt(0) ? Math.min(100, spent.div(limitNum).times(100).toNumber()) : 0;

  function save(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    start(async () => {
      const res = await saveSpendControlsAction({ monthlySpendLimit: limit, lowBalanceAlertAt: alertAt });
      if (res.ok) {
        toast.success(res.message ?? "Saved");
        router.refresh();
      } else {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Spend controls</CardTitle>
        <CardDescription>Set guardrails so a runaway script can&apos;t drain your balance.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} noValidate className="space-y-4" aria-label="Spend controls">
          <MoneyInput
            label="Monthly spend limit"
            value={limit}
            onChange={setLimit}
            error={errors.monthlySpendLimit}
            placeholder="No limit"
            disabled={pending}
            description="API requests are rejected once this month's spend reaches the limit. Leave empty for no limit."
          />
          {limitNum && limitNum.gt(0) && (
            <div className="space-y-1.5">
              <Progress value={pct} aria-label="Spend this month versus limit" />
              <p className="text-xs text-muted-foreground tabular-nums">
                {formatUSD(spent)} of {formatUSD(limitNum)} used this month
              </p>
            </div>
          )}
          <MoneyInput
            label="Low-balance alert"
            value={alertAt}
            onChange={setAlertAt}
            error={errors.lowBalanceAlertAt}
            placeholder="Use the auto-recharge threshold"
            disabled={pending}
            description="Email me when my balance falls below this amount (at most once a day)."
          />
          <SubmitButton pending={pending}>Save controls</SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}

export function RedeemCard() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (code.trim().length < 3) {
      setError("Enter a code");
      return;
    }
    start(async () => {
      const res = await redeemCodeAction({ code });
      if (res.ok) {
        toast.success(res.message ?? "Code redeemed");
        setCode("");
        router.refresh();
      } else {
        setError(res.fieldErrors?.code ?? res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gift className="size-4 text-muted-foreground" /> Redeem a code
        </CardTitle>
        <CardDescription>Got a promo or gift code? Enter it to add credit instantly.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-3" aria-label="Redeem code">
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor="redeem-code" className="sr-only">
              Code
            </FieldLabel>
            <Input
              id="redeem-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                if (error) setError(undefined);
              }}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              aria-invalid={!!error}
              disabled={pending}
            />
            {error ? <FieldError role="alert">{error}</FieldError> : <FieldDescription>Codes are case-insensitive and can be used once per account.</FieldDescription>}
          </Field>
          <SubmitButton pending={pending} disabled={!code.trim()}>
            Redeem
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}
