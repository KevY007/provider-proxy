import { afterAll, describe, expect, it, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { generateCodes, makeCode, normalizeCode, redeemCode, RedeemInputError } from "@/server/billing/redeem";
import { balanceOf, cleanupUsers, dbAvailable, makeUser } from "./helpers";

// the portal may run with customer billing off (prod default now): these tests exercise billing itself
beforeAll(async () => {
  await (await import("@/lib/settings")).setSettings({ customerBilling: true });
});

const up = await dbAvailable();
const codeIds: string[] = [];

describe("code format", () => {
  it("normalizes input", () => {
    expect(normalizeCode("  ab-cd 12 ")).toBe("AB-CD12");
  });
  it("makes prefixed, unambiguous codes", () => {
    const c = makeCode("promo!");
    expect(c).toMatch(/^PROMO-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(c.slice("PROMO-".length)).not.toMatch(/[01OIL]/);
    expect(makeCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
});

describe.skipIf(!up)("redeem codes", () => {
  afterAll(async () => {
    if (codeIds.length) await db.redeemCode.deleteMany({ where: { id: { in: codeIds } } });
    await cleanupUsers();
    await db.$disconnect();
  });

  async function mint(opts: { amount?: number; maxUses?: number; expiresAt?: Date | null } = {}) {
    const admin = await makeUser();
    const [code] = await generateCodes(admin.id, { amount: opts.amount ?? 7.5, count: 1, maxUses: opts.maxUses ?? 1, expiresAt: opts.expiresAt, prefix: "TEST" });
    const row = await db.redeemCode.findUniqueOrThrow({ where: { code } });
    codeIds.push(row.id);
    return { code, row };
  }

  it("generateCodes validates input", async () => {
    const admin = await makeUser();
    await expect(generateCodes(admin.id, { amount: 0, count: 1 })).rejects.toBeInstanceOf(RedeemInputError);
    await expect(generateCodes(admin.id, { amount: 5, count: 0 })).rejects.toBeInstanceOf(RedeemInputError);
    await expect(generateCodes(admin.id, { amount: 5, count: 501 })).rejects.toBeInstanceOf(RedeemInputError);
    await expect(generateCodes(admin.id, { amount: 5, count: 1, maxUses: 0 })).rejects.toBeInstanceOf(RedeemInputError);
    await expect(generateCodes(admin.id, { amount: 5, count: 1, expiresAt: new Date(Date.now() - 1000) })).rejects.toBeInstanceOf(RedeemInputError);
  });

  it("generates the requested number of unique codes", async () => {
    const admin = await makeUser();
    const codes = await generateCodes(admin.id, { amount: 1, count: 25, prefix: "BULK" });
    expect(new Set(codes).size).toBe(25);
    const rows = await db.redeemCode.findMany({ where: { code: { in: codes } } });
    codeIds.push(...rows.map((r) => r.id));
    expect(rows).toHaveLength(25);
  });

  it("credits the balance with a REDEEM ledger entry (case-insensitive)", async () => {
    const { code } = await mint({ amount: 12.34 });
    const u = await makeUser({ balance: "1" });
    const res = await redeemCode(u.id, ` ${code.toLowerCase()} `);
    expect(res.ok).toBe(true);
    expect(await balanceOf(u.id)).toBe("13.34");
    const entry = await db.ledgerEntry.findFirstOrThrow({ where: { userId: u.id } });
    expect(entry.type).toBe("REDEEM");
    expect(entry.amount.toFixed(2)).toBe("12.34");
  });

  it("allows only one use per user", async () => {
    const { code } = await mint({ maxUses: 5 });
    const u = await makeUser();
    expect((await redeemCode(u.id, code)).ok).toBe(true);
    const again = await redeemCode(u.id, code);
    expect(again).toMatchObject({ ok: false, reason: "already_redeemed" });
    expect(await balanceOf(u.id)).toBe("7.50");
  });

  it("respects maxUses, even under concurrency", async () => {
    const { code, row } = await mint({ maxUses: 2 });
    const users = await Promise.all(Array.from({ length: 6 }, () => makeUser()));
    const results = await Promise.all(users.map((u) => redeemCode(u.id, code)));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok && r.reason === "exhausted")).toHaveLength(4);
    expect((await db.redeemCode.findUniqueOrThrow({ where: { id: row.id } })).uses).toBe(2);
  });

  it("rejects expired and unknown codes", async () => {
    const { code, row } = await mint();
    await db.redeemCode.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const u = await makeUser();
    expect(await redeemCode(u.id, code)).toMatchObject({ ok: false, reason: "expired" });
    expect(await redeemCode(u.id, "NOPE-NOPE-NOPE")).toMatchObject({ ok: false, reason: "invalid_code" });
    expect(await redeemCode(u.id, "bad code!!")).toMatchObject({ ok: false, reason: "invalid_code" });
    expect(await balanceOf(u.id)).toBe("0.00");
  });

  it("does not let suspended accounts redeem", async () => {
    const { code } = await mint();
    const u = await makeUser({ status: "SUSPENDED" });
    expect(await redeemCode(u.id, code)).toMatchObject({ ok: false, reason: "account_inactive" });
  });
});
