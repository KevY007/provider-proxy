"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireAdminForAction } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/auth/types";
import { db } from "@/lib/db";
import { getClientIp } from "@/lib/http";
import { formatUSD } from "@/lib/money";
import { ActionFail, parseInput, toActionResult } from "./action-utils";
import { adminAdjustBalance } from "./ledger";
import { generateCodes } from "./redeem";

/**
 * Admin billing mutations. Every one requires an ADMIN (support staff can view /admin/billing but not mutate
 * money) and writes an audit log row.
 */
async function run<T>(
  name: string,
  fn: (ctx: { adminId: string; ip: string }) => Promise<{ data?: T; message?: string } | void>,
): Promise<ActionResult<T>> {
  try {
    const { user } = await requireAdminForAction({ adminOnly: true });
    const ip = getClientIp(await headers());
    const out = await fn({ adminId: user.id, ip });
    return { ok: true, data: out?.data, message: out?.message };
  } catch (err) {
    return toActionResult(err, name);
  }
}

const generateSchema = z.object({
  amount: z.coerce.number({ error: "Enter an amount" }).positive("Must be greater than 0").max(100_000, "Too large"),
  count: z.coerce.number({ error: "Enter a count" }).int("Whole number").min(1, "At least 1").max(500, "At most 500"),
  maxUses: z.coerce.number({ error: "Enter max uses" }).int("Whole number").min(1, "At least 1").max(1_000_000),
  expiresAt: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : v),
    z.coerce.date({ error: "Invalid date" }).nullable(),
  ),
  note: z.string().trim().max(200).optional(),
  prefix: z
    .string()
    .trim()
    .max(12)
    .regex(/^[A-Za-z0-9]*$/, "Letters and digits only")
    .optional(),
});

export async function generateCodesAction(input: unknown): Promise<ActionResult<{ codes: string[] }>> {
  return run("generateCodes", async ({ adminId }) => {
    const data = parseInput(generateSchema, input);
    if (data.expiresAt && data.expiresAt.getTime() <= Date.now()) {
      throw new ActionFail("Expiry must be in the future", { expiresAt: "Expiry must be in the future" });
    }
    const codes = await generateCodes(adminId, {
      amount: data.amount,
      count: data.count,
      maxUses: data.maxUses,
      expiresAt: data.expiresAt,
      note: data.note,
      prefix: data.prefix,
    });
    revalidatePath("/admin/billing");
    return { data: { codes }, message: `Generated ${codes.length} code${codes.length === 1 ? "" : "s"}` };
  });
}

/** Disable = expire now (history and usage counts are kept). */
export async function disableCodeAction(codeId: unknown): Promise<ActionResult> {
  return run("disableCode", async ({ adminId, ip }) => {
    const id = parseInput(z.string().min(1), codeId);
    const code = await db.redeemCode.update({ where: { id }, data: { expiresAt: new Date() }, select: { code: true } });
    await audit(adminId, "billing.redeem_code_disabled", { type: "RedeemCode", id }, { code: code.code }, ip);
    revalidatePath("/admin/billing");
    return { message: "Code disabled" };
  });
}

export async function deleteCodeAction(codeId: unknown): Promise<ActionResult> {
  return run("deleteCode", async ({ adminId, ip }) => {
    const id = parseInput(z.string().min(1), codeId);
    const code = await db.redeemCode.delete({ where: { id }, select: { code: true, uses: true } });
    await audit(adminId, "billing.redeem_code_deleted", { type: "RedeemCode", id }, { code: code.code, uses: code.uses }, ip);
    revalidatePath("/admin/billing");
    return { message: "Code deleted" };
  });
}

const adjustSchema = z.object({
  customer: z.string().trim().min(1, "Enter the customer's email or ID"),
  amount: z.coerce
    .number({ error: "Enter an amount" })
    .finite()
    .refine((n) => n !== 0, "Amount can't be zero")
    .refine((n) => Math.abs(n) <= 1_000_000, "Too large"),
  reason: z.string().trim().min(3, "A reason is required").max(300),
});

/** Credit (positive) or debit (negative) a customer's balance with a mandatory, audited reason. */
export async function adjustBalanceAction(input: unknown): Promise<ActionResult<{ balance: string; email: string }>> {
  return run("adjustBalance", async ({ adminId }) => {
    const data = parseInput(adjustSchema, input);
    const customer = await db.user.findFirst({
      where: data.customer.includes("@") ? { email: data.customer.toLowerCase() } : { id: data.customer },
      select: { id: true, email: true },
    });
    if (!customer) throw new ActionFail("No customer found with that email or ID", { customer: "No customer found" });
    const res = await adminAdjustBalance(adminId, customer.id, data.amount, data.reason);
    revalidatePath("/admin/billing");
    revalidatePath(`/admin/customers/${customer.id}`);
    return {
      data: { balance: res.balance.toString(), email: customer.email },
      message: `${customer.email}: balance is now ${formatUSD(res.balance)}`,
    };
  });
}
