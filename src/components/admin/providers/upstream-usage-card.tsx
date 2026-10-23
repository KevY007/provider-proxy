"use client";

import { useState } from "react";
import { Loader2, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAction } from "@/components/admin/use-action";
import { checkUpstreamUsageAction } from "@/server/admin/upstream-usage-actions";
import type { UpstreamUsageReport } from "@/server/admin/upstream-usage";

const usd = (n: number | null) => (n === null ? "-" : `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 6 : 4)}`);

function Diff({ up, ours }: { up: number | null; ours: number }) {
  if (up === null) return <span className="text-muted-foreground">-</span>;
  const d = ours - up;
  const pct = up > 0 ? Math.abs(d / up) * 100 : d === 0 ? 0 : 100;
  const tone = Math.abs(d) < 0.0005 || pct < 0.5 ? "text-emerald-600" : pct < 5 ? "text-amber-600" : "text-destructive";
  return (
    <span className={`tabular-nums ${tone}`} title="our recorded cost minus what the upstream billed">
      {d >= 0 ? "+" : "-"}${Math.abs(d).toFixed(4)} {up > 0 ? `(${pct.toFixed(1)}%)` : ""}
    </span>
  );
}

/**
 * Provider page: what the upstream itself says each of our keys spent, next to the cost we recorded for the key. On
 * demand only (one usage request per key).
 */
export function UpstreamUsageCard({ providerId }: { providerId: string }) {
  const [report, setReport] = useState<UpstreamUsageReport | null>(null);
  const { run, pending } = useAction();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Scale className="size-4" /> Upstream usage check
        </CardTitle>
        <CardDescription>
          What the provider billed each upstream key (from its own usage API) next to the cost we recorded for that key. A gap means the provider billed requests we did not record, or the other way round, for example a generation it finished after the client had disconnected.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button variant="outline" disabled={pending} onClick={() => void run(() => checkUpstreamUsageAction({ providerId }), { refresh: false, success: "", onOk: (r) => r && setReport(r) })}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Scale className="size-4" />} Check upstream usage
        </Button>
        {report && !report.supported && <p className="text-sm text-muted-foreground">This provider does not publish per-key usage (set settings.usageUrl if it has a compatible endpoint).</p>}
        {report?.supported &&
          report.keys.map((k) => (
            <div key={k.keyId} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                <span className="font-medium">{k.label}</span>
                {k.ok ? (
                  <>
                    <span>
                      Upstream billed <span className="tabular-nums">{usd(k.upstreamTotal)}</span>
                    </span>
                    <span>
                      We recorded <span className="tabular-nums">{usd(k.ourTotal)}</span>
                    </span>
                    <Diff up={k.upstreamTotal} ours={k.ourTotal} />
                    {k.balance !== null && <span className="text-xs text-muted-foreground">balance on the upstream account ${k.balance.toFixed(2)}</span>}
                  </>
                ) : (
                  <span className="text-destructive">Could not read the usage: {k.error}</span>
                )}
              </div>
              {k.days.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="py-1 text-left font-medium">Day ({report.timezone})</th>
                        <th className="py-1 text-right font-medium">Upstream requests</th>
                        <th className="py-1 text-right font-medium">Upstream billed</th>
                        <th className="py-1 text-right font-medium">Our requests</th>
                        <th className="py-1 text-right font-medium">We recorded</th>
                        <th className="py-1 text-right font-medium">Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {k.days.map((d) => (
                        <tr key={d.date} className="border-t">
                          <td className="py-1">{d.date}</td>
                          <td className="py-1 text-right tabular-nums">{d.upstreamRequests ?? "-"}</td>
                          <td className="py-1 text-right tabular-nums">{usd(d.upstreamCost)}</td>
                          <td className="py-1 text-right tabular-nums">{d.ourRequests}</td>
                          <td className="py-1 text-right tabular-nums">{usd(d.ourCost)}</td>
                          <td className="py-1 text-right">
                            <Diff up={d.upstreamCost} ours={d.ourCost} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
