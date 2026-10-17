import { safeEqual } from "@/lib/crypto";
import { env, isProd } from "@/lib/env";
import { runAllHealthChecks } from "@/gateway/health";
import { logger } from "@/lib/logger";

/**
 * Cloud Scheduler -> POST/GET /api/cron/health every 5 minutes with `Authorization: Bearer $CRON_SECRET`.
 * Probes every upstream key of every active provider and updates Provider.healthStatus.
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
    return Response.json({ ok: true, ...res, ms: Date.now() - started }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    logger.error("health cron failed", { err });
    return Response.json({ ok: false, error: { code: "internal_error", message: "Health run failed" } }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
