"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";
import { MoneyText } from "@/components/common/money-text";
import { StatusBadge } from "@/components/common/status-badge";
import { fmtDateTime } from "@/components/admin/format";
import { JsonView, KV } from "@/components/admin/misc";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/utils";
import { getLogDetail } from "@/server/admin/logs-actions";
import type { LogDetail } from "@/server/admin/logs-queries";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="divide-y">{children}</div>
    </section>
  );
}

export function LogDetailSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [state, setState] = useState<{ id: string; data?: LogDetail; error?: string } | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    getLogDetail(id)
      .then((res) => {
        if (cancelled) return;
        setState(res.ok && res.data ? { id, data: res.data } : { id, error: res.ok ? "Empty response" : res.error });
      })
      .catch((e) => !cancelled && setState({ id, error: e instanceof Error ? e.message : "Failed to load" }));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const current = state && state.id === id ? state : null;
  const d = current?.data;

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Request detail</SheetTitle>
          <SheetDescription className="flex items-center gap-1 font-mono text-xs">
            {id} {id && <CopyButton value={id} />}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-6">
          {!current && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          )}
          {current?.error && <p className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">{current.error}</p>}
          {d && (
            <>
              <Section title="Outcome">
                <KV label="Status">
                  <StatusBadge status={d.status} /> <span className="ml-1 text-muted-foreground">HTTP {d.httpStatus}</span>
                </KV>
                <KV label="Time (UTC)">{fmtDateTime(d.createdAt)}</KV>
                {d.errorCode && <KV label="Error code"><code>{d.errorCode}</code></KV>}
                {d.errorMessage && <KV label="Customer-safe message">{d.errorMessage}</KV>}
              </Section>
              {d.internalError && (
                <section className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-red-500">Internal error (admin only)</h3>
                  <JsonView value={d.internalError} className="border-red-500/30" />
                </section>
              )}

              <Section title="Who & what">
                <KV label="Customer">
                  {d.user ? (
                    <Link href={`/admin/customers/${d.user.id}`} className="text-primary hover:underline">
                      {d.user.email}
                    </Link>
                  ) : (
                    "-"
                  )}
                </KV>
                <KV label="API key">{d.apiKey ? <>{d.apiKey.name} <code className="text-xs">({d.apiKey.prefix}…)</code></> : "-"}</KV>
                <KV label="Group">{d.groupSlug ?? "-"}</KV>
                <KV label="Public model (what the customer sees)"><code>{d.modelSlug ?? "-"}</code></KV>
                <KV label="Real upstream model (what ran)"><code>{d.upstreamModel ?? "-"}</code></KV>
                <KV label="Endpoint"><code className="text-xs">{d.endpoint}</code></KV>
                <KV label="Inbound format">{d.inboundFormat}</KV>
                <KV label="Provider">{d.provider?.name ?? "-"}</KV>
                <KV label="Provider key">{d.providerKey?.label ?? "-"}</KV>
                <KV label="Streaming">{d.stream ? "yes" : "no"}</KV>
                <KV label="IP">{d.ip ?? "-"}</KV>
                <KV label="User agent"><span className="text-xs">{d.userAgent ?? "-"}</span></KV>
              </Section>

              <Section title="Money">
                <KV label="Price (charged)"><MoneyText value={d.price} /></KV>
                <KV label="Cost (upstream)"><MoneyText value={d.cost} /></KV>
                <KV label="Profit"><MoneyText value={d.profit} colorize /></KV>
              </Section>

              <Section title="Usage">
                <KV label="Input tokens">{formatNumber(d.inputTokens)}</KV>
                <KV label="Output tokens">{formatNumber(d.outputTokens)}</KV>
                <KV label="Cached tokens">{formatNumber(d.cachedTokens)}</KV>
                <KV label="Cache write tokens">{formatNumber(d.cacheWriteTokens)}</KV>
                <KV label="Reasoning tokens">{formatNumber(d.reasoningTokens)}</KV>
                <KV label="Images">{formatNumber(d.imageCount)}</KV>
                <KV label="Audio seconds">{d.audioSeconds}</KV>
                <KV label="Characters">{formatNumber(d.characters)}</KV>
                <KV label="Usage estimated (tokenizer)">{d.usageEstimated ? "yes" : "no"}</KV>
              </Section>

              <Section title="Timing">
                <KV label="Latency">{d.latencyMs} ms</KV>
                <KV label="Time to first token">{d.ttftMs != null ? `${d.ttftMs} ms` : "-"}</KV>
                <KV label="Queue wait">{d.queueMs} ms</KV>
              </Section>

              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Upstream attempts ({d.attempts.length})</h3>
                {d.attempts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No attempts recorded.</p>
                ) : (
                  <>
                    <div className="overflow-x-auto rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>#</TableHead>
                            <TableHead>Provider / key</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Error</TableHead>
                            <TableHead className="text-right">Latency</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {d.attempts.map((a, i) => (
                            <TableRow key={i}>
                              <TableCell>{i + 1}</TableCell>
                              <TableCell className="text-xs">
                                {(a.providerName as string | null) ?? String(a.providerId ?? "-")}
                                {a.providerKeyLabel ? <span className="text-muted-foreground"> / {String(a.providerKeyLabel)}</span> : null}
                              </TableCell>
                              <TableCell>{a.status != null ? String(a.status) : "-"}</TableCell>
                              <TableCell className="max-w-48 truncate text-xs" title={a.error != null ? String(a.error) : ""}>
                                {a.error != null ? String(a.error) : ""}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{a.latencyMs != null ? `${String(a.latencyMs)}ms` : "-"}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <JsonView value={d.attempts} maxHeight={220} />
                  </>
                )}
              </section>

              <section className="space-y-1">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Request body</h3>
                {d.requestBody != null ? <JsonView value={d.requestBody} /> : <p className="text-sm text-muted-foreground">Not stored (enable &ldquo;Log request/response bodies&rdquo; in Settings).</p>}
              </section>
              <section className="space-y-1">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Response body</h3>
                {d.responseBody != null ? <JsonView value={d.responseBody} /> : <p className="text-sm text-muted-foreground">Not stored.</p>}
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
