import { NextResponse, type NextRequest } from "next/server";
import { requireAdminForAction } from "@/lib/auth/session";
import { AuthError } from "@/lib/auth/types";
import { csvResponse, toCsv } from "@/server/analytics/csv";
import { getBreakdown, getTimeSeries } from "@/server/analytics/queries";
import { isBreakdownDim, parseAnalyticsParams } from "@/server/analytics/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /admin/analytics/export?by=model&range=7d[&filters...] -> CSV of the breakdown (or `by=time` for the time series). */
export async function GET(req: NextRequest) {
  try {
    await requireAdminForAction();
  } catch (err) {
    const status = err instanceof AuthError && err.code === "forbidden" ? 403 : 401;
    return NextResponse.json({ error: "Unauthorized" }, { status });
  }
  const sp = req.nextUrl.searchParams;
  const { filter, gran } = parseAnalyticsParams(sp);
  const by = sp.get("by") ?? "model";
  const stamp = new Date().toISOString().slice(0, 10);

  if (by === "time") {
    const rows = await getTimeSeries(filter, gran);
    return csvResponse(
      toCsv(rows, [
        { key: "t", header: "bucket_start_utc" },
        { key: "requests" },
        { key: "errors" },
        { key: "revenue" },
        { key: "cost" },
        { key: "profit" },
        { key: "tokens" },
      ]),
      `analytics-time-${stamp}.csv`,
    );
  }
  if (!isBreakdownDim(by)) return NextResponse.json({ error: "Unknown breakdown" }, { status: 400 });
  const rows = await getBreakdown(by, filter, { limit: 1000 });
  return csvResponse(
    toCsv(rows, [
      { key: "label", header: by },
      { key: "key", header: "id" },
      { key: "requests" },
      { key: "errors" },
      { key: "errorRate" },
      { key: "revenue" },
      { key: "cost" },
      { key: "profit" },
      { key: "marginPct" },
      { key: "inputTokens" },
      { key: "outputTokens" },
      { key: "tokens" },
      { key: "avgLatencyMs" },
      { key: "p95LatencyMs" },
    ]),
    `analytics-by-${by}-${stamp}.csv`,
  );
}
