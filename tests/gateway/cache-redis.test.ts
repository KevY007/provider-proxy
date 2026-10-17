/**
 * Cross-instance config invalidation over Redis pub/sub (`config:invalidate`). Skipped without Redis.
 * Another "instance" is simulated with a separate ioredis connection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";

const url = process.env.GW_TEST_REDIS_URL ?? "redis://localhost:6380";

async function reachable(): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, connectTimeout: 1500, retryStrategy: () => null });
  r.on("error", () => undefined);
  try {
    await r.connect();
    return (await r.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

const up = await reachable();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(20);
  return cond();
}

describe.skipIf(!up)("config invalidation over Redis pub/sub", () => {
  let cache: typeof import("@/gateway/cache");
  let other: Redis;
  let listener: Redis;
  const seen: Array<[string, string | undefined]> = [];
  const wire: string[] = [];

  beforeAll(async () => {
    process.env.REDIS_URL = url;
    cache = await import("@/gateway/cache");
    cache.onGatewayInvalidate((scope, id) => void seen.push([scope, id]));
    cache.startInvalidationListener();
    other = new Redis(url);
    listener = new Redis(url);
    await listener.subscribe("config:invalidate");
    listener.on("message", (_c, m) => wire.push(m));
    await sleep(300); // let the gateway's subscriber connect
  });

  afterAll(async () => {
    other?.disconnect();
    listener?.disconnect();
  });

  it("drops local caches when ANOTHER instance publishes an invalidation", async () => {
    await other.publish("config:invalidate", "apiKeys:key_abc");
    await other.publish("config:invalidate", "users:user_1");
    await other.publish("config:invalidate", "models");
    await other.publish("config:invalidate", "provider:prov_9"); // alias spelling used by other agents
    expect(await until(() => seen.length >= 4)).toBe(true);
    expect(seen).toEqual(expect.arrayContaining([["apiKeys", "key_abc"], ["users", "user_1"], ["models", undefined], ["providers", "prov_9"]]));
  });

  it("applies upstream-key cooldowns broadcast by another instance (pkh: messages)", async () => {
    const until1 = Date.now() + 60_000;
    await other.publish("config:invalidate", `pkh:key_remote:COOLDOWN:${until1}:3`);
    expect(await until(() => cache.getKeyRuntime("key_remote") !== undefined)).toBe(true);
    const k = { id: "key_remote", status: "ACTIVE", cooldownUntil: null, consecutiveFailures: 0 } as unknown as Parameters<typeof cache.isKeyUsable>[0];
    expect(cache.effectiveKeyState(k)).toMatchObject({ status: "COOLDOWN", cooldownUntil: until1, consecutiveFailures: 3 });
    expect(cache.isKeyUsable(k)).toBe(false);
  });

  it("publishes local invalidations for the other instances", async () => {
    wire.length = 0;
    await cache.invalidateGatewayConfig("groups");
    await cache.invalidateGatewayConfig("users", "user_77");
    expect(await until(() => wire.length >= 2)).toBe(true);
    expect(wire).toEqual(expect.arrayContaining(["groups", "users:user_77"]));
  });

  it("ignores unknown / malformed messages", async () => {
    // (the channel is shared with other processes on this Redis, so assert on OUR messages only)
    await other.publish("config:invalidate", "totally-unknown:thing_zzz");
    await other.publish("config:invalidate", "");
    await other.publish("config:invalidate", "pkh:");
    await sleep(200);
    expect(seen.some(([, id]) => id === "thing_zzz")).toBe(false);
    // and the listener is still alive afterwards
    await other.publish("config:invalidate", "users:still_alive");
    expect(await until(() => seen.some(([s, id]) => s === "users" && id === "still_alive"))).toBe(true);
  });
});
