import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Responses-API stickiness: `GET/DELETE /v1/responses/{id}` (and `previous_response_id`) must hit the same
 * upstream account that created the response, and only its owner may use the id. We remember
 * id -> {user, provider key, route, model} in memory (LRU) and in the database (`UpstreamObject` kind "response",
 * kept 30 days, pruned by upkeep), so the link survives the instance scaling to zero or being replaced, with or
 * without Redis.
 */
export interface StickyRecord {
  userId: string;
  providerId: string;
  providerKeyId: string;
  routeId: string;
  modelId: string;
}

const KIND = "response";
/** How long a response id stays usable through the gateway (OpenAI keeps stored responses 30 days). */
export const RESPONSE_PIN_DAYS = 30;
const MAX_MEM = 50_000;
const g = globalThis as unknown as { __ppSticky?: Map<string, StickyRecord> };
const mem = (g.__ppSticky ??= new Map());

const cutoff = (days = RESPONSE_PIN_DAYS) => new Date(Date.now() - days * 86_400_000);

/** Remember who owns a response id. The memory copy is set before anything is awaited; the database write never throws. */
export async function rememberResponse(id: string, rec: StickyRecord): Promise<void> {
  mem.delete(id);
  mem.set(id, rec);
  if (mem.size > MAX_MEM) {
    const first = mem.keys().next().value;
    if (first !== undefined) mem.delete(first);
  }
  try {
    await db.upstreamObject.upsert({
      where: { kind_upstreamId_providerId: { kind: KIND, upstreamId: id, providerId: rec.providerId } },
      create: { kind: KIND, upstreamId: id, providerId: rec.providerId, providerKeyId: rec.providerKeyId, userId: rec.userId, meta: { routeId: rec.routeId, modelId: rec.modelId } },
      update: {},
    });
  } catch (err) {
    logger.warn("response id link: database write failed (this instance still knows it)", { err });
  }
}

/** Owner and account of a response id, or null when unknown, older than 30 days, or the database is unreachable. */
export async function lookupResponse(id: string): Promise<StickyRecord | null> {
  const hit = mem.get(id);
  if (hit) return hit;
  try {
    const row = await db.upstreamObject.findFirst({ where: { kind: KIND, upstreamId: id, createdAt: { gte: cutoff() } }, orderBy: { createdAt: "desc" } });
    const meta = row?.meta as { routeId?: unknown; modelId?: unknown } | null | undefined;
    if (!row || typeof meta?.routeId !== "string" || typeof meta.modelId !== "string") return null;
    const rec: StickyRecord = { userId: row.userId, providerId: row.providerId, providerKeyId: row.providerKeyId, routeId: meta.routeId, modelId: meta.modelId };
    mem.set(id, rec);
    return rec;
  } catch (err) {
    logger.warn("response id link: database read failed", { err });
    return null;
  }
}

/** Upkeep: forget response ids older than 30 days. */
export async function pruneResponseLinks(days = RESPONSE_PIN_DAYS): Promise<number> {
  const r = await db.upstreamObject.deleteMany({ where: { kind: KIND, createdAt: { lt: cutoff(days) } } });
  return r.count;
}

/** Test hook: drop the in-memory copy, as after a restart. */
export function __forgetResponsesInMemoryForTests(): void {
  mem.clear();
}
