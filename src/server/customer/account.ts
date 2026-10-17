"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { audit } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";
import { destroyCurrentSession } from "@/lib/auth/session";
import { nameSchema } from "@/lib/auth/schemas";
import type { ActionResult } from "@/lib/auth/types";
import { randomToken } from "@/lib/crypto";
import { db } from "@/lib/db";
import { getClientIp } from "@/lib/http";
import { fail, invalidInput, withUser } from "./action-utils";

export async function updateProfileAction(input: unknown): Promise<ActionResult> {
  const parsed = z.object({ name: nameSchema }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  return withUser("updateProfile", async (s) => {
    await db.user.update({ where: { id: s.user.id }, data: { name: parsed.data.name?.trim() || null } });
    return { ok: true, message: "Profile updated" };
  });
}

/**
 * Soft-delete: revoke all API keys, suspend, anonymize identity (email/name/password/2FA/sessions/IP data).
 * Request history and ledger rows stay (financial records) but no longer identify the person.
 */
export async function deleteAccountAction(input: unknown): Promise<ActionResult<{ redirectTo: string }>> {
  const parsed = z.object({ email: z.string().trim().toLowerCase().min(1, "Type your email to confirm") }).safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  return withUser<{ redirectTo: string }>("deleteAccount", async (s) => {
    if (s.impersonatorId) return fail("Account deletion is disabled while impersonating.");
    if (s.user.role !== "CUSTOMER") return fail("Staff accounts can't be deleted here. Ask another administrator.");
    if (parsed.data.email !== s.user.email.toLowerCase()) return fail("That doesn't match your account email.", { email: "That doesn't match your account email." });
    if (s.user.balance.isNegative() && !s.user.balance.isZero()) return fail("You have an outstanding balance. Settle it on the Billing page before deleting your account.");
    const ip = getClientIp(await headers());
    const userId = s.user.id;
    const tombstone = `deleted+${userId}@deleted.invalid`;
    await db.$transaction([
      db.apiKey.updateMany({ where: { userId }, data: { status: "REVOKED" } }),
      db.session.deleteMany({ where: { userId } }),
      db.verificationToken.deleteMany({ where: { userId } }),
      db.requestLog.updateMany({ where: { userId }, data: { ip: null, userAgent: null } }),
      db.user.update({
        where: { id: userId },
        data: {
          status: "SUSPENDED",
          email: tombstone,
          name: null,
          passwordHash: await hashPassword(randomToken(24)),
          totpSecret: null,
          totpEnabled: false,
          autoRechargeEnabled: false,
          signupIp: null,
        },
      }),
    ]);
    await Promise.all([invalidateGatewayConfig("apiKeys"), invalidateGatewayConfig("users", userId)]);
    await audit(userId, "account.delete", { type: "User", id: userId }, { originalEmail: s.user.email }, ip);
    await destroyCurrentSession().catch(() => undefined);
    return { ok: true, data: { redirectTo: "/" }, message: "Your account was deleted." };
  });
}
