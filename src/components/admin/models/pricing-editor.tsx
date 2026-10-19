"use client";

import { useId, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { MoneyText } from "@/components/common/money-text";
import { GlossaryTip, PriceExplainer } from "@/components/common/savings-badge";
import { SavingsBadge } from "@/components/common/savings-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  costTable,
  fmtPct,
  marginTone,
  MODEL_PRICE_PAIRS,
  officialTable,
  PRICING_MODE_LABELS,
  PRICING_MODES,
  sellTable,
  TOOL_KEY_RE,
  TOOL_KEY_SUGGESTIONS,
  toNum,
  type PricingModeId,
} from "@/server/admin/models-calc";
import { previewPricing, type PriceUnitKey } from "@/server/pricing/preview";

export type PriceValues = Record<string, string>;

export interface PriceGridCols {
  official?: "edit" | "show";
  cost?: "edit" | "show";
  /** "edit" lets you type the Customer price, but only while the rule is FIXED (otherwise it is derived and read-only). */
  customer?: "edit" | "show";
  savings?: boolean;
  margin?: boolean;
}

/** Units that must always be listed even if still blank (e.g. image models: per image). */
export type FocusUnits = PriceUnitKey[];

const ALWAYS: PriceUnitKey[] = ["input", "output"];

/** Pure: model/route string values + rule -> live preview via previewPricing. */
export function usePricingPreview(values: PriceValues, mode: string, ruleValue: string, multiplier = 1) {
  return useMemo(() => {
    const v = toNum(ruleValue);
    return previewPricing({
      rule: { mode: (PRICING_MODES as readonly string[]).includes(mode) ? (mode as PricingModeId) : "FIXED", value: v },
      official: officialTable(values),
      cost: costTable(values),
      fixed: sellTable(values),
      multiplier,
    });
  }, [values, mode, ruleValue, multiplier]);
}

function NumInput({ value, onChange, label, error, className }: { value: string; onChange: (v: string) => void; label: string; error?: string; className?: string }) {
  return (
    <div className={className}>
      <Input
        type="number"
        step="any"
        min={0}
        inputMode="decimal"
        aria-label={label}
        aria-invalid={!!error}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-28 tabular-nums"
      />
      {error && <span className="block text-xs text-destructive">{error}</span>}
    </div>
  );
}

/**
 * One row per billable unit: Official - Our cost - Customer price - Savings - Margin, driven by `previewPricing`.
 * Loss rows (Customer price below Our cost) are red.
 */
