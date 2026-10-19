"use client";

import { useState } from "react";
import { Download, ImageIcon, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/common/empty-state";
import { MoneyText } from "@/components/common/money-text";
import { Skeleton } from "@/components/ui/skeleton";
import { estimateCost, estimateSaving } from "@/server/customer/pricing";
import { gatewayFetch, readGatewayError, type GatewayError, type usePlaygroundKey } from "./playground-api";
import { GatewayErrorAlert, SavedNote, type PlaygroundModel } from "./playground-shared";

interface GalleryItem {
  id: string;
  src: string;
  prompt: string;
  model: string;
  size: string;
}

const SIZES = ["1024x1024", "1536x1024", "1024x1536", "512x512"];

export function ImageTab({ models, keyApi, keyError }: { models: PlaygroundModel[]; keyApi: ReturnType<typeof usePlaygroundKey>; keyError: string | null }) {
  const [model, setModel] = useState(models[0]?.slug ?? "");
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState(SIZES[0]);
  const [n, setN] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GatewayError | null>(null);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [pending, setPending] = useState(0);
  const [cost, setCost] = useState(0);
  const [saved, setSaved] = useState<number | null>(null);
  const current = models.find((m) => m.slug === model);
  const count = Number(n);

  async function generate() {
    if (!prompt.trim() || busy || !current) return;
    setBusy(true);
    setError(null);
    setPending(count);
    try {
      const res = await gatewayFetch("/v1/images/generations", { method: "POST", body: JSON.stringify({ model: current.slug, prompt: prompt.trim(), size, n: count }) }, keyApi);
      if (!res.ok) {
        setError(await readGatewayError(res));
        return;
      }
      const body = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
      const items: GalleryItem[] = (body.data ?? [])
        .map((d, i) => ({ id: `${Date.now()}-${i}`, src: d.b64_json ? `data:image/png;base64,${d.b64_json}` : (d.url ?? ""), prompt: prompt.trim(), model: current.slug, size }))
        .filter((g) => g.src);
      if (items.length === 0) {
        setError({ status: 200, code: null, message: "The model returned no images." });
        return;
      }
      setGallery((g) => [...items, ...g]);
      const usage = { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0, images: current.prices.image ? items.length : 0 };
      setCost((c) => c + Number(estimateCost(usage, current.prices)));
      const runSaved = estimateSaving(usage, current.official, current.prices);
      if (runSaved !== null) setSaved((s) => (s ?? 0) + Number(runSaved));
      toast.success(`Generated ${items.length} image${items.length === 1 ? "" : "s"}`);
    } catch (err) {
      setError({ status: 0, code: null, message: err instanceof Error ? err.message : "Network error" });
    } finally {
      setBusy(false);
      setPending(0);
    }
  }

  function download(g: GalleryItem) {
    const a = document.createElement("a");
    a.href = g.src;
    a.download = `image-${g.id}.png`;
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
  }

  if (models.length === 0) {
    return <EmptyState icon={ImageIcon} title="No image models available" description="Image generation models will appear here when they're enabled for your pool." />;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      <Card className="h-fit gap-4 p-4">
        <Field>
          <FieldLabel>Model</FieldLabel>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="w-full" aria-label="Image model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.slug} value={m.slug}>
                  {m.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {current?.prices.image && (
            <FieldDescription>
              <MoneyText value={current.prices.image} /> per image
            </FieldDescription>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="img-prompt">Prompt</FieldLabel>
          <Textarea id="img-prompt" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="A watercolor fox reading a map under a lantern..." maxLength={4000} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel>Size</FieldLabel>
            <Select value={size} onValueChange={setSize}>
              <SelectTrigger className="w-full" aria-label="Size">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIZES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Images</FieldLabel>
            <Select value={n} onValueChange={setN}>
              <SelectTrigger className="w-full" aria-label="Number of images">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4].map((v) => (
                  <SelectItem key={v} value={String(v)}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        {keyError && <p className="text-sm text-red-500">{keyError}</p>}
        <Button onClick={() => void generate()} disabled={busy || !prompt.trim() || !!keyError}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          {busy ? "Generating..." : "Generate"}
        </Button>
        {current?.prices.image && (
          <p className="text-xs text-muted-foreground">
            Estimated cost: <MoneyText value={Number(current.prices.image) * count} />
          </p>
        )}
        <div className="flex items-center justify-between border-t pt-3 text-sm">
          <span className="text-muted-foreground">Session cost</span>
          <MoneyText value={cost} />
        </div>
        {saved !== null && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Saved vs official</span>
            <SavedNote saved={String(saved)} />
          </div>
        )}
      </Card>

      <div className="space-y-4">
        {error && <GatewayErrorAlert error={error} />}
        {gallery.length === 0 && pending === 0 ? (
          <EmptyState icon={ImageIcon} title="Your images will appear here" description="Describe what you want and hit Generate. Results are kept until you leave the page - download the ones you like." className="min-h-80" />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: pending }).map((_, i) => (
              <Skeleton key={`p${i}`} className="aspect-square rounded-xl" />
            ))}
            {gallery.map((g) => (
              <figure key={g.id} className="group relative overflow-hidden rounded-xl border bg-muted/30">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={g.src} alt={g.prompt} className="aspect-square w-full object-cover" loading="lazy" />
                <figcaption className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent p-3 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <span className="line-clamp-2">{g.prompt}</span>
                  <Button size="icon-sm" variant="secondary" onClick={() => download(g)} aria-label="Download image">
                    <Download className="size-4" />
                  </Button>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
