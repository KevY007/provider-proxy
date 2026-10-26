import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbOk } from "../gateway/harness";
import { db } from "@/lib/db";
import { invalidateSettingsCache } from "@/lib/settings";
import { alertLowBalances, groupAccounts } from "@/server/admin/upstream-balances";

const row = (providerId: string, keyId: string, balance: number | null, account: string | null = null) => ({ providerId, providerName: `P ${providerId}`, keyId, keyLabel: `K ${keyId}`, balance, account, ...(balance === null ? { error: "HTTP 401" } : {}) });

describe("groupAccounts", () => {
  it("groups providers of one named account, and keys reporting the same balance, into one account", () => {
    const accounts = groupAccounts([
      row("ce1", "k1", 11.044531, "codex-everywhere-account"),
      row("ce2", "k2", 11.044531, "codex-everywhere-account"),
      row("other", "k3", 3.5),
      row("other2", "k4", 3.5), // same wallet, no name: grouped by balance
      row("solo", "k5", 120),
    ]);
    expect(accounts.map((a) => [a.name, a.balance, a.providers.length])).toEqual([
      ["P other + P other2", 3.5, 2],
      ["the relay Account", 11.044531, 2],
      ["P solo", 120, 1],
    ]);
  });

  it("an unnamed key with a named account's balance joins it; a failed read stays alone", () => {
    const accounts = groupAccounts([row("ce1", "k1", 7.25, "ce"), row("ce3", "k9", 7.25), row("bad", "k2", null)]);
    expect(accounts).toHaveLength(2);
    expect(accounts.find((a) => a.id === "ce")!.keys.map((k) => k.id)).toEqual(["k1", "k9"]);
    expect(accounts.find((a) => a.balance === null)!.error).toBe("HTTP 401");
  });
});

describe.skipIf(!dbOk)("upstream low-balance alert", () => {
  const snap = (balance: number | null) => ({ at: new Date().toISOString(), accounts: [{ id: "acct-test-alert", name: "Test account", balance, keys: [], providers: [] }] });
  beforeAll(async () => {
    await db.setting.upsert({ where: { key: "upstreamBalanceLowUsd" }, create: { key: "upstreamBalanceLowUsd", value: 10 }, update: { value: 10 } });
    await db.setting.deleteMany({ where: { key: "upstreamBalanceAlerted" } });
    invalidateSettingsCache();
  });
  afterAll(async () => {
    await db.setting.deleteMany({ where: { key: { in: ["upstreamBalanceAlerted", "upstreamBalanceLowUsd"] } } });
    invalidateSettingsCache();
  });

  it("alerts once per drop below the level, again only after it was back above", async () => {
    expect(await alertLowBalances(snap(20))).toEqual([]);
    expect(await alertLowBalances(snap(8))).toEqual(["acct-test-alert"]);
    expect(await alertLowBalances(snap(6))).toEqual([]); // still low: no repeat
    expect(await alertLowBalances(snap(null))).toEqual([]); // failed read changes nothing
    expect(await alertLowBalances(snap(4))).toEqual([]);
    expect(await alertLowBalances(snap(50))).toEqual([]); // topped up
    expect(await alertLowBalances(snap(9))).toEqual(["acct-test-alert"]); // a new drop alerts again
  });
});
