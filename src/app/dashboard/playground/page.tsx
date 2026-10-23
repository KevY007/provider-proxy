import { PageHeader } from "@/components/common/page-header";
import { PlaygroundClient } from "@/components/customer/playground-client";
import type { PlaygroundModel } from "@/components/customer/playground-shared";
import { requireUser } from "@/lib/auth/session";
import { getModelsForUser } from "@/server/customer/portal-data";
import { poolSavingsLabel } from "@/server/customer/pricing";

export const metadata = { title: "Playground" };
export const dynamic = "force-dynamic";

export default async function PlaygroundPage() {
  const { user } = await requireUser();
  const { models, currentPool } = await getModelsForUser(user);
  const slug = currentPool?.slug ?? "";
  const toPlayground = (m: (typeof models)[number]): PlaygroundModel | null =>
    m.prices[slug] ? { slug: m.slug, displayName: m.displayName, vendor: m.vendor, capabilities: m.capabilities, prices: m.prices[slug], official: m.official } : null;
  const chatModels = models.filter((m) => m.capabilities.includes("chat")).map(toPlayground).filter((m): m is PlaygroundModel => !!m);
  const imageModels = models.filter((m) => m.capabilities.includes("images")).map(toPlayground).filter((m): m is PlaygroundModel => !!m);

  return (
    <>
      <PageHeader title="Playground" description="Try models right in the browser. Requests go through the same API your keys use." />
      <PlaygroundClient
        chatModels={chatModels}
        imageModels={imageModels}
        poolName={currentPool?.name ?? "default"}
        savings={poolSavingsLabel(currentPool?.savingsPct)}
        emailVerified={!!user.emailVerifiedAt}
        email={user.email}
      />
    </>
  );
}
