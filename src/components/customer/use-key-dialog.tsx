"use client";

import { TriangleAlert } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CopyButton } from "@/components/common/copy-button";
import { SnippetTabs, type ModelOption } from "./snippet-tabs";

export interface UseKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appUrl: string;
  siteName: string;
  models: ModelOption[];
  keyName?: string;
  /** Full secret, only when the key was just created. */
  apiKey?: string | null;
}

/** "Use key" dialog: base URL + ready-to-paste configs for every common client. */
export function UseKeyDialog({ open, onOpenChange, appUrl, siteName, models, keyName, apiKey }: UseKeyDialogProps) {
  const base = `${appUrl.replace(/\/+$/, "")}/v1`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] gap-4 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Use {keyName ? `"${keyName}"` : "your key"}</DialogTitle>
          <DialogDescription>Point any OpenAI, Anthropic or Gemini compatible client at the base URL below.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Base URL</p>
            <code className="block truncate font-mono text-sm">{base}</code>
          </div>
          <CopyButton value={base} />
        </div>
        {!apiKey && (
          <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
            Full keys are only shown once at creation. Replace <code className="font-mono">sk-pp-YOUR_API_KEY</code> in the snippets with your key.
          </p>
        )}
        <ScrollArea className="-mr-3 max-h-[52vh] pr-3">
          <SnippetTabs options={{ appUrl, apiKey, siteName }} models={models} />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
