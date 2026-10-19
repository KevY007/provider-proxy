import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Check,
  Gauge,
  ImageIcon,
  KeyRound,
  Layers,
  Plug,
  ShieldCheck,
  Sparkles,
  Wallet,
  Wrench,
  Zap,
} from "lucide-react";
import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { HeroTerminal } from "@/components/marketing/hero-terminal";
import { buildPriceRows, PriceTable } from "@/components/marketing/price-table";
import { appUrl } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { formatMultiplier } from "@/server/customer/pricing";
import { getCatalogModels, getDefaultGroup } from "@/server/customer/catalog";
import { vendorLabel } from "@/server/customer/labels";
import { publicVisibility } from "@/server/customer/visibility";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { absolute: "ProviderProxy - every frontier model, one endpoint" },
  description: "One API key and one base URL for OpenAI, Anthropic and Gemini compatible models. Pay as you go, with live price comparison.",
};

const FEATURES = [
  { icon: Plug, title: "Drop-in compatible", body: "OpenAI, Anthropic and Gemini wire formats on one base URL. Change the base URL and key, keep your SDK." },
  { icon: Zap, title: "Streaming & tools", body: "Server-sent events, tool/function calling, vision and structured outputs pass straight through." },
  { icon: ImageIcon, title: "Images & audio", body: "Image generation, embeddings, speech and transcription behind the same key and balance." },
  { icon: Layers, title: "Pools with lower prices", body: "Choose a pool per key: pay a multiplier of the base price and trade off cost and priority." },
  { icon: BarChart3, title: "Usage analytics", body: "Spend, tokens, latency and errors by model, key and endpoint, with request-level logs and CSV export." },
  { icon: Wallet, title: "Pay as you go", body: "Prepaid balance, no subscription. Top up by card, enable auto-recharge, set per-key spend limits." },
  { icon: Gauge, title: "Built for load", body: "Automatic failover and queueing absorb upstream rate limits, so your clients see fewer 429s." },
  { icon: ShieldCheck, title: "Key controls", body: "Per-key model allow-lists, rate limits, IP allowlists, expiry and one-click revoke." },
];

const FAQ = [
  { q: "How does it work?", a: "You get one API key and one base URL. Send requests in OpenAI, Anthropic or Gemini format; we route them to the best available capacity, meter the usage and bill it against your prepaid balance." },
  { q: "Will my existing SDK work?", a: "Yes. Point the official OpenAI or Anthropic SDK (or any compatible tool such as Codex CLI, Claude Code, OpenCode or Cursor) at our base URL and use your key. See the client setup guides in the docs." },
  { q: "How is pricing calculated?", a: "Each model has a per-token price; your pool applies a multiplier on top. You are charged for actual input, output and cached tokens, shown per request in your logs. There is no subscription or minimum." },
  { q: "Do you store my prompts?", a: "Request metadata (model, tokens, cost, latency, status) is logged so you can audit usage. Prompt and response bodies are not stored unless explicitly enabled by the operator." },
  { q: "What happens when my balance runs out?", a: "Requests are rejected with a 402 insufficient_balance error until you add funds. Turn on auto-recharge or low-balance emails to avoid interruptions." },
  { q: "What about rate limits?", a: "Each key can have its own requests-per-minute, tokens-per-minute and concurrency limits. When capacity is tight we queue briefly and otherwise return a standard 429 with retry-after, so SDK retries just work." },
  { q: "Can I use it for production workloads?", a: "Yes. Automatic failover across upstream accounts, streaming support and a public status page are built for production traffic." },
];

