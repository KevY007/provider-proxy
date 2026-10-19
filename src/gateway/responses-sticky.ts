import { getRedis, redisReady } from "@/lib/redis";

/**
 * Responses-API stickiness: `GET/DELETE /v1/responses/{id}` (and `previous_response_id`) must hit the same
 * upstream account that created the response. We remember id -> {user, provider key} in Redis (30 days) with an
 * in-memory fallback/LRU.
 */
export interface StickyRecord {
  userId: string;
  providerId: string;
  providerKeyId: string;
  routeId: string;
  modelId: string;
}

const TTL_SEC = 30 * 24 * 3600;
const MAX_MEM = 50_000;
const g = globalThis as unknown as { __ppSticky?: Map<string, StickyRecord> };
const mem = (g.__ppSticky ??= new Map());

const k = (id: string) => `resp:${id}`;

export async function rememberResponse(id: string, rec: StickyRecord): Promise<void> {
  mem.delete(id);
  mem.set(id, rec);
  if (mem.size > MAX_MEM) {
    const first = mem.keys().next().value;
    if (first !== undefined) mem.delete(first);
  }
  const r = getRedis();
  if (r && redisReady()) {
    try {
      await r.set(k(id), JSON.stringify(rec), "EX", TTL_SEC);
    } catch {
      /* memory copy is enough for this instance */
    }
  }
}

export async function lookupResponse(id: string): Promise<StickyRecord | null> {
  const hit = mem.get(id);
  if (hit) return hit;
  const r = getRedis();
  if (r && redisReady()) {
    try {
      const raw = await r.get(k(id));
      if (raw) {
        const rec = JSON.parse(raw) as StickyRecord;
        mem.set(id, rec);
        return rec;
      }
    } catch {
      /* not found */
    }
  }
  return null;
}
