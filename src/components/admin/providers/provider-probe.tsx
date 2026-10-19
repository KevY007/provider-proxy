"use client";

import { useState } from "react";
import { CheckCircle2, CircleDollarSign, Loader2, PlugZap, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/common/form-fields";
import { useAction } from "@/components/admin/use-action";
import { probeProviderAction } from "@/server/admin/providers-actions";
import type { ProbeResult } from "@/gateway/upstream-models";
import type { ProviderFormState } from "./provider-form";

const money = (v: number | null | undefined, unit = ""): string => (v === null || v === undefined ? "-" : `$${Number(v.toPrecision(6))}${unit}`);

/**
 * "Test connection" + "Fetch pricing" for the provider form (new or saved). Uses the values currently in the form, so a
 * provider can be checked before it is saved; the key typed here is only used for this test and never stored.
 */
export function ProviderProbe({ state, providerId, hasKeys }: { state: ProviderFormState; providerId?: string; hasKeys?: boolean }) {
  const [secret, setSecret] = useState("");
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [what, setWhat] = useState<"test" | "pricing" | null>(null);
  const { run, pending } = useAction();

  async function probe(kind: "test" | "pricing") {
    setWhat(kind);
    setResult(null); // never show the previous probe's answer under the new heading
    await run(
      () =>
        probeProviderAction({
          providerId: providerId ?? null,
          what: kind,
          secret: secret.trim() || null,
          draft: { preset: state.preset, baseUrl: state.baseUrl, authStyle: state.authStyle, formats: state.formats, extraHeaders: state.extraHeaders, settings: state.settings },
        }),
      { success: "", refresh: false, onOk: (r) => r && setResult(r) },
    );
  }

  const r = result;
  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1">
          <TextField
            label="API key for the test (optional)"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            description={hasKeys ? "Leave empty to use this provider's first active key. Only used for this test, never stored." : "Used only for this test, never stored. Add the key itself under Keys after saving."}
          />
        </div>
        <Button type="button" variant="outline" disabled={pending || !state.baseUrl.trim()} onClick={() => void probe("test")}>
          {pending && what === "test" ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />} Test connection
        </Button>
        <Button type="button" variant="outline" disabled={pending || !state.baseUrl.trim()} onClick={() => void probe("pricing")}>
          {pending && what === "pricing" ? <Loader2 className="size-4 animate-spin" /> : <CircleDollarSign className="size-4" />} Fetch pricing
        </Button>
      </div>

      {r && what === "test" && (
        <div className="text-sm">
          {r.models.ok ? (
            <p className="flex flex-wrap items-center gap-2">
              <CheckCircle2 className="size-4 text-emerald-600" /> Connected in {r.latencyMs} ms - {r.models.count} model(s)
              {r.models.sample.length > 0 && <span className="text-muted-foreground">e.g. {r.models.sample.slice(0, 6).join(", ")}</span>}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-destructive">
              <XCircle className="size-4" /> {r.models.error ?? "Connection failed"}
            </p>
          )}
        </div>
      )}

      {r && what === "pricing" && (
        <div className="space-y-2 text-sm">
          {r.pricing.count > 0 ? (
            <>
              <p className="flex flex-wrap items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-600" /> The provider publishes prices for {r.pricing.count} model(s).
                <span className="text-muted-foreground">They are prefilled as Our cost when you add these models (check them before saving).</span>
              </p>
              <div className="max-h-72 overflow-auto rounded border bg-background">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted text-left">
                    <tr>
                      <th className="p-2 font-medium">Model</th>
                      <th className="p-2 font-medium">Input /1M</th>
                      <th className="p-2 font-medium">Output /1M</th>
                      <th className="p-2 font-medium">Cached /1M</th>
                      <th className="p-2 font-medium">Image</th>
                      <th className="p-2 font-medium">Context</th>
                      <th className="p-2 font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.pricing.rows.map((row) => (
                      <tr key={row.id} className="border-t">
                        <td className="p-2 font-mono">{row.id}</td>
                        <td className="p-2 tabular-nums">{money(row.prices.input)}</td>
                        <td className="p-2 tabular-nums">{money(row.prices.output)}</td>
                        <td className="p-2 tabular-nums">{money(row.prices.cachedInput)}</td>
                        <td className="p-2 tabular-nums">{money(row.prices.image)}</td>
                        <td className="p-2 tabular-nums">{row.contextWindow ? row.contextWindow.toLocaleString() : "-"}</td>
                        <td className="p-2 text-muted-foreground">{row.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">No prices found. This provider does not publish them through its API; enter Our cost by hand when adding models (or set <code>pricingUrl</code> in Settings to a price list URL).</p>
          )}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Checked {r.pricing.tried.length} URL(s)</summary>
            <ul className="mt-1 space-y-0.5">
              {r.pricing.tried.map((t) => (
                <li key={t.url} className="flex flex-wrap gap-2">
                  <Badge variant="outline">{t.status || "error"}</Badge>
                  <span className="font-mono">{t.url}</span>
                  {t.found > 0 && <span>{t.found} priced</span>}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}
