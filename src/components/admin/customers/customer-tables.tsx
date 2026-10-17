"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { MoneyText } from "@/components/common/money-text";
import { StatusBadge } from "@/components/common/status-badge";
import { fmtDateTime, timeAgo } from "@/components/admin/format";
import { ApiKeyActions } from "@/components/admin/keys/key-actions";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/utils";
import type { CustomerDetail } from "@/server/admin/customers-queries";

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto rounded-lg border">{children}</div>;
}

export function CustomerKeysTable({ keys }: { keys: CustomerDetail["keys"] }) {
  if (!keys.length) return <EmptyState title="No API keys" description="This customer has not created any keys." />;
  return (
    <Frame>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Prefix</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Group</TableHead>
            <TableHead className="text-right">Spent</TableHead>
            <TableHead className="text-right">Limit</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>Created</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((k) => (
            <TableRow key={k.id}>
              <TableCell className="font-medium">
                {k.name} {k.isPlayground && <Badge variant="outline">playground</Badge>}
              </TableCell>
              <TableCell>
                <code className="text-xs">{k.prefix}…</code>
              </TableCell>
              <TableCell>
                <StatusBadge status={k.status} />
              </TableCell>
              <TableCell>{k.groupName ?? <span className="text-muted-foreground">inherit</span>}</TableCell>
              <TableCell className="text-right">
                <MoneyText value={k.spent} />
              </TableCell>
              <TableCell className="text-right">{k.spendLimit ? <MoneyText value={k.spendLimit} /> : <span className="text-muted-foreground">none</span>}</TableCell>
              <TableCell suppressHydrationWarning>{timeAgo(k.lastUsedAt)}</TableCell>
              <TableCell>{fmtDateTime(k.createdAt, false)}</TableCell>
              <TableCell className="text-right">
                <ApiKeyActions id={k.id} name={k.name} status={k.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Frame>
  );
}

export function CustomerLogsTable({ logs, userId }: { logs: CustomerDetail["logs"]; userId: string }) {
  if (!logs.length) return <EmptyState title="No requests yet" />;
  return (
    <div className="space-y-2">
      <Frame>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time (UTC)</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Endpoint</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Latency</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((l) => (
              <TableRow key={l.id}>
                <TableCell>
                  <Link href={`/admin/logs?user=${userId}&range=90d&log=${l.id}`} className="text-primary hover:underline">
                    {fmtDateTime(l.createdAt)}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{l.modelSlug ?? "-"}</TableCell>
                <TableCell className="font-mono text-xs">{l.endpoint}</TableCell>
                <TableCell>
                  <StatusBadge status={l.status} />
                  {l.errorCode && <span className="ml-2 text-xs text-muted-foreground">{l.errorCode}</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(l.tokens)}</TableCell>
                <TableCell className="text-right">
                  <MoneyText value={l.price} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{l.latencyMs}ms</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Frame>
      <Link href={`/admin/logs?user=${userId}&range=90d`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
        View all logs for this customer <ExternalLink className="size-3.5" />
      </Link>
    </div>
  );
}

export function PaymentsTable({ payments }: { payments: CustomerDetail["payments"] }) {
  if (!payments.length) return <EmptyState title="No payments" description="No Stripe payments recorded for this customer." />;
  return (
    <Frame>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date (UTC)</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Note</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.map((p) => (
            <TableRow key={p.id}>
              <TableCell>{fmtDateTime(p.createdAt, false)}</TableCell>
              <TableCell>{p.kind.replace(/_/g, " ")}</TableCell>
              <TableCell>
                <StatusBadge status={p.status} />
              </TableCell>
              <TableCell className="text-right">
                <MoneyText value={p.amount} /> <span className="text-xs uppercase text-muted-foreground">{p.currency}</span>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {p.failureReason ?? ""}
                {p.receiptUrl && (
                  <a href={p.receiptUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    receipt
                  </a>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Frame>
  );
}

export function LedgerTable({ ledger }: { ledger: CustomerDetail["ledger"] }) {
  if (!ledger.length) return <EmptyState title="No ledger entries" description="Top-ups, credits and adjustments appear here." />;
  return (
    <Frame>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date (UTC)</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Balance after</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>By</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ledger.map((l) => (
            <TableRow key={l.id}>
              <TableCell>{fmtDateTime(l.createdAt, false)}</TableCell>
              <TableCell>
                <Badge variant="outline">{l.type.replace(/_/g, " ").toLowerCase()}</Badge>
              </TableCell>
              <TableCell className="text-right">
                <MoneyText value={l.amount} signed colorize />
              </TableCell>
              <TableCell className="text-right">
                <MoneyText value={l.balanceAfter} />
              </TableCell>
              <TableCell className="max-w-xs truncate" title={l.description}>
                {l.description}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{l.createdBy ?? "-"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Frame>
  );
}

export function SessionsTable({ sessions }: { sessions: CustomerDetail["sessions"] }) {
  if (!sessions.length) return <EmptyState title="No active sessions" />;
  return (
    <Frame>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Started (UTC)</TableHead>
            <TableHead>IP</TableHead>
            <TableHead>Device</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((s) => (
            <TableRow key={s.id}>
              <TableCell>{fmtDateTime(s.createdAt, false)}</TableCell>
              <TableCell className="font-mono text-xs">{s.ip ?? "-"}</TableCell>
              <TableCell className="max-w-sm truncate text-xs text-muted-foreground" title={s.userAgent ?? ""}>
                {s.userAgent ?? "-"}
              </TableCell>
              <TableCell>{fmtDateTime(s.expiresAt, false)}</TableCell>
              <TableCell>{s.impersonated && <Badge variant="secondary">impersonated</Badge>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Frame>
  );
}
