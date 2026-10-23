import { describe, expect, it } from "vitest";
import { byAccount } from "@/server/admin/upstream-balances";

describe("byAccount", () => {
  it("reports one balance per upstream account, taking the first provider that answered", () => {
    const rows = byAccount([
      { providerId: "a", name: "CE Claude", account: "ce", balance: null, error: "HTTP 401" },
      { providerId: "b", name: "CE Codex", account: "ce", balance: 27.89 },
      { providerId: "c", name: "Other", account: "c", balance: 5 },
    ]);
    expect(rows).toEqual([
      { account: "ce", names: ["CE Claude", "CE Codex"], providerId: "b", balance: 27.89, error: undefined },
      { account: "c", names: ["Other"], providerId: "c", balance: 5, error: undefined },
    ]);
  });
});
