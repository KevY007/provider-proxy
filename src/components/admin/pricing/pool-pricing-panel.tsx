"use client";

import { useMemo, useState } from "react";
import { Target as TargetIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DEFAULT_WORKLOAD, economics, fmtMoney, fmtPctN, solveFactor, sumEconomics, workloadPrice, workloadTotal, type Economics, type Target } from "@/lib/price-economics";
import type { PoolSampleModel } from "@/server/admin/groups-queries";

export type PoolBasis = "model" | "cost";

const BASIS: Array<{ id: PoolBasis; label: string; hint: string }> = [
  { id: "model", label: "% of the model price", hint: "Model prices usually equal the official list price, so 30% = customers pay 30% of what OpenAI / Anthropic charge." },
  { id: "cost", label: "% of our upstream cost", hint: "Follows what the provider that serves each request charges us: 150% = a 50% markup, always profitable. Never above list price." },
];

/**
 * Pool pricing: basis + percentage, with a live "on 10M tokens" preview (revenue, upstream cost, profit, customer
 * saving) over the pool's models and a target helper that fills the percentage in.
 */
export function PoolPricingPanel({
  poolSlug,
  basis,
  onBasis,
  pct,
  onPct,
  error,
  samples,
  allowedModels,
}: {
  poolSlug: string;
  basis: PoolBasis;
  onBasis: (b: PoolBasis) => void;
  pct: string;
  onPct: (v: string) => void;
  error?: string;
  samples: PoolSampleModel[];
  allowedModels: string[];
}) {
  const factor = Number(pct) / 100;
  const models = useMemo(() => samples.filter((m) => (allowedModels.length ? allowedModels.includes(m.slug) : true) && m.cost[poolSlug] !== undefined), [samples, allowedModels, poolSlug]);
  const rows = useMemo(() => {
    const w = DEFAULT_WORKLOAD;
    return models.map((m) => {
      const cost = m.cost[poolSlug];
      const costAmt = cost ? workloadPrice(cost, w) : 0;
      const list = m.official ? workloadPrice(m.official, w) : null;
      const basisAmt = basis === "cost" && cost ? costAmt : workloadPrice(m.model, w);
      let revenue = Number.isFinite(factor) ? basisAmt * factor : 0;
      if (basis === "cost" && list !== null && revenue > list) revenue = list; // the gateway never bills above list
      return { slug: m.slug, basisAmt, e: economics(revenue, costAmt, list), hasCost: !!cost };
    });
  }, [models, poolSlug, basis, factor]);
  const total = useMemo(() => sumEconomics(rows.map((r) => r.e)), [rows]);
  const tokens = workloadTotal(DEFAULT_WORKLOAD);

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <p className="text-sm font-medium">What customers in this pool pay</p>
        <div role="radiogroup" aria-label="Price basis" className="mt-2 grid gap-2 sm:grid-cols-2">
          {BASIS.map((b) => (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={basis === b.id}
              onClick={() => onBasis(b.id)}
              className={cn("rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50", basis === b.id ? "border-primary bg-primary/5" : "border-border")}
            >
              <span className="block font-medium">{b.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{b.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="pool-pct" className="text-sm font-medium">
            Percentage
          </label>
          <div className="flex items-center gap-2">
            <Input id="pool-pct" type="number" step="any" min={0} inputMode="decimal" value={pct} onChange={(e) => onPct(e.target.value)} aria-invalid={!!error} className="h-9 w-28 tabular-nums" />
            <span className="text-sm text-muted-foreground">{basis === "cost" ? "% of upstream cost" : "% of model price"}</span>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <TargetFiller basis={basis} total={total} basisTotal={rows.reduce((a, r) => a + r.basisAmt, 0)} onPct={onPct} />
      </div>

      <EconomicsSummary e={total} tokensM={tokens} models={rows.length} />
      {rows.length > 0 && <EconomicsTable rows={rows} />}
    </div>
  );
}

/** "On 10M tokens across N models: customers pay $X, upstream costs $Y, profit $Z (M% margin), they save S% vs list." */
export function EconomicsSummary({ e, tokensM, models }: { e: Economics; tokensM: number; models?: number }) {
  const loss = e.profit < 0;
  return (
    <div className="grid gap-2 sm:grid-cols-4" aria-live="polite">
      <Stat label={`Customer pays${models !== undefined ? ` (${tokensM}M tokens per model)` : ` (${tokensM}M tokens)`}`} value={fmtMoney(e.revenue)} />
      <Stat label="Upstream cost" value={fmtMoney(e.cost)} />
      <Stat label="Profit" value={`${fmtMoney(e.profit)} (${fmtPctN(e.marginPct)})`} tone={loss ? "bad" : e.profit > 0 ? "good" : undefined} />
      <Stat label="Customer saves vs list" value={e.savingsPct === null ? "-" : fmtPctN(e.savingsPct)} tone={e.savingsPct !== null && e.savingsPct < 0 ? "bad" : undefined} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-md bg-muted/40 p-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("text-sm font-semibold tabular-nums", tone === "good" && "text-emerald-600 dark:text-emerald-400", tone === "bad" && "text-red-600 dark:text-red-400")}>{value}</p>
    </div>
  );
}

const TARGETS: Array<{ id: Target["kind"]; label: string }> = [
  { id: "revenue_per_cost", label: "Revenue per upstream spend" },
  { id: "margin", label: "Profit margin %" },
  { id: "markup", label: "Markup over cost %" },
  { id: "savings", label: "Customer saving vs list %" },
];

/** Pick a goal ("$40 revenue for every $30 we spend upstream", "40% margin", "save customers 70%") and fill the percentage. */
export function TargetFiller({ basis, total, basisTotal, onPct }: { basis: PoolBasis | "rule"; total: Economics; basisTotal: number; onPct: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Target["kind"]>("revenue_per_cost");
  const [a, setA] = useState("40");
  const [b, setB] = useState("30");
  const target: Target = kind === "revenue_per_cost" ? { kind, revenue: Number(a), cost: Number(b) } : { kind, pct: Number(a) };
  const factor = solveFactor(target, basisTotal, total.cost, total.list);
  const pctOut = factor === null ? null : Math.round(factor * 10000) / 100;
  if (!open)
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <TargetIcon className="size-4" /> Fill from a target
      </Button>
    );
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-2">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor="target-kind">
          Target
        </label>
        <select id="target-kind" value={kind} onChange={(e) => setKind(e.target.value as Target["kind"])} className="h-8 rounded-md border bg-background px-2 text-sm">
          {TARGETS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      {kind === "revenue_per_cost" ? (
        <>
          <TargetInput id="t-rev" label="Revenue $" value={a} onChange={setA} />
          <span className="pb-1.5 text-sm text-muted-foreground">for every</span>
          <TargetInput id="t-cost" label="Upstream spend $" value={b} onChange={setB} />
        </>
      ) : (
        <TargetInput id="t-pct" label="%" value={a} onChange={setA} />
      )}
      <Button type="button" size="sm" disabled={pctOut === null} onClick={() => pctOut !== null && onPct(String(pctOut))}>
        {pctOut === null ? "Not reachable" : `Use ${pctOut}%${basis === "cost" ? " of cost" : basis === "model" ? " of model price" : ""}`}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Close
      </Button>
    </div>
  );
}

function TargetInput({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground" htmlFor={id}>
        {label}
      </label>
      <Input id={id} type="number" step="any" min={0} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} className="h-8 w-24 tabular-nums" />
    </div>
  );
}

function EconomicsTable({ rows }: { rows: Array<{ slug: string; e: Economics; hasCost: boolean }> }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 6);
  return (
    <div className="space-y-1">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[34rem] text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Model (10M tokens)</th>
              <th className="px-2 py-1.5 text-right font-medium">Customer pays</th>
              <th className="px-2 py-1.5 text-right font-medium">Upstream cost</th>
              <th className="px-2 py-1.5 text-right font-medium">Profit</th>
              <th className="px-2 py-1.5 text-right font-medium">Saves vs list</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.slug} className={cn("border-t", r.e.profit < 0 && "bg-red-500/5")}>
                <td className="px-2 py-1 font-mono text-xs">{r.slug}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtMoney(r.e.revenue)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{r.hasCost ? fmtMoney(r.e.cost) : <span className="text-muted-foreground">no route</span>}</td>
                <td className={cn("px-2 py-1 text-right tabular-nums", r.e.profit < 0 ? "text-red-600 dark:text-red-400" : "")}>{fmtMoney(r.e.profit)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtPctN(r.e.savingsPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 6 && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setAll((x) => !x)}>
          {all ? "Show fewer" : `Show all ${rows.length} models`}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">10M tokens = 3.75M input, 3.75M cached input, 2.5M output. Upstream cost is the route this pool uses first.</p>
    </div>
  );
}
