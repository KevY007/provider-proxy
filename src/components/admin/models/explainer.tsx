import { ArrowRight, EyeOff, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trafficShares } from "@/server/admin/models-calc";
import type { RouteRow } from "@/server/admin/models-queries";

/** "What customers see vs what runs" for one model. Pure presentational (works in server or client trees). */
export function ModelExplainer({ slug, masked, routes }: { slug: string; masked: boolean; routes: RouteRow[] }) {
  const shares = trafficShares(routes);
  const enabled = routes.filter((r) => r.enabled).sort((a, b) => b.priority - a.priority);
  const tiers = new Map<number, RouteRow[]>();
  for (const r of enabled) tiers.set(r.priority, [...(tiers.get(r.priority) ?? []), r]);
  const realNames = [...new Set(enabled.map((r) => r.upstreamModel))];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">What customers see vs what runs</CardTitle>
        <CardDescription>Customers only ever know the public slug. Routing decides the rest.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Customers call</p>
          <p className="mt-1 font-mono text-base">{slug}</p>
          <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
            {masked ? <EyeOff className="mt-0.5 size-3.5 shrink-0 text-emerald-500" /> : <Eye className="mt-0.5 size-3.5 shrink-0 text-amber-500" />}
            {masked ? (
              <span>
                Responses and stream chunks report <span className="font-mono text-foreground">model: {slug}</span> - the real upstream model is masked.
              </span>
            ) : (
              <span>
                Masking is <strong>off</strong>: responses will show the real upstream model name
                {realNames.length ? ` (${realNames.join(", ")})` : ""}.
              </span>
            )}
          </p>
        </div>

        <div className="flex justify-center text-muted-foreground">
          <ArrowRight className="size-4 rotate-90" />
        </div>

        {enabled.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-center text-sm text-red-500">No enabled routes - requests fail with no_available_provider.</p>
        ) : (
          <ol className="space-y-3">
            {[...tiers.entries()].map(([prio, rs], i) => (
              <li key={prio} className="rounded-lg border p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {i === 0 ? "Tried first" : `Fallback ${i}`} · priority {prio}
                </p>
                <ul className="space-y-2">
                  {rs.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge variant="outline" className="tabular-nums">
                        {shares[r.id].sharePct.toFixed(0)}%
                      </Badge>
                      <span className="font-medium">{r.providerName}</span>
                      <ArrowRight className="size-3 text-muted-foreground" />
                      <span className="font-mono text-xs">{r.upstreamModel}</span>
                      {r.groupSlugs.length > 0 && (
                        <span className="text-xs text-muted-foreground">only pools: {r.groupSlugs.join(", ")}</span>
                      )}
                      {r.maxOutputTokens && <span className="text-xs text-muted-foreground">output clamp {r.maxOutputTokens}</span>}
                      {r.paramOverrides.trim() !== "{}" && (
                        <span className="font-mono text-[11px] text-muted-foreground">overrides {r.paramOverrides.replace(/\s+/g, " ").slice(0, 60)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
        <p className="text-xs text-muted-foreground">
          Shares are nominal. A route is skipped for a customer if its pool restriction does not match their group, its provider is disabled, or no upstream key has a free slot.
        </p>
      </CardContent>
    </Card>
  );
}
