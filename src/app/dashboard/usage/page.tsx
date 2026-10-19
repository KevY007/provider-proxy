import { PageHeader } from "@/components/common/page-header";
import { UsageClient } from "@/components/customer/usage-client";
import { LatencyHistoryChart, LatencyTable } from "@/components/common/latency-views";
import { StatCard } from "@/components/common/stat-card";
import { formatDuration } from "@/lib/utils";
import { getLatencyBreakdown, getLatencyHistory, getLatencySummary } from "@/server/analytics/latency";
import { Gauge, Timer } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { parseRangeParams } from "@/lib/date-range";
import { getUsage } from "@/server/customer/analytics";
import { clampGranularity, type Granularity } from "@/server/customer/buckets";

export const metadata = { title: "Usage" };
export const dynamic = "force-dynamic";

export default async function UsagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { user } = await requireUser();
  const range = parseRangeParams(sp, "7d");
  const g = Array.isArray(sp.gran) ? sp.gran[0] : sp.gran;
  const gran = clampGranularity(g === "hour" || g === "day" ? (g as Granularity) : undefined, range.from, range.to);
  const hourAllowed = range.to.getTime() - range.from.getTime() <= 14 * 86400_000;
  const lf = { from: range.from, to: range.to, userId: user.id };
  const [data, lat, latHistory, latByModel] = await Promise.all([
    getUsage(user.id, range.from, range.to, gran),
    getLatencySummary(lf),
    getLatencyHistory(lf, gran),
    getLatencyBreakdown("model", lf),
  ]);

  return (
    <>
      <PageHeader title="Usage" description="Spend, tokens and latency across your models, keys and endpoints." />
      <UsageClient
        range={{ preset: range.preset, from: range.from.toISOString(), to: range.to.toISOString() }}
        granularity={gran}
        hourAllowed={hourAllowed}
        totals={data.totals}
        series={data.series.map((p) => ({ ...p, bucket: p.bucket.toISOString() }))}
        byModel={data.byModel}
        byKey={data.byKey}
        byEndpoint={data.byEndpoint}
      />
      <section className="mt-8 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Latency</h2>
          <p className="text-sm text-muted-foreground">How long your successful calls took, from the moment we received them. First token = time until the first streamed token.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <StatCard label="Total p50" icon={Gauge} value={formatDuration(lat.p50Ms)} hint={`p95 ${formatDuration(lat.p95Ms)} - ${lat.calls} successful calls`} />
          <StatCard label="First token p50" icon={Timer} value={formatDuration(lat.ttftP50Ms)} hint={`p95 ${formatDuration(lat.ttftP95Ms)} (streaming)`} />
        </div>
        <LatencyHistoryChart data={latHistory} gran={gran} />
        <LatencyTable rows={latByModel} nameHeader="Model" />
      </section>
    </>
  );
}
