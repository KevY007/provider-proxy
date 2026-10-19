"use client";

import { useState } from "react";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { RANGE_PRESETS, rangeFromPreset, type DateRangeValue, type RangePreset } from "@/lib/date-range";
import { cn } from "@/lib/utils";

export interface DateRangePickerProps {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  className?: string;
}

/**
 * Preset toggle (24h / 7d / 30d / 90d) plus a "Custom" calendar popover.
 * Controlled; pair it with `parseRangeParams` / `rangeToParams` from `@/lib/date-range` to keep the
 * selection in the URL so server components can query the range.
 */
export function DateRangePicker({ value, onChange, className }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>({ from: value.from, to: value.to });

  function selectPreset(p: string) {
    if (!p) return;
    if (p === "custom") {
      setOpen(true);
      return;
    }
    onChange(rangeFromPreset(p as RangePreset));
  }

  function applyCustom() {
    if (!draft?.from) return;
    const from = new Date(draft.from);
    from.setHours(0, 0, 0, 0);
    const to = new Date(draft.to ?? draft.from);
    to.setHours(23, 59, 59, 999);
    onChange({ preset: "custom", from, to });
    setOpen(false);
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <ToggleGroup type="single" variant="outline" size="sm" value={value.preset === "custom" ? "" : value.preset} onValueChange={selectPreset}>
        {RANGE_PRESETS.map((p) => (
          <ToggleGroupItem key={p.value} value={p.value} aria-label={`Last ${p.label}`}>
            {p.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant={value.preset === "custom" ? "secondary" : "outline"} size="sm" className="gap-2">
            <CalendarIcon className="size-4" />
            {value.preset === "custom"
              ? `${format(value.from, "MMM d")} - ${format(value.to, "MMM d, yyyy")}`
              : "Custom"}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-auto p-0">
          <Calendar
            mode="range"
            numberOfMonths={2}
            selected={draft}
            onSelect={setDraft}
            disabled={{ after: new Date() }}
            defaultMonth={value.from}
          />
          <div className="flex justify-end gap-2 border-t p-3">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={applyCustom} disabled={!draft?.from}>
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
