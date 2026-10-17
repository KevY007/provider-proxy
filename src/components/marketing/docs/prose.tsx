import { Info, Lightbulb, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { CodeBlock } from "@/components/marketing/code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SnippetTab } from "@/components/customer/snippets";

export const slugId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function H2({ children }: { children: string }) {
  return (
    <h2 id={slugId(children)} className="mt-10 scroll-mt-20 border-b pb-2 text-xl font-semibold tracking-tight first:mt-0">
      {children}
    </h2>
  );
}

export function H3({ children }: { children: string }) {
  return (
    <h3 id={slugId(children)} className="mt-6 scroll-mt-20 text-base font-semibold">
      {children}
    </h3>
  );
}

export function P({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("my-3 leading-7 text-muted-foreground [&_strong]:text-foreground", className)}>{children}</p>;
}

export function C({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>;
}

export function UL({ children }: { children: React.ReactNode }) {
  return <ul className="my-3 list-disc space-y-1.5 pl-6 text-muted-foreground marker:text-muted-foreground/50">{children}</ul>;
}

const CALLOUT = {
  info: { icon: Info, cls: "border-sky-500/30 bg-sky-500/10", ic: "text-sky-500" },
  tip: { icon: Lightbulb, cls: "border-emerald-500/30 bg-emerald-500/10", ic: "text-emerald-500" },
  warn: { icon: TriangleAlert, cls: "border-amber-500/30 bg-amber-500/10", ic: "text-amber-500" },
} as const;

export function Callout({ kind = "info", title, children }: { kind?: keyof typeof CALLOUT; title?: string; children: React.ReactNode }) {
  const c = CALLOUT[kind];
  return (
    <div className={cn("my-5 flex gap-3 rounded-lg border p-4 text-sm", c.cls)}>
      <c.icon className={cn("mt-0.5 size-4 shrink-0", c.ic)} />
      <div className="space-y-1 text-muted-foreground [&_strong]:text-foreground">
        {title && <p className="font-medium text-foreground">{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  );
}

const METHOD_CLS: Record<string, string> = {
  GET: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  POST: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  DELETE: "bg-red-500/15 text-red-600 dark:text-red-400",
};

export function Endpoint({ method, path }: { method: string; path: string }) {
  return (
    <div className="my-4 flex items-center gap-3 rounded-lg border bg-card/60 px-4 py-3 font-mono text-sm">
      <span className={cn("rounded px-2 py-0.5 text-xs font-semibold", METHOD_CLS[method] ?? "bg-muted")}>{method}</span>
      <span className="break-all">{path}</span>
    </div>
  );
}

export function Table({ head, rows }: { head: string[]; rows: Array<Array<React.ReactNode>> }) {
  return (
    <div className="my-4 overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-4 py-2.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r, i) => (
            <tr key={i} className="align-top">
              {r.map((cell, j) => (
                <td key={j} className={cn("px-4 py-2.5", j > 0 && "text-muted-foreground")}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Tabbed set of code blocks (e.g. curl / Python / Node for the same call). */
export function CodeTabs({ tabs, defaultTab }: { tabs: Array<{ id: string; label: string; code: string; lang?: string; title?: string }>; defaultTab?: string }) {
  return (
    <Tabs defaultValue={defaultTab ?? tabs[0]?.id} className="my-4 gap-0">
      <TabsList className="h-auto flex-wrap">
        {tabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.id} value={t.id}>
          <CodeBlock code={t.code} lang={t.lang} title={t.title} className="mt-2" />
        </TabsContent>
      ))}
    </Tabs>
  );
}

/** Render a SnippetTab[] (from buildSnippets) as tabs; each tab may contain several blocks. */
export function SnippetTabs({ tabs, only }: { tabs: SnippetTab[]; only?: string[] }) {
  const list = only ? tabs.filter((t) => only.includes(t.id)) : tabs;
  return (
    <Tabs defaultValue={list[0]?.id} className="my-4 gap-0">
      <TabsList className="h-auto flex-wrap">
        {list.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {list.map((t) => (
        <TabsContent key={t.id} value={t.id}>
          {t.blocks.map((b) => (
            <div key={b.title}>
              <p className="mt-3 text-sm font-medium">{b.title}</p>
              <CodeBlock code={b.code} lang={b.lang} title={b.filename} className="mt-1" />
            </div>
          ))}
        </TabsContent>
      ))}
    </Tabs>
  );
}
