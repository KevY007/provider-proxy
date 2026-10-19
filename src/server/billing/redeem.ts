import { randomInt } from "node:crypto";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { Decimal, toDbString, toDecimal, type MoneyLike } from "@/lib/money";
import { Prisma } from "@/generated/prisma/client";
import { afterLedgerCommit, appendEntryTx } from "./ledger";

/** Unambiguous alphabet (no 0/O/1/I/L). */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export type RedeemFailure = "invalid_code" | "expired" | "exhausted" | "already_redeemed" | "account_inactive";

export type RedeemResult =
  | { ok: true; amount: Decimal; balance: Decimal; code: string }
  | { ok: false; reason: RedeemFailure; error: string };

const MESSAGES: Record<RedeemFailure, string> = {
  invalid_code: "That code isn't valid.",
  expired: "That code has expired.",
  exhausted: "That code has already been fully redeemed.",
  already_redeemed: "You've already redeemed this code.",
  account_inactive: "Your account can't redeem codes right now.",
};

const fail = (reason: RedeemFailure): RedeemResult => ({ ok: false, reason, error: MESSAGES[reason] });

/** Uppercase, strip whitespace/quotes. Codes are stored uppercase. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s"'`]+/g, "");
}

/**
 * Redeem a code for `userId`: one use per user, honours `maxUses` and `expiresAt`, credits the balance with
 * a REDEEM ledger entry. Everything happens in one transaction with the code row and user row locked, so
 * concurrent redemptions can never exceed `maxUses` or double-credit.
 */
export async function redeemCode(userId: string, rawCode: string): Promise<RedeemResult> {
  const code = normalizeCode(rawCode);
  if (!code || code.length > 64 || !/^[A-Z0-9_-]+$/.test(code)) return fail("invalid_code");

  const result = await db.$transaction(async (tx): Promise<RedeemResult> => {
    const rows = await tx.$queryRaw<
      Array<{ id: string; amount: Prisma.Decimal; maxUses: number; uses: number; expiresAt: Date | null }>
    >(Prisma.sql`SELECT "id", "amount", "maxUses", "uses", "expiresAt" FROM "RedeemCode" WHERE "code" = ${code} FOR UPDATE`);
    const row = rows[0];
    if (!row) return fail("invalid_code");
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return fail("expired");
    if (row.uses >= row.maxUses) return fail("exhausted");

    const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user || user.status !== "ACTIVE") return fail("account_inactive");

    const prior = await tx.redeemCodeUse.findUnique({ where: { codeId_userId: { codeId: row.id, userId } } });
    if (prior) return fail("already_redeemed");

    await tx.redeemCodeUse.create({ data: { codeId: row.id, userId } });
    await tx.redeemCode.update({ where: { id: row.id }, data: { uses: { increment: 1 } } });
    const amount = toDecimal(row.amount);
    const ledger = await appendEntryTx(tx, userId, amount, "REDEEM", `Redeemed code ${code}`, {
      metadata: { codeId: row.id, code },
    });
    return { ok: true, amount, balance: ledger.balance, code };
  });

  if (result.ok) {
    await afterLedgerCommit(userId);
    logger.info("redeem code used", { userId, code, amount: result.amount.toString() });
  }
  return result;
}

export interface GenerateCodesInput {
  amount: MoneyLike;
  count: number;
  maxUses?: number;
  expiresAt?: Date | null;
  note?: string | null;
  prefix?: string | null;
}

export class RedeemInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedeemInputError";
  }
}

function randomChunk(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

/** `PREFIX-XXXX-XXXX-XXXX` (prefix optional). */
export function makeCode(prefix?: string | null): string {
  const p = (prefix ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  return [p, randomChunk(4), randomChunk(4), randomChunk(4)].filter(Boolean).join("-");
}

/** Admin: mint `count` codes worth `amount` each. Returns the generated codes. */
export async function generateCodes(adminId: string, input: GenerateCodesInput): Promise<string[]> {
  const amount = toDecimal(input.amount);
  if (!amount.isFinite() || amount.lte(0) || amount.gt(100_000)) throw new RedeemInputError("Amount must be between $0.01 and $100,000");
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 500) throw new RedeemInputError("Count must be between 1 and 500");
  const maxUses = input.maxUses ?? 1;
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000) throw new RedeemInputError("Max uses must be at least 1");
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new RedeemInputError("Expiry must be in the future");

  const created: string[] = [];
  for (let attempt = 0; attempt < 5 && created.length < input.count; attempt++) {
    const need = input.count - created.length;
    const batch = new Set<string>();
    while (batch.size < need) batch.add(makeCode(input.prefix));
    const codes = [...batch];
    // skipDuplicates + read-back handles the (astronomically unlikely) collision with an existing code.
    await db.redeemCode.createMany({
      data: codes.map((code) => ({
        code,
        amount: toDbString(amount),
        maxUses,
        expiresAt: input.expiresAt ?? null,
        note: input.note?.trim() || null,
        createdById: adminId,
      })),
      skipDuplicates: true,
    });
    const rows = await db.redeemCode.findMany({ where: { code: { in: codes }, createdById: adminId, uses: 0 }, select: { code: true, createdAt: true } });
    const fresh = new Set(rows.filter((r) => Date.now() - r.createdAt.getTime() < 60_000).map((r) => r.code));
    for (const c of codes) if (fresh.has(c)) created.push(c);
  }
  await audit(adminId, "billing.redeem_codes_generated", null, {
    count: created.length,
    amount: toDbString(amount),
    maxUses,
    expiresAt: input.expiresAt?.toISOString() ?? null,
    note: input.note ?? null,
  });
  return created.slice(0, input.count);
}
