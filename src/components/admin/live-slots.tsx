"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/common/empty-state";
import { fetchSlotSnapshot } from "@/server/admin/providers-actions";
import type { SlotSnapshot, SlotUsage } from "@/gateway/slots";
import { SlotBar } from "./misc";

/**
 * Live concurrency-slot data, refreshed every `intervalMs` (default 5s, paused while the tab is hidden).
 *   const { snapshot, error, updatedAt } = useSlotSnapshot(initialSnapshot);
 */
export function useSlotSnapshot(initial: SlotSnapshot, intervalMs = 5000) {
  const [snapshot, setSnapshot] = useState<SlotSnapshot>(initial);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number>(() => Date.parse(initial.at) || Date.now());
  const busy = useRef(false);

  useEffect(() => {
    let stop = false;
    async function tick() {
      if (busy.current || document.visibilityState === "hidden") return;
      busy.current = true;
      try {
        const res = await fetchSlotSnapshot();
        if (stop) return;
        if (res.ok && res.data) {
          setSnapshot(res.data);
          setUpdatedAt(Date.now());
          setError(null);
        } else if (!res.ok) setError(res.error);
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : "Failed to refresh");
      } finally {
        busy.current = false;
      }
    }
    const t = setInterval(tick, intervalMs);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [intervalMs]);

  return { snapshot, error, updatedAt };
}

function Rows({ rows, empty }: { rows: SlotUsage[]; empty: string }) {
  if (rows.length === 0) return <p className="py-3 text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-3 text-sm">
          <span className="truncate" title={r.label}>
            {r.label}
          </span>
          <SlotBar inUse={r.inUse} max={r.max} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Live slot usage panel: provider totals, provider keys, queued requests and top customers by in-use slots.
 * `compact` shows only the summary + providers (for overview tiles).
 */
export function LiveSlots({ initial, compact, intervalMs }: { initial: SlotSnapshot; compact?: boolean; intervalMs?: number }) {
  const { snapshot, error, updatedAt } = useSlotSnapshot(initial, intervalMs);
  const totalInUse = snapshot.providerKeys.reduce((s, k) => s + k.inUse, 0);
  const keysBusy = snapshot.providerKeys.filter((k) => k.inUse > 0).length;
  const empty = snapshot.providerKeys.length === 0 && snapshot.providers.length === 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="size-4" /> Live slot usage
          </CardTitle>
          <CardDescription>
            {totalInUse} in use across {keysBusy} key{keysBusy === 1 ? "" : "s"} · refreshes every 5s
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={snapshot.queued > 0 ? "destructive" : "secondary"}>{snapshot.queued} queued</Badge>
          <span className="flex items-center gap-1 text-xs text-muted-foreground" title={error ?? "Last updated"} suppressHydrationWarning>
            <RefreshCw className="size-3" />
            {error ? "stale" : new Date(updatedAt).toLocaleTimeString()}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {empty ? (
          <EmptyState icon={Activity} title="No slot data" description="Slot usage appears here once the gateway has handled requests." className="border-0 py-6" />
        ) : (
          <div className={compact ? "space-y-4" : "grid gap-6 lg:grid-cols-3"}>
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Providers</h3>
              <Rows rows={snapshot.providers} empty="No providers" />
            </section>
            {!compact && (
              <>
                <section>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Provider keys</h3>
                  <Rows rows={snapshot.providerKeys} empty="No keys" />
                </section>
                <section>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Top customers by in-use slots</h3>
                  <Rows rows={snapshot.customers.filter((c) => c.inUse > 0)} empty="No customer requests in flight" />
                </section>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
