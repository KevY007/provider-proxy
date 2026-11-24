"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAction } from "@/components/admin/use-action";
import { saveSettings } from "@/server/admin/settings-actions";
import { MAX_PRICING_TARGETS, pricingTargetsSchema, unavailablePricingTarget, type PricingPoolOption, type PricingTarget } from "@/server/pricing/price-sync/targets";

export function PricingRoutesForm({ initial, options, canEdit }: { initial: PricingTarget[]; options: PricingPoolOption[]; canEdit: boolean }) {
  const [rows, setRows] = useState(initial);
  const { run, pending, fieldErrors, clearErrors } = useAction();
  const dirty = JSON.stringify(initial) !== JSON.stringify(rows);
  const parsed = pricingTargetsSchema.safeParse(rows);
  const invalid = unavailablePricingTarget(rows, options);
  const error = !parsed.success ? parsed.error.issues[0].message : invalid ? `No chat route for ${invalid.model} in ${invalid.pool}. Choose a replacement.` : fieldErrors.priceSyncTargets;
  const unused = options.flatMap(({ pool, models }) => models.map((model) => ({ pool, model }))).find((t) => !rows.some((r) => r.pool === t.pool && r.model === t.model));
  function change(next: PricingTarget[]) { clearErrors(); setRows(next); }
  function replace(i: number, row: PricingTarget) { change(rows.map((r, j) => i === j ? row : r)); }
  function move(i: number, j: number) {
    const next = rows.slice();
    [next[i], next[j]] = [next[j], next[i]];
    change(next);
  }
  return <Card id="pricing-routes">
    <CardHeader>
      <CardTitle>Price sync AI routes</CardTitle>
      <CardDescription>Pricing page reads try these pairs from top to bottom until a call returns text. Each attempt is logged under Pricing fetch AI at our own cost.</CardDescription>
    </CardHeader>
    <CardContent>
      <fieldset disabled={!canEdit || pending} className="space-y-3">
        <ol className="space-y-2">{rows.map(({ pool, model }, i) => {
          const group = options.find((g) => g.pool === pool);
          return <li key={i} className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{i === 0 ? "Primary" : `Fallback ${i}`}</span>
            <select className="rounded-md border p-2 text-sm" aria-label={`Pool ${i + 1}`} value={pool} onChange={(e) => {
              const g = options.find((o) => o.pool === e.target.value)!;
              replace(i, { pool: g.pool, model: g.models.includes(model) ? model : g.models[0] });
            }}>
              {!group && <option value={pool} disabled>{pool} (unavailable)</option>}
              {options.map((g) => <option key={g.pool}>{g.pool}</option>)}
            </select>
            <select className="rounded-md border p-2 text-sm" aria-label={`Model ${i + 1}`} value={model} onChange={(e) => replace(i, { pool, model: e.target.value })}>
              {!group?.models.includes(model) && <option value={model} disabled>{model} (unavailable)</option>}
              {group?.models.map((m) => <option key={m}>{m}</option>)}
            </select>
            <Button variant="outline" size="sm" disabled={i === 0} onClick={() => move(i, i - 1)}>Up</Button>
            <Button variant="outline" size="sm" disabled={i === rows.length - 1} onClick={() => move(i, i + 1)}>Down</Button>
            <Button variant="outline" size="sm" disabled={rows.length === 1} onClick={() => change(rows.filter((_, j) => i !== j))}>Remove</Button>
          </li>;
        })}</ol>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {canEdit && <div className="flex gap-2">
          <Button variant="outline" disabled={!unused || rows.length >= MAX_PRICING_TARGETS} onClick={() => unused && change([...rows, unused])}>Add fallback</Button>
          <Button variant="outline" disabled={!dirty} onClick={() => change(initial)}>Discard</Button>
          <Button disabled={!dirty || !parsed.success || !!invalid} onClick={() => run(() => saveSettings({ priceSyncTargets: rows }))}>Save AI routes</Button>
        </div>}
      </fieldset>
    </CardContent>
  </Card>;
}
