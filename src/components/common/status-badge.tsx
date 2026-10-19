import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE_CLASS: Record<StatusTone, string> = {
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  danger: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  neutral: "border-border bg-muted text-muted-foreground",
};

/** Tone for every enum value in the schema (UserStatus, KeyStatus, ProviderKeyStatus, HealthStatus, RequestStatus, PaymentStatus...). */
const STATUS_TONE: Record<string, StatusTone> = {
  // good
  ACTIVE: "success", SUCCESS: "success", OPERATIONAL: "success", SUCCEEDED: "success", OK: "success", PASSED: "success",
  // in-between
  PENDING: "warning", PENDING_VERIFICATION: "warning", COOLDOWN: "warning", DEGRADED: "warning",
  HIDDEN: "warning", CLIENT_ERROR: "warning", REFUNDED: "warning", EXHAUSTED: "warning", POSTPAID: "warning",
  // bad
  SUSPENDED: "danger", INVALID: "danger", DOWN: "danger", FAILED: "danger", UPSTREAM_ERROR: "danger",
  GATEWAY_ERROR: "danger", REVOKED: "danger", DISPUTED: "danger", ERROR: "danger",
  // neutral
  DISABLED: "neutral", UNKNOWN: "neutral", CANCELLED: "neutral", CANCELED: "neutral", PREPAID: "info",
  // roles
  ADMIN: "info", SUPPORT: "info", CUSTOMER: "neutral",
};

function humanize(s: string) {
  return s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export interface StatusBadgeProps {
  /** Enum value or any string. Unknown values render neutral. */
  status: string | null | undefined;
  /** Override the displayed text. */
  label?: string;
  /** Override the colour. */
  tone?: StatusTone;
  /** Show a leading dot. */
  dot?: boolean;
  className?: string;
}

/** Coloured pill for any status enum (colour inferred from the value). */
export function StatusBadge({ status, label, tone, dot = true, className }: StatusBadgeProps) {
  const key = (status ?? "UNKNOWN").toUpperCase();
  const t = tone ?? STATUS_TONE[key] ?? "neutral";
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", TONE_CLASS[t], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {label ?? humanize(key)}
    </Badge>
  );
}
