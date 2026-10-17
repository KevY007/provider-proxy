"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowRight, Check, Rocket, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { QuickStartState } from "@/server/admin/quickstart";

const STORAGE_KEY = "pp:admin-quickstart-dismissed";
const listeners = new Set<() => void>();
let memoryDismissed = false;

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return memoryDismissed;
  }
}

/** Auto-ticking admin setup checklist. Hidden once every step is done; dismissible (remembered in this browser). */
export function QuickStartChecklist({ state }: { state: QuickStartState }) {
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => false);
  if (state.allDone || dismissed) return null;

  function dismiss() {
    memoryDismissed = true;
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* storage unavailable: dismissed for this page view only */
    }
    listeners.forEach((l) => l());
  }

  return (
    <Card className="mb-6 border-primary/30 bg-gradient-to-br from-primary/5 to-transparent" aria-label="Quick start checklist">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Rocket className="size-4 text-primary" /> Quick start
          </CardTitle>
          <CardDescription>
            {state.doneCount} of {state.total} done. Each step ticks off automatically as you set things up.
          </CardDescription>
        </div>
        <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={dismiss} aria-label="Dismiss quick start checklist">
          <X className="size-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress value={(state.doneCount / state.total) * 100} className="h-1.5" aria-label="Setup progress" />
        <ol className="space-y-3">
          {state.steps.map((s, i) => (
            <li key={s.id} className="flex items-start gap-3">
              <span
                className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold", s.done ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-primary/10 text-primary")}
                aria-hidden
              >
                {s.done ? <Check className="size-4" /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm font-medium", s.done && "text-muted-foreground line-through decoration-muted-foreground/40")}>
                  {s.title}
                  <span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
                </p>
                {!s.done && <p className="text-sm text-muted-foreground">{s.description}</p>}
              </div>
              {!s.done && (
                <Button asChild variant={s.id === state.next?.id ? "default" : "outline"} size="sm" className="shrink-0">
                  <Link href={s.href}>
                    {s.cta} <ArrowRight className="size-3.5" />
                  </Link>
                </Button>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
