"use server";

import { z } from "zod";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { EFFORT_MATCHES, EFFORTS } from "@/gateway/effort-route";
import { ActionFail, adminAction, optDecimal, optInt, parseInput, slugSchema, stringList } from "./action";

const groupSchema = z.object({
  name: z.string().trim().min(1, "Required").max(80),
  slug: slugSchema.transform((s) => s.toLowerCase()),
  description: z.string().max(500).nullish().transform((v) => (v?.trim() ? v.trim() : null)),
  priceMultiplier: optDecimal.default("1").refine((v) => v !== null && Number(v) > 0 && Number(v) <= 1000, "Must be greater than 0"),
  providerTags: stringList.default([]),
  allowedModels: stringList.default([]),
  isDefault: z.boolean().default(false),
  isPublic: z.boolean().default(true),
  rpmLimit: optInt(1).default(null),
  maxConcurrency: optInt(1).default(null),
  sortOrder: optInt(-100000, 100000).default(null).transform((v) => v ?? 0),
  effortRoutes: z
    .array(
      z
        .object({
          models: stringList,
          efforts: z.array(z.enum(EFFORT_MATCHES)).min(1, "Tick at least one effort").transform((a) => EFFORT_MATCHES.filter((e) => a.includes(e))),
          groupId: z.string().nullish().transform((v) => v || null),
          providerId: z.string().nullish().transform((v) => v || null),
          capEffort: z.enum(EFFORTS).nullish().transform((v) => v ?? null),
        })
        .refine((r) => r.groupId || r.providerId, "Pick a pool or a provider to send these requests to"),
    )
    .max(20)
    .default([]),
});

/** Effort rules must point at pools / providers that exist (and not back at the pool itself without a provider). */
async function checkEffortRoutes(selfId: string | null, rules: z.infer<typeof groupSchema>["effortRoutes"]): Promise<void> {
  const groupIds = [...new Set(rules.map((r) => r.groupId).filter((v): v is string => !!v))];
  const providerIds = [...new Set(rules.map((r) => r.providerId).filter((v): v is string => !!v))];
  const [groups, providers] = await Promise.all([
    groupIds.length ? db.group.count({ where: { id: { in: groupIds } } }) : 0,
    providerIds.length ? db.provider.count({ where: { id: { in: providerIds } } }) : 0,
  ]);
  if (groups !== groupIds.length || providers !== providerIds.length) throw new ActionFail("An effort rule points at a pool or provider that no longer exists.", { effortRoutes: "Pick an existing pool / provider" });
  if (rules.some((r) => r.groupId && r.groupId === selfId && !r.providerId)) throw new ActionFail("An effort rule sends requests back to this same pool.", { effortRoutes: "Pick another pool or a provider" });
}

export async function createGroup(input: unknown) {
  return adminAction<{ id: string }>({ adminOnly: true }, async ({ admin, ip }) => {
    const f = parseInput(groupSchema, input);
    await checkEffortRoutes(null, f.effortRoutes);
    const g = await db.$transaction(async (tx) => {
      if (f.isDefault) await tx.group.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      else if ((await tx.group.count({ where: { isDefault: true } })) === 0) f.isDefault = true; // always keep one default
      return tx.group.create({ data: { ...f, priceMultiplier: f.priceMultiplier! }, select: { id: true } });
    });
    if (f.isDefault) await setSetting("defaultGroupSlug", f.slug).catch(() => undefined);
    await audit(admin.id, "group.create", { type: "Group", id: g.id }, { slug: f.slug, isDefault: f.isDefault }, ip);
    await invalidateGatewayConfig("groups", g.id);
    return { data: { id: g.id }, message: `Group ${f.name} created` };
  });
}

export async function updateGroup(id: string, input: unknown) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const f = parseInput(groupSchema, input);
    await checkEffortRoutes(id, f.effortRoutes);
    const before = await db.group.findUnique({ where: { id } });
    if (!before) throw new ActionFail("Group not found");
    if (before.isDefault && !f.isDefault) {
      throw new ActionFail("There must always be exactly one default group - make another group the default instead.", { isDefault: "Set another group as default to change this" });
    }
    await db.$transaction(async (tx) => {
      if (f.isDefault && !before.isDefault) await tx.group.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
      await tx.group.update({ where: { id }, data: { ...f, priceMultiplier: f.priceMultiplier! } });
      if (before.slug !== f.slug) {
        // routes restricted to this pool keep working after a rename
        await tx.$executeRaw`UPDATE "ModelRoute" SET "groupSlugs" = array_replace("groupSlugs", ${before.slug}, ${f.slug}) WHERE ${before.slug} = ANY("groupSlugs")`;
      }
    });
    if (f.isDefault) await setSetting("defaultGroupSlug", f.slug).catch(() => undefined);
    await audit(admin.id, "group.update", { type: "Group", id }, { slug: f.slug, prevSlug: before.slug, priceMultiplier: f.priceMultiplier, isDefault: f.isDefault, effortRoutes: f.effortRoutes }, ip);
    await invalidateGatewayConfig("groups", id);
    return { message: "Group saved" };
  });
}

export async function setDefaultGroup(id: string) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const g = await db.group.findUnique({ where: { id }, select: { slug: true } });
    if (!g) throw new ActionFail("Group not found");
    await db.$transaction([
      db.group.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } }),
      db.group.update({ where: { id }, data: { isDefault: true } }),
    ]);
    await setSetting("defaultGroupSlug", g.slug).catch(() => undefined);
    await audit(admin.id, "group.set_default", { type: "Group", id }, { slug: g.slug }, ip);
    await invalidateGatewayConfig("groups", id);
    return { message: `${g.slug} is now the default group` };
  });
}

/** Delete a group. If it still has users/keys, `reassign` moves them to the default group first. */
export async function deleteGroup(id: string, reassign = false) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const g = await db.group.findUnique({ where: { id }, include: { _count: { select: { users: true, apiKeys: true } } } });
    if (!g) throw new ActionFail("Group not found");
    if (g.isDefault) throw new ActionFail("Cannot delete the default group - make another group the default first.");
    const inUse = g._count.users + g._count.apiKeys;
    if (inUse > 0 && !reassign) {
      throw new ActionFail(`${g._count.users} customers and ${g._count.apiKeys} API keys still use this group. Reassign them to the default group to delete it.`);
    }
    await db.$transaction(async (tx) => {
      if (inUse > 0) {
        const def = await tx.group.findFirst({ where: { isDefault: true }, select: { id: true } });
        if (!def) throw new ActionFail("No default group to reassign to");
        await tx.user.updateMany({ where: { groupId: id }, data: { groupId: def.id } });
        await tx.apiKey.updateMany({ where: { groupId: id }, data: { groupId: def.id } });
      }
      await tx.$executeRaw`UPDATE "ModelRoute" SET "groupSlugs" = array_remove("groupSlugs", ${g.slug}) WHERE ${g.slug} = ANY("groupSlugs")`;
      await tx.group.delete({ where: { id } });
    });
    await audit(admin.id, "group.delete", { type: "Group", id }, { slug: g.slug, reassignedUsers: g._count.users, reassignedKeys: g._count.apiKeys }, ip);
    await invalidateGatewayConfig("all");
    return { message: `Group ${g.name} deleted` };
  });
}
