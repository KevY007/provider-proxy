"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NumberField } from "@/components/admin/fields";
import { useAction } from "@/components/admin/use-action";
import { createRoute } from "@/server/admin/models-actions";
import { MODEL_PRICE_PAIRS } from "@/server/admin/models-calc";
import type { WizardProvider } from "@/server/admin/models-queries";
import { officialAsCost, stepForField } from "@/server/admin/wizard-calc";
import type { PriceUnitKey } from "@/server/pricing/preview";
import { PriceGrid, type PriceValues } from "./pricing-editor";
import { ProviderPicker, Stepper, UpstreamModelPicker, type PickedModel } from "./wizard-parts";

const STEPS = ["Provider", "Model", "Our cost"];

/**
 * "Add another route" - reuses steps 1-2 of the Add model flow, then asks for Our cost with the model's
 * Official price and current Customer price shown for margin context.
 */
export function AddRouteWizard({
  modelId,
  publicSlug,
  model,
  providers,
  capabilities,
  onClose,
}: {
  modelId: string;
  publicSlug: string;
  /** Model form values: official* prices and the (effective) customer prices. */
  model: Record<string, string>;
  providers: WizardProvider[];
  capabilities: string[];
  onClose: () => void;
}) {
  const { run, pending } = useAction();
  const [step, setStep] = useState(1);
  const [providerId, setProviderId] = useState("");
  const [upstreamModel, setUpstreamModel] = useState("");
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [priority, setPriority] = useState("0");
  const [weight, setWeight] = useState("1");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hint, setHint] = useState("");
  const provider = providers.find((p) => p.id === providerId);

  function onPick(p: PickedModel) {
    const known = p.row?.known ?? p.lookup?.known ?? null;
    const direct = p.lookup?.direct ?? false;
    setUpstreamModel(p.id);
    // direct providers charge the official price; otherwise start from the model's official price as a reference only when we know it is direct
    setCosts(direct ? officialAsCost(known?.official) : {});
    setHint(direct ? "This provider is the model's maker, so Our cost starts equal to the official price." : "Enter what this provider charges you for each unit.");
    setErrors({});
    setStep(3);
  }

  const values: PriceValues = { ...model, ...costs };
  const focus: PriceUnitKey[] = [];
  if (capabilities.includes("images")) focus.push("image");
  if (capabilities.includes("video")) focus.push("perSecond");
  if (capabilities.includes("audio_speech")) focus.push("perMillionChars");
  if (capabilities.includes("audio_transcription")) focus.push("perMinute");

  async function add() {
    const payload: Record<string, unknown> = { providerId, upstreamModel, enabled: true, priority, weight };
    for (const p of MODEL_PRICE_PAIRS) if (costs[p.cost]) payload[p.cost] = costs[p.cost];
    const res = await run(() => createRoute(modelId, payload), {
      onError: (_e, fe) => {
        if (!fe) return;
        setErrors(fe);
        const first = Object.keys(fe)[0];
        if (first) setStep(stepForField(first) === 1 ? 1 : first === "upstreamModel" ? 2 : 3);
      },
    });
    if (res.ok) onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add another route</DialogTitle>
          <DialogDescription>
            Another place <span className="font-mono text-foreground">{publicSlug}</span> can be served from. Customers never notice which route ran.
          </DialogDescription>
        </DialogHeader>
        <Stepper steps={STEPS} current={step} />

        {step === 1 && <ProviderPicker providers={providers} value={providerId} onChange={(id) => { setProviderId(id); setUpstreamModel(""); }} />}
        {step === 2 && <UpstreamModelPicker key={providerId} providerId={providerId} value={upstreamModel} onPick={onPick} />}
        {step === 3 && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              <strong>{provider?.name}</strong> serves it as <span className="font-mono text-foreground">{upstreamModel}</span>. {hint}
            </p>
            {errors.upstreamModel && <p className="text-sm text-destructive">{errors.upstreamModel}</p>}
            <PriceGrid
              values={values}
              mode="FIXED"
              ruleValue=""
              onChange={(k, v) => setCosts((s) => ({ ...s, [k]: v }))}
              errors={errors}
              cols={{ official: "show", cost: "edit", customer: "show", margin: true }}
              focusUnits={focus}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField label="Priority" step="1" value={priority} onChange={setPriority} error={errors.priority} description="Higher is tried first." />
              <NumberField label="Weight" step="1" min={0} value={weight} onChange={setWeight} error={errors.weight} description="Traffic split among routes of the same priority." />
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t pt-4">
          <Button type="button" variant="outline" onClick={() => (step === 1 ? onClose() : setStep((s) => s - 1))} disabled={pending}>
            {step === 1 ? "Cancel" : (<><ArrowLeft className="size-4" /> Back</>)}
          </Button>
          {step === 1 && (
            <Button type="button" onClick={() => setStep(2)} disabled={!providerId}>
              Next <ArrowRight className="size-4" />
            </Button>
          )}
          {step === 3 && (
            <Button type="button" onClick={add} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Add route
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
