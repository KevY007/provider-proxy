import Link from "next/link";
import { Activity, AlertTriangle, Coins, DollarSign, Gauge, Percent, TrendingUp, Users, Zap } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { StatusBadge } from "@/components/common/status-badge";
import { EmptyState } from "@/components/common/empty-state";
import { TimeSeriesChart } from "@/components/admin/analytics-charts";
import { SlotBar } from "@/components/admin/misc";
import { QuickStartChecklist } from "@/components/admin/quickstart-checklist";
import { getQuickStart } from "@/server/admin/quickstart-data";
import { UrlRangePicker } from "@/components/admin/url-filters";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireAdmin } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { formatUSD } from "@/lib/money";
import { formatCompact, formatDuration, formatNumber, formatPercent, truncate } from "@/lib/utils";
import { getSlotSnapshot, type SlotSnapshot } from "@/gateway/slots";
import { getBreakdown, getRecentErrors, getTimeSeries, getTotals } from "@/server/analytics/queries";
import { parseAnalyticsParams, previousRange, trendPct } from "@/server/analytics/params";
import { getUpstreamBalances } from "@/server/admin/upstream-balances";
import { UpstreamBalancesCard } from "@/components/admin/upstream-balances-card";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

async function safeSlots(): Promise<SlotSnapshot | null> {
  try {
    return await getSlotSnapshot();
  } catch {
    return null;
  }
}

