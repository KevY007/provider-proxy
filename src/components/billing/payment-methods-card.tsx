"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { CreditCard, Loader2, Plus, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState } from "@/components/common/empty-state";
import { SubmitButton } from "@/components/common/form-fields";
import {
  createSetupIntentAction,
  removeCardAction,
  setDefaultCardAction,
  syncSetupIntentAction,
} from "@/server/billing/actions";
import type { SavedCardRow } from "@/server/billing/types";

const stripeCache = new Map<string, Promise<Stripe | null>>();
function getStripeJs(pk: string) {
  let p = stripeCache.get(pk);
  if (!p) {
    p = loadStripe(pk);
    stripeCache.set(pk, p);
  }
  return p;
}

const BRAND_LABEL: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
};

export function PaymentMethodsCard({
  cards,
  cardsError,
  stripeConfigured,
}: {
  cards: SavedCardRow[];
  cardsError: string | null;
  stripeConfigured: boolean;
}) {
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  function makeDefault(id: string) {
    setBusyId(id);
    start(async () => {
      const res = await setDefaultCardAction(id);
      setBusyId(null);
      if (res.ok) {
        toast.success(res.message ?? "Default card updated");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  async function remove(id: string) {
    const res = await removeCardAction(id);
    if (res.ok) {
      toast.success(res.message ?? "Card removed");
      router.refresh();
    } else {
      toast.error(res.error);
      throw new Error(res.error); // keep the confirm dialog open
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment methods</CardTitle>
        <CardDescription>Cards are stored securely by Stripe. We never see your card number.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {cardsError && (
          <Alert variant="destructive">
            <AlertDescription>{cardsError}</AlertDescription>
          </Alert>
        )}
        {cards.length === 0 && !cardsError ? (
          <EmptyState
            icon={CreditCard}
            title="No cards saved"
            description={stripeConfigured ? "Add a card to top up in one click and enable auto-recharge." : "Card payments aren't enabled on this deployment yet."}
            className="py-8"
          />
        ) : (
          <ul className="divide-y rounded-lg border">
            {cards.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <CreditCard className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {BRAND_LABEL[c.brand] ?? c.brand} <span className="tabular-nums">&bull;&bull;&bull;&bull; {c.last4}</span>
                    {c.isDefault && <Badge variant="secondary">Default</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    Expires {String(c.expMonth).padStart(2, "0")}/{String(c.expYear).slice(-2)}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {!c.isDefault && (
                    <Button variant="ghost" size="sm" disabled={pending} onClick={() => makeDefault(c.id)}>
                      {busyId === c.id ? <Loader2 className="size-3.5 animate-spin" /> : <Star className="size-3.5" />}
                      Make default
                    </Button>
                  )}
                  <ConfirmDialog
                    destructive
                    title="Remove this card?"
                    description={
                      c.isDefault && cards.length === 1
                        ? "This is your only card. Removing it will turn off auto-recharge."
                        : `${BRAND_LABEL[c.brand] ?? c.brand} ending ${c.last4} will be removed from your account.`
                    }
                    confirmLabel="Remove card"
                    onConfirm={() => remove(c.id)}
                    trigger={
                      <Button variant="ghost" size="icon" aria-label={`Remove card ending ${c.last4}`} className="text-muted-foreground hover:text-destructive">
                        <Trash2 className="size-4" />
                      </Button>
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        <Button variant="outline" onClick={() => setAddOpen(true)} disabled={!stripeConfigured}>
          <Plus className="size-4" /> Add card
        </Button>
        <AddCardDialog open={addOpen} onOpenChange={setAddOpen} />
      </CardContent>
    </Card>
  );
}

function AddCardDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a card</DialogTitle>
          <DialogDescription>Your card is saved with Stripe for top-ups and auto-recharge.</DialogDescription>
        </DialogHeader>
        {/* mounted only while the dialog is open, so each open starts a fresh SetupIntent */}
        <AddCardContent onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function AddCardContent({ onClose }: { onClose: () => void }) {
  const [setup, setSetup] = useState<{ clientSecret: string; publishableKey: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let cancelled = false;
    createSetupIntentAction().then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) setSetup(res.data);
      else setError(res.ok ? "Could not start card setup" : res.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const stripePromise = useMemo(() => (setup ? getStripeJs(setup.publishableKey) : null), [setup]);

  if (error) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!setup || !stripePromise) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-2/3" />
      </div>
    );
  }
  return (
    <Elements
      stripe={stripePromise}
      options={{ clientSecret: setup.clientSecret, appearance: { theme: resolvedTheme === "dark" ? "night" : "stripe" } }}
    >
      <AddCardForm onDone={onClose} />
    </Elements>
  );
}

function AddCardForm({ onDone }: { onDone: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    const { error: err, setupIntent } = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
      confirmParams: { return_url: `${window.location.origin}/dashboard/billing` },
    });
    if (err || !setupIntent) {
      setError(err?.message ?? "We couldn't save that card.");
      setBusy(false);
      return;
    }
    const res = await syncSetupIntentAction({ setupIntentId: setupIntent.id });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    toast.success("Card saved");
    router.refresh();
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="Add card">
      <PaymentElement options={{ layout: "tabs" }} />
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <SubmitButton pending={busy} disabled={!stripe || !elements}>
          Save card
        </SubmitButton>
      </div>
    </form>
  );
}
