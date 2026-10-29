import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getSettings } from "@/lib/settings";
import { ZERO, toDecimal } from "@/lib/money";
import type { Prisma } from "@/generated/prisma/client";
import { isStripeConfigured, listPaymentMethods } from "./stripe";
import { STRIPE_MAX_USD, STRIPE_MIN_USD } from "./topup";
import type { LedgerRow, PaymentRow, RedeemCodeRow, SavedCardRow } from "./types";

const iso = (d: Date) => d.toISOString();

function ledgerRow(e: {
  id: string;
  type: string;
  amount: Prisma.Decimal;
  balanceAfter: Prisma.Decimal;
  description: string;
  paymentId: string | null;
  createdAt: Date;
  userId?: string;
  user?: { email: string } | null;
  createdById?: string | null;
}): LedgerRow {
  return {
    id: e.id,
    type: e.type,
    amount: e.amount.toString(),
    balanceAfter: e.balanceAfter.toString(),
    description: e.description,
    paymentId: e.paymentId,
    createdAt: iso(e.createdAt),
    ...(e.user ? { userId: e.userId, userEmail: e.user.email } : {}),
  };
}

function paymentRow(p: {
  id: string;
  amount: Prisma.Decimal;
  status: string;
  kind: string;
  failureReason: string | null;
  receiptUrl: string | null;
  createdAt: Date;
  userId?: string;
  user?: { email: string } | null;
  stripePaymentIntentId?: string | null;
}): PaymentRow {
  return {
    id: p.id,
    amount: p.amount.toString(),
    status: p.status,
    kind: p.kind,
    failureReason: p.failureReason,
    receiptUrl: p.receiptUrl,
    createdAt: iso(p.createdAt),
    ...(p.user ? { userId: p.userId, userEmail: p.user.email, stripePaymentIntentId: p.stripePaymentIntentId ?? null } : {}),
  };
}

export function startOfMonthUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface CustomerBillingData {
  stripe: { configured: boolean; publishableKey: string | null; webhookConfigured: boolean };
  balance: string;
  creditLimit: string;
  billingMode: "PREPAID" | "POSTPAID";
  monthSpend: string;
  monthSpendLimit: string | null;
  lowBalanceAlertAt: string | null;
  autoRecharge: { enabled: boolean; threshold: string; amount: string };
  limits: { minTopup: number; maxTopup: number; autoRechargeMaxPerDay: number };
  cards: SavedCardRow[];
  cardsError: string | null;
  hasDefaultCard: boolean;
  ledger: LedgerRow[];
  payments: PaymentRow[];
}

export async function getCustomerBillingData(userId: string): Promise<CustomerBillingData | null> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  const settings = await getSettings();
  const [spend, ledger, payments] = await Promise.all([
    db.requestLog.aggregate({ where: { userId, createdAt: { gte: startOfMonthUtc() } }, _sum: { price: true } }),
    db.ledgerEntry.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 500 }),
    db.payment.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 200 }),
  ]);

  let cards: SavedCardRow[] = [];
  let cardsError: string | null = null;
  const configured = isStripeConfigured();
  if (configured && user.stripeCustomerId) {
    try {
      cards = await listPaymentMethods(userId);
    } catch (err) {
      logger.warn("could not list payment methods", { userId, err });
      cardsError = "We couldn't load your saved cards right now.";
    }
  }

  return {
    stripe: { configured, publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null, webhookConfigured: !!env.STRIPE_WEBHOOK_SECRET },
    balance: user.balance.toString(),
    creditLimit: user.creditLimit.toString(),
    billingMode: user.billingMode,
    monthSpend: (spend._sum.price ?? ZERO).toString(),
    monthSpendLimit: user.monthlySpendLimit?.toString() ?? null,
    lowBalanceAlertAt: user.lowBalanceAlertAt?.toString() ?? null,
    autoRecharge: {
      enabled: user.autoRechargeEnabled,
      threshold: user.autoRechargeThreshold.toString(),
      amount: user.autoRechargeAmount.toString(),
    },
    limits: {
      minTopup: Math.max(settings.minTopup, STRIPE_MIN_USD),
      maxTopup: Math.min(settings.maxTopup > 0 ? settings.maxTopup : STRIPE_MAX_USD, STRIPE_MAX_USD),
      autoRechargeMaxPerDay: settings.autoRechargeMaxPerDay,
    },
    cards,
    cardsError,
    hasDefaultCard: !!user.defaultPaymentMethodId,
    ledger: ledger.map(ledgerRow),
    payments: payments.map(paymentRow),
  };
}

