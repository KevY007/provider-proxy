import Redis from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

/**
 * Optional Redis. `getRedis()` returns null when REDIS_URL is unset - callers MUST provide an
 * in-memory fallback. Connection errors never throw into callers (they are logged once per outage).
 */
const g = globalThis as unknown as {
  __redis?: Redis | null;
  __redisSub?: Redis | null;
  __redisErrAt?: number;
};

function build(label: string, offlineQueue = false): Redis | null {
  if (!env.REDIS_URL) return null;
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: offlineQueue,
    connectTimeout: 5000,
    retryStrategy: (times) => Math.min(times * 200, 3000),
    lazyConnect: false,
  });
  client.on("error", (err) => {
    const now = Date.now();
    if (!g.__redisErrAt || now - g.__redisErrAt > 30_000) {
      g.__redisErrAt = now;
      logger.warn("redis error", { client: label, err });
    }
  });
  return client;
}

/** Shared command connection, or null if Redis is not configured. */
export function getRedis(): Redis | null {
  if (g.__redis === undefined) g.__redis = build("main");
  return g.__redis;
}

/** Dedicated connection for SUBSCRIBE (a subscribed connection cannot run other commands). */
export function getRedisSubscriber(): Redis | null {
  if (g.__redisSub === undefined) g.__redisSub = build("sub", true);
  return g.__redisSub;
}

/** True when Redis is configured and the connection is ready. */
export function redisReady(): boolean {
  const r = getRedis();
  return !!r && r.status === "ready";
}

export const CONFIG_INVALIDATE_CHANNEL = "config:invalidate";

/**
 * Tell all instances that config (settings / providers / models / keys / groups) changed.
 * `scope` is free-form, e.g. "settings", "provider:<id>", "model:<id>", "apikey:<id>", "all".
 * No-op without Redis (single-instance caches expire via TTL / are invalidated locally).
 */
export async function publishConfigInvalidate(scope: string): Promise<void> {
  const r = getRedis();
  if (!r || r.status !== "ready") return;
  try {
    await r.publish(CONFIG_INVALIDATE_CHANNEL, scope);
  } catch (err) {
    logger.warn("redis publish failed", { err });
  }
}
