"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Info, Loader2, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { TextField } from "@/components/common/form-fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MultiSelectField, NumberField, SelectField } from "@/components/admin/fields";
import { useAction } from "@/components/admin/use-action";
import { createModelWithRoute } from "@/server/admin/models-actions";
import { MODEL_CAPABILITIES, MODEL_PRICE_PAIRS, type PricingModeId } from "@/server/admin/models-calc";
import type { WizardProvider } from "@/server/admin/models-queries";
import { defaultRule, officialAsCost, prettyModelName, slugifyModelId, stepForField, tableToFields, uniqueName, validatePublicName } from "@/server/admin/wizard-calc";
import type { PriceUnitKey } from "@/server/pricing/preview";
import { PriceExplainer, PriceGrid, RuleSelector, usePricingPreview, type PriceValues } from "./pricing-editor";
import { ProviderPicker, Stepper, UpstreamModelPicker, type PickedModel } from "./wizard-parts";

const STEPS = ["Provider", "Model", "Names & prices", "Pricing rule"];

interface Details {
  slug: string;
  displayName: string;
  vendor: string;
  capabilities: string[];
  contextWindow: string;
  maxOutput: string;
  retiresAt: string;
  status: string;
}

const blankDetails: Details = { slug: "", displayName: "", vendor: "", capabilities: ["chat"], contextWindow: "", maxOutput: "", retiresAt: "", status: "ACTIVE" };

function focusUnitsFor(caps: string[]): PriceUnitKey[] {
  const u: PriceUnitKey[] = [];
  if (caps.includes("images")) u.push("image");
  if (caps.includes("video")) u.push("perSecond");
  if (caps.includes("audio_speech")) u.push("perMillionChars");
  if (caps.includes("audio_transcription")) u.push("perMinute");
  return u;
}

