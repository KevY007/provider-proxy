"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PASSTHROUGH, USER_AGENT_PRESETS, userAgentMode } from "@/lib/user-agents";

const CUSTOM = "custom";

/**
 * Pick the client identity sent upstream: pass the caller's through (default), a well-known client, or your own text.
 * `value` is the stored form: "" (passthrough), a preset id, or custom text. Choosing "Custom…" opens a text box.
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
  const [customChosen, setCustomChosen] = useState(() => userAgentMode(value, false) === CUSTOM);
  const mode = userAgentMode(value, customChosen);
  return (
    <div className="space-y-2">
      <Select
        value={mode}
        disabled={disabled}
        onValueChange={(v) => {
          if (v === CUSTOM) {
            setCustomChosen(true);
            // keep the text when already custom; a preset id is not custom text, so start empty
            onChange(mode === CUSTOM ? value : "");
          } else {
            setCustomChosen(false);
            onChange(v === PASSTHROUGH ? "" : v);
          }
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
          placeholder="e.g. My-Tool/1.0 (sent exactly as written)"
          maxLength={300}
          disabled={disabled}
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-xs"
        />
      )}
    </div>
  );
}
