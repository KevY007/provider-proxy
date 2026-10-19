import { notFound } from "next/navigation";
import { CreditCard } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/common/page-header";
import { BalanceHero } from "@/components/billing/balance-hero";
import { CheckoutReturn } from "@/components/billing/checkout-return";
import { LedgerTable, PaymentsTable } from "@/components/billing/history-tables";
import { PaymentMethodsCard } from "@/components/billing/payment-methods-card";
import { AutoRechargeCard, RedeemCard, SpendControlsCard } from "@/components/billing/settings-cards";
import { TopUpCard } from "@/components/billing/topup-card";
import { requireUser } from "@/lib/auth/session";
import { getCustomerBillingData } from "@/server/billing/queries";

export const metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ topup?: string; session_id?: string; setup_intent?: string }>;
}) {
  const { user } = await requireUser();
  const [data, sp] = await Promise.all([getCustomerBillingData(user.id), searchParams]);
  if (!data) notFound();

  const defaultCard = data.cards.find((c) => c.isDefault) ?? null;
  const stripeOn = data.stripe.configured;

  return (
    <div className="space-y-6">
      <CheckoutReturn topup={sp.topup} sessionId={sp.session_id} setupIntent={sp.setup_intent} />
      <PageHeader title="Billing" description="Your balance, payment methods and transaction history." />

      {!stripeOn && (
        <Alert>
          <CreditCard className="size-4" />
          <AlertTitle>Card payments aren&apos;t set up yet</AlertTitle>
          <AlertDescription>
            Adding cards, top-ups and auto-recharge are unavailable on this deployment until Stripe is configured. You can still redeem a code to add credit.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <BalanceHero
            balance={data.balance}
            creditLimit={data.creditLimit}
            billingMode={data.billingMode}
            monthSpend={data.monthSpend}
            monthSpendLimit={data.monthSpendLimit}
          />
        </div>
        <RedeemCard />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <TopUpCard
          stripeConfigured={stripeOn}
          limits={{ minTopup: data.limits.minTopup, maxTopup: data.limits.maxTopup }}
          defaultCard={defaultCard ? { brand: defaultCard.brand, last4: defaultCard.last4 } : null}
        />
        <PaymentMethodsCard cards={data.cards} cardsError={data.cardsError} stripeConfigured={stripeOn} />
        <AutoRechargeCard stripeConfigured={stripeOn} hasCard={data.hasDefaultCard} initial={data.autoRecharge} limits={data.limits} />
        <SpendControlsCard
          monthSpend={data.monthSpend}
          initial={{ monthlySpendLimit: data.monthSpendLimit, lowBalanceAlertAt: data.lowBalanceAlertAt }}
        />
      </div>

      <Card>
        <CardContent className="p-4 sm:p-6">
          <Tabs defaultValue="transactions">
            <TabsList>
              <TabsTrigger value="transactions">Transactions</TabsTrigger>
              <TabsTrigger value="payments">Payments</TabsTrigger>
            </TabsList>
            <TabsContent value="transactions" className="pt-4">
              <LedgerTable rows={data.ledger} exportName="transactions" />
            </TabsContent>
            <TabsContent value="payments" className="pt-4">
              <PaymentsTable rows={data.payments} exportName="payments" />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
