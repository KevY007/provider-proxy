import { describe, expect, it } from "vitest";
import {
  adjustBalanceSchema,
  canManageTarget,
  customerSettingsSchema,
  parseAdjustmentAmount,
  parseCustomerListParams,
} from "@/server/admin/customers-calc";

describe("parseCustomerListParams", () => {
  it("applies defaults and rejects junk", () => {
    const p = parseCustomerListParams({ status: "nope", sort: "evil", page: "-3" });
    expect(p).toMatchObject({ q: "", status: "", sort: "created", dir: "desc", page: 0, pageSize: 25 });
  });
  it("accepts valid values from URLSearchParams", () => {
    const p = parseCustomerListParams(new URLSearchParams("q= bob &status=SUSPENDED&role=ADMIN&sort=spend&dir=asc&page=3"));
    expect(p).toMatchObject({ q: "bob", status: "SUSPENDED", role: "ADMIN", sort: "spend", dir: "asc", page: 3 });
  });
});

describe("parseAdjustmentAmount", () => {
  it("parses signed values", () => {
    expect(parseAdjustmentAmount("25")).toEqual({ ok: true, amount: "25" });
    expect(parseAdjustmentAmount("-10.50")).toEqual({ ok: true, amount: "-10.5" });
    expect(parseAdjustmentAmount("+$0.25")).toEqual({ ok: true, amount: "0.25" });
    expect(parseAdjustmentAmount("1,000")).toEqual({ ok: true, amount: "1000" });
  });
  it("rejects zero, garbage and huge numbers", () => {
    expect(parseAdjustmentAmount("0").ok).toBe(false);
    expect(parseAdjustmentAmount("0.000").ok).toBe(false);
    expect(parseAdjustmentAmount("abc").ok).toBe(false);
    expect(parseAdjustmentAmount("1e5").ok).toBe(false);
    expect(parseAdjustmentAmount("99999999").ok).toBe(false);
  });
});

describe("schemas", () => {
  it("requires a reason", () => {
    expect(adjustBalanceSchema.safeParse({ userId: "u", amount: "5", reason: " " }).success).toBe(false);
    const ok = adjustBalanceSchema.parse({ userId: "u", amount: "-5", reason: "refund goodwill" });
    expect(ok.amount).toBe("-5");
  });
  it("normalises settings", () => {
    const s = customerSettingsSchema.parse({ userId: "u", billingMode: "POSTPAID", priceMultiplier: "", creditLimit: "", monthlySpendLimit: "100", maxConcurrency: "" });
    expect(s).toMatchObject({ priceMultiplier: null, creditLimit: "0", monthlySpendLimit: "100", maxConcurrency: null, groupId: null });
    expect(customerSettingsSchema.safeParse({ userId: "u", billingMode: "PREPAID", priceMultiplier: "-1" }).success).toBe(false);
  });
});

describe("canManageTarget", () => {
  it("blocks self and staff-for-support", () => {
    expect(canManageTarget("ADMIN", "CUSTOMER", "a", "a").ok).toBe(false);
    expect(canManageTarget("SUPPORT", "ADMIN", "a", "b").ok).toBe(false);
    expect(canManageTarget("SUPPORT", "CUSTOMER", "a", "b").ok).toBe(true);
    expect(canManageTarget("ADMIN", "SUPPORT", "a", "b").ok).toBe(true);
  });
});
