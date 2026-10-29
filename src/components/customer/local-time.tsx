"use client";

import { useSyncExternalStore } from "react";
import { format, formatDistanceToNowStrict } from "date-fns";

const noopSubscribe = () => () => undefined;
/** false during SSR + hydration, true afterwards (avoids server/client timezone mismatches). */
export function useMounted(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/**
 * Renders a timestamp in the viewer's local timezone (UTC during SSR, swapped right after hydration).
 * `full` = "2026-10-28 18:04:05" (tables); `seconds` drops the seconds of `full`.
 */
export function LocalTime({
  iso,
  mode = "datetime",
  className,
  seconds = true,
}: {
  iso: string | Date | null | undefined;
  mode?: "datetime" | "date" | "relative" | "time" | "full";
  className?: string;
  seconds?: boolean;
}) {
  const mounted = useMounted();
  if (!iso) return <span className={className}>-</span>;
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return <span className={className}>-</span>;
  let text: string;
  if (!mounted) {
    const s = d.toISOString();
    text = mode === "date" ? s.slice(0, 10) : mode === "time" ? s.slice(11, 19) : mode === "relative" ? s.slice(0, 10) : `${s.slice(0, 10)} ${s.slice(11, seconds ? 19 : 16)}`;
  } else {
    text =
      mode === "date" ? format(d, "MMM d, yyyy")
      : mode === "time" ? format(d, "HH:mm:ss")
      : mode === "relative" ? `${formatDistanceToNowStrict(d)} ago`
      : mode === "full" ? format(d, seconds ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd HH:mm")
      : format(d, "MMM d, HH:mm:ss");
  }
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString()} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}
