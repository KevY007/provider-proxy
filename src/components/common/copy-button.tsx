"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface CopyButtonProps {
  /** Text to put on the clipboard. */
  value: string;
  /** Optional visible label next to the icon. */
  label?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
  /** Toast message on success (set to "" to disable). */
  toastMessage?: string;
}

/** Copy-to-clipboard button with a check-mark confirmation and toast. */
export function CopyButton({
  value,
  label,
  variant = "ghost",
  size = label ? "sm" : "icon",
  className,
  toastMessage = "Copied to clipboard",
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (toastMessage) toast.success(toastMessage);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy - copy it manually");
    }
  }
  return (
    <Button type="button" variant={variant} size={size} className={cn(className)} onClick={copy} aria-label={label ?? "Copy"}>
      {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
      {label}
    </Button>
  );
}
