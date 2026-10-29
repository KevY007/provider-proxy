/**
 * A key paused because its upstream account ran out of credit, paused by ANOTHER instance (or before a restart): this
 * instance only has the stored state, and must still answer "out of capacity / funding", not a generic "unavailable".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk } from "./harness";
import { db } from "@/lib/db";
import { invalidateGatewayConfig } from "@/gateway/cache";

const h = createHarness("pkf");

describe.skipIf(!dbOk)("key paused for funding elsewhere", () => {
  let key = "";
  let slug = "";
  beforeAll(async () => {
    await h.start();
    const p = await h.makeProvider("p", { formats: ["openai_chat"], keys: [{ s: "k1" }] });
    slug = (await h.makeModel("m", { caps: ["chat"], providerId: p.id })).slug;
    // stored state only: no request on this instance ever saw the 402
    await db.providerKey.update({ where: { id: p.keys[0] }, data: { status: "COOLDOWN", cooldownUntil: new Date(Date.now() + 10 * 60_000), lastError: "402: Insufficient account balance" } });
    await invalidateGatewayConfig("all");
    const u = await h.makeUser("u", { balance: "10" });
    key = (await h.makeKey("k", u.id)).key;
  });
  afterAll(() => h.cleanup());

  it("answers upstream_insufficient_balance with the funding message", async () => {
    const res = await h.call("/v1/chat/completions", key, { model: slug, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("upstream_insufficient_balance");
    expect(body.error.message).toBe("The upstream model is out of capacity / funding. Please retry later.");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
