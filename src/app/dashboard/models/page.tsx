import { PageHeader } from "@/components/common/page-header";
import { LatencyTable } from "@/components/common/latency-views";
import { ModelsClient } from "@/components/customer/models-client";
import { requireUser } from "@/lib/auth/session";
import { getLatencyBreakdown } from "@/server/analytics/latency";
import { getModelsForUser } from "@/server/customer/portal-data";

export const metadata = { title: "Models & Pricing" };
export const dynamic = "force-dynamic";

export default async function ModelsPage() {
  const { user } = await requireUser();
  const to = new Date();
  const [{ models, pools, currentPool }, speeds] = await Promise.all([
    getModelsForUser(user),
    // platform-wide (every customer's calls, last 24 h), per model only - never which provider served it
    getLatencyBreakdown("model", { from: new Date(to.getTime() - 24 * 3_600_000), to }, 1000).catch(() => []),
  ]);
  const visible = new Set(models.map((m) => m.slug));
  return (
    <>
      <PageHeader title="Models & Pricing" description="Every model you can call, what it costs you and and how much you save." />
      <ModelsClient models={models} pools={pools} currentPoolSlug={currentPool?.slug ?? null} />
      <section className="mt-8 space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Model speed (last 24 hours)</h2>
          <p className="text-sm text-muted-foreground">Measured on real calls across the platform. Models nobody called recently have no numbers.</p>
        </div>
        <LatencyTable rows={speeds.filter((r) => visible.has(r.key))} nameHeader="Model" emptyTitle="No calls in the last 24 hours" />
      </section>
    </>
  );
}
