"use client";

import { useMemo, useState } from "react";
import { Eye, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CopyButton } from "@/components/common/copy-button";
import { useAction } from "@/components/admin/use-action";
import { revealOwnKeyAction } from "@/server/customer/keys";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";
import { buildGuides, type GuideCategory, type GuideModel } from "./integrations";
import { modelCopyValue } from "./key-models";
import type { ModelOption } from "./snippet-tabs";

export interface UseKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appUrl: string;
  siteName: string;
  /** Models this key can call (its pool, narrowed by the key's own model list). */
  models: ModelOption[];
  keyName?: string;
  /** The key's id: lets the owner fill their key into the instructions. */
  keyId?: string | null;
  poolName?: string | null;
  /** Full secret, when the key was just created. */
  apiKey?: string | null;
}

const CATEGORIES: GuideCategory[] = ["Coding agents", "IDE extensions", "Desktop & chat apps", "SDKs & API"];
const OS_KEY = "pp-use-key-os";
const CLIENT_KEY = "pp-use-key-client";

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

/** "Use key": exact, step-by-step setup for coding agents, IDEs, chat apps and SDKs, generated for this key. */
export function UseKeyDialog(props: UseKeyDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* remounted per key: the revealed secret never carries over to another key */}
      {props.open && <UseKeyBody key={props.keyId ?? props.apiKey ?? "key"} {...props} />}
    </Dialog>
  );
}

function initialOs(): "unix" | "windows" {
  const saved = store.get(OS_KEY);
  if (saved === "unix" || saved === "windows") return saved;
  return typeof navigator !== "undefined" && /win/i.test(navigator.platform) ? "windows" : "unix";
}

function UseKeyBody({ appUrl, siteName, models, keyName, keyId, poolName, apiKey }: UseKeyDialogProps) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [os, setOs] = useState<"unix" | "windows">(initialOs);
  const [client, setClient] = useState(() => store.get(CLIENT_KEY) ?? "claude-code");
  const { run, pending } = useAction();
  const secret = apiKey ?? revealed;

  const guides = useMemo(() => buildGuides({ appUrl, apiKey: secret, siteName, poolName, models: models as GuideModel[] }), [appUrl, secret, siteName, poolName, models]);
  const guide = guides.find((g) => g.id === client) ?? guides[0];
  const base = `${appUrl.replace(/\/+$/, "")}/v1`;
  const chooseClient = (id: string) => {
    setClient(id);
    store.set(CLIENT_KEY, id);
  };
  const chooseOs = (v: "unix" | "windows") => {
    setOs(v);
    store.set(OS_KEY, v);
  };

  return (
      <DialogContent className="flex max-h-[92vh] w-[calc(100vw-2rem)] max-w-[min(96vw,80rem)] flex-col gap-3 overflow-hidden sm:max-w-[min(96vw,80rem)]">
        <DialogHeader>
          <DialogTitle>Use {keyName ? `"${keyName}"` : "your key"}</DialogTitle>
          <DialogDescription>
            Pick the app you use and follow the steps. Everything below is generated for this key{poolName ? ` (${poolName} pool)` : ""}: copy it as is.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Base URL (OpenAI-compatible)</p>
              <code className="block truncate font-mono text-sm">{base}</code>
            </div>
            <CopyButton value={base} />
          </div>
          <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">API key</p>
              <code className="block truncate font-mono text-sm">{secret ?? "sk-pp-... (hidden)"}</code>
            </div>
            {secret ? (
              <CopyButton value={secret} />
            ) : keyId ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => revealOwnKeyAction({ id: keyId }), { success: "", refresh: false, onOk: (d) => d && setRevealed(d.key) })}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />} Fill in my key
              </Button>
            ) : null}
          </div>
        </div>
        {!secret && (
          <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
            {keyId ? 'Click "Fill in my key" to put your real key into every step, or replace ' : "Replace "}
            <code className="font-mono">sk-pp-YOUR_API_KEY</code> with your key yourself.
          </p>
        )}

        <div className="grid min-h-0 min-w-0 flex-1 gap-3 md:grid-cols-[13rem_minmax(0,1fr)]">
          {/* client picker: a list on wide screens, a select on phones */}
          <div className="md:hidden">
            <Select value={guide.id} onValueChange={chooseClient}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectGroup key={c}>
                    <SelectLabel>{c}</SelectLabel>
                    {guides
                      .filter((g) => g.category === c)
                      .map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.label}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
          <nav className="hidden max-h-[64vh] space-y-3 overflow-y-auto pr-1 md:block" aria-label="Apps">
            {CATEGORIES.map((c) => (
              <div key={c}>
                <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{c}</p>
                {guides
                  .filter((g) => g.category === c)
                  .map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => chooseClient(g.id)}
                      className={cn("block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted", g.id === guide.id && "bg-muted font-medium")}
                    >
                      {g.label}
                    </button>
                  ))}
              </div>
            ))}
          </nav>

          <div className="max-h-[64vh] min-w-0 overflow-y-auto overflow-x-hidden pr-3">
            <div className="space-y-4">
              <section className="rounded-lg border p-3" aria-label="Models available to this key">
                <h3 className="text-sm font-semibold">Models on this key ({models.length})</h3>
                {models.length ? <>
                  <p className="mt-1 text-xs text-muted-foreground">{guide.id === "claude-code" ? "Copy a /model command and paste it inside Claude Code. Non-chat models are listed by API ID only." : "Copy an exact model ID to use in your app."}</p>
                  <ul className="mt-2 grid max-h-44 gap-1 overflow-y-auto sm:grid-cols-2">
                    {models.map((m) => {
                      const value = modelCopyValue(m, guide.id === "claude-code");
                      return <li key={m.slug} className="flex min-w-0 items-center justify-between gap-1 rounded bg-muted/40 pl-2">
                        <div className="min-w-0 break-all text-xs"><code>{value}</code>
                          {guide.id === "claude-code" && m.claudeCodeAlias && <p className="text-muted-foreground">API ID: {m.slug}</p>}
                        </div>
                        <CopyButton value={value} className="size-8 shrink-0" accessibleLabel={`Copy ${value}`} />
                      </li>;
                    })}
                  </ul>
                </> : <p className="mt-1 text-xs text-muted-foreground">No models match the pool and restrictions for this key.</p>}
              </section>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">{guide.label}</h3>
                  <p className="text-sm text-muted-foreground">{guide.summary}</p>
                </div>
                {guide.steps.some((s) => s.os) && (
                  <div className="inline-flex rounded-md border p-0.5 text-xs" role="tablist" aria-label="Operating system">
                    {(["unix", "windows"] as const).map((v) => (
                      <button key={v} type="button" role="tab" aria-selected={os === v} onClick={() => chooseOs(v)} className={cn("rounded px-2 py-1", os === v ? "bg-muted font-medium" : "text-muted-foreground")}>
                        {v === "unix" ? "macOS / Linux" : "Windows"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {guide.warning && (
                <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                  {guide.warning}
                </p>
              )}
              <ol className="space-y-4">
                {guide.steps.map((s, i) => (
                  <li key={s.title} className="flex gap-3">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{i + 1}</span>
                    <div className="min-w-0 flex-1 space-y-2">
                      <p className="text-sm font-medium">{s.title}</p>
                      {s.text && <p className="text-sm text-muted-foreground">{s.text}</p>}
                      {[...(s.code ?? []), ...(s.os ? s.os[os] : [])].map((b, j) => (
                        <CodeBlock key={`${b.title}-${j}`} block={b} />
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
              {guide.notes?.length ? (
                <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  {guide.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        </div>
      </DialogContent>
  );
}
