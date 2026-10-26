"use server";

import { invalidateGatewayConfig } from "@/gateway/cache";
import { generateApiKey } from "@/lib/crypto";
import { db } from "@/lib/db";
import type { ActionResult } from "@/lib/auth/types";
import { fail, withUser } from "./action-utils";
import { canUsePool } from "./key-schemas";

/**
 * Returns a fresh raw key for the hidden `isPlayground` API key (created on first use), set to the pool the customer
 * picked in the playground (`groupId`; null = the account's default pool). The raw key is never stored: each call
 * rotates the hash, so the secret only ever lives in the browser tab's memory. Concurrent tabs simply re-request a
 * key when the gateway answers 401.
 */
export async function getPlaygroundKeyAction(groupId: string | null = null): Promise<ActionResult<{ key: string }>> {
  return withUser<{ key: string }>("playgroundKey", async (s) => {
    if (!s.user.emailVerifiedAt) return fail("Verify your email address to use the playground.");
    if (groupId !== null && typeof groupId !== "string") return fail("That pool is not available");
    if (groupId) {
      const g = await db.group.findUnique({ where: { id: groupId }, select: { id: true, isPublic: true } });
      if (!g || !canUsePool(g, s.user)) return fail("That pool is not available");
    }
    const gen = generateApiKey();
    const existing = await db.apiKey.findFirst({ where: { userId: s.user.id, isPlayground: true }, orderBy: { createdAt: "asc" } });
    let id: string;
    if (existing) {
      await db.apiKey.update({ where: { id: existing.id }, data: { keyHash: gen.hash, prefix: gen.prefix, status: "ACTIVE", expiresAt: null, groupId } });
      id = existing.id;
    } else {
      const row = await db.apiKey.create({ data: { userId: s.user.id, name: "Playground", prefix: gen.prefix, keyHash: gen.hash, isPlayground: true, groupId } });
      id = row.id;
    }
    await invalidateGatewayConfig("apiKeys", id);
    return { ok: true, data: { key: gen.key } };
  });
}
