import { KeysTable } from "@/components/admin/keys/keys-table";
import { PageHeader } from "@/components/common/page-header";
import { requireAdmin } from "@/lib/auth/session";
import { KEY_PAGE_SIZE, listApiKeys, parseKeyListParams } from "@/server/admin/keys-queries";
import { listGroupOptions } from "@/server/admin/customers-queries";

export const metadata = { title: "API Keys" };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const params = parseKeyListParams(await searchParams);
  const [{ rows, total }, groups] = await Promise.all([listApiKeys(params), listGroupOptions()]);
  return (
    <>
      <PageHeader title="API Keys" description="Every customer API key. Disable temporarily or revoke permanently." />
      <KeysTable rows={rows} total={total} page={params.page} pageSize={KEY_PAGE_SIZE} groups={groups} />
    </>
  );
}
