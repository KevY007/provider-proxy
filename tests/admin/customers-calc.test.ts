import { describe, expect, it } from "vitest";
import { adjustBalanceSchema, canManageTarget, createCustomerSchema, customerSettingsSchema, deletedEmail, deletionMode, parseAdjustmentAmount, parseCustomerListParams, updateProfileSchema } from "@/server/admin/customers-calc";

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

describe("user management schemas", () => {
  it("createCustomerSchema normalises and defaults", () => {
    const d = createCustomerSchema.parse({ email: "  New@Example.COM ", name: "  ", initialCredit: "" });
    expect(d).toMatchObject({ email: "new@example.com", name: null, role: "CUSTOMER", groupId: null, initialCredit: null, sendInvite: true });
    expect(createCustomerSchema.parse({ email: "a@b.co", initialCredit: "12.5", role: "SUPPORT" })).toMatchObject({ initialCredit: "12.5", role: "SUPPORT" });
  });

  it("createCustomerSchema rejects bad input", () => {
    expect(createCustomerSchema.safeParse({ email: "nope" }).success).toBe(false);
    expect(createCustomerSchema.safeParse({ email: "a@b.co", initialCredit: "-5" }).success).toBe(false);
    expect(createCustomerSchema.safeParse({ email: "a@b.co", role: "OWNER" }).success).toBe(false);
  });

  it("updateProfileSchema requires a user and a valid email", () => {
    expect(updateProfileSchema.parse({ userId: "u1", email: "X@Y.io", name: " Ann " })).toEqual({ userId: "u1", email: "x@y.io", name: "Ann" });
    expect(updateProfileSchema.safeParse({ userId: "", email: "x@y.io" }).success).toBe(false);
  });

  it("keeps billing history: anonymise instead of delete", () => {
    expect(deletionMode({ ledger: 0, payments: 0 })).toBe("delete");
    expect(deletionMode({ ledger: 1, payments: 0 })).toBe("anonymize");
    expect(deletionMode({ ledger: 0, payments: 2 })).toBe("anonymize");
    expect(deletedEmail("abc")).toBe("deleted-abc@deleted.invalid");
  });
});
