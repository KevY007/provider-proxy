import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { expireRequestDiagnostics } from "@/server/request-log-retention";
import { summarizeAttempts } from "@/server/admin/logs-query";

const dbOk = await db.$queryRaw`SELECT 1`.then(() => true, () => false);

describe.skipIf(!dbOk)("request diagnostic retention", () => {
  it("scrubs bounded batches, preserves the metered rows and attempt summary, and stops at 14 days", async () => {
    await db.$transaction(async tx => {
      // Shadow the real table on this connection. now() is stable for the transaction, including the boundary row.
      await tx.$executeRaw`CREATE TEMP TABLE "RequestLog" (LIKE "RequestLog" INCLUDING DEFAULTS INCLUDING INDEXES) ON COMMIT DROP`;
      await tx.$executeRaw`SET LOCAL search_path TO pg_temp`;
      await tx.$executeRaw`INSERT INTO "RequestLog" (id, "userId", endpoint, "inboundFormat", status, "httpStatus", "errorCode",
        price, waived, cost, profit, "officialPrice", "inputTokens", "toolUsage", "createdAt", attempts,
        "requestBody", "responseBody", ip, "userAgent", "errorMessage", "internalError")
        SELECT n::text, 'test-user', '/test', 'test', 'UPSTREAM_ERROR', 502, 'upstream_error',
          3, 1, 1, 2, 6, 100, '{"calls":2}'::jsonb, date_trunc('milliseconds', now() AT TIME ZONE 'UTC') - interval '14 days'
            + CASE WHEN n = 503 THEN interval '1 millisecond' WHEN n = 502 THEN interval '0' ELSE interval '-1 millisecond' END,
          CASE n WHEN 2 THEN '[]'::jsonb WHEN 3 THEN '"invalid"'::jsonb WHEN 4 THEN '[null,{"status":"private"}]'::jsonb
          ELSE '[{"status":200,"latencyMs":31,"idempotencyKey":"test","error":"in-stream failure"},
                 {"status":503,"latencyMs":5,"providerKeyId":"test","routeId":"test"},{"status":200,"latencyMs":8,"futureDetail":"test"}]'::jsonb END,
          'null'::jsonb, '{}'::jsonb, 'test-ip', 'test-agent', 'test-message', 'test-detail' FROM generate_series(1,503) n`;
      const protectedRows = () => tx.$queryRaw`SELECT id, md5((to_jsonb(r) - CASE WHEN id IN ('502','503') THEN ARRAY[]::text[] ELSE
        ARRAY['diagnosticsExpired','requestBody','responseBody','ip','userAgent','errorMessage','internalError','attempts'] END)::text) AS digest
        FROM "RequestLog" r ORDER BY id`;
      const before = await protectedRows();
      expect(await expireRequestDiagnostics(tx)).toBe(500);
      expect(await expireRequestDiagnostics(tx)).toBe(1);
      expect(await expireRequestDiagnostics(tx)).toBe(0);
      expect(await protectedRows()).toEqual(before);
      expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM "RequestLog" WHERE "diagnosticsExpired" AND "requestBody" IS NULL
        AND "responseBody" IS NULL AND ip IS NULL AND "userAgent" IS NULL AND "errorMessage" IS NULL AND "internalError" IS NULL`).toEqual([{ n: 501 }]);
      const a = await tx.$queryRaw<{ attempts: unknown }[]>`SELECT attempts FROM "RequestLog" WHERE id IN ('1','2','3','4') ORDER BY id`;
      expect(a.map(r => r.attempts)).toEqual([[{ status: 200, latencyMs: 31, error: "Failed" }, { status: 503, latencyMs: 5 }, { status: 200, latencyMs: 8 }], [], [], [{}, {}]]);
      expect(summarizeAttempts(a[0].attempts)).toMatchObject({ attempts: 3, failed: 2, failedMs: 36 });
    });
  });
});
