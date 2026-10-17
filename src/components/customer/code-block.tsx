"use client";

import { CopyButton } from "@/components/common/copy-button";
import { cn } from "@/lib/utils";
import type { SnippetBlock } from "./snippets";

/** Dark code panel with filename caption and copy button. */
export function CodeBlock({ block, className, maxHeight = "22rem" }: { block: Pick<SnippetBlock, "code" | "title" | "filename" | "lang">; className?: string; maxHeight?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-muted/30", className)}>
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5">
        <div className="min-w-0 truncate text-xs">
          <span className="font-medium">{block.title}</span>
          {block.filename && <span className="ml-2 font-mono text-muted-foreground">{block.filename}</span>}
        </div>
        <CopyButton value={block.code} size="icon-sm" toastMessage="Copied snippet" />
      </div>
      <pre className="overflow-auto p-3 font-mono text-[12.5px] leading-relaxed" style={{ maxHeight }}>
        <code>{block.code}</code>
      </pre>
    </div>
  );
}
