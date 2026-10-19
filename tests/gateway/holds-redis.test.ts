/**
 * Redis-backed credit holds (Lua check-and-reserve). Runs only when a Redis is reachable at GW_TEST_REDIS_URL
 * (default redis://localhost:6380 = docker-compose); skipped otherwise. Modules are imported dynamically AFTER
 * REDIS_URL is set, because lib/env reads it once at import time.
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

describe.skipIf(!up)("credit holds (Redis backend)", () => {
  let holds: typeof import("@/gateway/holds");
  let D: typeof import("@/lib/money").Decimal;
  let redis: Redis;
  const uid = () => `gwt-hold-${Math.random().toString(36).slice(2, 10)}`;
  const made: string[] = [];

  const input = (userId: string, id: string, amount: string, over: Record<string, unknown> = {}) => ({
    id,
    userId,
    keyId: null as string | null,
    amount: new D(amount),
    base: new D("1"),
    headroomExtra: new D(0),
    monthlyRemaining: null as InstanceType<typeof D> | null,
    keyRemaining: null as InstanceType<typeof D> | null,
    ...over,
  });
  const ref = (userId: string, id: string, keyId: string | null = null) => ({ id, userId, keyId, backend: "redis" as const, createdAt: Date.now() });

  beforeAll(async () => {
    process.env.REDIS_URL = url;
    holds = await import("@/gateway/holds");
    D = (await import("@/lib/money")).Decimal;
    const { getRedis } = await import("@/lib/redis");
    redis = getRedis()!;
    for (let i = 0; i < 50 && redis.status !== "ready"; i++) await sleep(50);
    expect(redis.status).toBe("ready");
  });

  afterAll(async () => {
    const keys = [...made.flatMap((u) => [`hold:${u}`, `bal:${u}`])];
    if (keys.length) await redis.del(...keys);
  });

  it("is atomic across concurrent reservations and seeds the shared balance", async () => {
    const u = uid();
    made.push(u);
    const res = await Promise.all(Array.from({ length: 40 }, (_, i) => holds.reserveHold(input(u, `r${i}`, "0.07"))));
    expect(res.every((r) => r.backend === "redis")).toBe(true);
    expect(res.filter((r) => r.ok).length).toBe(14); // floor(1 / 0.07)
    expect(await redis.hlen(`hold:${u}`)).toBe(14);
    expect(await redis.get(`bal:${u}`)).toBe("1000000"); // seeded from `base` (micro-USD)
    expect(res[0].sharedBalance?.toString()).toBe("1"); // the check reports the shared balance it used (stale-low recovery)
  });

  it("every hold has its own expiry", async () => {
    const u = uid();
    made.push(u);
    await holds.reserveHold(input(u, "e1", "0.1"));
    const v = (await redis.hget(`hold:${u}`, "e1"))!;
    const [kind, amount, exp] = v.split("|");
    expect(kind).toBe("H");
    expect(amount).toBe("100000");
    expect(Number(exp)).toBeGreaterThan(Date.now() + 60_000);
    expect(await redis.pttl(`hold:${u}`)).toBeGreaterThan(0);
  });

  it("settle keeps the actual price visible as a pending debit until the flush clears it and publishes the balance", async () => {
    const u = uid();
    made.push(u);
    expect((await holds.reserveHold(input(u, "s1", "0.5"))).ok).toBe(true);
    holds.settleHold(ref(u, "s1"), new D("0.4"));
    await sleep(50);
    expect((await redis.hget(`hold:${u}`, "s1"))!.startsWith("P|400000|")).toBe(true);
    // 1 - 0.4 pending = 0.6 available
    expect((await holds.reserveHold(input(u, "s2", "0.7"))).ok).toBe(false);
    expect((await holds.reserveHold(input(u, "s3", "0.55"))).ok).toBe(true);

    await holds.publishBalance(u, new D("0.6"), ["s1"]); // the meter writer committed the 0.4 debit
    expect(await redis.hexists(`hold:${u}`, "s1")).toBe(0);
    expect(await redis.get(`bal:${u}`)).toBe("600000"); // lowered to the authoritative balance
    // available = 0.6 - 0.55 (open hold s3) = 0.05
    const r = await holds.reserveHold(input(u, "s4", "0.1"));
    expect(r.ok).toBe(false);
    expect(r.available.toString()).toBe("0.05");
  });

  it("the shared balance is only ever lowered by a flush; a top-up (forget) reseeds it", async () => {
    const u = uid();
    made.push(u);
    await holds.reserveHold(input(u, "b1", "0.1"));
    await holds.publishBalance(u, new D("0.8"), []);
    expect(await redis.get(`bal:${u}`)).toBe("800000");
    await holds.publishBalance(u, new D("0.9"), []); // an older / out-of-order flush must not raise it
    expect(await redis.get(`bal:${u}`)).toBe("800000");
    holds.forgetSharedBalance(u);
    await sleep(50);
    expect(await redis.exists(`bal:${u}`)).toBe(0);
    const r = await holds.reserveHold(input(u, "b2", "0.1", { base: new D("5") }));
    expect(r.ok).toBe(true);
    expect(await redis.get(`bal:${u}`)).toBe("5000000");
  });

  it("release frees the hold; key and monthly limits are evaluated atomically in the same call", async () => {
    const u = uid();
    made.push(u);
    const key = `key-${u}`;
    made.push(`key:${key}`);
    const a = await holds.reserveHold(input(u, "k1", "0.1", { keyId: key, keyRemaining: new D("0.15") }));
    const b = await holds.reserveHold(input(u, "k2", "0.1", { keyId: key, keyRemaining: new D("0.15") }));
    expect([a.ok, b.ok]).toEqual([true, false]);
    expect(b.reason).toBe("key");
    expect(b.keyAvailable?.toString()).toBe("0.05");
    holds.releaseHold(ref(u, "k1", key));
    await sleep(50);
    expect((await holds.reserveHold(input(u, "k3", "0.1", { keyId: key, keyRemaining: new D("0.15") }))).ok).toBe(true);

    const m = await holds.reserveHold(input(u, "m1", "0.5", { monthlyRemaining: new D("0.4") }));
    expect(m.reason).toBe("monthly");
  });

  it("expired holds are purged by the next reservation", async () => {
    const u = uid();
    made.push(u);
    await redis.hset(`hold:${u}`, "dead", `H|900000|${Date.now() - 1000}`);
    const r = await holds.reserveHold(input(u, "live", "0.5"));
    expect(r.ok).toBe(true); // the expired 0.9 hold did not count
    expect(await redis.hexists(`hold:${u}`, "dead")).toBe(0);
  });
});