export default async function HomePage() {
  const [siteName, models, group, vis] = await Promise.all([getSetting("siteName"), getCatalogModels(), getDefaultGroup(), publicVisibility()]);
  // with private pricing nothing price-related reaches a visitor who is not signed in (table, savings, links)
  const showPrices = vis.pricing;
  const showModels = vis.models;
  const multiplier = group?.priceMultiplier ?? "1";
  const rows = buildPriceRows(models, multiplier);
  const chatModel = (showModels && models.find((m) => m.capabilities.includes("chat"))?.slug) || "gpt-6-sol";
  const featured = rows.filter((r) => !r.isImage && r.savings !== null).slice(0, 8);
  const savingsList = rows.map((r) => r.savings).filter((s): s is number => s !== null && s > 0);
  const avgSavings = showPrices && savingsList.length ? Math.round(savingsList.reduce((a, b) => a + b, 0) / savingsList.length) : null;

  const families = new Map<string, { count: number; names: string[] }>();
  for (const m of models) {
    const f = families.get(m.vendor) ?? { count: 0, names: [] };
    f.count++;
    if (f.names.length < 3) f.names.push(m.displayName);
    families.set(m.vendor, f);
  }

  return (
    <div>
      {/* Hero */}
      <section className="relative overflow-hidden border-b">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 [background:radial-gradient(60rem_30rem_at_20%_-10%,color-mix(in_oklch,var(--primary)_18%,transparent),transparent),radial-gradient(40rem_25rem_at_90%_10%,color-mix(in_oklch,var(--chart-4)_10%,transparent),transparent)]" />
        <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 py-16 lg:grid-cols-[1.05fr_1fr] lg:py-24">
          <div className="space-y-6">
            <span className="inline-flex items-center gap-2 rounded-full border bg-card/60 px-3 py-1 text-xs text-muted-foreground">
              <Sparkles className="size-3.5 text-primary" />
              OpenAI &middot; Anthropic &middot; Gemini compatible
            </span>
            <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl lg:text-6xl">
              Every frontier model.
              <br />
              <span className="bg-gradient-to-r from-primary to-[var(--chart-4)] bg-clip-text text-transparent">One endpoint.</span> Pay as you go.
            </h1>
            <p className="max-w-xl text-lg text-muted-foreground">
              A single API key and base URL for the best models from OpenAI, Anthropic, Google and more, billed per token
              {avgSavings ? <> at an average of <strong className="text-foreground">{avgSavings}% below</strong> official prices</> : null}.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg" className="h-10 px-5 text-sm">
                <Link href="/signup">
                  Get started free <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-10 px-5 text-sm">
                <Link href="/docs">Read the docs</Link>
              </Button>
            </div>
            <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
              {["No subscription", "Streaming & tools", "Usage analytics"].map((t) => (
                <li key={t} className="flex items-center gap-1.5">
                  <Check className="size-4 text-primary" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <HeroTerminal baseUrl={`${appUrl}/v1`} model={chatModel} />
        </div>
      </section>

      {/* Stats */}
      <section className="border-b bg-card/30">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-6 px-4 py-8 md:grid-cols-4">
          {[
            ...(showModels
              ? [
                  { v: String(models.length), l: "models available" },
                  { v: String(families.size), l: "model vendors" },
                ]
              : [
                  { v: "1", l: "API key for every model" },
                  { v: "SSE", l: "streaming & tool calls" },
                ]),
            { v: "3", l: "API formats, one base URL" },
            { v: avgSavings ? `${avgSavings}%` : "PAYG", l: avgSavings ? "average savings vs list" : "no monthly fee" },
          ].map((s) => (
            <div key={s.l} className="text-center">
              <div className="text-3xl font-semibold tabular-nums tracking-tight">{s.v}</div>
              <div className="text-sm text-muted-foreground">{s.l}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Price table */}
      {showPrices && (
        <section className="mx-auto w-full max-w-6xl px-4 py-16">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Official vs. {siteName}</h2>
              <p className="max-w-xl text-muted-foreground">
                Live prices from our catalog{group ? <> on the {group.name} pool ({formatMultiplier(multiplier)})</> : null}. Cheaper pools are available for every key.
              </p>
            </div>
            <Button asChild variant="outline">
              <Link href="/pricing">
                Full pricing <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
          <PriceTable rows={featured.length ? featured : rows.slice(0, 8)} compact />
        </section>
      )}

      {/* Model families */}
      {showModels && (
        <section className="border-y bg-card/30">
          <div className="mx-auto w-full max-w-6xl px-4 py-16">
            <div className="mb-8 max-w-xl space-y-2">
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">The models you want, in one place</h2>
              <p className="text-muted-foreground">Switch vendors by changing one string. Your code, keys and billing stay the same.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[...families.entries()].map(([vendor, f]) => (
                <Link key={vendor} href={showPrices ? "/pricing" : "/signup"} className="group rounded-xl border bg-card p-5 transition hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">{vendorLabel(vendor)}</h3>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{f.count} models</span>
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">{f.names.join(" · ")}{f.count > f.names.length ? " · ..." : ""}</p>
                  <span className="mt-4 inline-flex items-center gap-1 text-sm text-primary opacity-0 transition group-hover:opacity-100">
                    {showPrices ? "See prices" : "Get started"} <ArrowRight className="size-3.5" />
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Features */}
      <section className="mx-auto w-full max-w-6xl px-4 py-16">
        <div className="mb-10 max-w-xl space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Everything a production API needs</h2>
          <p className="text-muted-foreground">From the first curl to millions of requests a day.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border bg-card/50 p-5">
              <div className="mb-3 flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <f.icon className="size-4.5" />
              </div>
              <h3 className="font-medium">{f.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Steps */}
      <section className="border-y bg-card/30">
        <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-14 md:grid-cols-3">
          {[
            { icon: KeyRound, t: "1. Create an account", d: "Sign up and verify your email in under a minute." },
            { icon: Wallet, t: "2. Add balance", d: "Top up any amount by card. Pay only for tokens you use." },
            { icon: Wrench, t: "3. Call the API", d: "Create a key, set the base URL, and ship." },
          ].map((s) => (
            <div key={s.t} className="flex gap-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-background text-primary">
                <s.icon className="size-4.5" />
              </div>
              <div>
                <h3 className="font-medium">{s.t}</h3>
                <p className="text-sm text-muted-foreground">{s.d}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto w-full max-w-3xl px-4 py-16">
        <h2 className="mb-6 text-center text-2xl font-semibold tracking-tight sm:text-3xl">Frequently asked questions</h2>
        <Accordion type="single" collapsible className="rounded-xl border bg-card/50 px-4">
          {FAQ.map((f, i) => (
            <AccordionItem key={f.q} value={`q${i}`}>
              <AccordionTrigger className="text-base">{f.q}</AccordionTrigger>
              <AccordionContent className="text-muted-foreground">{f.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>

      {/* CTA */}
      <section className="mx-auto w-full max-w-6xl px-4 pb-20">
        <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-primary/15 via-card to-[var(--chart-4)]/10 p-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Start building in minutes</h2>
          <p className="mx-auto mt-2 max-w-lg text-muted-foreground">Create an account, grab an API key and point your SDK at {appUrl}/v1.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg" className="h-10 px-5 text-sm">
              <Link href="/signup">Create free account</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-10 px-5 text-sm">
              <Link href="/docs">Quickstart guide</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
