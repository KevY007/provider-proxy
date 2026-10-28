"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";
import { MoneyText } from "@/components/common/money-text";
import { SavingsBadge } from "@/components/common/savings-badge";
import { StatusBadge } from "@/components/common/status-badge";
import { fmtDateTime } from "@/components/admin/format";
import { JsonView, KV } from "@/components/admin/misc";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatToolUsage } from "@/lib/tool-usage";
import { cn, formatNumber } from "@/lib/utils";
import { getLogDetail } from "@/server/admin/logs-actions";
import type { LogDetail } from "@/server/admin/logs-queries";
import { attemptStatusLabel, explainError, logStatusInfo, parseAttempts } from "@/server/customer/log-status";

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-1", className)}>
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
  const st = d ? logStatusInfo(d.status, d.httpStatus) : null;
  const explained = d ? explainError(d.errorCode, d.errorMessage) : null;
  const attempts = d ? parseAttempts(d.attempts) : [];
  const attemptMeta = d ? (d.attempts as Array<Record<string, unknown>>) : [];
  const saved = d ? Number(d.officialPrice) - Number(d.price) : 0;

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Request detail</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-1 font-mono text-xs">
            <span className="break-all">{id}</span> {id && <CopyButton value={id} toastMessage="Request id copied" />}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-6">
          {!current && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          )}
          {current?.error && <p className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">{current.error}</p>}
          {d && st && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={d.status} label={st.label} tone={st.tone} className="text-sm" />
                <span className="text-sm text-muted-foreground">HTTP {d.httpStatus}</span>
                <span className="text-sm text-muted-foreground">· {fmtDateTime(d.createdAt)} UTC</span>
              </div>
              {st.hint && <p className="-mt-3 text-sm text-muted-foreground">{st.hint}</p>}

              {explained && (
                <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{explained.code}</code>
                    <Link href={explained.docsHref} target="_blank" className="inline-flex items-center gap-1 text-xs font-normal text-primary hover:underline">
                      What does this mean? <ExternalLink className="size-3" />
                    </Link>
                  </p>
                  <p>{explained.meaning}</p>
                  {explained.fix && <p className="text-muted-foreground">How to fix: {explained.fix}</p>}
                  {d.errorMessage && <p className="text-xs text-muted-foreground">Customer saw: &ldquo;{d.errorMessage}&rdquo;</p>}
                </div>
              )}
              {d.internalError && (
                <section className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-red-500">Internal error (admin only)</h3>
                  <JsonView value={d.internalError} className="border-red-500/30" />
                </section>
              )}

              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What the customer saw vs what ran</h3>
                <div className="grid items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr]">
                  <div className="rounded-lg border p-3 text-sm">
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Customer called</p>
                    <p className="font-mono text-sm font-medium break-all">{d.modelSlug ?? "-"}</p>
                    <p className="mt-1 font-mono text-xs break-all text-muted-foreground">{d.endpoint}</p>
                    <p className="text-xs text-muted-foreground">{d.inboundFormat} format{d.stream ? " · streaming" : ""}</p>
                    <p className="mt-1 text-xs">
                      Charged <MoneyText value={d.price} />
                    </p>
                  </div>
                  <ArrowRight className="hidden size-5 self-center text-muted-foreground sm:block" aria-hidden />
                  <div className="rounded-lg border p-3 text-sm">
                    <p className="mb-1 text-xs font-medium text-muted-foreground">What actually ran</p>
                    <p className="font-mono text-sm font-medium break-all">{d.upstreamModel ?? "-"}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {d.provider?.name ?? "No provider reached"}
                      {d.providerKey?.label ? ` / ${d.providerKey.label}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {attempts.length} attempt{attempts.length === 1 ? "" : "s"} · {d.latencyMs} ms
                    </p>
                    <p className="mt-1 text-xs">
                      Our cost <MoneyText value={d.cost} />
                    </p>
                  </div>
                </div>
              </section>

              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Attempts timeline ({attempts.length})</h3>
                {attempts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No upstream attempts were made (the request was stopped before reaching a provider).</p>
                ) : (
                  <ol className="space-y-0">
                    {attempts.map((a, i) => {
                      const meta = attemptMeta[i] ?? {};
                      const provider = (meta.providerName as string | null) ?? a.providerId ?? "unknown provider";
                      const key = meta.providerKeyLabel as string | null;
                      const model = meta.upstreamModel as string | null;
                      const last = i === attempts.length - 1;
                      return (
                        <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
                          {!last && <span className="absolute top-6 left-[9px] h-[calc(100%-1rem)] w-px bg-border" aria-hidden />}
                          {a.ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-500" aria-label="Succeeded" /> : <XCircle className="mt-0.5 size-5 shrink-0 text-red-500" aria-label="Failed" />}
                          <div className="min-w-0 flex-1 text-sm">
                            <p className="font-medium">
                              #{i + 1} {provider}
                              {key && <span className="font-normal text-muted-foreground"> / {key}</span>}
                              {last && a.ok && <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-600 dark:text-emerald-400">served</span>}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {model && <span className="font-mono">{model}</span>}
                              {model && " · "}
                              HTTP {a.status ?? "?"} · {attemptStatusLabel(a.status)} · {a.latencyMs != null ? `${a.latencyMs} ms` : "no timing"}
                            </p>
                            {a.error && <p className="mt-0.5 line-clamp-3 text-xs break-words text-red-600 dark:text-red-400">{a.error}</p>}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
                {attempts.length > 0 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Raw attempts JSON</summary><JsonView value={d.attempts} maxHeight={220} className="mt-1" /></details>}
              </section>

              <Section title="Money">
                <KV label="Official price (at the provider's list price)"><MoneyText value={d.officialPrice} /></KV>
                <KV label="Customer price (charged)"><MoneyText value={d.price} /></KV>
                <KV label="Savings for the customer">
                  {Number(d.officialPrice) > 0 ? (
                    <span className="inline-flex flex-wrap items-center justify-end gap-2">
                      <MoneyText value={saved} signed colorize /> <SavingsBadge official={d.officialPrice} price={d.price} />
                    </span>
                  ) : (
                    <span className="text-muted-foreground">no official price recorded</span>
                  )}
                </KV>
                <KV label="Our cost (paid to supplier)"><MoneyText value={d.cost} /></KV>
                <KV label="Margin (profit)"><MoneyText value={d.profit} colorize /></KV>
                {Number(d.waived) > 0 && (
                  <KV label="Waived (balance empty)">
                    <MoneyText value={d.waived} /> not taken from the balance
                  </KV>
                )}
              </Section>

              <Section title="Who & where">
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
                <KV label="IP">{d.ip ?? "-"}</KV>
                <KV label="User agent"><span className="text-xs">{d.userAgent ?? "-"}</span></KV>
              </Section>

              <Section title="Usage">
                <KV label="Input tokens">{formatNumber(d.inputTokens)}</KV>
                <KV label="Output tokens">{formatNumber(d.outputTokens)}</KV>
                <KV label="Cached tokens">{formatNumber(d.cachedTokens)}</KV>
                <KV label="Cache write tokens">{formatNumber(d.cacheWriteTokens)}</KV>
                <KV label="Reasoning tokens">{formatNumber(d.reasoningTokens)}</KV>
                <KV label="Images">{formatNumber(d.imageCount)}</KV>
                <KV label="Video seconds">{d.videoSeconds}</KV>
                <KV label="Audio seconds">{d.audioSeconds}</KV>
                <KV label="Characters">{formatNumber(d.characters)}</KV>
                <KV label="Usage estimated (tokenizer)">{d.usageEstimated ? "yes" : "no"}</KV>
                <KV label="Server tools">{Object.keys(d.toolUsage).length ? <span className="font-mono text-xs">{formatToolUsage(d.toolUsage)}</span> : "-"}</KV>
                {d.batchId && (
                  <KV label="Batch">
                    <span className="inline-flex items-center gap-1 break-all font-mono text-xs">
                      {d.batchId} <CopyButton value={d.batchId} />
                    </span>
                  </KV>
                )}
              </Section>

              <Section title="Timing">
                <KV label="Latency">{d.latencyMs} ms</KV>
                <KV label="Time to first token">{d.ttftMs != null ? `${d.ttftMs} ms` : "-"}</KV>
                <KV label="Queue wait">{d.queueMs} ms</KV>
              </Section>

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
