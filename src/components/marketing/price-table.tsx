import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCompact, cn } from "@/lib/utils";
import { formatPricePerMillion, formatUSD } from "@/lib/money";
import { effectivePrices, savingsPercent, type EffectivePrices } from "@/server/customer/pricing";
import { CAPABILITY_LABELS, vendorLabel } from "@/server/customer/labels";

/** Serializable subset of a catalog model used by the public tables. */
export interface PriceModel {
  slug: string;
  displayName: string;
  vendor: string;
  capabilities: string[];
  contextWindow: number | null;
  inputPrice: string;
  outputPrice: string;
  cachedInputPrice: string | null;
  cacheWritePrice: string | null;
  imagePrice: string | null;
  requestPrice: string | null;
  officialInputPrice: string | null;
  officialOutputPrice: string | null;
  officialCachedPrice: string | null;
}

export interface PriceRow {
  model: PriceModel;
  eff: EffectivePrices;
  savings: number | null;
  isImage: boolean;
}

export function buildPriceRows(models: PriceModel[], multiplier: string): PriceRow[] {
  return models.map((model) => {
    const eff = effectivePrices(model, multiplier);
    const isImage = !!model.imagePrice && model.capabilities.includes("images");
    return { model, eff, savings: isImage ? null : savingsPercent(model, eff), isImage };
  });
}

export function SavingsBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-muted-foreground">-</span>;
  const r = Math.round(pct);
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-semibold tabular-nums",
        r > 0 ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
      )}
    >
      {r > 0 ? `${r}% off` : r === 0 ? "same" : `+${Math.abs(r)}%`}
    </Badge>
  );
}

const priceM = (v: string | null) => (v === null ? "-" : formatPricePerMillion(v));

/** Presentational table: official vs our price with savings. No hooks, so usable from server and client components. */
export function PriceTable({ rows, showCapabilities = false }: { rows: PriceRow[]; showCapabilities?: boolean }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card/40">
      <Table>
        <TableHeader className="bg-muted/40">
          <TableRow className="hover:bg-transparent">
            <TableHead className="min-w-[200px]">Model</TableHead>
            <TableHead className="hidden text-right md:table-cell">Context</TableHead>
            <TableHead className="text-right">Official (in / out)</TableHead>
            <TableHead className="text-right">Ours (in / out)</TableHead>
            <TableHead className="hidden text-right lg:table-cell">Cached in</TableHead>
            <TableHead className="text-right">Saved</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                No models match your filters.
              </TableCell>
            </TableRow>
          )}
          {rows.map(({ model: m, eff, savings, isImage }) => (
            <TableRow key={m.slug}>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{m.displayName}</span>
                    <Badge variant="secondary" className="font-normal">
                      {vendorLabel(m.vendor)}
                    </Badge>
                  </div>
                  <code className="w-fit text-xs text-muted-foreground">{m.slug}</code>
                  {showCapabilities && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {m.capabilities.map((c) => (
                        <Badge key={c} variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
                          {CAPABILITY_LABELS[c] ?? c}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </TableCell>
              <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">
                {m.contextWindow ? formatCompact(m.contextWindow) : "-"}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {isImage ? (
                  "-"
                ) : m.officialInputPrice !== null ? (
                  <span className={savings !== null && savings > 0 ? "line-through decoration-muted-foreground/40" : ""}>
                    {priceM(m.officialInputPrice)} / {priceM(m.officialOutputPrice)}
                  </span>
                ) : (
                  "-"
                )}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {isImage ? (
                  <>{formatUSD(eff.image)} <span className="text-xs font-normal text-muted-foreground">/ image</span></>
                ) : (
                  <>
                    {priceM(eff.input)} / {priceM(eff.output)}
                    {eff.request && <div className="text-xs font-normal text-muted-foreground">+ {formatUSD(eff.request)} / request</div>}
                  </>
                )}
              </TableCell>
              <TableCell className="hidden text-right tabular-nums text-muted-foreground lg:table-cell">
                {isImage ? "-" : priceM(eff.cachedInput)}
              </TableCell>
              <TableCell className="text-right">
                <SavingsBadge pct={savings} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="border-t px-4 py-2 text-xs text-muted-foreground">USD per 1M tokens unless noted. Official prices are the vendors&apos; list prices for reference.</p>
    </div>
  );
}
