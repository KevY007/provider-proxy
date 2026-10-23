"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, RefreshCw, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAction } from "@/components/admin/use-action";
import { cn } from "@/lib/utils";
import { refreshUpstreamBalancesAction } from "@/server/admin/upstream-usage-actions";
import type { BalanceSnapshot } from "@/server/admin/upstream-balances";

/** Money left on each upstream account (one tile per account; providers sharing one wallet are grouped). */
export function UpstreamBalancesCard({ snapshot, lowUsd, intervalMin }: { snapshot: BalanceSnapshot; lowUsd: number; intervalMin: number }) {
  const router = useRouter();
  const { run, pending } = useAction();
  const low = snapshot.accounts.filter((a) => a.balance !== null && a.balance < lowUsd);
  const failed = snapshot.accounts.filter((a) => a.balance === null);
  return (
    <Card className={cn("mb-6", low.length ? "border-red-500/50" : failed.length ? "border-amber-500/50" : "")}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="size-4" /> Upstream balances
          </CardTitle>
          <CardDescription>
            Money left on our provider accounts (not customer wallets).{" "}
            {snapshot.at ? `Updated ${formatDistanceToNow(new Date(snapshot.at), { addSuffix: true })}` : "Not read yet"}
            {intervalMin > 0 ? `, refreshes every ${intervalMin >= 60 && intervalMin % 60 === 0 ? `${intervalMin / 60} h` : `${intervalMin} min`}` : ", automatic refresh off"} (
            <Link href="/admin/settings" className="underline underline-offset-2">
              change
            </Link>
            ).
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => refreshUpstreamBalancesAction(), { onOk: () => router.refresh() })}>
          <RefreshCw className={cn("size-4", pending && "animate-spin")} /> Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {snapshot.accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No provider publishes an account balance.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {snapshot.accounts.map((a) => {
              const isLow = a.balance !== null && a.balance < lowUsd;
              return (
                <div key={a.id} className={cn("rounded-lg border p-3", isLow && "border-red-500/60 bg-red-500/5", a.balance === null && "border-amber-500/60 bg-amber-500/5")}>
                  <p className="truncate text-sm font-medium">{a.name}</p>
                  <p className={cn("mt-1 text-2xl font-semibold tabular-nums", isLow && "text-red-600 dark:text-red-400")}>
                    {a.balance === null ? <span className="text-base text-amber-600 dark:text-amber-400">unavailable</span> : `$${a.balance.toFixed(2)}`}
                  </p>
                  {isLow && (
                    <p className="mt-1 flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
                      <AlertTriangle className="size-3.5" /> Below ${lowUsd}: top up soon
                    </p>
                  )}
                  {a.balance === null && a.error && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{a.error}</p>}
                  <p className="mt-2 text-xs text-muted-foreground">
                    {a.providers.map((p, i) => (
                      <span key={p.id}>
                        {i > 0 && ", "}
                        <Link href={`/admin/providers/${p.id}`} className="hover:underline">
                          {p.name}
                        </Link>
                      </span>
                    ))}
                    {" · "}
                    {a.keys.length} key{a.keys.length === 1 ? "" : "s"}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
