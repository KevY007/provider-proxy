import Link from "next/link";
import { KeysTable } from "@/components/admin/keys/keys-table";
import { EmptyRevokedKeys } from "@/components/admin/keys/key-actions";
import { PageHeader } from "@/components/common/page-header";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requireAdmin } from "@/lib/auth/session";
import { countRevokedApiKeys, KEY_PAGE_SIZE, listApiKeys, parseKeyListParams } from "@/server/admin/keys-queries";
import { listGroupOptions } from "@/server/admin/customers-queries";

export const metadata = { title: "API Keys" };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const params = parseKeyListParams(await searchParams);
  const [{ rows, total }, groups, revoked] = await Promise.all([listApiKeys(params), listGroupOptions(), countRevokedApiKeys()]);
  const bin = params.view === "revoked";
  return (
    <>
      <PageHeader
        title="API Keys"
        description={bin ? "Revoked keys. They no longer work; delete them to clear them out for good (request logs stay)." : "Every customer API key. Disable temporarily or revoke permanently."}
        actions={bin ? <EmptyRevokedKeys count={revoked} /> : undefined}
      />
      <Tabs value={bin ? "revoked" : "active"} className="mb-4">
        <TabsList>
          <TabsTrigger value="active" asChild>
            <Link href="/admin/keys">Keys</Link>
          </TabsTrigger>
          <TabsTrigger value="revoked" asChild>
            <Link href="/admin/keys?view=revoked">Revoked ({revoked})</Link>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <KeysTable rows={rows} total={total} page={params.page} pageSize={KEY_PAGE_SIZE} groups={groups} bin={bin} />
    </>
  );
}
