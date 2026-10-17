"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw, Save, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { useAction } from "@/components/admin/use-action";
import { deleteProvider, updateProvider } from "@/server/admin/providers-actions";
import type { ProviderDetail } from "@/server/admin/providers-queries";
import { ProviderFormFields, providerPayload, type ProviderFormState } from "./provider-form";

export function ProviderEditor({
  provider,
  canEdit,
  routeCount,
  keyCount,
  presetFormats,
}: {
  provider: ProviderDetail["provider"];
  canEdit: boolean;
  routeCount: number;
  keyCount: number;
  /** The provider preset's CURRENT format list (null for custom / unknown presets). */
  presetFormats: string[] | null;
}) {
  const router = useRouter();
  const initial: ProviderFormState = {
    name: provider.name, slug: provider.slug, preset: provider.preset, baseUrl: provider.baseUrl, authStyle: provider.authStyle,
    formats: provider.formats, tags: provider.tags, extraHeaders: provider.extraHeaders, settings: provider.settings,
    status: provider.status, timeoutMs: String(provider.timeoutMs), priority: String(provider.priority),
    maxConcurrency: provider.maxConcurrency == null ? "" : String(provider.maxConcurrency), notes: provider.notes,
  };
  const [state, setState] = useState<ProviderFormState>(initial);
  const { run, pending, fieldErrors } = useAction();
  const dirty = JSON.stringify(state) !== JSON.stringify(initial);
  const presetDiffers = !!presetFormats && JSON.stringify([...presetFormats].sort()) !== JSON.stringify([...provider.formats].sort());

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Connection &amp; settings</CardTitle>
        <CardDescription>How the gateway talks to this upstream. Changes apply to the gateway within seconds.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!canEdit && (
          <Alert>
            <AlertTitle>Read-only</AlertTitle>
            <AlertDescription>Only administrators can change providers.</AlertDescription>
          </Alert>
        )}
        <fieldset disabled={!canEdit || pending} className="contents">
          <ProviderFormFields state={state} set={(p) => setState((s) => ({ ...s, ...p }))} errors={fieldErrors} />
        </fieldset>
        {canEdit && presetFormats && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3 text-sm">
            <span className="text-muted-foreground">
              {presetDiffers ? "The preset now lists formats this provider does not have yet (e.g. the Files APIs)." : "Formats match the current preset."}{" "}
              <span className="font-mono text-xs">{presetFormats.join(", ")}</span>
            </span>
            <ConfirmDialog
              title="Apply preset formats?"
              description={
                <>
                  Replaces this provider&apos;s native endpoint formats with the preset&apos;s current list and saves immediately. Other fields are not touched.
                  <span className="mt-2 block font-mono text-xs">{presetFormats.join(", ")}</span>
                </>
              }
              confirmLabel="Apply and save"
              onConfirm={async () => {
                const res = await run(() => updateProvider(provider.id, providerPayload({ ...initial, formats: presetFormats })), { success: "Preset formats applied" });
                if (!res.ok) throw new Error(res.error);
                setState((s) => ({ ...s, formats: presetFormats }));
              }}
              trigger={
                <Button variant="outline" size="sm" disabled={pending}>
                  <RotateCcw className="size-4" /> Apply preset formats
                </Button>
              }
            />
          </div>
        )}
        {canEdit && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <ConfirmDialog
              destructive
              title={`Delete ${provider.name}?`}
              description={
                <>
                  This permanently deletes the provider, its {keyCount} key{keyCount === 1 ? "" : "s"} and health history
                  {routeCount > 0 ? <strong> and {routeCount} model route{routeCount === 1 ? "" : "s"} that use it</strong> : null}. Request logs are kept.
                </>
              }
              confirmLabel="Delete provider"
              onConfirm={async () => {
                const res = await run(() => deleteProvider(provider.id), { refresh: false });
                if (!res.ok) throw new Error(res.error);
                router.push("/admin/providers");
              }}
              trigger={
                <Button variant="outline" className="text-red-500 hover:text-red-500">
                  <Trash2 className="size-4" /> Delete
                </Button>
              }
            />
            <div className="flex items-center gap-2">
              {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
              <Button variant="outline" disabled={!dirty || pending} onClick={() => setState(initial)}>
                Reset
              </Button>
              <Button disabled={!dirty || pending} onClick={() => run(() => updateProvider(provider.id, providerPayload(state)), { success: "Provider saved" })}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save changes
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
