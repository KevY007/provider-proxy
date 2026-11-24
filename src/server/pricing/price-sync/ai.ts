// The AI that reads pricing pages runs through our own gateway, like any customer call: the pool and model come from
// the ordered pricing targets in settings. Each attempt is logged and its upstream cost recorded, but it is made by
// the internal customer "Pricing fetch AI" whose price multiplier is 0 - so it is billed at our own cost, never to a
// customer, and it is grouped under that customer in the logs and analytics.
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { generateApiKey } from "@/lib/crypto";
import { getSettings } from "@/lib/settings";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { pricingTargets, tryPricingTargets, type PricingTarget } from "./targets";

export const PRICING_BOT_EMAIL = "pricing-fetch@system.internal";
export const PRICING_BOT_NAME = "Pricing fetch AI";
const KEY_NAME = "Pricing fetch AI run";

/**
 * The internal customer + a throwaway API key in `poolSlug`. The key exists only for one AI call: `askPricingAi`
 * deletes it afterwards, so no standing key shows up in the key lists.
 */
export async function createPricingBotKey(poolSlug: string): Promise<{ key: string; userId: string; apiKeyId: string }> {
  const group = await db.group.findUnique({ where: { slug: poolSlug }, select: { id: true } });
  if (!group) throw new Error(`Price sync pool "${poolSlug}" does not exist (Settings > Price sync AI routes)`);
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
  requestIds?: string[]; // includes failed attempts for run cost attribution
  model: string;
}

export type AskAi = (system: string, user: string) => Promise<AiAnswer>;

/** One chat completion through the gateway (in-process: no network hop to ourselves). */
async function askTarget({ pool, model }: PricingTarget, system: string, user: string): Promise<AiAnswer> {
  const { handle } = await import("@/gateway/handle");
  const { key, userId, apiKeyId } = await createPricingBotKey(pool);
  let requestId: string | null = null;
  try {
    // Keys left behind by an interrupted call (only this internal user's run keys).
    await db.apiKey.deleteMany({ where: { userId, name: KEY_NAME, id: { not: apiKeyId }, createdAt: { lt: new Date(Date.now() - 3_600_000) } } }).catch(() => undefined);
    const res = await handle(new Request("http://price-sync.internal/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": "ProviderProxy-PriceSync/1.0" },
      body: JSON.stringify({ model, stream: false, temperature: 0, max_tokens: 16000, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    }));
    requestId = res.headers.get("x-request-id");
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const c = j.choices?.[0]?.message?.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => typeof p?.text === "string" ? p.text : "").join("") : "";
    if (!text.trim()) throw new Error("price sync AI returned no text");
    return { text, requestId, model };
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { requestId });
  } finally {
    await dropPricingBotKey(apiKeyId, userId);
  }
}

export const askPricingAi: AskAi = async (system, user) =>
  tryPricingTargets(pricingTargets(await getSettings()), (target) => askTarget(target, system, user));
