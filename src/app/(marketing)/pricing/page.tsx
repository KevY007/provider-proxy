import type { Metadata } from "next";
import { PricingExplorer } from "@/components/marketing/pricing-explorer";
import { toPriceModel } from "@/server/customer/price-rows";
import { getCatalogModels, getPublicGroups } from "@/server/customer/catalog";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Live pricing for every model, by pool, compared with the original providers' official prices.",
};
export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const [models, groups] = await Promise.all([getCatalogModels(), getPublicGroups()]);
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12">
      <div className="mb-8 max-w-2xl space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Simple, transparent pricing</h1>
        <p className="text-muted-foreground">
          Pay only for what you use, billed from a prepaid balance. For every model you see the official price (what OpenAI, Anthropic and others charge directly), your price with us, and how much you save. If we are ever more expensive, we show that too.
        </p>
      </div>
      <PricingExplorer
        models={models.map(toPriceModel)}
        groups={groups
          .filter((g) => g.isPublic)
          .map((g) => ({ slug: g.slug, name: g.name, description: g.description, priceMultiplier: g.priceMultiplier, isDefault: g.isDefault }))}
      />
    </div>
  );
}
