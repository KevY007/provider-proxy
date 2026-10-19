import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { BalanceCard } from "@/components/admin/customers/balance-card";
import { CustomerHeaderActions } from "@/components/admin/customers/customer-actions";
import { CustomerControls } from "@/components/admin/customers/customer-controls";
import { CustomerKeysTable, CustomerLogsTable, LedgerTable, PaymentsTable, SessionsTable } from "@/components/admin/customers/customer-tables";
import { CustomerUsage } from "@/components/admin/customers/customer-usage";
import { UrlRangePicker } from "@/components/admin/url-filters";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requireAdmin } from "@/lib/auth/session";
import { formatUSD } from "@/lib/money";
import { formatCompact, formatDuration, formatPercent } from "@/lib/utils";
import { getCustomerDetail, listGroupOptions } from "@/server/admin/customers-queries";
import { parseAnalyticsParams } from "@/server/analytics/params";
import { getBreakdown, getTimeSeries, getTotals } from "@/server/analytics/queries";

export const metadata = { title: "Customer" };
export const dynamic = "force-dynamic";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user: me } = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const { range, gran, filter } = parseAnalyticsParams(sp, { userId: id, defaultRange: "30d" });

  const detail = await getCustomerDetail(id);
  if (!detail) notFound();
  const [groups, totals, series, models] = await Promise.all([
    listGroupOptions(),
    getTotals(filter),
    getTimeSeries(filter, gran),
    getBreakdown("model", filter, { limit: 15 }),
  ]);

  const { user } = detail;
  const isAdmin = me.role === "ADMIN";
  const canImpersonate = user.role === "CUSTOMER" || isAdmin;

  return (
    <>
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
        <Link href="/admin/customers">
          <ArrowLeft className="size-4" /> Customers
        </Link>
      </Button>
      <PageHeader
        title={user.name ? `${user.name}` : user.email}
        description={
          <>
            {user.email} · <code className="text-xs">{user.id}</code> · joined {user.createdAt.slice(0, 10)}
            {user.groupName ? ` · group ${user.groupName}` : ""}
          </>
        }
        actions={<CustomerHeaderActions userId={user.id} email={user.email} canImpersonate={canImpersonate} isSelf={user.id === me.id} />}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Spend" value={formatUSD(totals.revenue)} hint={`cost ${formatUSD(totals.cost)}`} />
        <StatCard label="Profit" value={formatUSD(totals.profit)} hint={`${totals.marginPct.toFixed(1)}% margin`} />
        <StatCard label="Requests" value={formatCompact(totals.requests)} hint={`${formatCompact(totals.totalTokens)} tokens`} />
        <StatCard label="Error rate" value={formatPercent(totals.errorRate)} hint={`p95 ${formatDuration(totals.p95LatencyMs)}`} invertTrend />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-[1fr_340px]">
        <CustomerControls user={user} groups={groups} isAdmin={isAdmin} isSelf={user.id === me.id} />
        <BalanceCard user={user} isAdmin={isAdmin} spend30d={totals.revenue} />
      </div>

      <Tabs defaultValue="usage">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList className="h-auto max-w-full flex-wrap">
            <TabsTrigger value="usage">Usage</TabsTrigger>
            <TabsTrigger value="keys">API keys ({detail.keys.length})</TabsTrigger>
            <TabsTrigger value="logs">Recent logs</TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="ledger">Ledger</TabsTrigger>
            <TabsTrigger value="sessions">Sessions ({detail.sessions.length})</TabsTrigger>
          </TabsList>
          <UrlRangePicker initial={{ preset: range.preset, from: range.from.toISOString(), to: range.to.toISOString() }} />
        </div>
        <TabsContent value="usage" className="mt-4">
          <CustomerUsage series={series} models={models} gran={gran} />
        </TabsContent>
        <TabsContent value="keys" className="mt-4">
          <CustomerKeysTable keys={detail.keys} />
        </TabsContent>
        <TabsContent value="logs" className="mt-4">
          <CustomerLogsTable logs={detail.logs} userId={user.id} />
        </TabsContent>
        <TabsContent value="payments" className="mt-4">
          <PaymentsTable payments={detail.payments} />
        </TabsContent>
        <TabsContent value="ledger" className="mt-4">
          <LedgerTable ledger={detail.ledger} />
        </TabsContent>
        <TabsContent value="sessions" className="mt-4">
          <SessionsTable sessions={detail.sessions} />
        </TabsContent>
      </Tabs>
    </>
  );
}