export function PriceGrid({
  values,
  mode,
  ruleValue,
  onChange,
  errors = {},
  cols,
  focusUnits = [],
  multiplier = 1,
  collapsedHint = "Show all price units",
}: {
  values: PriceValues;
  mode: string;
  ruleValue: string;
  onChange?: (key: string, v: string) => void;
  errors?: Record<string, string>;
  cols: PriceGridCols;
  focusUnits?: FocusUnits;
  multiplier?: number;
  collapsedHint?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const preview = usePricingPreview(values, mode, ruleValue, multiplier);
  const fixed = mode === "FIXED";
  const pairs = MODEL_PRICE_PAIRS.filter((p) => p.unitKey);
  const filled = (k: string | null) => !!k && (toNum(values[k]) ?? 0) > 0;
  const visible = pairs.filter((p) => showAll || ALWAYS.includes(p.unitKey as PriceUnitKey) || focusUnits.includes(p.unitKey as PriceUnitKey) || filled(p.official) || filled(p.sell) || filled(p.cost));
  const hidden = pairs.length - visible.length;

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border">
        <Table className="min-w-[44rem]">
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
              <TableHead>Unit</TableHead>
              {cols.official && (
                <TableHead>
                  Official price <GlossaryTip term="official" />
                </TableHead>
              )}
              {cols.cost && (
                <TableHead>
                  Our cost <GlossaryTip term="cost" />
                </TableHead>
              )}
              {cols.customer && (
                <TableHead>
                  Customer price <GlossaryTip term="customer" />
                </TableHead>
              )}
              {cols.savings && (
                <TableHead>
                  Savings <GlossaryTip term="savings" />
                </TableHead>
              )}
              {cols.margin && (
                <TableHead className="text-right">
                  Margin <GlossaryTip term="margin" />
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((p) => {
              const u = p.unitKey as PriceUnitKey;
              const customer = preview.customer[u] ?? null;
              const margin = preview.marginPct[u] ?? null;
              const loss = margin !== null && margin < 0;
              const offV = p.official ? values[p.official] ?? "" : "";
              const costV = values[p.cost] ?? "";
              const off = toNum(offV);
              return (
                <TableRow key={p.sell} className={cn(loss && "bg-red-500/5")}>
                  <TableCell>
                    <span className="text-sm">{p.label}</span>
                    <span className="block text-[10px] text-muted-foreground">{p.unit}</span>
                  </TableCell>
                  {cols.official && (
                    <TableCell>
                      {cols.official === "edit" && p.official ? (
                        <NumInput value={offV} onChange={(v) => onChange?.(p.official as string, v)} label={`Official ${p.label}`} error={errors[p.official]} />
                      ) : off !== null ? (
                        <MoneyText value={off} className="text-sm" />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  )}
                  {cols.cost && (
                    <TableCell>
                      {cols.cost === "edit" ? (
                        <NumInput value={costV} onChange={(v) => onChange?.(p.cost, v)} label={`Our cost ${p.label}`} error={errors[p.cost]} />
                      ) : toNum(costV) !== null ? (
                        <MoneyText value={toNum(costV) as number} className="text-sm" />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  )}
                  {cols.customer && (
                    <TableCell>
                      {cols.customer === "edit" && fixed ? (
                        <NumInput value={values[p.sell] ?? ""} onChange={(v) => onChange?.(p.sell, v)} label={`Customer price ${p.label}`} error={errors[p.sell]} />
                      ) : customer !== null ? (
                        <MoneyText value={customer} className="text-sm font-medium" />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  )}
                  {cols.savings && (
                    <TableCell>
                      <SavingsBadge official={off} price={customer} />
                    </TableCell>
                  )}
                  {cols.margin && (
                    <TableCell className="text-right">
                      <span className={cn("tabular-nums text-sm", marginTone(margin))}>{fmtPct(margin, 1)}</span>
                      {loss && <span className="ml-1 rounded bg-red-500/15 px-1 text-[10px] font-semibold uppercase text-red-500">loss</span>}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {(hidden > 0 || showAll) && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((s) => !s)}>
          {showAll ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          {showAll ? "Hide unused units" : `${collapsedHint} (+${hidden})`}
        </Button>
      )}
      {preview.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border p-3 text-sm" role="alert">
          {preview.warnings.map((w) => {
            const bad = /\(loss\)|below our cost|is zero|free/i.test(w);
            return (
              <li key={w} className={cn("flex items-start gap-2", bad ? "font-medium text-red-600 dark:text-red-400" : "text-amber-700 dark:text-amber-400")}>
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {w}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Fixed / % of official / Markup over our cost selector with its value input. */
export function RuleSelector({
  mode,
  value,
  onMode,
  onValue,
  valueError,
}: {
  mode: string;
  value: string;
  onMode: (m: PricingModeId) => void;
  onValue: (v: string) => void;
  valueError?: string;
}) {
  const info = PRICING_MODE_LABELS[(mode as PricingModeId) in PRICING_MODE_LABELS ? (mode as PricingModeId) : "FIXED"];
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="How is the customer price set?" className="grid gap-2 sm:grid-cols-3">
        {PRICING_MODES.map((m) => {
          const on = m === mode;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onMode(m)}
              className={cn(
                "rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                on ? "border-primary bg-primary/5" : "border-border",
              )}
            >
              <span className="block font-medium">{PRICING_MODE_LABELS[m].label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{PRICING_MODE_LABELS[m].hint}</span>
            </button>
          );
        })}
      </div>
      {mode !== "FIXED" && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="rule-value" className="text-sm font-medium">
              {info.valueLabel}
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="rule-value"
                type="number"
                step="any"
                min={0}
                inputMode="decimal"
                value={value}
                onChange={(e) => onValue(e.target.value)}
                aria-invalid={!!valueError}
                placeholder={mode === "PERCENT_OF_OFFICIAL" ? "100" : "30"}
                className="h-9 w-28 tabular-nums"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
            {valueError ? <p className="text-xs text-destructive">{valueError}</p> : <p className="max-w-md text-xs text-muted-foreground">{info.valueHint}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export interface ToolPriceColumn {
  label: React.ReactNode;
  /** tool key -> USD per unit (string as typed, or a derived number) */
  values: Record<string, string | number | null | undefined>;
  /** Set to make the column editable. */
  onChange?: (key: string, v: string) => void;
}

/**
 * "Server tools" table: one row per tool price key (web_search_request, code_execution_hour, ...) and one column per price
 * list (Official / Our cost / Customer price). Editable columns get inputs; new keys come from the suggestions or are typed.
 */
export function ToolPriceTable({ cols, onRemove, errors = {} }: { cols: ToolPriceColumn[]; onRemove?: (key: string) => void; errors?: Record<string, string> }) {
  const listId = useId();
  const [added, setAdded] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState("");
  const editable = cols.some((c) => c.onChange);
  const keys = useMemo(() => [...new Set([...cols.flatMap((c) => Object.keys(c.values)), ...added])].sort(), [cols, added]);
  const hint = (k: string) => TOOL_KEY_SUGGESTIONS.find((t) => t.key === k)?.hint ?? "USD per unit";

  function add() {
    const k = draft.trim();
    if (!TOOL_KEY_RE.test(k)) return setDraftError("Letters, numbers, _ . : - only");
    if (keys.includes(k)) return setDraftError("Already listed");
    setAdded((a) => [...a, k]);
    setDraft("");
    setDraftError("");
  }

  return (
    <div className="space-y-2">
      {keys.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead>Tool</TableHead>
                {cols.map((c, i) => (
                  <TableHead key={i}>{c.label}</TableHead>
                ))}
                {editable && onRemove && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k}>
                  <TableCell>
                    <span className="font-mono text-xs">{k}</span>
                    <span className="block text-[10px] text-muted-foreground">{hint(k)}</span>
                  </TableCell>
                  {cols.map((c, i) => {
                    const v = c.values[k];
                    return (
                      <TableCell key={i}>
                        {c.onChange ? (
                          <NumInput value={v === null || v === undefined ? "" : String(v)} onChange={(x) => c.onChange?.(k, x)} label={`${k} ${typeof c.label === "string" ? c.label : ""}`.trim()} />
                        ) : toNum(v ?? null) !== null ? (
                          <MoneyText value={toNum(v ?? null) as number} className="text-sm" />
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    );
                  })}
                  {editable && onRemove && (
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={`Remove ${k}`}
                        onClick={() => {
                          setAdded((a) => a.filter((x) => x !== k));
                          onRemove(k);
                        }}
                      >
                        <X className="size-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No server-tool prices. Tools without a price are free for the customer.</p>
      )}
      {editable && (
        <div className="flex flex-wrap items-start gap-2">
          <div>
            <Input
              list={listId}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setDraftError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="tool key, e.g. web_search_request"
              aria-label="New server tool key"
              aria-invalid={!!draftError}
              className="h-8 w-64 font-mono text-xs"
            />
            <datalist id={listId}>
              {TOOL_KEY_SUGGESTIONS.filter((t) => !keys.includes(t.key)).map((t) => (
                <option key={t.key} value={t.key}>
                  {t.hint}
                </option>
              ))}
            </datalist>
            {draftError && <span className="block text-xs text-destructive">{draftError}</span>}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={add} disabled={!draft.trim()}>
            <Plus className="size-4" /> Add tool price
          </Button>
        </div>
      )}
      {Object.entries(errors).map(([k, e]) => (
        <p key={k} className="text-xs text-destructive">
          {k}: {e}
        </p>
      ))}
    </div>
  );
}

export { PriceExplainer };
