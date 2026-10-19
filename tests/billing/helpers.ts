import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { db } from "@/lib/db";

/** True when the dev Postgres is reachable; DB-backed tests are skipped otherwise. */
export async function dbAvailable(): Promise<boolean> {
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

const created: string[] = [];
const emails: string[] = [];

export async function makeUser(
  data: Partial<{
    balance: string;
    status: "ACTIVE" | "SUSPENDED" | "PENDING_VERIFICATION";
    autoRechargeEnabled: boolean;
    autoRechargeThreshold: string;
    autoRechargeAmount: string;
    stripeCustomerId: string | null;
    defaultPaymentMethodId: string | null;
    billingMode: "PREPAID" | "POSTPAID";
    creditLimit: string;
  }> = {},
) {
  const email = `billing-test-${randomBytes(6).toString("hex")}@test.local`;
  const user = await db.user.create({
    data: { email, passwordHash: "x", status: "ACTIVE", ...data },
  });
  created.push(user.id);
  emails.push(email);
  return user;
}

export async function cleanupUsers() {
  if (created.length) await db.user.deleteMany({ where: { id: { in: created } } });
  if (emails.length) await db.emailOutbox.deleteMany({ where: { to: { in: emails } } });
  if (created.length) await db.auditLog.deleteMany({ where: { targetId: { in: created } } });
  created.length = 0;
  emails.length = 0;
}

export async function balanceOf(userId: string): Promise<string> {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } });
  return u.balance.toFixed(2);
}

/** Minimal Stripe stand-in; override any method per test. */
export function mockStripe(overrides: Record<string, unknown> = {}) {
  const stripe = {
    customers: { create: vi.fn(async () => ({ id: "cus_mock" })), update: vi.fn(async () => ({})) },
    paymentIntents: {
      create: vi.fn(),
      retrieve: vi.fn(),
      cancel: vi.fn(async () => ({})),
    },
    charges: { retrieve: vi.fn(async () => ({ receipt_url: "https://receipt.test/r" })) },
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() } },
    paymentMethods: { list: vi.fn(async (): Promise<{ data: Array<{ id: string }> }> => ({ data: [] })), retrieve: vi.fn(), detach: vi.fn() },
    setupIntents: { create: vi.fn(), retrieve: vi.fn() },
    ...overrides,
  };
  return stripe;
}

export function piSucceeded(id: string, paymentId: string, cents: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    object: "payment_intent",
    status: "succeeded",
    amount: cents,
    amount_received: cents,
    currency: "usd",
    latest_charge: "ch_mock",
    metadata: { paymentId },
    ...extra,
  };
}

export function event(type: string, object: unknown, id = `evt_${randomBytes(4).toString("hex")}`) {
  return { id, type, data: { object } } as never;
}
