import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { adminAdjustBalance, credit, debit, LedgerError } from "@/server/billing/ledger";
import { balanceOf, cleanupUsers, dbAvailable, makeUser } from "./helpers";

const up = await dbAvailable();

describe.skipIf(!up)("ledger", () => {
  afterAll(async () => {
    await cleanupUsers();
    await db.$disconnect();
  });

  it("credit and debit write entries with balanceAfter", async () => {
    const u = await makeUser({ balance: "10.000000000000" });
    const a = await credit(u.id, 5, "TOPUP", "test topup");
    expect(a.balance.toFixed(2)).toBe("15.00");
    expect(a.entry.balanceAfter.toString()).toBe("15");
    const b = await debit(u.id, "2.5", "ADJUSTMENT", "test debit");
    expect(b.balance.toFixed(2)).toBe("12.50");
    expect(b.entry.amount.toFixed(2)).toBe("-2.50");
    expect(await balanceOf(u.id)).toBe("12.50");
    const entries = await db.ledgerEntry.findMany({ where: { userId: u.id }, orderBy: { createdAt: "asc" } });
    expect(entries.map((e) => e.type)).toEqual(["TOPUP", "ADJUSTMENT"]);
  });

  it("a debit may take the balance negative (refund/chargeback)", async () => {
    const u = await makeUser({ balance: "1" });
    const r = await debit(u.id, 4, "CHARGEBACK", "cb");
    expect(r.balance.toFixed(2)).toBe("-3.00");
  });

  it("rejects non-positive amounts and unknown users", async () => {
    const u = await makeUser();
    await expect(credit(u.id, 0, "TOPUP", "x")).rejects.toBeInstanceOf(LedgerError);
    await expect(credit(u.id, -1, "TOPUP", "x")).rejects.toBeInstanceOf(LedgerError);
    await expect(debit(u.id, 0, "REFUND", "x")).rejects.toBeInstanceOf(LedgerError);
    await expect(credit("does-not-exist", 1, "TOPUP", "x")).rejects.toMatchObject({ code: "user_not_found" });
  });

  it("the same paymentId only ever moves the balance once (sequential and concurrent replays)", async () => {
    const u = await makeUser();
    const payment = await db.payment.create({ data: { userId: u.id, amount: "20", kind: "topup", status: "PENDING" } });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => credit(u.id, 20, "TOPUP", "replay", { paymentId: payment.id })),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(7);
    const again = await credit(u.id, 20, "TOPUP", "replay", { paymentId: payment.id });
    expect(again.duplicate).toBe(true);
    expect(await balanceOf(u.id)).toBe("20.00");
    expect(await db.ledgerEntry.count({ where: { userId: u.id } })).toBe(1);
  });

  it("concurrent credits serialize on the row lock (no lost updates)", async () => {
    const u = await makeUser();
    await Promise.all(Array.from({ length: 20 }, (_, i) => credit(u.id, 1, "TOPUP", `c${i}`)));
    expect(await balanceOf(u.id)).toBe("20.00");
    const last = await db.ledgerEntry.findMany({ where: { userId: u.id }, select: { balanceAfter: true } });
    // every intermediate balance appears exactly once
    expect(new Set(last.map((e) => e.balanceAfter.toFixed(0))).size).toBe(20);
  });

  it("adminAdjustBalance needs a reason, writes ADJUSTMENT with createdById, and audits", async () => {
    const admin = await makeUser();
    const u = await makeUser({ balance: "5" });
    await expect(adminAdjustBalance(admin.id, u.id, 3, "  ")).rejects.toBeInstanceOf(LedgerError);
    await expect(adminAdjustBalance(admin.id, u.id, 0, "reason here")).rejects.toBeInstanceOf(LedgerError);

    const up1 = await adminAdjustBalance(admin.id, u.id, 10, "goodwill credit");
    expect(up1.balance.toFixed(2)).toBe("15.00");
    expect(up1.entry.type).toBe("ADJUSTMENT");
    expect(up1.entry.createdById).toBe(admin.id);
    const down = await adminAdjustBalance(admin.id, u.id, -4, "correction");
    expect(down.balance.toFixed(2)).toBe("11.00");

    const logs = await db.auditLog.findMany({ where: { targetId: u.id, action: "billing.adjust_balance" } });
    expect(logs).toHaveLength(2);
    expect(logs[0].actorId).toBe(admin.id);
  });
});