export interface AdminBillingFilters {
  status?: string;
  kind?: string;
  q?: string;
  ledgerType?: string;
}

export interface AdminBillingData {
  kpis: {
    revenueAllTime: string;
    revenueMonth: string;
    refunds: string;
    chargebacks: string;
    outstandingPostpaid: string;
    postpaidCustomers: number;
    customerLiability: string;
    customersWithBalance: number;
    pendingPayments: number;
  };
  payments: PaymentRow[];
  ledger: LedgerRow[];
  codes: RedeemCodeRow[];
  stripe: { configured: boolean; webhookConfigured: boolean };
}

const PAYMENT_STATUSES = ["PENDING", "SUCCEEDED", "FAILED", "REFUNDED", "DISPUTED", "CANCELED"] as const;
const LEDGER_TYPES = [
  "TOPUP", "AUTO_RECHARGE", "TRIAL_CREDIT", "REDEEM", "ADJUSTMENT", "REFUND", "CHARGEBACK", "POSTPAID_SETTLEMENT", "USAGE_CORRECTION",
] as const;

export async function getAdminBillingData(f: AdminBillingFilters = {}): Promise<AdminBillingData> {
  const status = PAYMENT_STATUSES.find((s) => s === f.status);
  const ledgerType = LEDGER_TYPES.find((t) => t === f.ledgerType);
  const q = f.q?.trim();
  const userFilter = q ? { OR: [{ email: { contains: q, mode: "insensitive" as const } }, { id: q }] } : undefined;
  const monthStart = startOfMonthUtc();

  const [revAll, revMonth, refunds, chargebacks, postpaid, liability, pending, payments, ledger, codes] = await Promise.all([
    db.payment.aggregate({ where: { status: { in: ["SUCCEEDED", "REFUNDED", "DISPUTED"] } }, _sum: { amount: true } }),
    db.payment.aggregate({
      where: { status: { in: ["SUCCEEDED", "REFUNDED", "DISPUTED"] }, createdAt: { gte: monthStart } },
      _sum: { amount: true },
    }),
    db.ledgerEntry.aggregate({ where: { type: "REFUND" }, _sum: { amount: true } }),
    db.ledgerEntry.aggregate({ where: { type: "CHARGEBACK" }, _sum: { amount: true } }),
    db.user.aggregate({ where: { billingMode: "POSTPAID", balance: { lt: 0 } }, _sum: { balance: true }, _count: true }),
    db.user.aggregate({ where: { balance: { gt: 0 } }, _sum: { balance: true }, _count: true }),
    db.payment.count({ where: { status: "PENDING" } }),
    db.payment.findMany({
      where: { ...(status ? { status } : {}), ...(f.kind ? { kind: f.kind } : {}), ...(userFilter ? { user: userFilter } : {}) },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { user: { select: { email: true } } },
    }),
    db.ledgerEntry.findMany({
      where: { ...(ledgerType ? { type: ledgerType } : {}), ...(userFilter ? { user: userFilter } : {}) },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { user: { select: { email: true } } },
    }),
    db.redeemCode.findMany({ orderBy: { createdAt: "desc" }, take: 1000 }),
  ]);

  const now = Date.now();
  return {
    kpis: {
      revenueAllTime: toDecimal(revAll._sum.amount).toString(),
      revenueMonth: toDecimal(revMonth._sum.amount).toString(),
      refunds: toDecimal(refunds._sum.amount).abs().toString(),
      chargebacks: toDecimal(chargebacks._sum.amount).abs().toString(),
      outstandingPostpaid: toDecimal(postpaid._sum.balance).abs().toString(),
      postpaidCustomers: postpaid._count,
      customerLiability: toDecimal(liability._sum.balance).toString(),
      customersWithBalance: liability._count,
      pendingPayments: pending,
    },
    payments: payments.map(paymentRow),
    ledger: ledger.map(ledgerRow),
    codes: codes.map((c) => ({
      id: c.id,
      code: c.code,
      amount: c.amount.toString(),
      maxUses: c.maxUses,
      uses: c.uses,
      expiresAt: c.expiresAt ? iso(c.expiresAt) : null,
      note: c.note,
      createdAt: iso(c.createdAt),
      status: c.expiresAt && c.expiresAt.getTime() <= now ? "expired" : c.uses >= c.maxUses ? "exhausted" : "active",
    })),
    stripe: { configured: isStripeConfigured(), webhookConfigured: !!env.STRIPE_WEBHOOK_SECRET },
  };
}
