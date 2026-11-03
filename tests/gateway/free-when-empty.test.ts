/**
 * Free when empty (admin switch per customer): once the balance is used up requests keep working instead of 402. The
 * balance is charged while it lasts and never goes below 0; each request still records its full price, and the part
 * the balance could not cover is `waived` (admin analytics count it as a loss).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk } from "./harness";
import { db } from "@/lib/db";
import { invalidateGatewayConfig } from "@/gateway/cache";

const h = createHarness("fwe");
// model price 3 / 15 per 1M: 1M in + 0.1M out = 3 + 1.5 = $4.50 per call
const BIG = "hi [[usage:in=1000000,out=100000]]";

describe.skipIf(!dbOk)("free when empty", () => {
  let slug = "";
  beforeAll(async () => {
    await h.start();
    const p = await h.makeProvider("p", { formats: ["openai_chat"], keys: [{ s: "k1" }] });
    slug = (await h.makeModel("m", { caps: ["chat"], providerId: p.id })).slug;
  });
  afterAll(() => h.cleanup());

  it("off (default): a used-up balance is refused with 402", async () => {
    const u = await h.makeUser("off", { balance: "0" });
    const { key } = await h.makeKey("off", u.id);
    const res = await h.call("/v1/chat/completions", key, { model: slug, messages: [{ role: "user", content: BIG }] });
    expect(res.status).toBe(402);
  });

  it("on: the balance is charged while it lasts, stops at 0, and the rest is waived", async () => {
    const u = await h.makeUser("on", { balance: "6" });
    await db.user.update({ where: { id: u.id }, data: { freeWhenEmpty: true } });
    await invalidateGatewayConfig("users", u.id);
    const { key } = await h.makeKey("on", u.id);

    // 1st call: $4.50, fully covered (balance 6 -> 1.5)
    const a = await h.call("/v1/chat/completions", key, { model: slug, messages: [{ role: "user", content: BIG }] });
    expect(a.status).toBe(200);
    const la = await h.logOf(a);
    expect(Number(la.price)).toBeCloseTo(4.5, 6);
    expect(Number(la.waived)).toBe(0);
    expect((await h.balanceOf(u.id)).toNumber()).toBeCloseTo(1.5, 6);

    // 2nd call: $4.50 with only $1.50 left - runs anyway, takes 1.50, waives 3.00, balance stops at 0
    const b = await h.call("/v1/chat/completions", key, { model: slug, messages: [{ role: "user", content: BIG }] });
    expect(b.status).toBe(200);
    const lb = await h.logOf(b);
    expect(Number(lb.price)).toBeCloseTo(4.5, 6); // the full price is still reported
    expect(Number(lb.waived)).toBeCloseTo(3, 6);
    expect((await h.balanceOf(u.id)).toNumber()).toBe(0);

    // 3rd call at $0: still served, fully waived, balance stays at 0 (never negative)
    const c = await h.call("/v1/chat/completions", key, { model: slug, messages: [{ role: "user", content: BIG }] });
    expect(c.status).toBe(200);
    const lc = await h.logOf(c);
    expect(Number(lc.waived)).toBeCloseTo(4.5, 6);
    expect((await h.balanceOf(u.id)).toNumber()).toBe(0);

    // the per-request lookup still reports the real charge
    const look = await h.call(`/v1/requests/${lc.id}`, key);
    expect(Number(((await look.json()) as { charged_usd: number }).charged_usd)).toBeCloseTo(4.5, 6);
  });

  it("on: a stream is never cut by the funds guard (no cutoff), so the upstream is called once", async () => {
    // regression: cutAtTokens 0 ("no cutoff") made the guard cut every stream at its first event (0 >= 0), so the first
    // upstream attempt was dropped before any output and retried - the upstream billed both attempts
    const u = await h.makeUser("stream", { balance: "10" });
    await db.user.update({ where: { id: u.id }, data: { freeWhenEmpty: true } });
    await invalidateGatewayConfig("users", u.id);
    const { key } = await h.makeKey("stream", u.id);
    const res = await h.call("/v1/chat/completions", key, { model: slug, stream: true, messages: [{ role: "user", content: "write [[words:300]]" }] });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("[DONE]");
    expect(text).not.toMatch(/insufficient_balance|balance was used up/);
    const log = await h.logOf(res);
    expect(log.status).toBe("SUCCESS");
    expect((log.attempts as unknown[]).length).toBe(1);
    expect(log.outputTokens).toBeGreaterThanOrEqual(300);
  });
});
