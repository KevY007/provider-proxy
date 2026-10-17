"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { loadStripe } from "@stripe/stripe-js";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/common/form-fields";
import { formatUSD } from "@/lib/money";
import { validateTopupAmount } from "@/server/billing/amount";
import { confirmTopupAction, topUpAction } from "@/server/billing/actions";
import { cn } from "@/lib/utils";
import { MoneyInput } from "./money-input";

const PRESETS = [10, 25, 50, 100];

export function TopUpCard({
  stripeConfigured,
  limits,
  defaultCard,
}: {
  stripeConfigured: boolean;
  limits: { minTopup: number; maxTopup: number };
  defaultCard: { brand: string; last4: string } | null;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState("25");
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();
  const [phase, setPhase] = useState<"idle" | "verifying">("idle");

  const presets = PRESETS.filter((p) => p >= limits.minTopup && p <= limits.maxTopup);

  function validate(): string | null {
    const r = validateTopupAmount(amount, { min: limits.minTopup, max: limits.maxTopup });
    if (!r.ok) {
      setError(r.error);
      return null;
    }
    setError(undefined);
    return r.amount.toString();
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = validate();
    if (!value) return;
    start(async () => {
      const res = await topUpAction({ amount: value });
      if (!res.ok) {
        setError(res.fieldErrors?.amount);
        toast.error(res.error);
        return;
      }
      const d = res.data!;
      if (d.status === "checkout") {
        toast.message("Redirecting to secure checkout...");
        window.location.assign(d.url);
        return;
      }
      if (d.status === "requires_action") {
        setPhase("verifying");
        try {
          const stripe = await loadStripe(d.publishableKey);
          if (!stripe) throw new Error("Stripe failed to load");
          const next = await stripe.handleNextAction({ clientSecret: d.clientSecret });
          if (next.error) {
            toast.error(next.error.message ?? "Your bank could not verify this payment.");
            // Let the server record the failed attempt.
            await confirmTopupAction({ paymentIntentId: d.paymentIntentId });
          } else {
            const confirmed = await confirmTopupAction({ paymentIntentId: d.paymentIntentId });
            if (confirmed.ok) toast.success(confirmed.message ?? "Payment received");
            else toast.error(confirmed.error);
          }
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Verification failed");
        } finally {
          setPhase("idle");
          router.refresh();
        }
        return;
      }
      toast.success(res.message ?? "Payment received");
      router.refresh();
    });
  }

  const busy = pending || phase === "verifying";
  const parsed = validateTopupAmount(amount, { min: limits.minTopup, max: limits.maxTopup });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add credit</CardTitle>
        <CardDescription>
          {defaultCard ? (
            <>
              Charged to your default card <span className="font-medium capitalize">{defaultCard.brand}</span> ending {defaultCard.last4}.
            </>
          ) : (
            "You'll complete the payment on Stripe's secure checkout page."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4" aria-label="Top up balance">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Preset amounts">
            {presets.map((p) => (
              <Button
                key={p}
                type="button"
                variant={amount === String(p) ? "default" : "outline"}
                aria-pressed={amount === String(p)}
                disabled={!stripeConfigured || busy}
                onClick={() => {
                  setAmount(String(p));
                  setError(undefined);
                }}
                className={cn("min-w-16")}
              >
                ${p}
              </Button>
            ))}
          </div>
          <MoneyInput
            label="Amount"
            value={amount}
            onChange={(v) => {
              setAmount(v);
              if (error) setError(undefined);
            }}
            onBlur={() => amount && validate()}
            error={error}
            disabled={!stripeConfigured || busy}
            description={`Between ${formatUSD(limits.minTopup)} and ${formatUSD(limits.maxTopup)}.`}
          />
          <SubmitButton pending={busy} disabled={!stripeConfigured || !parsed.ok} className="w-full">
            <Plus className="size-4" />
            {phase === "verifying" ? "Waiting for your bank..." : parsed.ok ? `Add ${formatUSD(parsed.amount)}` : "Add credit"}
          </SubmitButton>
          {!stripeConfigured && (
            <p className="text-xs text-muted-foreground">Card payments aren&apos;t enabled on this deployment yet. You can still redeem a code below.</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
