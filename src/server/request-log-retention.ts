import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

// One short statement per upkeep. The index skips completed rows (including rows that never had bodies).
// Late metering/dead-letter inserts start unexpired and are picked up even if their createdAt is old.
export function expireRequestDiagnostics(tx: Pick<typeof db, "$executeRaw"> = db): Promise<number> {
  return tx.$executeRaw(Prisma.sql`
    WITH batch AS (
      SELECT id FROM "RequestLog"
      WHERE NOT "diagnosticsExpired" AND "createdAt" < date_trunc('milliseconds', now() AT TIME ZONE 'UTC') - interval '14 days'
      ORDER BY "createdAt", id LIMIT 500 FOR UPDATE SKIP LOCKED
    )
    UPDATE "RequestLog" r SET "diagnosticsExpired" = true,
      "requestBody" = NULL, "responseBody" = NULL, ip = NULL, "userAgent" = NULL,
      "errorMessage" = NULL, "internalError" = NULL,
      attempts = COALESCE((
        SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'status', CASE WHEN jsonb_typeof(a->'status') = 'number' THEN a->'status' END,
          'latencyMs', CASE WHEN jsonb_typeof(a->'latencyMs') = 'number' THEN a->'latencyMs' END,
          -- A 2xx attempt can still have failed in-stream. Preserve that fact, not its text.
          'error', CASE WHEN jsonb_typeof(a->'error') = 'string' AND btrim(a->>'error') <> '' THEN 'Failed' END
        )) ORDER BY ord)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.attempts) = 'array' THEN r.attempts ELSE '[]'::jsonb END)
          WITH ORDINALITY AS entries(a, ord)
      ), '[]'::jsonb)
    FROM batch WHERE r.id = batch.id`);
}
