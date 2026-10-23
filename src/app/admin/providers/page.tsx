import { PageHeader } from "@/components/common/page-header";
import { ProvidersTable } from "@/components/admin/providers/providers-table";
import { getSlotSnapshot } from "@/gateway/slots";
import { requireAdmin } from "@/lib/auth/session";
import { listPresets } from "@/server/admin/provider-presets";
import { listProviders } from "@/server/admin/providers-queries";
import { getUpstreamBalances } from "@/server/admin/upstream-balances";

export const metadata = { title: "Providers" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const { user } = await requireAdmin();
  const [rows, slots, balances] = await Promise.all([
    listProviders(),
    getSlotSnapshot().catch(() => ({ providerKeys: [], providers: [], customers: [], queued: 0, at: new Date().toISOString() })),
    getUpstreamBalances().catch(() => []),
  ]);
  return (
    <>
      <PageHeader title="Providers" description="Upstream providers and their API keys/accounts. Every public model routes to one or more of these." />
      <ProvidersTable rows={rows} presets={listPresets()} initialSlots={slots} canEdit={user.role === "ADMIN"} balances={Object.fromEntries(balances.map((b) => [b.providerId, { balance: b.balance, error: b.error }]))} />
    </>
  );
}
