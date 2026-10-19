import { Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MoneyLike } from "@/lib/money";
import { describeSavings, SAVINGS_TONE_CLASS } from "@/server/customer/savings";

/** Green "−62% vs official" / amber "+15% vs official" pill. Transparent: premiums are shown, never hidden. */
export function SavingsBadge({ official, price, className }: { official: MoneyLike; price: MoneyLike; className?: string }) {
  const s = describeSavings(official, price);
  if (s.tone === "unknown") return <span className={cn("text-xs text-muted-foreground", className)}>-</span>;
  return (
    <Badge variant="outline" className={cn("whitespace-nowrap font-medium tabular-nums", SAVINGS_TONE_CLASS[s.tone], className)}>
      {s.label}
    </Badge>
  );
}

export const PRICE_GLOSSARY = {
  official: "Official price = what OpenAI, Anthropic and the other model makers charge when you buy directly from them.",
  yours: "Your price = what you pay us (includes your pool discount).",
  customer: "Customer price = what we charge the customer (after group and customer multipliers).",
  cost: "Our cost = what we pay our supplier for this model.",
  savings: "Savings = Official price − Your price. Amber means we are more expensive than the official price.",
  margin: "Margin = Customer price − Our cost. Red means we lose money on every request.",
} as const;

/** One-line explainer shown above price tables. */
export function PriceExplainer({ audience = "customer", className }: { audience?: "customer" | "admin"; className?: string }) {
  return (
    <p className={cn("flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground", className)}>
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        {audience === "customer" ? (
          <>
            <strong className="font-medium text-foreground">Official price</strong> = what OpenAI, Anthropic and other providers charge directly.{" "}
            <strong className="font-medium text-foreground">Your price</strong> = what you pay us.{" "}
            <strong className="font-medium text-foreground">Savings</strong> compares the two. If we are ever more expensive, it shows in amber.
          </>
        ) : (
          <>
            <strong className="font-medium text-foreground">Official price</strong> = the original provider&apos;s list price. <strong className="font-medium text-foreground">Our cost</strong> = what we pay our supplier.{" "}
            <strong className="font-medium text-foreground">Customer price</strong> = what we charge. <strong className="font-medium text-foreground">Savings</strong> = Official &minus; Customer price.{" "}
            <strong className="font-medium text-foreground">Margin</strong> = Customer price &minus; Our cost.
          </>
        )}
      </span>
    </p>
  );
}

/** Small (i) icon with a tooltip carrying one glossary definition. */
export function GlossaryTip({ term, className }: { term: keyof typeof PRICE_GLOSSARY; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={PRICE_GLOSSARY[term]} className={cn("inline-flex align-middle text-muted-foreground hover:text-foreground", className)}>
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{PRICE_GLOSSARY[term]}</TooltipContent>
    </Tooltip>
  );
}
