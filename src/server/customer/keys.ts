"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { audit } from "@/lib/audit";
import { encrypt, generateApiKey } from "@/lib/crypto";
import { db } from "@/lib/db";
import { getClientIp } from "@/lib/http";
import { toDbString } from "@/lib/money";
import type { ActionResult } from "@/lib/auth/types";
import { fail, invalidInput, withUser } from "./action-utils";
import { canUsePool, keyFormSchema, keyIdSchema, keyUpdateSchema, type KeyFormValues } from "./key-schemas";

const MAX_KEYS_PER_USER = 100;

/**
 * Validates group + allowed models against what the customer may actually choose: a public pool, their own pool, a
 * private pool an admin allowed for their account, or (when editing) the pool the key is already in.
 */
async function resolveKeyFields(
  v: KeyFormValues,
  user: { groupId: string | null; extraGroupIds: string[] },
  currentGroupId: string | null = null,
): Promise<{ ok: true; groupId: string | null } | { ok: false; error: string; field?: string }> {
  let groupId: string | null = null;
  if (v.groupId) {
    const g = await db.group.findUnique({ where: { id: v.groupId }, select: { id: true, isPublic: true } });
    if (!g || !canUsePool(g, user, currentGroupId)) return { ok: false, error: "That pool is not available", field: "groupId" };
    groupId = g.id;
  }
  if (v.allowedModels.length) {
    const found = await db.model.findMany({ where: { slug: { in: v.allowedModels }, status: { not: "DISABLED" } }, select: { slug: true } });
    const set = new Set(found.map((m) => m.slug));
    const unknown = v.allowedModels.filter((m) => !set.has(m));
    if (unknown.length) return { ok: false, error: `Unknown model: ${unknown[0]}`, field: "allowedModels" };
  }
  return { ok: true, groupId };
}

const dataFor = (v: KeyFormValues, groupId: string | null) => ({
  name: v.name,
  groupId,
  allowedModels: [...new Set(v.allowedModels)],
  ipAllowlist: [...new Set(v.ipAllowlist)],
  rpmLimit: v.rpmLimit ?? null,
  tpmLimit: v.tpmLimit ?? null,
  maxConcurrency: v.maxConcurrency ?? null,
  spendLimit: v.spendLimit != null ? toDbString(v.spendLimit) : null,
  expiresAt: v.expiresAt ? new Date(v.expiresAt) : null,
});

export interface CreatedKey {
  id: string;
  /** The full secret. Shown exactly once - it is never stored. */
  key: string;
  prefix: string;
}

export async function createKeyAction(input: unknown): Promise<ActionResult<CreatedKey>> {
  const parsed = keyFormSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  return withUser<CreatedKey>("createKey", async (s) => {
    if (s.impersonatorId) return fail("API keys cannot be created while impersonating.");
    if (!s.user.emailVerifiedAt) return fail("Verify your email address before creating API keys. Check your inbox for the verification link.");
    const count = await db.apiKey.count({ where: { userId: s.user.id, isPlayground: false, status: { not: "REVOKED" } } });
    if (count >= MAX_KEYS_PER_USER) return fail(`You have reached the limit of ${MAX_KEYS_PER_USER} active keys. Revoke unused keys first.`);
    const r = await resolveKeyFields(parsed.data, s.user);
    if (!r.ok) return fail(r.error, r.field ? { [r.field]: r.error } : undefined);
    const gen = generateApiKey();
    const row = await db.apiKey.create({ data: { userId: s.user.id, keyHash: gen.hash, prefix: gen.prefix, secretEncrypted: encrypt(gen.key), ...dataFor(parsed.data, r.groupId) } });
    await invalidateGatewayConfig("apiKeys", row.id);
    await audit(s.user.id, "apikey.create", { type: "ApiKey", id: row.id }, { name: row.name }, getClientIp(await headers()));
    revalidatePath("/dashboard/keys");
    return { ok: true, data: { id: row.id, key: gen.key, prefix: gen.prefix }, message: "API key created" };
  });
}

export async function updateKeyAction(input: unknown): Promise<ActionResult> {
  const parsed = keyUpdateSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { id, ...rest } = parsed.data;
  return withUser("updateKey", async (s) => {
    const key = await db.apiKey.findFirst({ where: { id, userId: s.user.id, isPlayground: false } });
    if (!key) return fail("Key not found");
    if (key.status === "REVOKED") return fail("Revoked keys can't be edited");
    const r = await resolveKeyFields(rest as KeyFormValues, s.user, key.groupId);
    if (!r.ok) return fail(r.error, r.field ? { [r.field]: r.error } : undefined);
    await db.apiKey.update({ where: { id }, data: dataFor(rest as KeyFormValues, r.groupId) });
    await invalidateGatewayConfig("apiKeys", id);
    await audit(s.user.id, "apikey.update", { type: "ApiKey", id }, { name: rest.name }, getClientIp(await headers()));
    revalidatePath("/dashboard/keys");
    return { ok: true, message: "Key updated" };
  });
}

export async function setKeyEnabledAction(input: unknown): Promise<ActionResult> {
  const parsed = keyIdSchema.extend({ enabled: z.boolean() }).safeParse(input);
  if (!parsed.success) return fail("Invalid request");
  return withUser("setKeyEnabled", async (s) => {
    const key = await db.apiKey.findFirst({ where: { id: parsed.data.id, userId: s.user.id, isPlayground: false } });
    if (!key) return fail("Key not found");
    if (key.status === "REVOKED") return fail("Revoked keys can't be re-enabled. Create a new key instead.");
    await db.apiKey.update({ where: { id: key.id }, data: { status: parsed.data.enabled ? "ACTIVE" : "DISABLED" } });
    await invalidateGatewayConfig("apiKeys", key.id);
    await audit(s.user.id, parsed.data.enabled ? "apikey.enable" : "apikey.disable", { type: "ApiKey", id: key.id }, {}, getClientIp(await headers()));
    revalidatePath("/dashboard/keys");
    return { ok: true, message: parsed.data.enabled ? "Key enabled" : "Key disabled" };
  });
}

export async function revokeKeyAction(input: unknown): Promise<ActionResult> {
  const parsed = keyIdSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid request");
  return withUser("revokeKey", async (s) => {
    const key = await db.apiKey.findFirst({ where: { id: parsed.data.id, userId: s.user.id, isPlayground: false } });
    if (!key) return fail("Key not found");
    await db.apiKey.update({ where: { id: key.id }, data: { status: "REVOKED" } });
    await invalidateGatewayConfig("apiKeys", key.id);
    await audit(s.user.id, "apikey.revoke", { type: "ApiKey", id: key.id }, { name: key.name }, getClientIp(await headers()));
    revalidatePath("/dashboard/keys");
    return { ok: true, message: "Key revoked. Requests using it will now fail." };
  });
}
