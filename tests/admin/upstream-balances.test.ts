import { describe, expect, it } from "vitest";
import { groupAccounts } from "@/server/admin/upstream-balances";

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
      ["Codex Everywhere Account", 11.044531, 2],
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
