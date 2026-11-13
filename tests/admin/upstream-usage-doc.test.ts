/** The balance an upstream publishes with a key (`balance`, `remaining` or `balance_usd`) is read from its usage document. */
import { describe, expect, it } from "vitest";
import { parseUsageDoc } from "@/server/admin/upstream-usage";

describe("parseUsageDoc balance", () => {
  it("reads balance, remaining and balance_usd", () => {
    expect(parseUsageDoc({ balance: 12.5 }).balance).toBe(12.5);
    expect(parseUsageDoc({ remaining: "3.25" }).balance).toBe(3.25);
    expect(parseUsageDoc({ object: "balance", currency: "USD", balance_usd: 52.4876 }).balance).toBe(52.4876);
  });

  it("is null when the document has no balance", () => {
    expect(parseUsageDoc({ object: "usage" }).balance).toBeNull();
  });
});