export default async function AdminOverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const { range, gran, filter } = parseAnalyticsParams(sp, { defaultRange: "7d" });
  const prev = previousRange(range);

  const [quickStart, totals, prevTotals, series, topModels, topCustomers, errors, providers, slots, upstreamBalances] = await Promise.all([
    getQuickStart(),
    getTotals(filter),
    getTotals({ ...filter, ...prev }),
    getTimeSeries(filter, gran),
    getBreakdown("model", filter, { limit: 8 }),
    getBreakdown("customer", filter, { limit: 8 }),
    getRecentErrors(filter, 8, { includeInternal: true }),
    db.provider.findMany({
      orderBy: [{ status: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        status: true,
        healthStatus: true,
        lastLatencyMs: true,
        lastCheckAt: true,
        _count: { select: { keys: { where: { status: "ACTIVE" } } } },
      },
    }),
    safeSlots(),
    getUpstreamBalances().catch(() => ({ at: null, accounts: [] })),
  ]);
  const settings = await getSettings();

  const providerName = new Map(providers.map((p) => [p.id, p.name]));
  const totalInUse = slots?.providerKeys.reduce((a, k) => a + k.inUse, 0) ?? 0;
  const totalMax = slots?.providerKeys.reduce((a, k) => a + (k.max ?? 0), 0) ?? 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Revenue, cost, profit and platform health."
        actions={<UrlRangePicker initial={{ preset: range.preset, from: range.from.toISOString(), to: range.to.toISOString() }} />}
      />

      <QuickStartChecklist state={quickStart} />

      {upstreamBalances.accounts.length > 0 && <UpstreamBalancesCard snapshot={upstreamBalances} lowUsd={settings.upstreamBalanceLowUsd} intervalMin={settings.upstreamBalanceIntervalMin} />}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        <StatCard label="Revenue" icon={DollarSign} value={formatUSD(totals.revenue)} trend={trendPct(totals.revenue, prevTotals.revenue)} hint="vs prev. period" />
        <StatCard label="Cost" icon={Coins} value={formatUSD(totals.cost)} trend={trendPct(totals.cost, prevTotals.cost)} invertTrend hint="vs prev. period" />
        <StatCard label="Profit" icon={TrendingUp} value={formatUSD(totals.profit)} trend={trendPct(totals.profit, prevTotals.profit)} hint="vs prev. period" />
        <StatCard label="Margin" icon={Percent} value={`${totals.marginPct.toFixed(1)}%`} hint={`prev ${prevTotals.marginPct.toFixed(1)}%`} />
        <StatCard label="Requests" icon={Activity} value={formatNumber(totals.requests)} trend={trendPct(totals.requests, prevTotals.requests)} hint="vs prev. period" />
        <StatCard label="Error rate" icon={AlertTriangle} value={formatPercent(totals.errorRate)} invertTrend hint={`${formatNumber(totals.errorRequests)} errors`} />
        <StatCard label="Active customers" icon={Users} value={formatNumber(totals.activeCustomers)} trend={trendPct(totals.activeCustomers, prevTotals.activeCustomers)} hint="with requests" />
        <StatCard label="Latency p50" icon={Gauge} value={formatDuration(totals.p50LatencyMs)} hint={`avg ${formatDuration(totals.avgLatencyMs)}`} />
        <StatCard label="Latency p95" icon={Gauge} value={formatDuration(totals.p95LatencyMs)} hint="successful requests" />
        <StatCard label="Tokens" icon={Zap} value={formatCompact(totals.totalTokens)} hint={`${formatCompact(totals.inputTokens)} in / ${formatCompact(totals.outputTokens)} out`} />
      </div>

      <div className="mb-6">
        <TimeSeriesChart data={series} gran={gran} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Top models</CardTitle>
              <CardDescription>By revenue</CardDescription>
            </div>
            <Link href={`/admin/analytics?by=model&range=${range.preset}`} className="text-sm text-primary hover:underline">
              All
            </Link>
          </CardHeader>
          <CardContent>
            {topModels.length === 0 ? (
              <EmptyState title="No traffic yet" className="border-0 py-8" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Profit</TableHead>
                    <TableHead className="text-right">Margin</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topModels.map((m) => (
                    <TableRow key={m.key}>
                      <TableCell className="font-mono text-xs">{m.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(m.requests)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatUSD(m.revenue)}</TableCell>
                      <TableCell className={`text-right tabular-nums ${m.profit < 0 ? "text-red-500" : ""}`}>{formatUSD(m.profit)}</TableCell>
                      <TableCell className={`text-right tabular-nums ${m.marginPct < 0 ? "text-red-500" : ""}`}>{m.marginPct.toFixed(1)}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Top customers</CardTitle>
              <CardDescription>By revenue</CardDescription>
            </div>
            <Link href="/admin/customers" className="text-sm text-primary hover:underline">
              All
            </Link>
          </CardHeader>
          <CardContent>
            {topCustomers.length === 0 ? (
              <EmptyState title="No traffic yet" className="border-0 py-8" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Profit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topCustomers.map((c) => (
                    <TableRow key={c.key}>
                      <TableCell className="max-w-48 truncate">
                        {c.key === "(none)" ? (
                          c.label
                        ) : (
                          <Link href={`/admin/customers/${c.key}`} className="hover:underline">
                            {c.label}
                          </Link>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(c.requests)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatUSD(c.revenue)}</TableCell>
                      <TableCell className={`text-right tabular-nums ${c.profit < 0 ? "text-red-500" : ""}`}>{formatUSD(c.profit)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Provider health</CardTitle>
              <CardDescription>Latest health check and usable upstream keys</CardDescription>
            </div>
            <Link href="/admin/status" className="text-sm text-primary hover:underline">
              Status
            </Link>
          </CardHeader>
          <CardContent>
            {providers.length === 0 ? (
              <EmptyState title="No providers yet" description="Add an upstream provider to start routing traffic." className="border-0 py-8" />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {providers.map((p) => {
                  const slot = slots?.providers.find((s) => s.id === p.id);
                  return (
                    <Link key={p.id} href={`/admin/providers/${p.id}`} className="rounded-lg border p-3 transition-colors hover:bg-accent/50">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{p.name}</span>
                        {p.status === "DISABLED" ? <StatusBadge status="DISABLED" /> : <StatusBadge status={p.healthStatus} />}
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{p._count.keys} active key{p._count.keys === 1 ? "" : "s"}</span>
                        <span>{p.lastLatencyMs != null ? formatDuration(p.lastLatencyMs) : "no check"}</span>
                      </div>
                      {slot && <SlotBar inUse={slot.inUse} max={slot.max} className="mt-2" compact />}
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Live slots</CardTitle>
              <CardDescription>Upstream concurrency right now</CardDescription>
            </div>
            <Link href="/admin/status" className="text-sm text-primary hover:underline">
              Live view
            </Link>
          </CardHeader>
          <CardContent className="space-y-3">
            {!slots ? (
              <p className="text-sm text-muted-foreground">Slot manager unavailable.</p>
            ) : (
              <>
                <div className="flex items-end justify-between">
                  <span className="text-3xl font-semibold tabular-nums">{totalInUse}</span>
                  <span className="text-sm text-muted-foreground">of {totalMax || "-"} slots in use</span>
                </div>
                <SlotBar inUse={totalInUse} max={totalMax || null} />
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Queued requests</span>
                  <span className={`tabular-nums ${slots.queued > 0 ? "font-medium text-amber-500" : ""}`}>{slots.queued}</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Recent errors</CardTitle>
            <CardDescription>Latest failed requests in the selected range</CardDescription>
          </div>
          <Link href="/admin/logs?status=UPSTREAM_ERROR" className="text-sm text-primary hover:underline">
            Logs
          </Link>
        </CardHeader>
        <CardContent>
          {errors.length === 0 ? (
            <EmptyState title="No errors in this period" className="border-0 py-8" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {errors.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDistanceToNow(new Date(e.createdAt), { addSuffix: true })}</TableCell>
                    <TableCell className="font-mono text-xs">{e.modelSlug ?? "-"}</TableCell>
                    <TableCell className="text-xs">{e.providerId ? (providerName.get(e.providerId) ?? "-") : "-"}</TableCell>
                    <TableCell>
                      <StatusBadge status={e.status} label={`${e.httpStatus}`} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.errorCode ?? "-"}</TableCell>
                    <TableCell className="max-w-96 truncate text-xs text-muted-foreground" title={e.internalError ?? e.errorMessage ?? ""}>
                      <Link href={`/admin/logs?log=${e.id}`} className="hover:underline">
                        {truncate(e.internalError ?? e.errorMessage ?? "", 120) || "-"}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
