import { Activity, Gauge, Hourglass, Timer } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { LatencyHistoryChart, LatencyTable } from "@/components/common/latency-views";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FilterSelect, GranularitySelect, ResetFilters, UrlRangePicker } from "@/components/admin/url-filters";
import { requireAdmin } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { formatDuration, formatNumber } from "@/lib/utils";
import { getLatencyBreakdown, getLatencyHistory, getLatencySummary } from "@/server/analytics/latency";
import { parseAnalyticsParams } from "@/server/analytics/params";

export const metadata = { title: "Latency" };
export const dynamic = "force-dynamic";

const FILTER_KEYS = ["model", "provider"];

export default async function LatencyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const { range, gran, filter } = parseAnalyticsParams(sp);
  const [sum, history, byProvider, byKey, byModel, models, providers] = await Promise.all([
    getLatencySummary(filter),
    getLatencyHistory(filter, gran),
    getLatencyBreakdown("provider", filter),
    getLatencyBreakdown("providerKey", filter),
    getLatencyBreakdown("model", filter),
    db.model.findMany({ select: { slug: true }, orderBy: { slug: "asc" } }),
    db.provider.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <>
      <PageHeader
        title="Latency"
        description="Response times per provider, key and model, measured on real customer calls only. The proxy never pings upstreams on a timer, so a provider nobody calls has no recent numbers."
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
        <ResetFilters keys={FILTER_KEYS} />
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Successful calls" icon={Activity} value={formatNumber(sum.calls)} hint={sum.lastAt ? "in this period" : "none in this period"} />
        <StatCard label="Total p50" icon={Gauge} value={formatDuration(sum.p50Ms)} hint={`p95 ${formatDuration(sum.p95Ms)}`} />
        <StatCard label="First token p50" icon={Timer} value={formatDuration(sum.ttftP50Ms)} hint={`p95 ${formatDuration(sum.ttftP95Ms)} (streaming)`} />
        <StatCard label="Queue p95" icon={Hourglass} value={formatDuration(sum.queueP95Ms)} hint="waiting for a slot" />
      </div>
      <div className="mb-6">
        <LatencyHistoryChart data={history} gran={gran} />
      </div>
      <Tabs defaultValue="provider">
        <TabsList>
          <TabsTrigger value="provider">By provider</TabsTrigger>
          <TabsTrigger value="key">By provider key</TabsTrigger>
          <TabsTrigger value="model">By model</TabsTrigger>
        </TabsList>
        <TabsContent value="provider" className="mt-4">
          <LatencyTable rows={byProvider} nameHeader="Provider" showErrors showQueue />
        </TabsContent>
        <TabsContent value="key" className="mt-4">
          <LatencyTable rows={byKey} nameHeader="Provider key" showErrors showQueue />
        </TabsContent>
        <TabsContent value="model" className="mt-4">
          <LatencyTable rows={byModel} nameHeader="Model" showErrors showQueue />
        </TabsContent>
      </Tabs>
    </>
  );
}
