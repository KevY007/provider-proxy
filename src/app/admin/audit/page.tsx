import { PageHeader } from "@/components/common/page-header";
import { AuditTable } from "@/components/admin/audit/audit-table";
import { FilterInput, FilterSelect, ResetFilters, UrlRangePicker } from "@/components/admin/url-filters";
import { requireAdmin } from "@/lib/auth/session";
import { listAudit } from "@/server/admin/audit-queries";

export const metadata = { title: "Audit Log" };
export const dynamic = "force-dynamic";

const TARGET_TYPES = ["Provider", "ProviderKey", "Model", "ModelRoute", "Group", "User", "ApiKey", "Setting", "Announcement", "Payment", "RedeemCode"];

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const { rows, nextCursor, range } = await listAudit(sp);
  return (
    <>
      <PageHeader title="Audit Log" description="Every admin mutation and sensitive event, newest first." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterInput param="action" placeholder="Action contains..." className="w-48" />
        <FilterInput param="actor" placeholder="Actor email or id" className="w-48" />
        <FilterSelect param="targetType" label="Target" options={TARGET_TYPES.map((t) => ({ value: t, label: t }))} />
        <ResetFilters keys={["action", "actor", "targetType"]} />
        <UrlRangePicker initial={range} className="ml-auto" />
      </div>
      <AuditTable rows={rows} nextCursor={nextCursor} />
    </>
  );
}
