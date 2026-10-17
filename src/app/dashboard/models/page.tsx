import { PageHeader } from "@/components/common/page-header";
import { ModelsClient } from "@/components/customer/models-client";
import { requireUser } from "@/lib/auth/session";
import { getModelsForUser } from "@/server/customer/portal-data";

export const metadata = { title: "Models & Pricing" };
export const dynamic = "force-dynamic";

export default async function ModelsPage() {
  const { user } = await requireUser();
  const { models, pools, currentPool } = await getModelsForUser(user);
  return (
    <>
      <PageHeader title="Models & Pricing" description="Every model you can call and exactly what it costs you, including your pool and account multipliers." />
      <ModelsClient models={models} pools={pools} currentPoolSlug={currentPool?.slug ?? null} />
    </>
  );
}
