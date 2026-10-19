import { Badge } from "@/components/ui/badge";
import { PriceExplainer, SavingsBadge } from "@/components/common/savings-badge";
import { formatCompact } from "@/lib/utils";
import {
  applyMultiplierToMap,
  buildUnitRows,
  formatRetireDate,
  formatUnitPrice,
  headlineSavings,
  type UnitPriceMap,
  type UnitPriceRow,
} from "@/server/customer/price-rows";
import { CAPABILITY_LABELS, vendorLabel } from "@/server/customer/labels";

/** Serializable subset of a catalog model used by the public + dashboard tables. */
export interface PriceModel {
  slug: string;
  displayName: string;
  vendor: string;
  capabilities: string[];
  contextWindow: number | null;
  retiresAt: string | null;
  /** Base customer prices per unit (multiplier is applied by buildPriceRows). */
  sell: UnitPriceMap;
  /** Official prices per unit. */
  official: UnitPriceMap;
}

export interface PriceRow {
  model: PriceModel;
  units: UnitPriceRow[];
  /** Blended input/output savings vs official (null when not comparable). */
  savings: number | null;
  isImage: boolean;
}

export function buildPriceRows(models: PriceModel[], multiplier: string): PriceRow[] {
  return models.map((model) => {
    const units = buildUnitRows(model.official, applyMultiplierToMap(model.sell, multiplier));
    const isImage = !!model.sell.image && model.capabilities.includes("images");
    return { model, units, savings: headlineSavings(units), isImage };
  });
}

function RetiringBadge({ date }: { date: string }) {
  return (
    <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-[10px] font-normal text-amber-700 dark:text-amber-400">
      Retiring {formatRetireDate(date)}
    </Badge>
  );
}

/**
 * Presentational price list: per model, per unit - Official price, Your price, Savings.
 * No hooks, so usable from server and client components. Stacks cleanly at 390px.
 */
export function PriceTable({ rows, showCapabilities = false, compact = false }: { rows: PriceRow[]; showCapabilities?: boolean; compact?: boolean }) {
  return (
    <div className="space-y-3">
      <PriceExplainer />
      <div className="divide-y overflow-hidden rounded-xl border bg-card/40">
        {rows.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">No models match your filters.</p>}
        {rows.map(({ model: m, units }) => {
          const shown = compact ? units.slice(0, 3) : units;
          return (
            <div key={m.slug} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{m.displayName}</span>
                    <Badge variant="secondary" className="font-normal">
                      {vendorLabel(m.vendor)}
                    </Badge>
                    {m.retiresAt && <RetiringBadge date={m.retiresAt} />}
                  </div>
                  <code className="block break-all text-xs text-muted-foreground">{m.slug}</code>
                  {showCapabilities && m.capabilities.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {m.capabilities.map((c) => (
                        <Badge key={c} variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
                          {CAPABILITY_LABELS[c] ?? c}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                {m.contextWindow ? <span className="text-xs text-muted-foreground">{formatCompact(m.contextWindow)} context</span> : null}
              </div>

              {shown.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No prices set.</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[22rem] text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="py-1 pr-3 font-medium">Unit</th>
                        <th className="px-3 py-1 text-right font-medium">Official price</th>
                        <th className="px-3 py-1 text-right font-medium">Your price</th>
                        <th className="py-1 pl-3 text-right font-medium">Savings</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {shown.map((r) => (
                        <tr key={r.unit.id}>
                          <td className="py-1.5 pr-3">
                            <span>{r.unit.label}</span>
                            <span className="ml-1 text-xs text-muted-foreground">{r.unit.per}</span>
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.official ? formatUnitPrice(r.unit, r.official) : "-"}</td>
                          <td className="px-3 py-1.5 text-right font-medium tabular-nums">{r.price ? formatUnitPrice(r.unit, r.price) : "-"}</td>
                          <td className="py-1.5 pl-3 text-right">
                            <SavingsBadge official={r.official} price={r.price} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Prices are in USD. Official prices are the original providers&apos; public list prices, shown for reference; amber means we are more expensive than official for that unit.
      </p>
    </div>
  );
}
