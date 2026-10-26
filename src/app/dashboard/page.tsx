import Link from "next/link";
import { Activity, AlertTriangle, ArrowRight, BarChart3, Clock, Coins, Gauge, Hash, KeyRound, PiggyBank, Wallet } from "lucide-react";
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
import { CodeBlock } from "@/components/customer/code-block";
import { OnboardingChecklist } from "@/components/customer/onboarding-checklist";
import { buildSnippets } from "@/components/customer/snippets";
import { VerifyBanner } from "@/components/customer/verify-banner";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { formatCompact, formatDuration, formatPercent } from "@/lib/utils";
import { getOverview } from "@/server/customer/analytics";
import { explainError } from "@/server/customer/log-status";
import { getOnboarding } from "@/server/customer/onboarding-data";
import { summarizeSavings, type SavingsSummary } from "@/server/customer/savings";
import { getSavingsTotals, getSpendByPool } from "@/server/customer/savings-totals";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

const levelStyle: Record<string, string> = {
  info: "border-sky-500/30 bg-sky-500/5",
  success: "border-emerald-500/30 bg-emerald-500/5",
  warning: "border-amber-500/30 bg-amber-500/5",
  error: "border-red-500/30 bg-red-500/5",
};

function SavingsFigure({ label, s }: { label: string; s: SavingsSummary & { hasData: boolean } }) {
  const tone = s.kind === "saved" ? "text-emerald-600 dark:text-emerald-400" : s.kind === "paid_more" ? "text-amber-600 dark:text-amber-400" : undefined;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${tone ?? ""}`}>{s.hasData ? (s.kind === "paid_more" ? `+${s.value}` : s.value) : "-"}</p>
      <p className="text-xs text-muted-foreground">
        {!s.hasData
          ? "No priced requests yet"
          : s.kind === "saved"
            ? "saved"
            : s.kind === "paid_more"
              ? "more than regular"
              : "same as regular"}
      </p>
    </div>
  );
}

export default async function DashboardPage() {
  const { user } = await requireUser();
  const [ov, announcements, siteName, onboarding, totals, byPool] = await Promise.all([
    getOverview(user.id),
    db.announcement.findMany({ where: { active: true }, orderBy: { createdAt: "desc" }, take: 3 }),
    getSetting("siteName"),
    getOnboarding(user),
    getSavingsTotals(user.id),
    getSpendByPool(user.id),
  ]);
  const { today, week, series, models, errors, keyCount } = ov;
  const savings = summarizeSavings(week.official, week.comparable);
  const hasSavings = week.official > 0;
  const curl = buildSnippets({ appUrl, siteName })[0].blocks[0];
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

      <OnboardingChecklist state={onboarding} siteName={siteName}>
        <CodeBlock block={curl} maxHeight="14rem" />
      </OnboardingChecklist>

      <Card className="mb-4 border-emerald-500/20 bg-emerald-500/[0.03]">
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <PiggyBank className="size-4 text-emerald-600 dark:text-emerald-400" /> Your savings
            </CardTitle>
            <CardDescription>What the same requests would have cost at the regular price, minus what you paid.</CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/usage">
              Details <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <SavingsFigure label="This month" s={totals.month} />
          <SavingsFigure label="Last 7 days" s={{ ...savings, hasData: hasSavings }} />
          <SavingsFigure label="All time" s={totals.allTime} />
        </CardContent>
        {byPool.length > 0 && (
          <CardContent className="border-t pt-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">By pool, all time</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1.5 pr-4 font-medium">Pool</th>
                    <th className="py-1.5 pr-4 text-right font-medium">Requests</th>
                    <th className="py-1.5 pr-4 text-right font-medium">Spent</th>
                    <th className="py-1.5 pr-4 text-right font-medium">Regular price</th>
                    <th className="py-1.5 text-right font-medium">Saved</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {byPool.map((p) => {
                    const saved = p.listPrice - p.comparablePaid;
                    return (
                      <tr key={p.slug ?? "none"} className="border-t">
                        <td className="py-1.5 pr-4 font-medium">{p.name}</td>
                        <td className="py-1.5 pr-4 text-right">{formatCompact(p.requests)}</td>
                        <td className="py-1.5 pr-4 text-right">
                          <MoneyText value={p.spent} />
                        </td>
                        <td className="py-1.5 pr-4 text-right text-muted-foreground">{p.listPrice > 0 ? <MoneyText value={p.listPrice} /> : "-"}</td>
                        <td className={`py-1.5 text-right ${saved > 0 ? "text-emerald-600 dark:text-emerald-400" : saved < 0 ? "text-amber-600 dark:text-amber-400" : ""}`}>
                          {p.listPrice > 0 ? (
                            <>
                              {saved < 0 ? "+" : ""}
                              <MoneyText value={Math.abs(saved)} />
                            </>
                          ) : (
                            "-"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        )}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Balance" icon={Wallet} value={<MoneyText value={user.balance.toString()} />} hint={<Link href="/dashboard/billing" className="hover:text-foreground hover:underline">Manage billing</Link>} />
        <StatCard label="Spend today" icon={Coins} value={<MoneyText value={today.spend} />} hint={`${formatCompact(today.requests)} requests`} />
        <StatCard label="Spend, 7 days" icon={BarChart3} value={<MoneyText value={week.spend} />} />
        <StatCard label="Tokens, 7 days" icon={Hash} value={formatCompact(tokens7)} hint={`${formatCompact(week.inputTokens)} in / ${formatCompact(week.outputTokens)} out`} />
        <StatCard label="Requests, 7 days" icon={Activity} value={formatCompact(week.requests)} />
        <StatCard label="Error rate" icon={Gauge} value={formatPercent(errorRate)} hint={`${formatCompact(week.errors)} failed`} />
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
                const info = explainError(e.errorCode, e.errorMessage);
                return (
                  <li key={e.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3">
                    <Badge variant="destructive" className="font-mono">
                      {e.httpStatus}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        {info ? (
                          <Link href={info.docsHref} className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline">
                            {info.code}
                          </Link>
                        ) : (
                          <span className="font-mono text-xs text-muted-foreground">error</span>
                        )}
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
