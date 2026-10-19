import { getSession } from "@/lib/auth/session";
import { parseRangeParams } from "@/lib/date-range";
import { getSeries } from "@/server/customer/analytics";
import { clampGranularity, type Granularity } from "@/server/customer/buckets";
import { csvResponse, toCsv } from "@/server/customer/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /dashboard/usage/export?range=7d&gran=day - time-series CSV for the signed-in customer. */
export async function GET(req: Request) {
  const s = await getSession();
  if (!s) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  const range = parseRangeParams({ range: url.searchParams.get("range") ?? undefined, from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined });
  const g = url.searchParams.get("gran");
  const gran = clampGranularity(g === "hour" || g === "day" ? (g as Granularity) : undefined, range.from, range.to);
  const series = await getSeries(s.user.id, range.from, range.to, gran);
  const csv = toCsv(
    ["bucket_start_utc", "requests", "errors", "cost_usd", "input_tokens", "output_tokens", "cached_tokens"],
    series.map((p) => [p.bucket, p.requests, p.errors, p.spend, p.inputTokens, p.outputTokens, p.cachedTokens]),
  );
  return csvResponse("usage", csv);
}
