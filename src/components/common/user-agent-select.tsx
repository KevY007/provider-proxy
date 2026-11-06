"use client";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PASSTHROUGH, USER_AGENT_PRESETS, findUserAgentPreset, isPassthrough } from "@/lib/user-agents";

const CUSTOM = "__custom";

/** Which dropdown entry a stored value shows as. */
function modeOf(value: string): string {
  if (isPassthrough(value)) return PASSTHROUGH;
  return findUserAgentPreset(value) ? value.trim() : CUSTOM;
}

/**
 * Pick the client identity sent upstream: pass the caller's through (default), a well-known client, or your own text.
 * `value` is the stored form: "" / "passthrough", a preset id, or custom text.
 */
export function UserAgentSelect({
  value,
  onChange,
  disabled,
  id,
  passthroughLabel = "Passthrough (default)",
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  id?: string;
  passthroughLabel?: string;
}) {
  const mode = modeOf(value);
  return (
    <div className="space-y-2">
      <Select
        value={mode}
        disabled={disabled}
        onValueChange={(v) => {
          if (v === CUSTOM) onChange(mode === CUSTOM ? value : " ");
          else onChange(v === PASSTHROUGH ? "" : v);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={PASSTHROUGH}>{passthroughLabel}</SelectItem>
          {USER_AGENT_PRESETS.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.label}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>Custom…</SelectItem>
        </SelectContent>
      </Select>
      {mode === CUSTOM && (
        <Input
          aria-label="Custom user-agent"
          placeholder="e.g. My-Tool/1.0"
          maxLength={300}
          disabled={disabled}
          value={value === " " ? "" : value}
          onChange={(e) => onChange(e.target.value || " ")}
          className="font-mono text-xs"
        />
      )}
    </div>
  );
}
