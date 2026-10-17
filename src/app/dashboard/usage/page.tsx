import { PageHeader } from "@/components/common/page-header";
import { UsageClient } from "@/components/customer/usage-client";
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
  const data = await getUsage(user.id, range.from, range.to, gran);

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
    </>
  );
}
