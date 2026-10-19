"use client";

import { useMemo, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeBlock } from "./code-block";
import { buildSnippets, type SnippetOptions } from "./snippets";

export interface ModelOption {
  slug: string;
  displayName: string;
  vendor: string;
  capabilities: string[];
}

/** Picks sensible example models per API family from a model list. */
export function pickExampleModels(models: ModelOption[]) {
  const chat = models.filter((m) => m.capabilities.includes("chat") || m.capabilities.includes("responses"));
  return {
    model: (chat.find((m) => m.vendor === "openai") ?? chat[0])?.slug,
    claudeModel: chat.find((m) => m.vendor === "anthropic")?.slug,
    geminiModel: chat.find((m) => m.vendor === "google")?.slug,
  };
}

/** Tabbed, ready-to-paste client configs (curl / SDKs / Codex CLI / Claude Code / OpenCode / Cursor). */
export function SnippetTabs({ options, models, defaultTab = "curl" }: { options: SnippetOptions; models?: ModelOption[]; defaultTab?: string }) {
  const [tab, setTab] = useState(defaultTab);
  const examples = useMemo(() => pickExampleModels(models ?? []), [models]);
  const tabs = useMemo(() => buildSnippets({ ...examples, ...stripUndefined(options) }), [examples, options]);
  return (
    <Tabs value={tab} onValueChange={setTab} className="gap-3">
      <TabsList className="h-auto flex-wrap">
        {tabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.id} value={t.id} className="space-y-3">
          {t.blocks.map((b) => (
            <CodeBlock key={b.title} block={b} />
          ))}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
