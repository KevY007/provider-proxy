import { beforeEach, describe, expect, it } from "vitest";
import { __resetHoldsForTests, holdsFlushed, isHoldOpen, memoryObligations, releaseHold, reserveHold, settleHold, type ReserveInput } from "@/gateway/holds";
import { Decimal } from "@/lib/money";

const d = (v: Decimal.Value) => new Decimal(v);
let n = 0;
const input = (over: Partial<ReserveInput> = {}): ReserveInput => ({
  id: `h${++n}`,
  userId: "u1",
  keyId: "k1",
  amount: d("0.3"),
  base: d("1"),
  headroomExtra: d(0),
  monthlyRemaining: null,
  keyRemaining: null,
  ...over,
});

describe("credit holds (in-memory backend)", () => {
  beforeEach(() => __resetHoldsForTests());

  it("admits holds until the available funds are used up, then rejects with the real availability", async () => {
    const a = await reserveHold(input());
    const b = await reserveHold(input());
    const c = await reserveHold(input());
    const e = await reserveHold(input());
    expect([a.ok, b.ok, c.ok, e.ok]).toEqual([true, true, true, false]);
    expect(e.reason).toBe("balance");
    expect(e.available.toString()).toBe("0.1"); // 1 - 3 x 0.3
    expect(memoryObligations("u1").holds.toString()).toBe("0.9");
  });

  it("is atomic under concurrency: never admits more than the balance", async () => {
    const res = await Promise.all(Array.from({ length: 50 }, () => reserveHold(input({ amount: d("0.07") }))));
    expect(res.filter((r) => r.ok).length).toBe(14); // floor(1 / 0.07)
  });

  it("credit limit and minBalanceToCall move the ceiling", async () => {
    const r = await reserveHold(input({ base: d("-0.5"), headroomExtra: d("2"), amount: d("1.4") }));
    expect(r.ok).toBe(true);
    const s = await reserveHold(input({ base: d("-0.5"), headroomExtra: d("2"), amount: d("0.2") }));
    expect(s.ok).toBe(false);
  });

  it("a zero-amount check needs strictly positive funds and creates no hold", async () => {
    expect((await reserveHold(input({ amount: d(0), base: d(0) }))).ok).toBe(false);
    const ok = await reserveHold(input({ amount: d(0) }));
    expect(ok.ok).toBe(true);
    expect(memoryObligations("u1").holds.toString()).toBe("0");
  });

  it("settle turns the hold into a pending debit until the meter writer flushed it; release frees it", async () => {
    const ref = (id: string) => ({ id, userId: "u1", keyId: "k1", backend: "memory" as const, createdAt: Date.now() });
    const a = input({ id: "a", amount: d("0.4") });
    const b = input({ id: "b", amount: d("0.4") });
    expect((await reserveHold(a)).ok && (await reserveHold(b)).ok).toBe(true);
    expect(isHoldOpen("a")).toBe(true);

    settleHold(ref("a"), d("0.35")); // actual price
    expect(isHoldOpen("a")).toBe(false);
    expect(memoryObligations("u1")).toEqual({ holds: d("0.4"), pending: d("0.35") });
    releaseHold(ref("b"));
    expect(memoryObligations("u1")).toEqual({ holds: d(0), pending: d("0.35") });

    // the pending debit still counts: 1 - 0.35 = 0.65 available
    expect((await reserveHold(input({ amount: d("0.7") }))).ok).toBe(false);
    expect((await reserveHold(input({ amount: d("0.6") }))).ok).toBe(true);

    await holdsFlushed("u1", ["a"]);
    expect(memoryObligations("u1").pending.toString()).toBe("0");
  });

  it("key and monthly limits count open holds only", async () => {
    const ref = (id: string) => ({ id, userId: "u1", keyId: "k1", backend: "memory" as const, createdAt: Date.now() });
    const first = await reserveHold(input({ id: "k-a", amount: d("0.1"), keyRemaining: d("0.15") }));
    expect(first.ok).toBe(true);
    const second = await reserveHold(input({ id: "k-b", amount: d("0.1"), keyRemaining: d("0.15") }));
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("key");
    expect(second.keyAvailable?.toString()).toBe("0.05");
    releaseHold(ref("k-a"));
    expect((await reserveHold(input({ id: "k-c", amount: d("0.1"), keyRemaining: d("0.15") }))).ok).toBe(true);

    const m1 = await reserveHold(input({ id: "m-a", userId: "u2", keyId: null, amount: d("0.2"), monthlyRemaining: d("0.25") }));
    const m2 = await reserveHold(input({ id: "m-b", userId: "u2", keyId: null, amount: d("0.2"), monthlyRemaining: d("0.25") }));
    expect([m1.ok, m2.ok]).toEqual([true, false]);
    expect(m2.reason).toBe("monthly");
  });

  it("settling an unknown / already settled hold is harmless and idempotent", () => {
    const ref = { id: "ghost", userId: "u9", keyId: null, backend: "memory" as const, createdAt: Date.now() };
    expect(() => releaseHold(ref)).not.toThrow();
    settleHold(ref, d("0.1"));
    settleHold(ref, d("0.1"));
    expect(memoryObligations("u9").pending.toString()).toBe("0.1"); // same id -> same entry, not double counted
  });
});
