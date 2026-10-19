"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, KeyRound, Loader2, Search } from "lucide-react";
import { StatusBadge } from "@/components/common/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { lookupKnownForProvider, listProviderModels, type KnownLookup } from "@/server/admin/models-actions";
import type { WizardProvider } from "@/server/admin/models-queries";
import { knownSummary } from "@/server/admin/wizard-calc";
import type { UpstreamModel } from "@/gateway/upstream-models";
import { cn } from "@/lib/utils";

/** Step 1: only ACTIVE providers that have at least one active key are selectable; the rest explain what is missing. */
export function ProviderPicker({ providers, value, onChange }: { providers: WizardProvider[]; value: string; onChange: (id: string) => void }) {
  if (providers.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No providers yet.{" "}
        <Link href="/admin/providers" className="text-primary underline-offset-4 hover:underline">
          Add a provider and an API key first
        </Link>
        .
      </div>
    );
  }
  return (
    <div role="radiogroup" aria-label="Provider" className="grid gap-3 sm:grid-cols-2">
      {providers.map((p) => {
        const usable = p.status === "ACTIVE" && p.keysActive > 0;
        const on = value === p.id;
        const why = p.status !== "ACTIVE" ? "Provider is disabled" : p.keysActive === 0 ? (p.keysTotal ? "No active keys" : "No API key yet") : null;
        return (
          <div key={p.id} className="relative">
            <button
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!usable}
              onClick={() => onChange(p.id)}
              className={cn(
                "flex w-full flex-col gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                on ? "border-primary bg-primary/5" : "border-border",
                usable ? "hover:bg-muted/50" : "cursor-not-allowed opacity-60",
              )}
            >
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="block text-xs text-muted-foreground">{p.preset}</span>
                </span>
                {on && <CheckCircle2 className="size-5 shrink-0 text-primary" aria-label="Selected" />}
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs">
                <StatusBadge status={p.healthStatus} className="text-[10px]" />
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <KeyRound className="size-3" /> {p.keysActive} active key{p.keysActive === 1 ? "" : "s"}
                </span>
                {p.lastLatencyMs != null && <span className="text-muted-foreground">{p.lastLatencyMs} ms</span>}
              </span>
            </button>
            {why && (
              <Link href={`/admin/providers/${p.id}`} className="absolute right-3 bottom-3 text-xs text-primary underline-offset-4 hover:underline">
                {why}: fix
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}

type LoadState = { providerId: string; models?: UpstreamModel[]; error?: string };

export interface PickedModel {
  id: string;
  row: UpstreamModel | null;
  lookup: KnownLookup | null;
}

/** Step 2: pick the real model from the provider's live list (searchable) or type a custom id. */
export function UpstreamModelPicker({ providerId, value, onPick }: { providerId: string; value: string; onPick: (picked: PickedModel) => void }) {
  const [state, setState] = useState<LoadState | null>(null);
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listProviderModels(providerId)
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.data) setState({ providerId, models: res.data.models, error: res.data.error });
        else setState({ providerId, models: [], error: res.ok ? "Empty response" : res.error });
      })
      .catch((e) => !cancelled && setState({ providerId, models: [], error: e instanceof Error ? e.message : "Failed to load" }));
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const current = state && state.providerId === providerId ? state : null;
  const models = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = current?.models ?? [];
    const filtered = q ? list.filter((m) => m.id.toLowerCase().includes(q) || (m.ownedBy ?? "").toLowerCase().includes(q)) : list;
    return filtered.slice(0, 300);
  }, [current, query]);

  async function pick(id: string, row: UpstreamModel | null) {
    setBusy(true);
    try {
      const res = await lookupKnownForProvider(providerId, id).catch(() => null);
      onPick({ id, row, lookup: res && res.ok ? (res.data ?? null) : null });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the provider's models..." aria-label="Search models" className="pl-8" autoFocus />
      </div>

      <div className="max-h-80 overflow-y-auto rounded-lg border">
        {!current && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading the provider&apos;s model list...
          </div>
        )}
        {current?.error && (
          <p className="border-b bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
            Couldn&apos;t load the live model list ({current.error}). You can still type the model id below.
          </p>
        )}
        {current && !current.error && models.length === 0 && <p className="p-4 text-sm text-muted-foreground">{query ? "No model matches your search." : "This provider returned no models."} You can type a model id below.</p>}
        <ul className="divide-y">
          {models.map((m) => {
            const on = value === m.id;
            const summary = knownSummary(m.known?.official);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={busy}
                  onClick={() => pick(m.id, m)}
                  className={cn("flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none", on && "bg-primary/5")}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.id}</span>
                  {summary ? (
                    <span className="text-xs text-muted-foreground">{summary}</span>
                  ) : m.remote ? (
                    <span className="text-xs text-muted-foreground">{knownSummary(m.remote.prices)}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground/60">no price on file</span>
                  )}
                  {m.remote && (
                    <Badge variant="outline" className="text-[10px]" title={`Published by this provider (${m.remote.source})`}>
                      provider price
                    </Badge>
                  )}
                  {m.shutdownDate && (
                    <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400">
                      retires {m.shutdownDate.slice(0, 10)}
                    </Badge>
                  )}
                  {m.alreadyRouted && (
                    <Badge variant="secondary" className="text-[10px]">
                      already added
                    </Badge>
                  )}
                  {on && <CheckCircle2 className="size-4 text-primary" aria-label="Selected" />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="rounded-lg border p-3">
        <label htmlFor="custom-upstream" className="text-sm font-medium">
          Or type a model id
        </label>
        <p className="text-xs text-muted-foreground">Exactly as the provider expects it, e.g. a new model that isn&apos;t in the list yet.</p>
        <div className="mt-2 flex gap-2">
          <Input id="custom-upstream" value={custom} onChange={(e) => setCustom(e.target.value)} className="font-mono" placeholder="gpt-6-sol" spellCheck={false} />
          <Button type="button" variant="secondary" disabled={!custom.trim() || busy} onClick={() => pick(custom.trim(), null)}>
            Use this id
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label="Progress">
      {steps.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const on = n === current;
        return (
          <li key={label} className="flex items-center gap-2" aria-current={on ? "step" : undefined}>
            <span
              className={cn(
                "grid size-6 place-items-center rounded-full border text-xs font-medium",
                on && "border-primary bg-primary text-primary-foreground",
                done && "border-primary/50 bg-primary/10 text-primary",
                !on && !done && "text-muted-foreground",
              )}
            >
              {done ? <CheckCircle2 className="size-4" /> : n}
            </span>
            <span className={cn(on ? "font-medium" : "text-muted-foreground", "hidden sm:inline")}>{label}</span>
            {n < steps.length && <span className="h-px w-4 bg-border" />}
          </li>
        );
      })}
    </ol>
  );
}
