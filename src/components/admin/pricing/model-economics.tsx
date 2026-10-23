"use client";

import { useMemo } from "react";
import { DEFAULT_WORKLOAD, economics, fmtMoney, fmtPctN, workloadPrice, workloadTotal, type TokenPrices } from "@/lib/price-economics";
import { cn } from "@/lib/utils";
import { EconomicsSummary, TargetFiller } from "./pool-pricing-panel";

/**
 * Live economics of a model's price on 10M tokens: the model price itself, and what each pool's customers end up
 * paying (pool percentage on top), against our upstream cost and the official list price. `onFactor` fills the rule
 * value from a target (factor on the BASIS of the rule: the official price or our cost).
 */
export function ModelEconomics({
  customer,
  cost,
  official,
  pools,
  ruleBasis,
  onRuleValue,
}: {
  /** model (customer) prices per 1M tokens as currently derived */
  customer: TokenPrices;
  cost: TokenPrices | null;
  official: TokenPrices | null;
  pools: Array<{ slug: string; name: string; multiplier?: number; basis?: "model" | "cost"; allowed?: boolean }>;
  /** what the rule value multiplies: "official" (% of official), "cost" (% of / markup over cost), null (fixed prices) */
  ruleBasis: { kind: "official" | "cost" | "markup"; } | null;
  onRuleValue?: (v: string) => void;
}) {
  const w = DEFAULT_WORKLOAD;
  const tokens = workloadTotal(w);
  const costAmt = cost ? workloadPrice(cost, w) : 0;
  const listAmt = official ? workloadPrice(official, w) : null;
  const base = economics(workloadPrice(customer, w), costAmt, listAmt);
  const poolRows = useMemo(
    () =>
      pools
        .filter((p) => p.allowed !== false && p.multiplier !== undefined)
        .map((p) => {
          let rev = p.basis === "cost" && cost ? costAmt * p.multiplier! : base.revenue * p.multiplier!;
          if (p.basis === "cost" && listAmt !== null && rev > listAmt) rev = listAmt;
          return { ...p, e: economics(rev, costAmt, listAmt) };
        }),
    [pools, cost, costAmt, base.revenue, listAmt],
  );
  const basisAmt = ruleBasis?.kind === "official" ? listAmt ?? 0 : costAmt;
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">On {tokens}M tokens at the model price</p>
        {ruleBasis && onRuleValue && (
          <TargetFiller
            basis="rule"
            total={base}
            basisTotal={basisAmt}
            onPct={(pct) => onRuleValue(ruleBasis.kind === "markup" ? String(Math.round((Number(pct) - 100) * 100) / 100) : pct)}
          />
        )}
      </div>
      <EconomicsSummary e={base} tokensM={tokens} />
      {poolRows.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[30rem] text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Pool</th>
                <th className="px-2 py-1.5 text-right font-medium">Customer pays</th>
                <th className="px-2 py-1.5 text-right font-medium">Profit</th>
                <th className="px-2 py-1.5 text-right font-medium">Saves vs list</th>
              </tr>
            </thead>
            <tbody>
              {poolRows.map((p) => (
                <tr key={p.slug} className={cn("border-t", p.e.profit < 0 && "bg-red-500/5")}>
                  <td className="px-2 py-1">
                    {p.name} <span className="text-xs text-muted-foreground">{Math.round(p.multiplier! * 10000) / 100}% of {p.basis === "cost" ? "cost" : "model price"}</span>
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtMoney(p.e.revenue)}</td>
                  <td className={cn("px-2 py-1 text-right tabular-nums", p.e.profit < 0 && "text-red-600 dark:text-red-400")}>
                    {fmtMoney(p.e.profit)} <span className="text-xs text-muted-foreground">({fmtPctN(p.e.marginPct)})</span>
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtPctN(p.e.savingsPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">10M tokens = 3.75M input, 3.75M cached input, 2.5M output. Upstream cost = the primary route.</p>
    </div>
  );
}
