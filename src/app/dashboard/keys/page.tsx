import { PageHeader } from "@/components/common/page-header";
import { KeysClient } from "@/components/customer/keys-client";
import { requireUser } from "@/lib/auth/session";
import { appUrl } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { getKeysPageData } from "@/server/customer/portal-data";

export const metadata = { title: "API Keys" };
export const dynamic = "force-dynamic";

export default async function KeysPage() {
  const { user } = await requireUser();
  const [data, siteName] = await Promise.all([getKeysPageData(user), getSetting("siteName")]);
  return (
    <>
      <PageHeader title="API Keys" description="Create keys for your apps and tools. Each key can have its own pool, model access, rate limits, spend cap and expiry." />
      <KeysClient
        keys={data.keys}
        pools={data.pools}
        currentPool={data.currentPool}
        models={data.models}
        appUrl={appUrl}
        siteName={siteName}
        emailVerified={!!user.emailVerifiedAt}
        email={user.email}
      />
    </>
  );
}
