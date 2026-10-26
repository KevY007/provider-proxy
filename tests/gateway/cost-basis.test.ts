/**
 * A pool priced as a percentage of our UPSTREAM cost: the customer pays the serving route's cost x the pool percentage
 * (capped at the official list price), not the model price.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk } from "./harness";
import { db } from "@/lib/db";
import { invalidateGatewayConfig } from "@/gateway/cache";

const h = createHarness("cbp");

describe.skipIf(!dbOk)("cost-basis pool", () => {
  let key = "";
  let slug = "";
  beforeAll(async () => {
    await h.start();
    const p = await h.makeProvider("p", { formats: ["openai_chat"], keys: [{ s: "k1" }] });
    // model price 3 / 15, official 4 / 20, route cost 1.5 / 7.5
    slug = (await h.makeModel("m", { caps: ["chat"], providerId: p.id, official: { officialInputPrice: "4", officialOutputPrice: "20" } })).slug;
    await db.group.update({ where: { id: h.groupId }, data: { priceBasis: "cost", priceMultiplier: "1.5" } });
    await invalidateGatewayConfig("all");
    const u = await h.makeUser("u", { balance: "50" });
    key = (await h.makeKey("k", u.id)).key;
  });
  afterAll(() => h.cleanup());

  it("bills cost x 1.5 and records the official equivalent", async () => {
    const res = await h.call("/v1/chat/completions", key, { model: slug, messages: [{ role: "user", content: "hi [[usage:in=1000000,out=100000]]" }] });
    expect(res.status).toBe(200);
    const log = await h.logOf(res);
    // cost = 1M x 1.5 + 0.1M x 7.5 = 2.25 ; price = 3.375 ; official = 4 + 2 = 6
    expect(Number(log.cost)).toBeCloseTo(2.25, 6);
    expect(Number(log.price)).toBeCloseTo(3.375, 6);
    expect(Number(log.profit)).toBeCloseTo(1.125, 6);
    expect(Number(log.officialPrice)).toBeCloseTo(6, 6);
  });

  it("a pool's shown saving replaces the official figure: 50% = twice what the customer paid", async () => {
    await db.group.update({ where: { id: h.groupId }, data: { referenceSavingsPct: 50 } });
    await invalidateGatewayConfig("all");
    const res = await h.call("/v1/chat/completions", key, { model: slug, messages: [{ role: "user", content: "hi [[usage:in=1000000,out=100000]]" }] });
    const log = await h.logOf(res);
    expect(Number(log.price)).toBeCloseTo(3.375, 6);
    expect(Number(log.officialPrice)).toBeCloseTo(6.75, 6);
    await db.group.update({ where: { id: h.groupId }, data: { referenceSavingsPct: null } });
    await invalidateGatewayConfig("all");
  });

  it("x-price-multiplier is the share of the official price, never the factor on our cost", async () => {
    const res = await h.call("/v1/chat/completions", key, { model: slug, messages: [{ role: "user", content: "hi" }] });
    // input: cost 1.5 x 1.5 = 2.25 against official 4 => 0.5625 of list (the pool's own 1.5 stays internal)
    expect(Number(res.headers.get("x-price-multiplier"))).toBeCloseTo(0.5625, 4);
  });

  it("/v1/models shows the cost-based price", async () => {
    const res = await h.call("/v1/models", key);
    const m = ((await res.json()) as { data: Array<{ id: string; x_pricing: { yours: { input: number; output: number } } }> }).data.find((x) => x.id === slug)!;
    expect(m.x_pricing.yours.input).toBeCloseTo(2.25);
    expect(m.x_pricing.yours.output).toBeCloseTo(11.25);
  });
});
