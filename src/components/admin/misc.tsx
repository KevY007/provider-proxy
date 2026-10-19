"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** In-use / max bar for concurrency slots. `max` null = unlimited. Turns amber >70%, red >=100%. */
export function SlotBar({ inUse, max, className, compact }: { inUse: number; max: number | null; className?: string; compact?: boolean }) {
  const pct = max && max > 0 ? Math.min(100, (inUse / max) * 100) : 0;
  const tone = pct >= 100 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className={cn("flex items-center gap-2", className)} title={`${inUse} in use of ${max ?? "unlimited"}`}>
      <div className={cn("h-1.5 flex-1 overflow-hidden rounded-full bg-muted", compact ? "min-w-12" : "min-w-20")}>
        <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${max ? pct : inUse > 0 ? 8 : 0}%` }} />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {inUse}/{max ?? "∞"}
      </span>
    </div>
  );
}

/** Pretty-printed JSON block (for logs, attempts, audit data). */
export function JsonView({ value, className, maxHeight = 320 }: { value: unknown; className?: string; maxHeight?: number }) {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <pre className={cn("overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all", className)} style={{ maxHeight }}>
      {text ?? "null"}
    </pre>
  );
}

/**
 * Dialog wrapper with trigger + footer submit button. `onSubmit` returns true to close the dialog.
 * Keep form state in the caller (reset it in `onOpenChange` if needed).
 */
export function FormDialog({
  trigger,
  title,
  description,
  children,
  submitLabel = "Save",
  onSubmit,
  pending,
  open: openProp,
  onOpenChange,
  wide,
  destructive,
  submitDisabled,
}: {
  trigger?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  submitLabel?: string;
  /** Resolve true => close. */
  onSubmit: () => Promise<boolean | void> | boolean | void;
  pending?: boolean;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  wide?: boolean;
  destructive?: boolean;
  submitDisabled?: boolean;
}) {
  const [openState, setOpenState] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (o: boolean) => {
    setOpenState(o);
    onOpenChange?.(o);
  };
  const isBusy = busy || !!pending;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const ok = await onSubmit();
      if (ok) setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !isBusy && setOpen(o)}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className={cn("max-h-[90vh] overflow-y-auto", wide ? "sm:max-w-2xl" : "sm:max-w-lg")}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="grid gap-4">{children}</div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isBusy}>
              Cancel
            </Button>
            <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={isBusy || submitDisabled}>
              {isBusy && <Loader2 className="size-4 animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Small key/value row for detail panels. */
export function KV({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 py-1.5 text-sm", className)}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right">{children}</span>
    </div>
  );
}
