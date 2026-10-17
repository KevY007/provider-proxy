import Link from "next/link";
import { Activity, AlertTriangle, ArrowRight, BarChart3, Clock, Coins, Gauge, Hash, KeyRound, Wallet } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/common/copy-button";
import { MoneyText } from "@/components/common/money-text";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { LocalTime } from "@/components/customer/local-time";
import { ModelDonutCard, SpendOverTimeCard } from "@/components/customer/overview-charts";
import { QuickstartCard } from "@/components/customer/quickstart-card";
import { VerifyBanner } from "@/components/customer/verify-banner";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { formatCompact, formatDuration, formatPercent } from "@/lib/utils";
import { getOverview } from "@/server/customer/analytics";
import { describeErrorCode } from "@/server/customer/error-codes";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

const levelStyle: Record<string, string> = {
  info: "border-sky-500/30 bg-sky-500/5",
  success: "border-emerald-500/30 bg-emerald-500/5",
  warning: "border-amber-500/30 bg-amber-500/5",
  error: "border-red-500/30 bg-red-500/5",
};

export default async function DashboardPage() {
  const { user } = await requireUser();
  const [ov, announcements, siteName] = await Promise.all([
    getOverview(user.id),
    db.announcement.findMany({ where: { active: true }, orderBy: { createdAt: "desc" }, take: 3 }),
    getSetting("siteName"),
  ]);
  const { today, week, series, models, errors, keyCount } = ov;
  const tokens7 = week.inputTokens + week.outputTokens;
  const errorRate = week.requests ? week.errors / week.requests : 0;
  const spendByModel = models.some((m) => m.spend > 0);
  const balanceLow = user.balance.lte(0);

  return (
    <>
      <PageHeader
        title={user.name ? `Welcome back, ${user.name.split(" ")[0]}` : "Overview"}
        description="Your balance, spend and recent API activity."
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/dashboard/keys">
                <KeyRound className="size-4" /> API keys
              </Link>
            </Button>
            <Button asChild>
              <Link href="/dashboard/billing">
                <Wallet className="size-4" /> Add funds
              </Link>
            </Button>
          </>
        }
      />

      {!user.emailVerifiedAt && <VerifyBanner email={user.email} />}

      {announcements.map((a) => (
        <Alert key={a.id} className={`mb-4 ${levelStyle[a.level] ?? levelStyle.info}`}>
          <AlertTitle>{a.title}</AlertTitle>
          <AlertDescription>{a.body}</AlertDescription>
        </Alert>
      ))}

      {balanceLow && (
        <Alert className="mb-4 border-amber-500/40 bg-amber-500/5">
          <AlertTriangle className="text-amber-500" />
          <AlertTitle>Your balance is empty</AlertTitle>
          <AlertDescription>
            API requests are rejected with <code className="font-mono">insufficient_balance</code> until you add funds.{" "}
            <Link href="/dashboard/billing" className="font-medium text-primary hover:underline">
              Add funds
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {keyCount === 0 && <QuickstartCard appUrl={appUrl} hasBalance={!balanceLow} siteName={siteName} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Balance" icon={Wallet} value={<MoneyText value={user.balance.toString()} />} hint={<Link href="/dashboard/billing" className="hover:text-foreground hover:underline">Manage billing</Link>} />
        <StatCard label="Spend today" icon={Coins} value={<MoneyText value={today.spend} />} hint={`${formatCompact(today.requests)} requests`} />
        <StatCard label="Spend, 7 days" icon={BarChart3} value={<MoneyText value={week.spend} />} hint={`${formatCompact(week.requests)} requests`} />
        <StatCard label="Tokens, 7 days" icon={Hash} value={formatCompact(tokens7)} hint={`${formatCompact(week.inputTokens)} in / ${formatCompact(week.outputTokens)} out`} />
        <StatCard label="Requests, 7 days" icon={Activity} value={formatCompact(week.requests)} hint={`${formatCompact(today.requests)} today`} />
        <StatCard label="Error rate" icon={Gauge} value={formatPercent(errorRate)} hint={`${formatCompact(week.errors)} failed of ${formatCompact(week.requests)}`} />
        <StatCard label="Avg latency" icon={Clock} value={week.requests ? formatDuration(week.avgLatencyMs) : "-"} hint="last 7 days" />
        <StatCard label="Active keys" icon={KeyRound} value={String(keyCount)} hint={<Link href="/dashboard/keys" className="hover:text-foreground hover:underline">Manage keys</Link>} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <SpendOverTimeCard data={series.map((p) => ({ bucket: p.bucket.toISOString(), spend: p.spend, requests: p.requests }))} />
        <ModelDonutCard data={models.map((m) => ({ name: m.name, spend: m.spend, requests: m.requests }))} metric={spendByModel ? "spend" : "requests"} />
      </div>

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">Recent errors</CardTitle>
            <CardDescription>Latest failed requests. Share the request id with support if you need help.</CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/logs?status=error">
              All logs <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {errors.length === 0 ? (
            <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">No errors recently. Nice.</p>
          ) : (
            <ul className="divide-y">
              {errors.map((e) => {
                const info = describeErrorCode(e.errorCode);
                return (
                  <li key={e.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3">
                    <Badge variant="destructive" className="font-mono">
                      {e.httpStatus}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        <span className="font-mono text-xs text-muted-foreground">{e.errorCode ?? "error"}</span>
                        {e.modelSlug && <span className="text-muted-foreground"> - {e.modelSlug}</span>}
                      </p>
                      <p className="line-clamp-2 text-sm">{e.errorMessage ?? info?.meaning ?? "Request failed"}</p>
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <code className="font-mono">{e.id}</code>
                        <CopyButton value={e.id} size="icon-xs" toastMessage="Request id copied" />
                      </p>
                    </div>
                    <LocalTime iso={e.createdAt.toISOString()} mode="relative" className="text-xs text-muted-foreground" />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
