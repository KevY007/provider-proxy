import { PageHeader } from "@/components/common/page-header";
import { PlaygroundClient, type PlaygroundPool } from "@/components/customer/playground-client";
import type { PlaygroundModel } from "@/components/customer/playground-shared";
import { requireUser } from "@/lib/auth/session";
import { getModelsForUser } from "@/server/customer/portal-data";
import { poolSavingsLabel } from "@/server/customer/pricing";

export const metadata = { title: "Playground" };
export const dynamic = "force-dynamic";

export default async function PlaygroundPage() {
  const { user } = await requireUser();
  const { models, pools, currentPool } = await getModelsForUser(user);
  // every pool the customer may use, each with its own models at that pool's prices
  const options: PlaygroundPool[] = pools
    .map((p) => {
      const toPlayground = (m: (typeof models)[number]): PlaygroundModel | null =>
        m.prices[p.slug] ? { slug: m.slug, displayName: m.displayName, vendor: m.vendor, capabilities: m.capabilities, prices: m.prices[p.slug], official: m.official } : null;
      const of = (cap: string) => models.filter((m) => m.capabilities.includes(cap)).map(toPlayground).filter((m): m is PlaygroundModel => !!m);
      return { id: p.id, name: p.name, savings: poolSavingsLabel(p.savingsPct), chatModels: of("chat"), imageModels: of("images") };
    })
    .filter((p) => p.chatModels.length || p.imageModels.length);

  return (
    <>
      <PageHeader title="Playground" description="Try models right in the browser. Requests go through the same API your keys use." />
      <PlaygroundClient pools={options} defaultPoolId={currentPool?.id ?? null} emailVerified={!!user.emailVerifiedAt} email={user.email} />
    </>
  );
}
