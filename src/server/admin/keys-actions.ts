"use server";

import { z } from "zod";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { audit } from "@/lib/audit";
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
