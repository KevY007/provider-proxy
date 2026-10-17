import { CustomersTable } from "@/components/admin/customers/customers-table";
import { PageHeader } from "@/components/common/page-header";
import { requireAdmin } from "@/lib/auth/session";
import { parseCustomerListParams } from "@/server/admin/customers-calc";
import { listCustomers, listGroupOptions } from "@/server/admin/customers-queries";

export const metadata = { title: "Customers" };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const params = parseCustomerListParams(sp);
  const [{ rows, total }, groups] = await Promise.all([listCustomers(params), listGroupOptions()]);
  const exportQuery = new URLSearchParams(
    Object.entries({ q: params.q, status: params.status, role: params.role, group: params.group, sort: params.sort, dir: params.dir }).filter(([, v]) => v),
  ).toString();
  return (
    <>
      <PageHeader title="Customers" description="Accounts, balances and 30-day usage. Click a row for the full profile." />
      <CustomersTable rows={rows} total={total} page={params.page} pageSize={params.pageSize} groups={groups} exportQuery={exportQuery} />
    </>
  );
}
