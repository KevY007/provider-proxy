import { requireAdminForAction } from "@/lib/auth/session";
import { AuthError } from "@/lib/auth/types";
import { parseLogFilters } from "@/server/admin/logs-query";
import { iterateLogs } from "@/server/admin/logs-queries";
import { csvEscape } from "@/server/analytics/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPORT_CAP = 50_000;
const COLUMNS = [
  "id", "createdAt", "userId", "email", "keyPrefix", "modelSlug", "upstreamModel", "providerName", "providerKeyLabel",
  "endpoint", "status", "httpStatus", "errorCode", "stream", "inputTokens", "outputTokens", "cachedTokens",
  "serverTools", "batchId", "price", "cost", "profit", "officialPrice", "latencyMs", "queueMs",
] as const;

export async function GET(req: Request) {
  try {
    await requireAdminForAction();
  } catch (err) {
    if (err instanceof AuthError) return new Response(err.code === "unauthenticated" ? "Unauthorized" : "Forbidden", { status: err.code === "unauthenticated" ? 401 : 403 });
    throw err;
  }
  const filters = parseLogFilters(new URL(req.url).searchParams);
  const encoder = new TextEncoder();
  const iterator = iterateLogs(filters, EXPORT_CAP);
  let headerSent = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!headerSent) {
          headerSent = true;
          controller.enqueue(encoder.encode(COLUMNS.join(",") + "\r\n"));
          return;
        }
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        const text = value.map((r) => COLUMNS.map((c) => csvEscape((r as unknown as Record<string, unknown>)[c])).join(",")).join("\r\n") + "\r\n";
        controller.enqueue(encoder.encode(text));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="request-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
