"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DateRangePicker } from "@/components/common/date-range-picker";
import { parseRangeParams, rangeToParams, type DateRangeValue } from "@/lib/date-range";
import { cn } from "@/lib/utils";

/**
 * Filters live in the URL so server components can read them (`searchParams`) and links are shareable.
 *   const { get, set, setMany, clear, pending } = useUrlFilters();
 * Changing any filter other than `cursor`/`page` resets pagination.
 */
export function useUrlFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();

  const setMany = useCallback(
    (patch: Record<string, string | null | undefined>, opts: { keepPage?: boolean } = {}) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === "") next.delete(k);
        else next.set(k, v);
      }
      if (!opts.keepPage) {
        next.delete("cursor");
        next.delete("page");
      }
      const qs = next.toString();
      start(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
    },
    [router, pathname, sp],
  );

  return {
    get: (k: string) => sp.get(k) ?? "",
    set: (k: string, v: string | null | undefined, opts?: { keepPage?: boolean }) => setMany({ [k]: v }, opts),
    setMany,
    clear: (keys: string[]) => setMany(Object.fromEntries(keys.map((k) => [k, null]))),
    pending,
    params: sp,
  };
}

const ALL = "__all__";

/** Dropdown filter bound to a URL param ("" = All). */
export function FilterSelect({
  param,
  label,
  options,
  className,
  allLabel = "All",
}: {
  param: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  className?: string;
  allLabel?: string;
}) {
  const { get, set } = useUrlFilters();
  const value = get(param);
  return (
    <Select value={value || ALL} onValueChange={(v) => set(param, v === ALL ? null : v)}>
      <SelectTrigger size="sm" className={cn("min-w-32", className)} aria-label={label}>
        <span className="mr-1 text-muted-foreground">{label}:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Debounced text filter bound to a URL param. */
export function FilterInput({
  param,
  placeholder,
  className,
  type = "text",
  label,
}: {
  param: string;
  placeholder: string;
  className?: string;
  type?: string;
  label?: string;
}) {
  const { get, set } = useUrlFilters();
  const urlValue = get(param);
  // draft remembers which URL value it was typed on top of; once the URL changes (debounced push or reset) it is ignored
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const value = draft && draft.base === urlValue ? draft.text : urlValue;
  useEffect(() => {
    if (!draft || draft.base !== urlValue || draft.text.trim() === urlValue) return;
    const t = setTimeout(() => set(param, draft.text.trim() || null), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, urlValue]);
  const setValue = (text: string) => setDraft({ base: urlValue, text });
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label={label ?? placeholder}
        type={type}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="h-7 pl-8 text-sm"
      />
    </div>
  );
}

/** "Reset filters" button; hidden when none of `keys` are set. */
export function ResetFilters({ keys }: { keys: string[] }) {
  const { get, clear } = useUrlFilters();
  if (!keys.some((k) => get(k))) return null;
  return (
    <Button variant="ghost" size="sm" onClick={() => clear(keys)}>
      <X className="size-4" /> Reset
    </Button>
  );
}

/** Range picker synced to `?range=&from=&to=`. `initial` comes from the server (parseRangeParams). */
export function UrlRangePicker({ initial, className }: { initial: { preset: DateRangeValue["preset"]; from: string; to: string }; className?: string }) {
  const { setMany, params } = useUrlFilters();
  const parsed = parseRangeParams({
    range: params.get("range") ?? initial.preset,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
  });
  // keep server-provided from/to for display until the URL carries its own range
  const value: DateRangeValue = params.get("range") ? parsed : { preset: initial.preset, from: new Date(initial.from), to: new Date(initial.to) };
  return (
    <DateRangePicker
      className={className}
      value={value}
      onChange={(v) => setMany({ range: null, from: null, to: null, ...rangeToParams(v) })}
    />
  );
}

/** Granularity select bound to `?gran=`. */
export function GranularitySelect({ value }: { value: "hour" | "day" | "week" | "month" }) {
  const { set } = useUrlFilters();
  return (
    <Select value={value} onValueChange={(v) => set("gran", v)}>
      <SelectTrigger size="sm" className="w-28" aria-label="Granularity">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="hour">Hourly</SelectItem>
        <SelectItem value="day">Daily</SelectItem>
        <SelectItem value="week">Weekly</SelectItem>
        <SelectItem value="month">Monthly</SelectItem>
      </SelectContent>
    </Select>
  );
}
