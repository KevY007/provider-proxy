import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { runBillingCron } from "@/server/billing/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Billing cron (Cloud Scheduler hourly): auto-recharge sweep, postpaid settlement, stale PENDING payment
 * reconciliation. Auth: `Authorization: Bearer $CRON_SECRET`. GET and POST are equivalent.
 */
async function handle(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token || !safeEqual(token, env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  try {
    const summary = await runBillingCron();
    logger.info("billing cron finished", { ms: Date.now() - started, ...summary });
    return NextResponse.json({ ok: true, ms: Date.now() - started, ...summary });
  } catch (err) {
    logger.error("billing cron failed", { err });
    return NextResponse.json({ ok: false, error: "billing cron failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
