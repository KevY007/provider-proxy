"use client";

import { useRef, useState } from "react";
import { CheckCircle2, FileJson, XCircle } from "lucide-react";
import { FormDialog } from "@/components/admin/misc";
import { CheckField, TextAreaField } from "@/components/admin/fields";
import { useAction } from "@/components/admin/use-action";
import { Button } from "@/components/ui/button";
import { importModels, type ImportItemResult } from "@/server/admin/models-actions";

const EXAMPLE = `[
  {
    "slug": "my-model",
    "displayName": "My Model",
    "vendor": "openai",
    "capabilities": ["chat", "tools"],
    "inputPrice": "2.50",
    "outputPrice": "10.00",
    "routes": [
      { "provider": "openai", "upstreamModel": "gpt-4.1", "inputCost": "2.00", "outputCost": "8.00" }
    ]
  }
]`;

export function ModelImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { run } = useAction();
  const [text, setText] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [results, setResults] = useState<ImportItemResult[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setText(await file.text());
    setResults(null);
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setResults(null);
      }}
      wide
      title="Import models (JSON)"
      description={
        <>
          Array of models, each with optional <code>routes</code> that reference providers by <code>provider</code> slug. Models are upserted by slug
          (fields you omit are reset to defaults); routes are upserted by provider + upstream model.
        </>
      }
      submitLabel={dryRun ? "Validate (dry run)" : "Import"}
      submitDisabled={!text.trim()}
      onSubmit={async () => {
        const res = await run(() => importModels(text, dryRun), { refresh: !dryRun });
        if (res.ok && res.data) {
          setResults(res.data.results);
          // keep the dialog open so results can be read; real imports with no failures close it
          return !dryRun && res.data.results.every((r) => r.ok);
        }
        return false;
      }}
    >
      <div className="flex items-center gap-2">
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
          <FileJson className="size-4" /> Choose file
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setText(EXAMPLE)}>
          Insert example
        </Button>
      </div>
      <TextAreaField label="JSON" value={text} onChange={(v) => { setText(v); setResults(null); }} rows={12} mono placeholder={EXAMPLE} />
      <CheckField label="Dry run" checked={dryRun} onChange={setDryRun} description="Validate and show what would change without writing anything." />
      {results && (
        <ul className="max-h-48 space-y-1 overflow-auto rounded-md border p-2 text-sm" aria-label="Import results">
          {results.map((r, i) => (
            <li key={`${r.slug}-${i}`} className="flex items-start gap-2">
              {r.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-red-500" />}
              <span className="font-mono">{r.slug}</span>
              <span className="text-muted-foreground">
                {r.ok ? `${dryRun ? "would " : ""}${r.action} · ${r.routes ?? 0} route(s)` : r.error}
              </span>
            </li>
          ))}
        </ul>
      )}
    </FormDialog>
  );
}
