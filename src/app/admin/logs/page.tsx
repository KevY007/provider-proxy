import { LogsTable } from "@/components/admin/logs/logs-table";
import { PageHeader } from "@/components/common/page-header";
import { requireAdmin } from "@/lib/auth/session";
import { parseRangeParams } from "@/lib/date-range";
import { decodeCursor, filtersToQuery, parseLogFilters } from "@/server/admin/logs-query";
import { getLogFilterOptions, listLogs } from "@/server/admin/logs-queries";

export const metadata = { title: "Logs" };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  const filters = parseLogFilters(sp);
  const range = parseRangeParams({ range: one("range"), from: one("from"), to: one("to") }, "24h");
  const cursor = decodeCursor(one("cursor"));
  const dir = cursor && one("dir") === "newer" ? "newer" : "older";
  const [page, options] = await Promise.all([listLogs(filters, cursor, dir), getLogFilterOptions()]);
  const logId = one("log");

  return (
    <>
      <PageHeader title="Request logs" description="Every gateway request with cost, price, profit and internal error detail. Click a row for the full record." />
      <LogsTable
        rows={page.rows}
        hasOlder={page.hasOlder}
        hasNewer={page.hasNewer}
        olderCursor={page.olderCursor}
        newerCursor={page.newerCursor}
        range={{ preset: range.preset, from: range.from.toISOString(), to: range.to.toISOString() }}
        providers={options.providers}
        exportQuery={filtersToQuery(sp)}
        initialLogId={logId && logId.length < 100 ? logId : undefined}
      />
    </>
  );
}
