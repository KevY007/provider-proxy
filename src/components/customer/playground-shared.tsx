"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatUSD } from "@/lib/money";
import type { EffectivePrices, OfficialUnitPrices } from "@/server/customer/pricing";
import type { GatewayError } from "./playground-api";

export interface PlaygroundModel {
  slug: string;
  displayName: string;
  vendor: string;
  capabilities: string[];
  prices: EffectivePrices;
  /** Official list prices (reference for the per-run "saved" estimate). */
  official: OfficialUnitPrices;
}

/** "saved $0.0123" / "$0.0040 more than official" for a run (renders nothing when unknown or zero). */
export function SavedNote({ saved }: { saved: string | null | undefined }) {
  if (saved == null) return null;
  const n = Number(saved);
  if (!Number.isFinite(n) || Math.abs(n) < 1e-9) return null;
  return n > 0 ? (
    <span className="text-emerald-600 dark:text-emerald-400">saved {formatUSD(n)}</span>
  ) : (
    <span className="text-amber-600 dark:text-amber-400">{formatUSD(Math.abs(n))} more than official</span>
  );
}

/** Friendly rendering of gateway errors with a next step where one exists. */
export function GatewayErrorAlert({ error }: { error: GatewayError }) {
  const code = error.code ?? "";
  let title = "Request failed";
  let action: React.ReactNode = null;
  if (code === "insufficient_balance" || error.status === 402) {
    title = "Insufficient balance";
    action = (
      <Button asChild size="sm" className="mt-2">
        <Link href="/dashboard/billing">Add funds</Link>
      </Button>
    );
  } else if (code === "rate_limited" || code === "no_capacity" || error.status === 429) {
    title = "Rate limited";
  } else if (code === "model_not_found" || code === "model_not_allowed") {
    title = "Model unavailable";
  } else if (error.status >= 500) {
    title = "Upstream problem";
  }
  return (
    <Alert variant="destructive" className="border-red-500/30">
      <AlertTriangle />
      <AlertTitle>
        {title}
        {code && <span className="ml-2 font-mono text-xs font-normal opacity-80">{code}</span>}
      </AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
        {action}
        {code && (
          <Link href={`/docs/errors#${code}`} target="_blank" className="mt-1 inline-block text-xs underline-offset-2 hover:underline">
            What does this mean?
          </Link>
        )}
      </AlertDescription>
    </Alert>
  );
}
