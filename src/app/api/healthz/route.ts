import { db } from "@/lib/db";
import { getRedis } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness/readiness probe: `{ ok, db, redis }` (redis is "disabled" when REDIS_URL is unset). */
export async function GET() {
  let dbOk = false;
  try {
    await db.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const redis = getRedis();
  let redisState: "ok" | "down" | "disabled" = "disabled";
  if (redis) {
    try {
      redisState = (await redis.ping()) === "PONG" ? "ok" : "down";
    } catch {
      redisState = "down";
    }
  }

  const ok = dbOk; // Redis is optional; only the DB gates readiness
  return Response.json(
    { ok, db: dbOk ? "ok" : "down", redis: redisState, time: new Date().toISOString() },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