export function AddModelWizard({ providers, taken }: { providers: WizardProvider[]; taken: string[] }) {
  const router = useRouter();
  const { run, pending } = useAction();
  const [step, setStep] = useState(1);
  const [providerId, setProviderId] = useState("");
  const [upstreamModel, setUpstreamModel] = useState("");
  const [d, setD] = useState<Details>(blankDetails);
  const [values, setValues] = useState<PriceValues>({});
  const [mode, setMode] = useState<PricingModeId>("FIXED");
  const [ruleValue, setRuleValue] = useState("");
  const [ruleTouched, setRuleTouched] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "warn" | "info"; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // catalog extras with no input on screen: description, Anthropic 1h cache write, long-context surcharge
  const [extras, setExtras] = useState<{ description: string; cacheWrite1h: number | null; longContext: { threshold: number; multiplier: number } | null }>({ description: "", cacheWrite1h: null, longContext: null });

  const provider = providers.find((p) => p.id === providerId);
  const setDetail = <K extends keyof Details>(k: K, v: Details[K]) => setD((s) => ({ ...s, [k]: v }));
  const nameError = step >= 3 ? validatePublicName(d.slug, taken) : null;
  const detailsOk = !nameError && !!d.displayName.trim() && !!d.vendor.trim() && d.capabilities.length > 0;

  const preview = usePricingPreview(values, mode, ruleValue);

  function onPick(p: PickedModel) {
    const known = p.row?.known ?? p.lookup?.known ?? null;
    const direct = p.lookup?.direct ?? false;
    const official = tableToFields(known?.official, "official");
    const cost = direct ? officialAsCost(known?.official) : {};
    const next = { ...official, ...cost };
    const rule = defaultRule(next);
    setUpstreamModel(p.id);
    setExtras({ description: known?.description ?? "", cacheWrite1h: direct ? (known?.cacheWrite1h ?? null) : null, longContext: known?.longContext ?? null });
    setValues(next);
    setMode(rule.mode);
    setRuleValue(rule.value);
    setRuleTouched(false);
    setD({
      slug: uniqueName(slugifyModelId(p.id), taken),
      displayName: known?.displayName ?? prettyModelName(p.id),
      vendor: known?.vendor ?? (provider && !["custom", "openrouter", "together", "fireworks", "azure"].includes(provider.preset) ? provider.preset : ""),
      capabilities: known?.capabilities?.length ? known.capabilities.filter((c) => (MODEL_CAPABILITIES as readonly string[]).includes(c)) : ["chat"],
      contextWindow: known?.contextWindow ? String(known.contextWindow) : "",
      maxOutput: known?.maxOutput ? String(known.maxOutput) : "",
      retiresAt: (p.row?.shutdownDate ?? known?.retiresAt ?? "").slice(0, 10),
      status: "ACTIVE",
    });
    setErrors({});
    if (known) {
      setNote(
        known.needsReview
          ? { tone: "warn", text: "We found this model in our built-in price list, but the numbers are a best guess. Please check them against the vendor's pricing page." }
          : { tone: "ok", text: direct ? "Prefilled from our built-in price list. This provider is the model's maker, so Our cost starts equal to the Official price." : "Official prices prefilled from our built-in price list. Enter what this provider charges you as Our cost." },
      );
    } else {
      setNote({ tone: "info", text: "We don't have a price on file for this model. Enter the Official price from the vendor's pricing page (it powers the customer savings display) and what the provider charges you as Our cost." });
    }
  }

  async function create() {
    const sell: Record<string, string> = {};
    for (const p of MODEL_PRICE_PAIRS) {
      if (mode === "FIXED") {
        if (values[p.sell]) sell[p.sell] = values[p.sell];
      } else if (p.unitKey) {
        const v = preview.customer[p.unitKey];
        if (v !== null && v !== undefined) sell[p.sell] = String(Number(v.toPrecision(10)));
      }
    }
    const official: Record<string, string> = {};
    const costs: Record<string, string> = {};
    for (const p of MODEL_PRICE_PAIRS) {
      if (p.official && values[p.official]) official[p.official] = values[p.official];
      if (values[p.cost]) costs[p.cost] = values[p.cost];
    }
    // Anthropic 1h cache write: no official column, so scale our cost by the customer/official ratio of the 5m write
    const cw = values.officialCacheWritePrice ? Number(values.officialCacheWritePrice) : 0;
    const cwCustomer = mode === "FIXED" ? Number(values.cacheWritePrice || 0) : (preview.customer.cacheWrite ?? 0);
    if (extras.cacheWrite1h) {
      costs.cacheWrite1hCost = String(extras.cacheWrite1h);
      sell.cacheWrite1hPrice = String(Number(((cw > 0 && cwCustomer > 0 ? extras.cacheWrite1h * (cwCustomer / cw) : extras.cacheWrite1h)).toPrecision(10)));
    }
    const res = await run(
      () =>
        createModelWithRoute({
          providerId,
          upstreamModel,
          model: {
            slug: d.slug.trim(),
            displayName: d.displayName.trim(),
            vendor: d.vendor.trim(),
            capabilities: d.capabilities,
            contextWindow: d.contextWindow,
            maxOutput: d.maxOutput,
            retiresAt: d.retiresAt,
            description: extras.description,
            ...(extras.longContext ? { longContextThreshold: extras.longContext.threshold, longContextMultiplier: extras.longContext.multiplier } : {}),
            status: d.status,
            aliases: [],
            pricingMode: mode,
            pricingValue: mode === "FIXED" ? "" : ruleValue,
            ...sell,
            ...official,
          },
          costs,
        }),
      {
        refresh: false,
        onError: (_e, fe) => {
          if (!fe) return;
          setErrors(fe);
          const first = Object.keys(fe)[0];
          if (first) setStep(stepForField(first));
        },
      },
    );
    if (res.ok && res.data) router.push(`/admin/models/${res.data.id}`);
  }

  const canNext = step === 1 ? !!providerId : step === 2 ? !!upstreamModel : step === 3 ? detailsOk : true;
  const focusUnits = focusUnitsFor(d.capabilities);

  return (
    <>
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
        <Link href="/admin/models">
          <ArrowLeft className="size-4" /> Models
        </Link>
      </Button>
      <PageHeader title="Add model" description="Four quick steps: pick the provider, pick the real model, check the prices, choose how customers are charged." />
      <div className="mb-6">
        <Stepper steps={STEPS} current={step} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Step {step}: {["Which provider will serve it?", "Which model is it?", "Name it and check the prices", "How should customers be charged?"][step - 1]}
          </CardTitle>
          <CardDescription>
            {
              [
                "Only active providers with at least one working API key can be chosen. Health is shown so you can pick a healthy one.",
                "Choose from the provider's live model list, or type a model id. \"Already added\" means a route to this model exists.",
                "Customers see the public name. Official price = what the original provider charges; Our cost = what you pay your supplier.",
                "The table shows exactly what customers will pay, how much they save versus the official price, and your margin.",
              ][step - 1]
            }
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {step === 1 && <ProviderPicker providers={providers} value={providerId} onChange={(id) => { setProviderId(id); setUpstreamModel(""); }} />}

          {step === 2 && <UpstreamModelPicker key={providerId} providerId={providerId} value={upstreamModel} onPick={(p) => { onPick(p); setStep(3); }} />}

          {step === 3 && (
            <>
              {note && (
                <p
                  className={
                    note.tone === "warn"
                      ? "flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
                      : "flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground"
                  }
                >
                  {note.tone === "ok" ? <Sparkles className="mt-0.5 size-4 shrink-0" /> : <Info className="mt-0.5 size-4 shrink-0" />} {note.text}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                Real model at <strong>{provider?.name}</strong>: <span className="font-mono text-foreground">{upstreamModel}</span>
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Public name (what customers put in `model`)"
                  className="font-mono"
                  value={d.slug}
                  onChange={(e) => setDetail("slug", e.target.value)}
                  error={nameError ?? errors.slug}
                  description="Customers never see the real model id."
                />
                <TextField label="Display name" value={d.displayName} onChange={(e) => setDetail("displayName", e.target.value)} error={errors.displayName} />
                <TextField label="Vendor" value={d.vendor} onChange={(e) => setDetail("vendor", e.target.value)} error={errors.vendor} placeholder="openai" description="The company that makes the model." />
                <MultiSelectField label="Capabilities" values={d.capabilities} onChange={(v) => setDetail("capabilities", v)} options={MODEL_CAPABILITIES.map((c) => ({ value: c, label: c }))} error={errors.capabilities} />
                <NumberField label="Context window" suffix="tokens" step="1" min={1} value={d.contextWindow} onChange={(v) => setDetail("contextWindow", v)} error={errors.contextWindow} />
                <NumberField label="Max output" suffix="tokens" step="1" min={1} value={d.maxOutput} onChange={(v) => setDetail("maxOutput", v)} error={errors.maxOutput} />
              </div>
              <PriceGrid values={values} mode="FIXED" ruleValue="" onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))} errors={errors} cols={{ official: "edit", cost: "edit" }} focusUnits={focusUnits} />
            </>
          )}

          {step === 4 && (
            <>
              <PriceExplainer audience="admin" />
              <RuleSelector mode={mode} value={ruleValue} onMode={(m) => { setRuleTouched(true); setMode(m); if (m !== "FIXED" && !ruleValue) setRuleValue(m === "PERCENT_OF_OFFICIAL" ? "100" : "30"); }} onValue={(v) => { setRuleTouched(true); setRuleValue(v); }} valueError={errors.pricingValue} />
              <PriceGrid
                values={values}
                mode={mode}
                ruleValue={ruleValue}
                onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))}
                errors={errors}
                cols={{ official: "show", cost: "show", customer: "edit", savings: true, margin: true }}
                focusUnits={focusUnits}
              />
              <SelectField
                label="Visibility"
                value={d.status}
                onChange={(v) => setDetail("status", v)}
                options={[
                  { value: "ACTIVE", label: "Active - listed for customers" },
                  { value: "HIDDEN", label: "Hidden - callable by name, not listed" },
                ]}
                description="You can change this later on the model page."
              />
            </>
          )}

          <div className="flex items-center justify-between gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1 || pending}>
              <ArrowLeft className="size-4" /> Back
            </Button>
            {step < 4 ? (
              <Button
                type="button"
                onClick={() => {
                  // suggest a rule from the prices entered in step 3 (unless the admin already chose one)
                  if (step === 3 && !ruleTouched) {
                    const r = defaultRule(values);
                    setMode(r.mode);
                    setRuleValue(r.value);
                  }
                  setStep((s) => s + 1);
                }}
                disabled={!canNext || step === 2}
              >
                Next <ArrowRight className="size-4" />
              </Button>
            ) : (
              <Button type="button" onClick={create} disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Create model
              </Button>
            )}
          </div>
          {step === 2 && <p className="-mt-3 text-right text-xs text-muted-foreground">Choosing a model takes you to the next step.</p>}
        </CardContent>
      </Card>
    </>
  );
}
