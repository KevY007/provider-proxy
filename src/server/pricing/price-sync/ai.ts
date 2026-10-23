// The AI that reads pricing pages runs through our own gateway, like any customer call: the pool and model come from
// the settings (priceSyncPool / priceSyncModel), the call is logged and its upstream cost recorded, but it is made by
// the internal customer "Pricing fetch AI" whose price multiplier is 0 - so it is billed at our own cost, never to a
// customer, and it is grouped under that customer in the logs and analytics.
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { generateApiKey } from "@/lib/crypto";
import { getSettings } from "@/lib/settings";
import { invalidateGatewayConfig } from "@/gateway/cache";

export const PRICING_BOT_EMAIL = "pricing-fetch@system.internal";
export const PRICING_BOT_NAME = "Pricing fetch AI";
const KEY_NAME = "Pricing fetch AI run";

/**
 * The internal customer + a throwaway API key in `poolSlug`. The key exists only for one AI call: `askPricingAi`
 * deletes it afterwards, so no standing key shows up in the key lists.
 */
export async function createPricingBotKey(poolSlug: string): Promise<{ key: string; userId: string; apiKeyId: string }> {
  const group = await db.group.findUnique({ where: { slug: poolSlug }, select: { id: true } });
  if (!group) throw new Error(`Price sync pool "${poolSlug}" does not exist (Settings > Price sync AI: pool)`);
  let user = await db.user.findUnique({ where: { email: PRICING_BOT_EMAIL }, select: { id: true, groupId: true, extraGroupIds: true } });
  if (!user) {
    user = await db.user.create({
      // no usable password (cannot log in); multiplier 0 = price 0; the credit limit only keeps the balance check happy
      data: { email: PRICING_BOT_EMAIL, name: PRICING_BOT_NAME, passwordHash: "!no-login", role: "CUSTOMER", status: "ACTIVE", emailVerifiedAt: new Date(), groupId: group.id, priceMultiplier: new Prisma.Decimal(0), creditLimit: new Prisma.Decimal(1_000_000), lowBalanceAlertAt: null },
      select: { id: true, groupId: true, extraGroupIds: true },
    });
  } else if (user.groupId !== group.id) {
    await db.user.update({ where: { id: user.id }, data: { groupId: group.id, priceMultiplier: new Prisma.Decimal(0) } });
  }
  const k = generateApiKey();
  const created = await db.apiKey.create({ data: { userId: user.id, name: KEY_NAME, prefix: k.prefix, keyHash: k.hash, groupId: group.id } });
  await invalidateGatewayConfig("users", user.id);
  return { key: k.key, userId: user.id, apiKeyId: created.id };
}

/** Delete the throwaway key once its request is metered (the log keeps the internal customer, the key link is cleared). */
async function dropPricingBotKey(apiKeyId: string, userId: string): Promise<void> {
  try {
    const { flushMeter } = await import("@/gateway/meter-writer");
    await flushMeter();
    await db.apiKey.deleteMany({ where: { id: apiKeyId } });
    await invalidateGatewayConfig("users", userId);
  } catch {
    // a leftover key is harmless (internal customer, price 0); the next call cleans up older ones
  }
}

export interface AiAnswer {
  text: string;
  requestId: string | null;
  model: string;
}

export type AskAi = (system: string, user: string) => Promise<AiAnswer>;

/** One chat completion through the gateway (in-process: no network hop to ourselves). */
export const askPricingAi: AskAi = async (system, user) => {
  const s = await getSettings();
  const { key, userId, apiKeyId } = await createPricingBotKey(s.priceSyncPool);
  // keys left behind by an interrupted call
  await db.apiKey.deleteMany({ where: { userId, name: KEY_NAME, id: { not: apiKeyId }, createdAt: { lt: new Date(Date.now() - 3_600_000) } } }).catch(() => undefined);
  const { handle } = await import("@/gateway/handle");
  const req = new Request("http://price-sync.internal/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": "ProviderProxy-PriceSync/1.0" },
    body: JSON.stringify({ model: s.priceSyncModel, stream: false, temperature: 0, max_tokens: 16000, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  let res: Response;
  let raw: string;
  try {
    res = await handle(req);
    raw = await res.text();
  } finally {
    await dropPricingBotKey(apiKeyId, userId);
  }
  const requestId = res.headers.get("x-request-id");
  if (!res.ok) throw Object.assign(new Error(`price sync AI call failed (${res.status}): ${raw.slice(0, 300)}`), { requestId });
  let text = "";
  try {
    const j = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
    const c = j.choices?.[0]?.message?.content;
    text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : "")).join("") : "";
  } catch {
    text = "";
  }
  if (!text) throw Object.assign(new Error("price sync AI returned no text"), { requestId });
  return { text, requestId, model: s.priceSyncModel };
};
