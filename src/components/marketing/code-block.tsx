"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CodeBlockProps {
  code: string;
  lang?: string;
  /** Caption shown above the code (file name or title). */
  title?: string;
  className?: string;
}

/** Dark code panel with a copy button. Used across docs and landing. */
export function CodeBlock({ code, lang, title, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className={cn("group relative my-4 overflow-hidden rounded-lg border bg-[oklch(0.14_0.006_55)] text-[oklch(0.92_0.01_250)]", className)}>
      {(title || lang) && (
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs text-white/60">
          <span className="truncate font-mono">{title ?? lang}</span>
          {title && lang && <span className="ml-3 shrink-0 uppercase tracking-wide opacity-60">{lang}</span>}
        </div>
      )}
      <button
        type="button"
        onClick={copy}
        aria-label="Copy code"
        className="absolute right-2 top-2 z-10 inline-flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white/70 opacity-0 transition hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover:opacity-100 data-[copied=true]:opacity-100"
        data-copied={copied}
        style={title || lang ? { top: "2.6rem" } : undefined}
      >
        {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
      </button>
      <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
