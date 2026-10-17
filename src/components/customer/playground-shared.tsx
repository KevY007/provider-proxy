"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { EffectivePrices } from "@/server/customer/pricing";
import type { GatewayError } from "./playground-api";

export interface PlaygroundModel {
  slug: string;
  displayName: string;
  vendor: string;
  capabilities: string[];
  prices: EffectivePrices;
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
