/**
 * Redis-backed slot manager (Lua leases). Runs only when a Redis is reachable at GW_TEST_REDIS_URL
 * (default redis://localhost:6380 = docker-compose); skipped otherwise. Modules are imported dynamically AFTER
 * REDIS_URL is set, because lib/env reads it once at import time (vitest sets it to "" for the other suites).
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

describe.skipIf(!up)("slot manager (Redis backend)", () => {
  let slots: typeof import("@/gateway/slots");
  let redis: Redis;
  const id = (s: string) => `${s}-${Math.random().toString(36).slice(2, 8)}`;
  const pool = (i: string, max: number) => ({ kind: "pkey" as const, id: i, max });

  beforeAll(async () => {
    process.env.REDIS_URL = url;
    slots = await import("@/gateway/slots");
    const { getRedis } = await import("@/lib/redis");
    redis = getRedis()!;
    for (let i = 0; i < 50 && redis.status !== "ready"; i++) await sleep(50);
    expect(redis.status).toBe("ready");
    slots.__resetSlotsForTests();
  });

  afterAll(async () => {
    slots?.__resetSlotsForTests();
    const keys = await redis?.keys("slots:pkey:gwt-*");
    if (keys?.length) await redis.del(...keys);
  });

  it("uses Redis (a sorted set per pool) and respects max across concurrent acquirers", async () => {
    const p = id("gwt-a");
    const a = await slots.acquireSlots([pool(p, 2)]);
    const b = await slots.acquireSlots([pool(p, 2)]);
    const c = await slots.acquireSlots([pool(p, 2)]);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, false]);
    expect(await redis.zcard(`slots:pkey:${p}`)).toBe(2);
    if (a.ok) a.lease.release();
    await sleep(30);
    expect(await redis.zcard(`slots:pkey:${p}`)).toBe(1);
    expect((await slots.acquireSlots([pool(p, 2)])).ok).toBe(true);
  });

  it("never exceeds max under heavy contention", async () => {
    const p = id("gwt-b");
    const max = 4;
    let held = 0;
    let peak = 0;
    const worker = async () => {
      for (let i = 0; i < 10; i++) {
        const r = await slots.acquireSlots([pool(p, max)]);
        if (!r.ok) {
          await sleep(2);
          continue;
        }
        held++;
        peak = Math.max(peak, held);
        await sleep(Math.random() * 5);
        held--;
        r.lease.release();
      }
    };
    await Promise.all(Array.from({ length: 40 }, worker));
    expect(peak).toBeLessThanOrEqual(max);
    expect(peak).toBeGreaterThan(1);
    await sleep(50);
    expect(await slots.slotInUse("pkey", p)).toBe(0);
  });

  it("is all-or-nothing across pools", async () => {
    const x = id("gwt-x");
    const y = id("gwt-y");
    const hold = await slots.acquireSlots([pool(y, 1)]);
    expect(hold.ok).toBe(true);
    const r = await slots.acquireSlots([pool(x, 5), pool(y, 1)]);
    expect(r).toEqual({ ok: false, fullIndex: 1 });
    expect(await redis.zcard(`slots:pkey:${x}`)).toBe(0);
  });

  it("heartbeat keeps a live lease past its TTL; a lease nobody renews (crashed instance) expires and is reclaimed", async () => {
    slots.__resetSlotsForTests({ ttlMs: 300, heartbeatMs: 60_000 });
    const live = id("gwt-live");
    const l = await slots.acquireSlots([pool(live, 1)]);
    expect(l.ok).toBe(true);
    for (let i = 0; i < 6; i++) {
      await sleep(100);
      await slots.__heartbeatForTests(); // renews every locally tracked lease
    }
    expect((await slots.acquireSlots([pool(live, 1)])).ok).toBe(false); // 600ms > 300ms TTL, renewed -> still held
    if (l.ok) l.lease.release();
    await sleep(30);
    expect((await slots.acquireSlots([pool(live, 1)])).ok).toBe(true);
  });

  it("an unrenewed lease expires by TTL", async () => {
    slots.__resetSlotsForTests({ ttlMs: 300, heartbeatMs: 60_000 });
    const dead = id("gwt-dead2");
    expect((await slots.acquireSlots([pool(dead, 1)])).ok).toBe(true);
    slots.__resetSlotsForTests({ ttlMs: 300, heartbeatMs: 60_000 }); // drops local tracking => nothing renews it
    expect((await slots.acquireSlots([pool(dead, 1)])).ok).toBe(false); // still within TTL
    await sleep(450);
    expect((await slots.acquireSlots([pool(dead, 1)])).ok).toBe(true); // expired -> reclaimed
  });

  it("snapshot reports in-use counts for a held key", async () => {
    slots.__resetSlotsForTests();
    const p = id("gwt-snap");
    const a = await slots.acquireSlots([pool(p, 3)]);
    expect(a.ok).toBe(true);
    expect(await slots.slotInUse("pkey", p)).toBe(1);
    const snap = await slots.getSlotSnapshot();
    expect(snap).toMatchObject({ queued: 0 });
    expect(Array.isArray(snap.providerKeys)).toBe(true);
    if (a.ok) a.lease.release();
  });
});
