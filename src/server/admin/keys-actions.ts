"use server";

import { z } from "zod";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { audit } from "@/lib/audit";
import { decrypt } from "@/lib/crypto";
import { db } from "@/lib/db";
import { ActionFail, adminAction, parseInput } from "./action";

/** Enable / disable / revoke a customer API key. REVOKED is permanent. Staff (SUPPORT) allowed. */
export async function setApiKeyStatus(keyId: string, status: "ACTIVE" | "DISABLED" | "REVOKED") {
  return adminAction({}, async ({ admin, ip }) => {
    const st = parseInput(z.enum(["ACTIVE", "DISABLED", "REVOKED"]), status);
    const key = await db.apiKey.findUnique({ where: { id: keyId }, select: { id: true, name: true, prefix: true, status: true, userId: true } });
    if (!key) throw new ActionFail("API key not found");
    if (key.status === "REVOKED") throw new ActionFail("This key is revoked and cannot be changed");
    if (key.status === st) return { message: "No change" };
    await db.apiKey.update({ where: { id: keyId }, data: { status: st } });
    const verb = st === "REVOKED" ? "revoke" : st === "DISABLED" ? "disable" : "enable";
    await audit(admin.id, `apikey.${verb}`, { type: "ApiKey", id: keyId }, { userId: key.userId, prefix: key.prefix, name: key.name, from: key.status }, ip);
    await invalidateGatewayConfig("apiKeys", keyId);
    return { message: st === "REVOKED" ? "Key revoked" : st === "DISABLED" ? "Key disabled" : "Key enabled" };
  });
}

/** Show a customer API key in full (ADMIN only, audited). Keys created before keys were stored encrypted cannot be shown. */
export async function revealApiKey(keyId: string) {
  return adminAction<{ key: string }>({ adminOnly: true }, async ({ admin, ip }) => {
    const key = await db.apiKey.findUnique({ where: { id: keyId }, select: { id: true, name: true, prefix: true, userId: true, isPlayground: true, secretEncrypted: true } });
    if (!key) throw new ActionFail("API key not found");
    if (!key.secretEncrypted) {
      throw new ActionFail(key.isPlayground ? "Playground keys rotate on every use and are never stored" : "This key was created before keys were stored for viewing; only its fingerprint exists. Create a new key to be able to view it.");
    }
    let plain: string;
    try {
      plain = decrypt(key.secretEncrypted);
    } catch {
      throw new ActionFail("The stored key cannot be decrypted (was ENCRYPTION_KEY changed?)");
    }
    await audit(admin.id, "apikey.reveal", { type: "ApiKey", id: keyId }, { userId: key.userId, prefix: key.prefix, name: key.name }, ip);
    return { data: { key: plain } };
  });
}
