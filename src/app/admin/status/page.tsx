import { Activity, AlertTriangle, CheckCircle2, Server } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { LiveSlots } from "@/components/admin/live-slots";
import { RunChecksButton, StatusTables } from "@/components/admin/status/status-tables";
import { requireAdmin } from "@/lib/auth/session";
import { getStatusData } from "@/server/admin/status-queries";

export const metadata = { title: "Status" };
export const dynamic = "force-dynamic";

export default async function Page() {
  await requireAdmin();
  const data = await getStatusData();
  const active = data.providers.filter((p) => p.status === "ACTIVE");
  const ok = active.filter((p) => p.healthStatus === "OPERATIONAL").length;
  const down = active.filter((p) => p.healthStatus === "DOWN").length;
  const degraded = active.filter((p) => p.healthStatus === "DEGRADED").length;
  const badKeys = data.keys.filter((k) => ["INVALID", "EXHAUSTED", "COOLDOWN"].includes(k.status)).length;
  return (
    <>
      <PageHeader title="Status" description="Provider and key health history, plus live concurrency-slot usage." actions={<RunChecksButton />} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active providers" value={active.length} hint={`${data.providers.length} total`} icon={Server} />
        <StatCard label="Operational" value={ok} hint={degraded ? `${degraded} degraded` : "none degraded"} icon={CheckCircle2} />
        <StatCard label="Down" value={down} icon={AlertTriangle} invertTrend hint={down ? "needs attention" : "all clear"} />
        <StatCard label="Keys needing attention" value={badKeys} icon={Activity} hint="cooldown / invalid / exhausted" />
      </div>
      <div className="mb-6">
        <LiveSlots initial={data.slots} />
      </div>
      <StatusTables providers={data.providers} keys={data.keys} failures={data.failures} />
    </>
  );
}
