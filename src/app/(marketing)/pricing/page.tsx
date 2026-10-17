import type { Metadata } from "next";
import { PricingExplorer } from "@/components/marketing/pricing-explorer";
import { getCatalogModels, getPublicGroups } from "@/server/customer/catalog";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Live per-token pricing for every model, by pool, compared with official list prices.",
};
export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const [models, groups] = await Promise.all([getCatalogModels(), getPublicGroups()]);
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12">
      <div className="mb-8 max-w-2xl space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Simple, transparent pricing</h1>
        <p className="text-muted-foreground">
          Pay per token, billed from a prepaid balance. Pick a pool for your API key to unlock lower multipliers. Prices below are live from our catalog.
        </p>
      </div>
      <PricingExplorer
        models={models.map((m) => ({
          slug: m.slug,
          displayName: m.displayName,
          vendor: m.vendor,
          capabilities: m.capabilities,
          contextWindow: m.contextWindow,
          inputPrice: m.inputPrice,
          outputPrice: m.outputPrice,
          cachedInputPrice: m.cachedInputPrice,
          cacheWritePrice: m.cacheWritePrice,
          imagePrice: m.imagePrice,
          requestPrice: m.requestPrice,
          officialInputPrice: m.officialInputPrice,
          officialOutputPrice: m.officialOutputPrice,
          officialCachedPrice: m.officialCachedPrice,
        }))}
        groups={groups
          .filter((g) => g.isPublic)
          .map((g) => ({ slug: g.slug, name: g.name, description: g.description, priceMultiplier: g.priceMultiplier, isDefault: g.isDefault }))}
      />
    </div>
  );
}
