import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __heartbeatForTests, __resetSlotsForTests, acquireSlots, queuedCount, slotInUse, trackQueued, waitForRelease, type SlotLease } from "@/gateway/slots";

// vitest sets REDIS_URL="" so the slot manager runs on its in-memory backend (identical semantics to Redis mode)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pool = (id: string, max: number) => ({ kind: "pkey" as const, id, max });

describe("slot manager (memory backend)", () => {
  beforeEach(() => __resetSlotsForTests());
  afterEach(() => __resetSlotsForTests());

  it("never hands out more than `max` concurrent leases under heavy contention", async () => {
    const max = 5;
    let held = 0;
    let peak = 0;
    let granted = 0;
    const worker = async () => {
      for (let i = 0; i < 20; i++) {
        const r = await acquireSlots([pool("hot", max)]);
        if (!r.ok) {
          await sleep(Math.random() * 3);
          continue;
        }
        granted++;
        held++;
        peak = Math.max(peak, held);
        expect(held).toBeLessThanOrEqual(max);
        await sleep(Math.random() * 4);
        held--;
        r.lease.release();
      }
    };
    await Promise.all(Array.from({ length: 60 }, worker));
    expect(peak).toBeLessThanOrEqual(max);
    expect(peak).toBeGreaterThan(1);
    expect(granted).toBeGreaterThan(20);
    expect(await slotInUse("pkey", "hot")).toBe(0);
  });

  it("rejects when full and reports which pool was full", async () => {
    const a = await acquireSlots([pool("k", 1)]);
    expect(a.ok).toBe(true);
    const b = await acquireSlots([pool("k", 1)]);
    expect(b).toEqual({ ok: false, fullIndex: 0 });
  });

  it("is all-or-nothing across pools (a failed multi-pool acquire leaves no residue)", async () => {
    const full = await acquireSlots([pool("b", 1)]);
    expect(full.ok).toBe(true);
    const r = await acquireSlots([pool("a", 2), pool("b", 1)]);
    expect(r).toEqual({ ok: false, fullIndex: 1 });
    expect(await slotInUse("pkey", "a")).toBe(0);
    if (full.ok) full.lease.release();
    const again = await acquireSlots([pool("a", 2), pool("b", 1)]);
    expect(again.ok).toBe(true);
    expect(await slotInUse("pkey", "a")).toBe(1);
    expect(await slotInUse("pkey", "b")).toBe(1);
  });

  it("release is idempotent and frees the slot immediately", async () => {
    const a = await acquireSlots([pool("r", 1)]);
    if (!a.ok) throw new Error("expected lease");
    a.lease.release();
    a.lease.release();
    expect(await slotInUse("pkey", "r")).toBe(0);
    const b = await acquireSlots([pool("r", 1)]);
    expect(b.ok).toBe(true);
  });

  it("releases on abort: a waiter blocked on a full pool wakes up when the holder aborts", async () => {
    const holder = await acquireSlots([pool("q", 1)]);
    if (!holder.ok) throw new Error("expected lease");
    const ac = new AbortController();
    // the "request" holding the slot is aborted -> its finally{} releases
    const holderTask = new Promise<void>((resolve) => {
      ac.signal.addEventListener("abort", () => {
        holder.lease.release();
        resolve();
      });
    });
    const t0 = Date.now();
    const waiter = (async () => {
      for (;;) {
        const r = await acquireSlots([pool("q", 1)]);
        if (r.ok) return r.lease;
        await waitForRelease(2_000);
      }
    })();
    setTimeout(() => ac.abort(), 30);
    await holderTask;
    const lease = await waiter;
    expect(Date.now() - t0).toBeLessThan(1_000); // woken by the release, not by the 2s poll
    lease.release();
  });

  it("waitForRelease resolves on timeout and on its own abort signal", async () => {
    const t0 = Date.now();
    await waitForRelease(40);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const t1 = Date.now();
    await waitForRelease(5_000, ac.signal);
    expect(Date.now() - t1).toBeLessThan(1_000);
  });

  it("expires leases that are never released or renewed (self-healing)", async () => {
    __resetSlotsForTests({ ttlMs: 40, heartbeatMs: 10_000 });
    const leaked = await acquireSlots([pool("ttl", 1)]);
    expect(leaked.ok).toBe(true);
    expect((await acquireSlots([pool("ttl", 1)])).ok).toBe(false);
    await sleep(70);
    const next = await acquireSlots([pool("ttl", 1)]);
    expect(next.ok).toBe(true);
  });

  it("the heartbeat keeps live leases from expiring", async () => {
    __resetSlotsForTests({ ttlMs: 120, heartbeatMs: 10_000 });
    const live = await acquireSlots([pool("hb", 1)]);
    if (!live.ok) throw new Error("expected lease");
    for (let i = 0; i < 4; i++) {
      await sleep(50);
      await __heartbeatForTests(); // renews to now + ttl
    }
    expect((await acquireSlots([pool("hb", 1)])).ok).toBe(false); // 200ms > ttl, still held
    live.lease.release();
    expect((await acquireSlots([pool("hb", 1)])).ok).toBe(true);
  });

  it("stops renewing a lease that exceeds its max age (leak protection)", async () => {
    __resetSlotsForTests({ ttlMs: 10_000, heartbeatMs: 10_000, maxAgeMs: 30 });
    const leaked = await acquireSlots([pool("age", 1)]);
    expect(leaked.ok).toBe(true);
    await sleep(60);
    await __heartbeatForTests();
    expect((await acquireSlots([pool("age", 1)])).ok).toBe(true);
  });

  it("skips pools with max <= 0 and tracks the queued gauge", async () => {
    const r = await acquireSlots([{ kind: "key", id: "none", max: 0 }]);
    expect(r.ok).toBe(true);
    trackQueued(2);
    expect(queuedCount()).toBe(2);
    trackQueued(-5);
    expect(queuedCount()).toBe(0);
  });

  it("many independent pools do not interfere", async () => {
    const leases: SlotLease[] = [];
    for (let i = 0; i < 50; i++) {
      const r = await acquireSlots([pool(`p${i}`, 1)]);
      expect(r.ok).toBe(true);
      if (r.ok) leases.push(r.lease);
    }
    expect((await acquireSlots([pool("p7", 1)])).ok).toBe(false);
    leases.forEach((l) => l.release());
    expect((await acquireSlots([pool("p7", 1)])).ok).toBe(true);
  });
});
