import { AlertTriangle, Banknote, Hourglass, Landmark, Scale, TrendingUp } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { MoneyText } from "@/components/common/money-text";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { AdjustBalanceDialog } from "@/components/billing/admin-dialogs";
import { AdminBillingView, type AdminFilters } from "@/components/billing/admin-billing-view";
import { requireAdmin } from "@/lib/auth/session";
import { getAdminBillingData } from "@/server/billing/queries";

export const metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

type SP = { tab?: string; status?: string; kind?: string; ltype?: string; q?: string };

export default async function AdminBillingPage({ searchParams }: { searchParams: Promise<SP> }) {
  const { user } = await requireAdmin();
  const sp = await searchParams;
  const tab: AdminFilters["tab"] = sp.tab === "ledger" || sp.tab === "codes" ? sp.tab : "payments";
  const filters: AdminFilters = { tab, status: sp.status, kind: sp.kind, ltype: sp.ltype, q: sp.q?.slice(0, 120) };
  const data = await getAdminBillingData({ status: sp.status, kind: sp.kind, ledgerType: sp.ltype, q: sp.q?.slice(0, 120) });
  const canMutate = user.role === "ADMIN";
  const k = data.kpis;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        description="Payments, balance ledger, redeem codes and manual adjustments."
        actions={canMutate ? <AdjustBalanceDialog /> : undefined}
      />

      {!data.stripe.configured && (
        <Alert>
          <AlertTriangle className="size-4" />
          <AlertTitle>Stripe is not configured</AlertTitle>
          <AlertDescription>
            Set STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY and STRIPE_WEBHOOK_SECRET to enable card payments. Redeem codes and manual adjustments work without it.
          </AlertDescription>
        </Alert>
      )}
      {data.stripe.configured && !data.stripe.webhookConfigured && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Stripe webhook secret missing</AlertTitle>
          <AlertDescription>
            Without STRIPE_WEBHOOK_SECRET, refunds, disputes and asynchronous payment results are not recorded. Point a Stripe webhook at /api/stripe/webhook.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Revenue"
          icon={Banknote}
          value={<MoneyText value={k.revenueAllTime} />}
          hint={
            <>
              <MoneyText value={k.revenueMonth} /> this month
            </>
          }
        />
        <StatCard
          label="Refunds & chargebacks"
          icon={TrendingUp}
          invertTrend
          value={<MoneyText value={Number(k.refunds) + Number(k.chargebacks)} />}
          hint={
            <>
              <MoneyText value={k.refunds} /> refunded &middot; <MoneyText value={k.chargebacks} /> disputed
            </>
          }
        />
        <StatCard
          label="Postpaid outstanding"
          icon={Landmark}
          value={<MoneyText value={k.outstandingPostpaid} />}
          hint={`${k.postpaidCustomers} customer${k.postpaidCustomers === 1 ? "" : "s"} in the red`}
        />
        <StatCard
          label="Customer balances"
          icon={Scale}
          value={<MoneyText value={k.customerLiability} />}
          hint={`Liability across ${k.customersWithBalance} account${k.customersWithBalance === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Pending payments"
          icon={Hourglass}
          value={String(k.pendingPayments)}
          hint={k.pendingPayments ? "Reconciled hourly by cron" : "Nothing in flight"}
        />
      </div>

      <AdminBillingView filters={filters} payments={data.payments} ledger={data.ledger} codes={data.codes} canMutate={canMutate} />
    </div>
  );
}
