import { afterAll, afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { setStripeClientForTests } from "@/server/billing/stripe";
import { createTopup, validateTopupAmount } from "@/server/billing/topup";
import { balanceOf, cleanupUsers, dbAvailable, makeUser, mockStripe } from "./helpers";

// the portal may run with customer billing off (prod default now): these tests exercise billing itself
beforeAll(async () => {
  await (await import("@/lib/settings")).setSettings({ customerBilling: true });
});

describe("validateTopupAmount", () => {
  const limits = { min: 5, max: 1000 };
  const ok = (v: unknown) => {
    const r = validateTopupAmount(v, limits);
    return r.ok ? r.amount.toString() : `ERR:${r.error}`;
  };

  it("accepts values inside the limits (numbers and strings, up to 2 dp)", () => {
    expect(ok(5)).toBe("5");
    expect(ok("25")).toBe("25");
    expect(ok("$49.99")).toBe("49.99");
    expect(ok(1000)).toBe("1000");
  });
  it("enforces min and max", () => {
    expect(ok(4.99)).toMatch(/^ERR:Minimum top-up is \$5\.00/);
    expect(ok(1000.01)).toMatch(/^ERR:Maximum top-up is \$1,000\.00/);
  });
  it("never goes below Stripe's $0.50 even if minTopup is lower", () => {
    expect(validateTopupAmount(0.25, { min: 0, max: 100 })).toMatchObject({ ok: false });
    expect(validateTopupAmount(0.5, { min: 0, max: 100 })).toMatchObject({ ok: true });
  });
  it("rejects junk", () => {
    for (const v of ["", null, undefined, "abc", "-5", 0, "0", "1e3", "10.123", NaN, Infinity, {}, [], "5,00"]) {
      expect(validateTopupAmount(v, limits).ok).toBe(false);
    }
  });
});

const up = await dbAvailable();

describe.skipIf(!up)("createTopup (mocked Stripe)", () => {
  let stripe: ReturnType<typeof mockStripe>;
  beforeEach(() => {
    stripe = mockStripe();
    setStripeClientForTests(stripe);
  });
  afterEach(() => setStripeClientForTests(null));
  afterAll(async () => {
    await cleanupUsers();
    await db.$disconnect();
  });

  it("is a no-op error when Stripe isn't configured", async () => {
    setStripeClientForTests(null);
    const u = await makeUser();
    const r = await createTopup(u.id, 20);
    expect(r).toMatchObject({ ok: false, code: "not_configured" });
    expect(await db.payment.count({ where: { userId: u.id } })).toBe(0);
  });

  it("rejects bad amounts before touching Stripe or the DB", async () => {
    const u = await makeUser();
    expect(await createTopup(u.id, 1)).toMatchObject({ ok: false, code: "invalid_amount" });
    expect(await createTopup(u.id, 5_000_000)).toMatchObject({ ok: false, code: "invalid_amount" });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(await db.payment.count({ where: { userId: u.id } })).toBe(0);
  });

  it("charges the default card immediately and credits the balance", async () => {
    const u = await makeUser({ stripeCustomerId: "cus_t1", defaultPaymentMethodId: "pm_t1" });
    stripe.paymentIntents.create.mockImplementation(async (params: { metadata: { paymentId: string }; amount: number }) => ({
      id: "pi_t1",
      status: "succeeded",
      amount: params.amount,
      amount_received: params.amount,
      currency: "usd",
      latest_charge: "ch_1",
      metadata: params.metadata,
    }));
    const r = await createTopup(u.id, "25.50");
    expect(r).toMatchObject({ ok: true, status: "succeeded" });
    const args = stripe.paymentIntents.create.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({ amount: 2550, currency: "usd", customer: "cus_t1", payment_method: "pm_t1", confirm: true });
    expect(await balanceOf(u.id)).toBe("25.50");
    const p = await db.payment.findFirstOrThrow({ where: { userId: u.id } });
    expect(p).toMatchObject({ status: "SUCCEEDED", kind: "topup", stripePaymentIntentId: "pi_t1" });
  });

  it("returns the client secret for 3D Secure and leaves the Payment PENDING (no credit yet)", async () => {
    const u = await makeUser({ stripeCustomerId: "cus_t2", defaultPaymentMethodId: "pm_t2" });
    stripe.paymentIntents.create.mockResolvedValue({ id: "pi_3ds", status: "requires_action", client_secret: "pi_3ds_secret", amount: 1000, currency: "usd", metadata: {} });
    const r = await createTopup(u.id, 10);
    expect(r).toMatchObject({ ok: true, status: "requires_action", clientSecret: "pi_3ds_secret", paymentIntentId: "pi_3ds" });
    expect(await balanceOf(u.id)).toBe("0.00");
    expect((await db.payment.findFirstOrThrow({ where: { userId: u.id } })).status).toBe("PENDING");
  });

  it("marks the Payment FAILED on a declined card", async () => {
    const u = await makeUser({ stripeCustomerId: "cus_t3", defaultPaymentMethodId: "pm_t3" });
    stripe.paymentIntents.create.mockRejectedValue(Object.assign(new Error("Your card was declined."), { code: "card_declined" }));
    const r = await createTopup(u.id, 10);
    expect(r).toMatchObject({ ok: false, code: "declined", error: "Your card was declined." });
    expect(await db.payment.findFirstOrThrow({ where: { userId: u.id } })).toMatchObject({ status: "FAILED", failureReason: "Your card was declined." });
    expect(await balanceOf(u.id)).toBe("0.00");
  });

  it("falls back to Stripe Checkout when there is no saved card", async () => {
    const u = await makeUser({ stripeCustomerId: "cus_t4" });
    stripe.checkout.sessions.create.mockResolvedValue({ id: "cs_t4", url: "https://checkout.stripe.test/cs_t4" });
    const r = await createTopup(u.id, 40);
    expect(r).toMatchObject({ ok: true, status: "checkout", url: "https://checkout.stripe.test/cs_t4" });
    const args = stripe.checkout.sessions.create.mock.calls[0][0] as { line_items: Array<{ price_data: { unit_amount: number } }>; metadata: { paymentId: string } };
    expect(args.line_items[0].price_data.unit_amount).toBe(4000);
    const p = await db.payment.findFirstOrThrow({ where: { userId: u.id } });
    expect(p).toMatchObject({ status: "PENDING", stripeCheckoutId: "cs_t4" });
    expect(args.metadata.paymentId).toBe(p.id);
  });
});
