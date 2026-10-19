"use client";

import { useSyncExternalStore } from "react";
import { format, formatDistanceToNowStrict } from "date-fns";

const noopSubscribe = () => () => undefined;
/** false during SSR + hydration, true afterwards (avoids server/client timezone mismatches). */
export function useMounted(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** Renders a timestamp in the viewer's local timezone (UTC during SSR). */
export function LocalTime({ iso, mode = "datetime", className }: { iso: string | null | undefined; mode?: "datetime" | "date" | "relative" | "time"; className?: string }) {
  const mounted = useMounted();
  if (!iso) return <span className={className}>-</span>;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return <span className={className}>-</span>;
  let text: string;
  if (!mounted) {
    const s = d.toISOString();
    text = mode === "date" ? s.slice(0, 10) : mode === "time" ? s.slice(11, 19) + " UTC" : mode === "relative" ? s.slice(0, 10) : `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`;
  } else {
    text =
      mode === "date" ? format(d, "MMM d, yyyy")
      : mode === "time" ? format(d, "HH:mm:ss")
      : mode === "relative" ? `${formatDistanceToNowStrict(d)} ago`
      : format(d, "MMM d, HH:mm:ss");
  }
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString()} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}
