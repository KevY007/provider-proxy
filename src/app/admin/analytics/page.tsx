import { Activity, AlertTriangle, Coins, DollarSign, Gauge, Percent, TrendingUp, Zap } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { BreakdownPanel, DimensionTabs, TimeSeriesChart } from "@/components/admin/analytics-charts";
import { FilterSelect, GranularitySelect, ResetFilters, UrlRangePicker } from "@/components/admin/url-filters";
import { requireAdmin } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { formatUSD } from "@/lib/money";
import { formatCompact, formatDuration, formatNumber, formatPercent } from "@/lib/utils";
import { getBreakdown, getTimeSeries, getTotals } from "@/server/analytics/queries";
import { isBreakdownDim, parseAnalyticsParams, previousRange, trendPct, REQUEST_STATUSES, type BreakdownDim } from "@/server/analytics/params";

export const metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

const DIMS: BreakdownDim[] = ["model", "provider", "providerKey", "customer", "group", "endpoint", "status", "errorCode", "apiKey"];
const FILTER_KEYS = ["model", "provider", "group", "status"];

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const { range, gran, filter } = parseAnalyticsParams(sp);
  const byRaw = Array.isArray(sp.by) ? sp.by[0] : sp.by;
  const by: BreakdownDim = isBreakdownDim(byRaw) ? byRaw : "model";
  const prev = previousRange(range);

  const [totals, prevTotals, series, rows, models, providers, groups] = await Promise.all([
    getTotals(filter),
    getTotals({ ...filter, ...prev }),
    getTimeSeries(filter, gran),
    getBreakdown(by, filter, { limit: 500 }),
    db.model.findMany({ select: { slug: true }, orderBy: { slug: "asc" } }),
    db.provider.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.group.findMany({ select: { slug: true, name: true }, orderBy: { sortOrder: "asc" } }),
  ]);

  const exportParams = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const val = Array.isArray(v) ? v[0] : v;
    if (val && k !== "by") exportParams.set(k, val);
  }
  exportParams.set("by", by);

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Revenue, cost, profit and traffic broken down by model, provider, key, customer and more."
        actions={
          <>
            <UrlRangePicker initial={{ preset: range.preset, from: range.from.toISOString(), to: range.to.toISOString() }} />
            <GranularitySelect value={gran} />
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterSelect param="model" label="Model" options={models.map((m) => ({ value: m.slug, label: m.slug }))} />
        <FilterSelect param="provider" label="Provider" options={providers.map((p) => ({ value: p.id, label: p.name }))} />
        <FilterSelect param="group" label="Group" options={groups.map((g) => ({ value: g.slug, label: g.name }))} />
        <FilterSelect param="status" label="Status" options={REQUEST_STATUSES.map((s) => ({ value: s, label: s }))} />
        <ResetFilters keys={FILTER_KEYS} />
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Revenue" icon={DollarSign} value={formatUSD(totals.revenue)} trend={trendPct(totals.revenue, prevTotals.revenue)} hint="vs previous period" />
        <StatCard label="Cost" icon={Coins} value={formatUSD(totals.cost)} trend={trendPct(totals.cost, prevTotals.cost)} invertTrend hint="vs previous period" />
        <StatCard label="Profit" icon={TrendingUp} value={formatUSD(totals.profit)} trend={trendPct(totals.profit, prevTotals.profit)} hint="vs previous period" />
        <StatCard label="Margin" icon={Percent} value={`${totals.marginPct.toFixed(1)}%`} hint={`prev ${prevTotals.marginPct.toFixed(1)}%`} />
        <StatCard label="Requests" icon={Activity} value={formatNumber(totals.requests)} trend={trendPct(totals.requests, prevTotals.requests)} hint={`${formatNumber(totals.activeCustomers)} customers`} />
        <StatCard label="Error rate" icon={AlertTriangle} value={formatPercent(totals.errorRate)} invertTrend trend={trendPct(totals.errorRate, prevTotals.errorRate)} hint={`${formatNumber(totals.errorRequests)} errors`} />
        <StatCard label="Latency p50 / p95" icon={Gauge} value={`${formatDuration(totals.p50LatencyMs)} / ${formatDuration(totals.p95LatencyMs)}`} hint={`avg ${formatDuration(totals.avgLatencyMs)}`} />
        <StatCard label="Tokens" icon={Zap} value={formatCompact(totals.totalTokens)} hint={`${formatCompact(Math.max(0, totals.inputTokens - totals.cachedTokens))} in / ${formatCompact(totals.outputTokens)} out, +${formatCompact(totals.cachedTokens)} cache reads`} />
      </div>

      <div className="mb-6">
        <TimeSeriesChart data={series} gran={gran} title="Trend" />
      </div>

      <div className="mb-3">
        <DimensionTabs value={by} dims={DIMS} />
      </div>
      <BreakdownPanel dim={by} rows={rows} customerLinks={by === "customer"} exportHref={`/admin/analytics/export?${exportParams.toString()}`} />
    </>
  );
}
