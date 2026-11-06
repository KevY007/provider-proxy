"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { COMMON_STRIP_HEADERS, normalizeStripList } from "@/lib/strip-headers";

/**
 * Choose request headers to strip before they reach the upstream. Nothing is stripped by default. Tick the common ones,
 * or type others (comma separated; "anthropic-beta:flag" removes one beta flag). Credentials can't be stripped.
 */
export function StripHeadersSelect({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const known = new Set(COMMON_STRIP_HEADERS.map((h) => h.id));
  const [text, setText] = useState(() => value.filter((v) => !known.has(v)).join(", "));
  const toggle = (id: string, on: boolean) => onChange(on ? [...new Set([...value, id])] : value.filter((v) => v !== id));
  return (
    <div className="space-y-2">
      <div className="grid gap-1.5 sm:grid-cols-2">
        {COMMON_STRIP_HEADERS.map((h) => (
          <label key={h.id} className="flex cursor-pointer items-start gap-2 text-sm" title={h.hint}>
            <Checkbox checked={value.includes(h.id)} disabled={disabled} onCheckedChange={(c) => toggle(h.id, c === true)} className="mt-0.5" />
            <span>
              <span className="font-mono text-xs">{h.label}</span>
              <span className="block text-xs text-muted-foreground">{h.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <Input
        aria-label="Other headers to strip"
        placeholder="Other headers, comma separated (e.g. x-stainless-os, anthropic-beta:some-flag)"
        disabled={disabled}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange([...new Set([...value.filter((v) => known.has(v)), ...normalizeStripList(e.target.value)])]);
        }}
        className="font-mono text-xs"
      />
    </div>
  );
}
