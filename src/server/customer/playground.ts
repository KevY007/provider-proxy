"use server";

import { invalidateGatewayConfig } from "@/gateway/cache";
import { generateApiKey } from "@/lib/crypto";
import { db } from "@/lib/db";
import type { ActionResult } from "@/lib/auth/types";
import { fail, withUser } from "./action-utils";

/**
 * Returns a fresh raw key for the hidden `isPlayground` API key (created on first use). The raw key is never
 * stored: each call rotates the hash, so the secret only ever lives in the browser tab's memory. Concurrent tabs
 * simply re-request a key when the gateway answers 401.
 */
export async function getPlaygroundKeyAction(): Promise<ActionResult<{ key: string }>> {
  return withUser<{ key: string }>("playgroundKey", async (s) => {
    if (!s.user.emailVerifiedAt) return fail("Verify your email address to use the playground.");
    const gen = generateApiKey();
    const existing = await db.apiKey.findFirst({ where: { userId: s.user.id, isPlayground: true }, orderBy: { createdAt: "asc" } });
    let id: string;
    if (existing) {
      await db.apiKey.update({ where: { id: existing.id }, data: { keyHash: gen.hash, prefix: gen.prefix, status: "ACTIVE", expiresAt: null } });
      id = existing.id;
    } else {
      const row = await db.apiKey.create({ data: { userId: s.user.id, name: "Playground", prefix: gen.prefix, keyHash: gen.hash, isPlayground: true } });
      id = row.id;
    }
    await invalidateGatewayConfig("apiKeys", id);
    return { ok: true, data: { key: gen.key } };
  });
}
