import Link from "next/link";
import { Activity, AlertTriangle, CheckCircle2, Server } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LiveSlots } from "@/components/admin/live-slots";
import { RunChecksButton, StatusTables } from "@/components/admin/status/status-tables";
import { UptimePanel } from "@/components/admin/status/uptime-panel";
import { requireAdmin } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import { getStatusData } from "@/server/admin/status-queries";
import { getUptime, isUptimeRange } from "@/server/admin/uptime-queries";
import { getJobRuns } from "@/server/maintenance";

export const metadata = { title: "Status" };
export const dynamic = "force-dynamic";

const JOB_LABEL: Record<string, string> = { upkeep: "Upkeep (health from traffic, sweeps, dead letters)", billing: "Billing (auto-recharge, postpaid)", probes: "Uptime pings" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const raw = Array.isArray(sp.uptime) ? sp.uptime[0] : sp.uptime;
  const range = isUptimeRange(raw) ? raw : "24h";
  const [data, uptime, settings, jobs] = await Promise.all([getStatusData(), getUptime(range), getSettings(), getJobRuns().catch(() => [])]);
  const active = data.providers.filter((p) => p.status === "ACTIVE");
  const ok = active.filter((p) => p.healthStatus === "OPERATIONAL").length;
  const down = active.filter((p) => p.healthStatus === "DOWN").length;
  const degraded = active.filter((p) => p.healthStatus === "DEGRADED").length;
  const badKeys = data.keys.filter((k) => ["INVALID", "EXHAUSTED", "COOLDOWN"].includes(k.status)).length;
  const timers = settings.backgroundJobs || settings.activeHealthChecks;
  return (
    <>
      <PageHeader title="Status" description="Provider and key health, uptime and ping history, plus live concurrency-slot usage." actions={<RunChecksButton />} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active providers" value={active.length} hint={`${data.providers.length} total`} icon={Server} />
        <StatCard label="Operational" value={ok} hint={degraded ? `${degraded} degraded` : "none degraded"} icon={CheckCircle2} />
        <StatCard label="Down" value={down} icon={AlertTriangle} invertTrend hint={down ? "needs attention" : "all clear"} />
        <StatCard label="Keys needing attention" value={badKeys} icon={Activity} hint="cooldown / invalid / exhausted" />
      </div>
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Background mode: {timers ? "timers on" : "activity-driven (cold)"}</CardTitle>
          <CardDescription>
            {timers ? (
              <>
                {settings.backgroundJobs && `Upkeep every ${settings.maintenanceIntervalMin} min. `}
                {settings.activeHealthChecks && `Uptime pings every ${settings.healthCheckIntervalMin} min. `}
                Timers run while an instance is running.{" "}
              </>
            ) : (
              <>Nothing runs on a timer and no provider is pinged: upkeep runs while calls or admin pages are served (at most every 5 min, billing hourly). </>
            )}
            <Link href="/admin/settings" className="underline underline-offset-2">
              Change in Settings &gt; Monitoring
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 text-sm sm:grid-cols-3">
            {(["upkeep", "billing", "probes"] as const).map((name) => {
              const j = jobs.find((x) => x.name === name);
              return (
                <li key={name} className="rounded-md border p-2">
                  <div className="font-medium">{JOB_LABEL[name]}</div>
                  <div className="text-xs text-muted-foreground" suppressHydrationWarning>
                    {j ? `last run ${new Date(j.lastRunAt).toLocaleString()} (${j.source})` : name === "probes" && !settings.activeHealthChecks ? "off" : "not run yet"}
                    {j?.error && <span className="block text-destructive">{j.error}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
      <div className="mb-6">
        <UptimePanel range={range} providers={uptime.providers} monitoring={settings.activeHealthChecks} />
      </div>
      <div className="mb-6">
        <LiveSlots initial={data.slots} />
      </div>
      <StatusTables providers={data.providers} keys={data.keys} failures={data.failures} />
    </>
  );
}
