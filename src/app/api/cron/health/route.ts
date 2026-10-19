import { safeEqual } from "@/lib/crypto";
import { env, isDev } from "@/lib/env";
import { logger } from "@/lib/logger";
import { runDueJobs } from "@/server/maintenance";

/**
 * OPTIONAL Cloud Scheduler hook (`Authorization: Bearer $CRON_SECRET`), e.g. every 5 minutes. Nothing needs it: by
 * default the same work runs while the server handles calls (server/maintenance.ts). Use it to keep upkeep and uptime
 * pings going while nobody calls, without keeping an instance running.
 *
 * Runs "upkeep" (provider health from traffic, video + batch sweeps, metering dead-letter replay, history pruning) and,
 * only when Settings > Monitoring > Uptime monitoring is on, "probes" (a free ping of every upstream key).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return isDev && env.NODE_ENV === "development"; // local dev convenience only; everything else requires CRON_SECRET
  const header = req.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? "";
  return token.length > 0 && safeEqual(token, secret);
}

async function run(req: Request): Promise<Response> {
  if (!authorized(req)) return Response.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
  const started = Date.now();
  try {
    const jobs = await runDueJobs("cron", { only: ["upkeep", "probes"] });
    const probes = jobs.find((j) => j.job === "probes");
    const res = (probes?.result as { checked: number; failed: number } | undefined) ?? { checked: 0, failed: 0 };
    return Response.json(
      { ok: true, ...res, ...(probes?.ran ? {} : { skipped: "uptime monitoring is off" }), jobs, ms: Date.now() - started },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    logger.error("health cron failed", { err });
    return Response.json({ ok: false, error: { code: "internal_error", message: "Health run failed" } }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
