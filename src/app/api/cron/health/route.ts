import { safeEqual } from "@/lib/crypto";
import { env, isProd } from "@/lib/env";
import { runAllHealthChecks } from "@/gateway/health";
import { sweepBatches } from "@/gateway/batches";
import { sweepVideoJobs } from "@/gateway/video";
import { replayDeadLetters } from "@/gateway/meter-writer";
import { logger } from "@/lib/logger";

/**
 * Cloud Scheduler -> POST/GET /api/cron/health every 5 minutes with `Authorization: Bearer $CRON_SECRET`.
 * Probes every upstream key of every active provider and updates Provider.healthStatus, and polls open video jobs
 * so jobs that failed upstream are refunded even if the customer never asks for their status again, and polls open
 * batches (Batch APIs: ended batches are metered, the holds of running ones kept in place). It also replays
 * the metering dead-letter file (rows that could not be written to the database earlier).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return !isProd; // dev convenience; production requires CRON_SECRET
  const header = req.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? "";
  return token.length > 0 && safeEqual(token, secret);
}

async function run(req: Request): Promise<Response> {
  if (!authorized(req)) return Response.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
  const started = Date.now();
  try {
    const res = await runAllHealthChecks();
    const videos = await sweepVideoJobs().catch((err) => {
      logger.warn("video sweep failed", { err });
      return { polled: 0, refunded: 0 };
    });
    const batches = await sweepBatches().catch((err) => {
      logger.warn("batch sweep failed", { err });
      return { polled: 0, metered: 0, failed: 0 };
    });
    const metering = await replayDeadLetters().catch((err) => {
      logger.warn("meter dead letter replay failed", { err });
      return { found: 0, replayed: 0, failed: 0 };
    });
    return Response.json({ ok: true, ...res, videos, batches, metering, ms: Date.now() - started }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    logger.error("health cron failed", { err });
    return Response.json({ ok: false, error: { code: "internal_error", message: "Health run failed" } }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
