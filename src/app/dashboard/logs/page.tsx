import { PageHeader } from "@/components/common/page-header";
import { LogsClient } from "@/components/customer/logs-client";
import { requireUser } from "@/lib/auth/session";
import { parseRangeParams } from "@/lib/date-range";
import { parseLogFilters } from "@/server/customer/log-filters";
import { getLogFilterOptions, listLogs } from "@/server/customer/logs";

export const metadata = { title: "Logs" };
export const dynamic = "force-dynamic";

export default async function LogsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { user } = await requireUser();
  const range = parseRangeParams(sp, "7d");
  const filters = parseLogFilters(sp, range);
  const cursor = (Array.isArray(sp.cursor) ? sp.cursor[0] : sp.cursor) || null;
  const [page, options] = await Promise.all([listLogs(user.id, filters, cursor), getLogFilterOptions(user.id)]);

  return (
    <>
      <PageHeader title="Request logs" description="Every API request made with your keys. Click a row for details." />
      <LogsClient
        rows={page.rows}
        nextCursor={page.nextCursor}
        hasCursor={!!cursor}
        range={{ preset: range.preset, from: range.from.toISOString(), to: range.to.toISOString() }}
        options={options}
      />
    </>
  );
}
