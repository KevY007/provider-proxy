import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { reconcileStalePayments, settlePostpaidUser } from "@/server/billing/cron";
import { __resetLocks } from "@/server/billing/locks";
import { setStripeClientForTests } from "@/server/billing/stripe";
import { balanceOf, cleanupUsers, dbAvailable, makeUser, mockStripe } from "./helpers";

const up = await dbAvailable();

describe.skipIf(!up)("billing cron (mocked Stripe)", () => {
  let stripe: ReturnType<typeof mockStripe>;
  beforeEach(() => {
    __resetLocks();
    stripe = mockStripe();
    setStripeClientForTests(stripe);
  });
  afterEach(() => setStripeClientForTests(null));
  afterAll(async () => {
    await cleanupUsers();
    await db.$disconnect();
  });

  const postpaid = (balance: string, extra: Record<string, unknown> = {}) =>
    makeUser({
      billingMode: "POSTPAID",
      creditLimit: "100",
      balance,
      stripeCustomerId: `cus_pp_${Math.random().toString(36).slice(2)}`,
      defaultPaymentMethodId: "pm_pp",
      ...extra,
    });

  it("settles a negative postpaid balance to zero via POSTPAID_SETTLEMENT, once per day", async () => {
    const u = await postpaid("-12.341");
    stripe.paymentIntents.create.mockImplementation(async (p: { amount: number; metadata: Record<string, string> }) => ({
      id: `pi_${p.metadata.paymentId}`,
      status: "succeeded",
      amount: p.amount,
      amount_received: p.amount,
      currency: "usd",
      latest_charge: null,
      metadata: p.metadata,
    }));
    expect(await settlePostpaidUser(u.id)).toBe("charged");
    expect(stripe.paymentIntents.create.mock.calls[0][0]).toMatchObject({ amount: 1235, off_session: true });
    expect(await balanceOf(u.id)).toBe("0.01"); // rounded up to the cent
    expect((await db.ledgerEntry.findFirstOrThrow({ where: { userId: u.id } })).type).toBe("POSTPAID_SETTLEMENT");

    await db.user.update({ where: { id: u.id }, data: { balance: "-5" } });
    expect(await settlePostpaidUser(u.id)).toBe("skipped"); // already settled within 20h
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  });

  it("skips tiny debts, prepaid users, positive balances and customers without a card", async () => {
    expect(await settlePostpaidUser((await postpaid("-0.40")).id)).toBe("skipped");
    expect(await settlePostpaidUser((await postpaid("25")).id)).toBe("skipped");
    expect(await settlePostpaidUser((await postpaid("-20", { defaultPaymentMethodId: null })).id)).toBe("skipped");
    expect(await settlePostpaidUser((await makeUser({ balance: "-20", stripeCustomerId: "cus_x1", defaultPaymentMethodId: "pm" })).id)).toBe("skipped");
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("records a failed settlement and leaves the debt in place", async () => {
    const u = await postpaid("-30");
    stripe.paymentIntents.create.mockRejectedValue(Object.assign(new Error("Insufficient funds"), { code: "card_declined" }));
    expect(await settlePostpaidUser(u.id)).toBe("failed");
    expect(await balanceOf(u.id)).toBe("-30.00");
    expect(await db.payment.findFirstOrThrow({ where: { userId: u.id } })).toMatchObject({ status: "FAILED", kind: "postpaid_settlement" });
  });

  it("reconciles PENDING payments older than 24h against Stripe", async () => {
    const old = new Date(Date.now() - 30 * 3600_000);
    const u = await makeUser();
    const paid = await db.payment.create({ data: { userId: u.id, amount: "15", kind: "topup", status: "PENDING", stripePaymentIntentId: "pi_old_paid", createdAt: old } });
    const dead = await db.payment.create({ data: { userId: u.id, amount: "15", kind: "topup", status: "PENDING", stripePaymentIntentId: "pi_old_dead", createdAt: old } });
    const noStripe = await db.payment.create({ data: { userId: u.id, amount: "15", kind: "topup", status: "PENDING", createdAt: old } });
    const fresh = await db.payment.create({ data: { userId: u.id, amount: "15", kind: "topup", status: "PENDING" } });

    stripe.paymentIntents.retrieve.mockImplementation(async (id: string) =>
      id === "pi_old_paid"
        ? { id, status: "succeeded", amount: 1500, amount_received: 1500, currency: "usd", latest_charge: null, metadata: {} }
        : { id, status: "requires_action", amount: 1500, currency: "usd", metadata: {} },
    );
    const stats = await reconcileStalePayments();
    expect(stats).toMatchObject({ checked: 3, settled: 1, canceled: 2 });

    const get = (id: string) => db.payment.findUniqueOrThrow({ where: { id } });
    expect((await get(paid.id)).status).toBe("SUCCEEDED");
    expect((await get(dead.id)).status).toBe("CANCELED");
    expect((await get(noStripe.id)).status).toBe("CANCELED");
    expect((await get(fresh.id)).status).toBe("PENDING");
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_old_dead");
    expect(await balanceOf(u.id)).toBe("15.00");

    // running again changes nothing
    await reconcileStalePayments();
    expect(await balanceOf(u.id)).toBe("15.00");
  });
});
