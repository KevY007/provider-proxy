"use client";

import { StatusBadge, type StatusTone } from "@/components/common/status-badge";

/** Renders an ISO timestamp in the viewer's locale/timezone (suppresses the SSR/CSR text difference). */
export function DateTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  if (!iso) return <span className="text-muted-foreground">-</span>;
  const d = new Date(iso);
  return (
    <time dateTime={iso} suppressHydrationWarning className={className}>
      {d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

export const LEDGER_LABELS: Record<string, string> = {
  TOPUP: "Top-up",
  AUTO_RECHARGE: "Auto-recharge",
  TRIAL_CREDIT: "Trial credit",
  REDEEM: "Redeemed code",
  ADJUSTMENT: "Adjustment",
  REFUND: "Refund",
  CHARGEBACK: "Chargeback",
  POSTPAID_SETTLEMENT: "Postpaid settlement",
  USAGE_CORRECTION: "Usage correction",
};

const LEDGER_TONES: Record<string, StatusTone> = {
  TOPUP: "success",
  AUTO_RECHARGE: "success",
  TRIAL_CREDIT: "info",
  REDEEM: "info",
  ADJUSTMENT: "neutral",
  REFUND: "warning",
  CHARGEBACK: "danger",
  POSTPAID_SETTLEMENT: "success",
  USAGE_CORRECTION: "neutral",
};

export function LedgerTypeBadge({ type }: { type: string }) {
  return <StatusBadge status={type} label={LEDGER_LABELS[type] ?? type} tone={LEDGER_TONES[type] ?? "neutral"} dot={false} />;
}

export const KIND_LABELS: Record<string, string> = {
  topup: "Top-up",
  auto_recharge: "Auto-recharge",
  postpaid_settlement: "Postpaid settlement",
};

export const PAYMENT_STATUSES = ["PENDING", "SUCCEEDED", "FAILED", "REFUNDED", "DISPUTED", "CANCELED"] as const;
