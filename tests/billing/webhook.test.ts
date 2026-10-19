import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { setStripeClientForTests } from "@/server/billing/stripe";
import { handleStripeEvent } from "@/server/billing/webhook";
import { balanceOf, cleanupUsers, dbAvailable, event, makeUser, mockStripe, piSucceeded } from "./helpers";

const granted = vi.fn(async () => ({ granted: true }));
vi.mock("@/lib/auth/service", () => ({ grantTrialCredit: (...a: unknown[]) => granted(...(a as [])) }));
vi.mock("@/lib/settings", async (orig) => {
  const real = await orig<typeof import("@/lib/settings")>();
  return {
    ...real,
    getSetting: vi.fn(async (k: string) => (k === "requireCardForTrial" ? true : real.settingDefaults()[k as never])),
  };
});

const up = await dbAvailable();

describe.skipIf(!up)("stripe webhook handlers", () => {
  let stripe: ReturnType<typeof mockStripe>;
  beforeEach(() => {
    granted.mockClear();
    stripe = mockStripe();
    stripe.paymentMethods.retrieve.mockImplementation(async () => ({ id: "pm", card: { fingerprint: "fp_test" } }));
    setStripeClientForTests(stripe);
  });
  afterEach(() => setStripeClientForTests(null));
  afterAll(async () => {
    await cleanupUsers();
    await db.$disconnect();
  });

  async function pendingPayment(userId: string, amount = "25", pi?: string) {
    return db.payment.create({
      data: { userId, amount, kind: "topup", status: "PENDING", stripePaymentIntentId: pi ?? null },
    });
  }

  it("payment_intent.succeeded credits exactly once, even when replayed concurrently", async () => {
    const u = await makeUser();
    const p = await pendingPayment(u.id, "25", "pi_replay");
    const ev = event("payment_intent.succeeded", piSucceeded("pi_replay", p.id, 2500));

    const results = await Promise.all([handleStripeEvent(ev), handleStripeEvent(ev), handleStripeEvent(ev), handleStripeEvent(ev)]);
    expect(results.every((r) => r.handled)).toBe(true);
    await handleStripeEvent(ev); // late replay
    await handleStripeEvent(ev);

    expect(await balanceOf(u.id)).toBe("25.00");
    expect(await db.ledgerEntry.count({ where: { userId: u.id } })).toBe(1);
    const after = await db.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe("SUCCEEDED");
    expect(after.receiptUrl).toBe("https://receipt.test/r");
    const entry = await db.ledgerEntry.findFirstOrThrow({ where: { userId: u.id } });
    expect(entry.type).toBe("TOPUP");
    expect(entry.paymentId).toBe(p.id);
  });

  it("resolves the payment via metadata.paymentId when the intent id is not stored yet", async () => {
    const u = await makeUser();
    const p = await pendingPayment(u.id, "10");
    await handleStripeEvent(event("payment_intent.succeeded", piSucceeded("pi_meta", p.id, 1000)));
    expect(await balanceOf(u.id)).toBe("10.00");
    expect((await db.payment.findUniqueOrThrow({ where: { id: p.id } })).stripePaymentIntentId).toBe("pi_meta");
  });

  it("uses the amount Stripe actually collected", async () => {
    const u = await makeUser();
    const p = await pendingPayment(u.id, "50", "pi_amt");
    await handleStripeEvent(event("payment_intent.succeeded", piSucceeded("pi_amt", p.id, 4900)));
    expect(await balanceOf(u.id)).toBe("49.00");
  });

  it("ignores unknown payments and unknown event types (200 path)", async () => {
    expect(await handleStripeEvent(event("payment_intent.succeeded", piSucceeded("pi_nobody", "nope", 100)))).toMatchObject({ handled: false });
    expect(await handleStripeEvent(event("customer.created", { id: "cus_x" }))).toMatchObject({ handled: false, note: "ignored" });
  });

  it("payment_intent.payment_failed marks FAILED once and never downgrades a success", async () => {
    const u = await makeUser();
    const p = await pendingPayment(u.id, "30", "pi_fail");
    const failEv = event("payment_intent.payment_failed", { id: "pi_fail", metadata: {}, last_payment_error: { message: "Your card was declined." } });
    await handleStripeEvent(failEv);
    await handleStripeEvent(failEv);
    let row = await db.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe("FAILED");
    expect(row.failureReason).toBe("Your card was declined.");
    expect(await db.emailOutbox.count({ where: { to: (await db.user.findUniqueOrThrow({ where: { id: u.id } })).email } })).toBe(1);
    expect(await balanceOf(u.id)).toBe("0.00");

    const ok = await pendingPayment(u.id, "5", "pi_ok");
    await handleStripeEvent(event("payment_intent.succeeded", piSucceeded("pi_ok", ok.id, 500)));
    await handleStripeEvent(event("payment_intent.payment_failed", { id: "pi_ok", metadata: {}, last_payment_error: { message: "late" } }));
    row = await db.payment.findUniqueOrThrow({ where: { id: ok.id } });
    expect(row.status).toBe("SUCCEEDED");
  });

  it("checkout.session.completed credits once and attaches the intent", async () => {
    const u = await makeUser();
    const p = await db.payment.create({ data: { userId: u.id, amount: "40", kind: "topup", stripeCheckoutId: "cs_1" } });
    const session = {
      id: "cs_1",
      payment_status: "paid",
      status: "complete",
      currency: "usd",
      amount_total: 4000,
      metadata: { paymentId: p.id },
      payment_intent: { id: "pi_cs", payment_method: null, latest_charge: { receipt_url: "https://r/cs" } },
    };
    stripe.checkout.sessions.retrieve.mockResolvedValue(session);
    const ev = event("checkout.session.completed", { id: "cs_1", metadata: { paymentId: p.id }, payment_intent: "pi_cs" });
    await Promise.all([handleStripeEvent(ev), handleStripeEvent(ev)]);
    await handleStripeEvent(ev);
    expect(await balanceOf(u.id)).toBe("40.00");
    const row = await db.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({ status: "SUCCEEDED", stripePaymentIntentId: "pi_cs", receiptUrl: "https://r/cs" });
  });

  it("charge.refunded debits partial then full refunds exactly once each", async () => {
    const u = await makeUser();
    const p = await pendingPayment(u.id, "100", "pi_ref");
    await handleStripeEvent(event("payment_intent.succeeded", piSucceeded("pi_ref", p.id, 10000)));
    const partial = event("charge.refunded", { id: "ch_ref", payment_intent: "pi_ref", amount_refunded: 3000, refunded: false });
    await Promise.all([handleStripeEvent(partial), handleStripeEvent(partial)]);
    await handleStripeEvent(partial);
    expect(await balanceOf(u.id)).toBe("70.00");
    expect((await db.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("SUCCEEDED");

    const full = event("charge.refunded", { id: "ch_ref", payment_intent: "pi_ref", amount_refunded: 10000, refunded: true });
    await handleStripeEvent(full);
    await handleStripeEvent(full);
    expect(await balanceOf(u.id)).toBe("0.00");
    expect((await db.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("REFUNDED");
    const refunds = await db.ledgerEntry.findMany({ where: { userId: u.id, type: "REFUND" } });
    expect(refunds.map((r) => r.amount.toFixed(0)).sort()).toEqual(["-30", "-70"]);
  });

  it("charge.dispute.created debits, marks DISPUTED, suspends and audits (once)", async () => {
    const u = await makeUser();
    const p = await pendingPayment(u.id, "60", "pi_disp");
    await handleStripeEvent(event("payment_intent.succeeded", piSucceeded("pi_disp", p.id, 6000)));
    const ev = event("charge.dispute.created", { id: "dp_1", charge: "ch_d", payment_intent: "pi_disp", amount: 6000, reason: "fraudulent" });
    await Promise.all([handleStripeEvent(ev), handleStripeEvent(ev)]);
    await handleStripeEvent(ev);
    expect(await balanceOf(u.id)).toBe("0.00");
    expect(await db.ledgerEntry.count({ where: { userId: u.id, type: "CHARGEBACK" } })).toBe(1);
    expect((await db.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("DISPUTED");
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).status).toBe("SUSPENDED");
    expect(await db.auditLog.count({ where: { targetId: u.id, action: "billing.chargeback" } })).toBe(1);
  });

  it("charge.dispute.closed (won) reverses the chargeback once and re-activates a customer we suspended for it", async () => {
    const u = await makeUser();
    const p = await pendingPayment(u.id, "40", "pi_won");
    await handleStripeEvent(event("payment_intent.succeeded", piSucceeded("pi_won", p.id, 4000)));
    await handleStripeEvent(event("charge.dispute.created", { id: "dp_won", charge: "ch_w", payment_intent: "pi_won", amount: 4000, reason: "fraudulent" }));
    expect(await balanceOf(u.id)).toBe("0.00");
    const closed = event("charge.dispute.closed", { id: "dp_won", charge: "ch_w", payment_intent: "pi_won", amount: 4000, status: "won" });
    await Promise.all([handleStripeEvent(closed), handleStripeEvent(closed)]);
    expect(await balanceOf(u.id)).toBe("40.00");
    expect((await db.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("SUCCEEDED");
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).status).toBe("ACTIVE");
    // lost: nothing changes
    const u2 = await makeUser();
    const p2 = await pendingPayment(u2.id, "10", "pi_lost");
    await handleStripeEvent(event("payment_intent.succeeded", piSucceeded("pi_lost", p2.id, 1000)));
    await handleStripeEvent(event("charge.dispute.created", { id: "dp_lost", charge: "ch_l", payment_intent: "pi_lost", amount: 1000 }));
    await handleStripeEvent(event("charge.dispute.closed", { id: "dp_lost", charge: "ch_l", payment_intent: "pi_lost", amount: 1000, status: "lost" }));
    expect(await balanceOf(u2.id)).toBe("0.00");
    expect((await db.user.findUniqueOrThrow({ where: { id: u2.id } })).status).toBe("SUSPENDED");
  });

  it("charge.dispute.closed (won) keeps a customer an admin suspended afterwards for another reason", async () => {
    const u = await makeUser();
    const p = await pendingPayment(u.id, "20", "pi_won2");
    await handleStripeEvent(event("payment_intent.succeeded", piSucceeded("pi_won2", p.id, 2000)));
    await handleStripeEvent(event("charge.dispute.created", { id: "dp_won2", charge: "ch_w2", payment_intent: "pi_won2", amount: 2000 }));
    await new Promise((r) => setTimeout(r, 5));
    await db.auditLog.create({ data: { action: "customer.suspend", targetType: "User", targetId: u.id } });
    await handleStripeEvent(event("charge.dispute.closed", { id: "dp_won2", charge: "ch_w2", payment_intent: "pi_won2", amount: 2000, status: "won" }));
    expect(await balanceOf(u.id)).toBe("20.00");
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).status).toBe("SUSPENDED");
  });

  it("setup_intent.succeeded sets the default card and grants trial credit when a card is required", async () => {
    const u = await makeUser({ stripeCustomerId: `cus_${Math.random().toString(36).slice(2)}` });
    const ev = event("setup_intent.succeeded", { id: "seti_1", customer: u.stripeCustomerId, payment_method: "pm_new", metadata: { userId: u.id } });
    await handleStripeEvent(ev);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).defaultPaymentMethodId).toBe("pm_new");
    expect(granted).toHaveBeenCalledWith(u.id, { cardFingerprint: "fp_test" });

    // a second card does not steal the default
    await handleStripeEvent(event("setup_intent.succeeded", { id: "seti_2", customer: u.stripeCustomerId, payment_method: "pm_second", metadata: { userId: u.id } }));
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).defaultPaymentMethodId).toBe("pm_new");
  });

  it("payment_method.detached switches to another card, or clears the default and disables auto-recharge", async () => {
    const u = await makeUser({ stripeCustomerId: `cus_${Math.random().toString(36).slice(2)}`, defaultPaymentMethodId: "pm_a", autoRechargeEnabled: true });
    stripe.paymentMethods.list.mockResolvedValueOnce({ data: [{ id: "pm_b" }] });
    await handleStripeEvent(event("payment_method.detached", { id: "pm_a" }));
    let row = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.defaultPaymentMethodId).toBe("pm_b");
    expect(row.autoRechargeEnabled).toBe(true);

    stripe.paymentMethods.list.mockResolvedValueOnce({ data: [] });
    await handleStripeEvent(event("payment_method.detached", { id: "pm_b" }));
    row = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.defaultPaymentMethodId).toBeNull();
    expect(row.autoRechargeEnabled).toBe(false);
  });
});
