/**
 * Balance mirror (a customer's balance = the upstream account's balance, e.g. the studio on the relay) and the
 * shared concurrency pool of providers on one upstream account.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, dbOk } from "../gateway/harness";
import { syncMirroredBalances } from "@/server/billing/balance-mirror";
import { upstreamPools } from "@/gateway/execute";
import { db } from "@/lib/db";

describe("upstreamPools", () => {
  it("adds one pool shared by every provider of the same upstream account", () => {
    const cand = (pid: string, settings: Record<string, unknown>) => ({ key: { id: `k-${pid}`, maxConcurrency: null }, route: { provider: { id: pid, maxConcurrency: null, settings } } }) as never;
    const shared = { sharedConcurrency: { group: "ce-account", max: 20 } };
    expect(upstreamPools(cand("p1", shared), { defaultKeyConcurrency: 50 })).toEqual([
      { kind: "pkey", id: "k-p1", max: 50 },
      { kind: "provider", id: "shared:ce-account", max: 20 },
    ]);
    expect(upstreamPools(cand("p2", shared), { defaultKeyConcurrency: 50 })[1]).toEqual({ kind: "provider", id: "shared:ce-account", max: 20 });
    expect(upstreamPools(cand("p3", {}), { defaultKeyConcurrency: 50 })).toHaveLength(1);
  });
});

const h = createHarness("bmr");

describe.skipIf(!dbOk)("syncMirroredBalances", () => {
  let userId = "";
  let upstreamBalance = 34.58;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    await h.start();
    const p = await h.makeProvider("ce", { formats: ["openai_responses"], settings: { usageUrl: `${h.base}/v1/usage` }, keys: [{ s: "k1" }] });
    const u = await h.makeUser("studio", { balance: "918.26" });
    userId = u.id;
    await db.user.update({ where: { id: userId }, data: { balanceMirrorProviderId: p.id } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/usage")) return Response.json({ balance: upstreamBalance, daily_usage: [] });
      return realFetch(input, init);
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await db.ledgerEntry.deleteMany({ where: { userId } }).catch(() => undefined);
    await h.cleanup();
  });

  it("sets the balance to the upstream account's balance with an ADJUSTMENT entry, and is idempotent", async () => {
    const r = await syncMirroredBalances({ userId });
    expect(r).toMatchObject({ users: 1, updated: 1, errors: [] });
    const u = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.balance.toString()).toBe("34.58");
    const entry = await db.ledgerEntry.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: "desc" } });
    expect(entry.type).toBe("ADJUSTMENT");
    expect(entry.amount.toString()).toBe("-883.68");
    expect(entry.balanceAfter.toString()).toBe("34.58");
    expect((await syncMirroredBalances({ userId })).updated).toBe(0);
  });

  it("follows the upstream when it changes (top-up there, spend there)", async () => {
    upstreamBalance = 134.58;
    await syncMirroredBalances({ userId });
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).balance.toString()).toBe("134.58");
  });
});
