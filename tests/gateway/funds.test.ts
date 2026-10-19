/**
 * Funds protection (PLAN 9c): credit reservations, output clamping, stream cutoff, video upfront charge and the
 * per-request official price. Real database + in-process mock upstream; skipped when the database is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbOk, createHarness, sseBlocks, sleep } from "./harness";
import { __resetHoldsForTests, memoryObligations } from "@/gateway/holds";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { flushMeter } from "@/gateway/meter-writer";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";

const h = createHarness("fnd");
const M: Record<string, { slug: string; id: string }> = {};
const P: Record<string, { id: string; keys: string[] }> = {};

const mockStats = async () => (await fetch(`${h.base}/__mock/stats`)).json() as Promise<{ byKey: Record<string, { total: number }> }>;
const mockLast = async (path: string) => (await fetch(`${h.base}/__mock/last?path=${encodeURIComponent(path)}`)).json() as Promise<{ body: Record<string, unknown> }>;
const upstreamCalls = async (s: string) => (await mockStats()).byKey[h.secret(s)]?.total ?? 0;
const chat = (key: string, model: string, content: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  h.call("/v1/chat/completions", key, { model, messages: [{ role: "user", content }], ...extra }, { headers });

describe.skipIf(!dbOk)("funds protection", () => {
  beforeAll(async () => {
    __resetHoldsForTests();
    await h.start();
    const base = h.base;
    P.oa = await h.makeProvider("oa", { formats: ["openai_chat", "openai_completions", "openai_responses", "openai_images"], keys: [{ s: "oa1" }] });
    P.both = await h.makeProvider("both", { formats: ["openai_chat", "anthropic_messages", "gemini"], settings: { anthropicBaseUrl: base, geminiBaseUrl: base }, keys: [{ s: "bo1" }] });
    P.anth = await h.makeProvider("anth", { formats: ["anthropic_messages"], baseUrl: base, authStyle: "X_API_KEY", settings: { anthropicBaseUrl: base }, keys: [{ s: "an1" }] });
    P.vid = await h.makeProvider("vid", { preset: "openai", formats: ["openai_videos"], keys: [{ s: "vid1" }] });

    const official = { officialInputPrice: "3", officialOutputPrice: "6", officialCachedPrice: "1.5" };
    M.gpt = await h.makeModel("gpt", { caps: ["chat", "completions", "responses"], providerId: P.oa.id, in: "1", out: "2", maxOutput: 16000, official, cost: { inputCost: "0.5", outputCost: "1" } });
    M.unk = await h.makeModel("unk", { caps: ["chat"], providerId: P.oa.id, in: "1", out: "2", maxOutput: null, cost: { inputCost: "0.5", outputCost: "1" } });
    M.nat = await h.makeModel("nat", { caps: ["chat"], providerId: P.both.id, in: "1", out: "2", maxOutput: 2000, cost: { inputCost: "0.5", outputCost: "1" } });
    M.anth = await h.makeModel("anthm", { caps: ["chat"], providerId: P.anth.id, in: "1", out: "2", maxOutput: 2000, cost: { inputCost: "0.5", outputCost: "1" } });
    M.partial = await h.makeModel("part", { caps: ["chat"], providerId: P.oa.id, in: "1", out: "2", maxOutput: 16000, official: { officialInputPrice: "3" }, cost: { inputCost: "0.5", outputCost: "1" } });
    M.noOff = await h.makeModel("nooff", { caps: ["chat"], providerId: P.oa.id, in: "1", out: "2", maxOutput: 16000, cost: { inputCost: "0.5", outputCost: "1" } });
    M.img = await h.makeModel("img", { caps: ["images"], providerId: P.oa.id, in: "0", out: "0", image: "0.04", official: { officialImagePrice: "0.05" } });
    M.vid = await h.makeModel("vid", { caps: ["video"], providerId: P.vid.id, in: "0", out: "0", perSecond: "0.1", upstream: "sora-mock" });
    await invalidateGatewayConfig("all");
  }, 60_000);

  afterAll(async () => {
    await h.cleanup();
  }, 30_000);

  // ------------------------------------------------------------------ concurrent requests vs a small balance
  it("N concurrent requests against a small balance: only the affordable ones are admitted, the rest get 402, nothing overshoots", async () => {
    const u = await h.makeUser("c1", { balance: "0.002" });
    const k = await h.makeKey("c1", u.id);
    await invalidateGatewayConfig("all");
    const before = await upstreamCalls("oa1");
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => chat(k.key, M.gpt.slug, `burst ${i} [[usage:in=10,out=100]]`, { max_tokens: 100 })));
    const ok = res.filter((r) => r.status === 200);
    const rejected = res.filter((r) => r.status === 402);
    expect(ok.length + rejected.length).toBe(20);
    expect(ok.length).toBeGreaterThanOrEqual(5);
    expect(ok.length).toBeLessThanOrEqual(10);
    expect(rejected.length).toBeGreaterThanOrEqual(10);
    for (const r of rejected) expect((await r.json()).error).toMatchObject({ code: "insufficient_balance", type: "billing_error" });
    for (const r of ok) await r.text();
    // the upstream was contacted exactly for the admitted requests
    expect((await upstreamCalls("oa1")) - before).toBe(ok.length);

    const price = new Decimal((await h.logOf(ok[0])).price.toString());
    expect(price.toString()).toBe("0.00021"); // 10 in x $1/M + 100 out x $2/M
    const bal = await h.balanceOf(u.id);
    expect(bal.equals(new Decimal("0.002").minus(price.times(ok.length)))).toBe(true);
    expect(bal.gte(0)).toBe(true);
    // every rejected request is logged as CLIENT_ERROR 402 and nothing is charged for it
    const log = await h.logOf(rejected[0]);
    expect(log).toMatchObject({ status: "CLIENT_ERROR", httpStatus: 402, errorCode: "insufficient_balance" });
    expect(log.price.toString()).toBe("0");
    expect(memoryObligations(u.id).holds.toString()).toBe("0"); // all holds settled / released
  });

  it("credit limit counts as available funds, and the balance never goes below -creditLimit", async () => {
    const u = await h.makeUser("c2", { balance: "0.0002", creditLimit: "0.0018" });
    const k = await h.makeKey("c2", u.id);
    await invalidateGatewayConfig("all");
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => chat(k.key, M.gpt.slug, `credit ${i} [[usage:in=10,out=100]]`, { max_tokens: 100 })));
    const ok = res.filter((r) => r.status === 200);
    for (const r of res) await r.text();
    expect(ok.length).toBeGreaterThanOrEqual(5);
    expect(ok.length).toBeLessThan(20);
    const bal = await h.balanceOf(u.id);
    expect(bal.gte(new Decimal("-0.0018"))).toBe(true);
    expect(bal.lt(0)).toBe(true); // it did use the credit
  });

  // ------------------------------------------------------------------ clamping
  it("clamps an omitted max_tokens to the affordable amount and records it in the log", async () => {
    const u = await h.makeUser("cl", { balance: "0.001" });
    const k = await h.makeKey("cl", u.id);
    await invalidateGatewayConfig("all");
    const res = await chat(k.key, M.gpt.slug, "clamp me");
    expect(res.status).toBe(200);
    await res.text();
    const sent = (await mockLast("/v1/chat/completions")).body;
    const cap = Number(sent.max_tokens);
    expect(cap).toBeGreaterThanOrEqual(256);
    expect(cap).toBeLessThan(500); // $0.001 / $2 per 1M, minus the prompt
    const log = await h.logOf(res);
    expect(log.internalError).toContain("funds: output clamped");
    expect(log.status).toBe("SUCCESS");
  });

  it("does not touch the request when the omitted limit is affordable in full", async () => {
    const u = await h.makeUser("cl2", { balance: "10" });
    const k = await h.makeKey("cl2", u.id);
    await invalidateGatewayConfig("all");
    const res = await chat(k.key, M.gpt.slug, "plenty of funds");
    expect(res.status).toBe(200);
    await res.text();
    const sent = (await mockLast("/v1/chat/completions")).body;
    expect(sent.max_tokens).toBeUndefined();
    expect((await h.logOf(res)).internalError).toBeNull();
  });

  it("402 when even the minimum output is not affordable, and when an EXPLICIT max_tokens does not fit (no clamp)", async () => {
    const u = await h.makeUser("cl3", { balance: "0.0003" });
    const k = await h.makeKey("cl3", u.id);
    await invalidateGatewayConfig("all");
    const before = await upstreamCalls("oa1");
    const tiny = await chat(k.key, M.gpt.slug, "too poor");
    expect(tiny.status).toBe(402);
    const explicit = await chat(k.key, M.gpt.slug, "explicit", { max_tokens: 100_000 });
    expect(explicit.status).toBe(402);
    const body = await explicit.json();
    expect(body.error.code).toBe("insufficient_balance");
    expect(body.error.message).toMatch(/max_tokens/);
    expect(await upstreamCalls("oa1")).toBe(before);
  });

  it("an explicit limit above the model's declared maximum is passed through unchanged (1:1; the hold covers the maximum)", async () => {
    const u = await h.makeUser("cl5", { balance: "10" });
    const k = await h.makeKey("cl5", u.id);
    await invalidateGatewayConfig("all");
    const res = await chat(k.key, M.gpt.slug, "too many tokens", { max_tokens: 20_000 });
    expect(res.status).toBe(200);
    await res.text();
    expect((await mockLast("/v1/chat/completions")).body.max_tokens).toBe(20_000);
    expect((await h.logOf(res)).internalError).toContain("above the catalog maximum 16000; passed through unchanged");
    const within = await chat(k.key, M.gpt.slug, "within", { max_tokens: 500 });
    await within.text();
    expect((await mockLast("/v1/chat/completions")).body.max_tokens).toBe(500);
    expect((await h.logOf(within)).internalError).toBeNull();
  });

  it("the cap of a model without maxOutput defaults to 16384 tokens (never unbounded)", async () => {
    const u = await h.makeUser("cl4", { balance: "0.01" });
    const k = await h.makeKey("cl4", u.id);
    await invalidateGatewayConfig("all");
    const res = await chat(k.key, M.unk.slug, "unknown max");
    expect(res.status).toBe(200); // 16384 x $2/M = $0.033 > $0.01 -> clamped
    await res.text();
    const cap = Number((await mockLast("/v1/chat/completions")).body.max_tokens);
    expect(cap).toBeGreaterThan(256);
    expect(cap).toBeLessThan(5000);
  });

  it("the Anthropic API requires max_tokens: an omitted one is filled in (model maximum), not rejected", async () => {
    const u = await h.makeUser("an1", { balance: "10" });
    const k = await h.makeKey("an1", u.id);
    await invalidateGatewayConfig("all");
    const res = await h.call("/v1/messages", null, { model: M.anth.slug, messages: [{ role: "user", content: "no max_tokens" }] }, { headers: { "x-api-key": k.key, "anthropic-version": "2023-06-01" } });
    expect(res.status).toBe(200);
    await res.text();
    expect((await mockLast("/v1/messages")).body.max_tokens).toBe(2000);
  });

  // ------------------------------------------------------------------ stream cutoff
  it("OpenAI stream: cut at the reserved amount - final chunk, native error event, [DONE]; what was produced is metered", async () => {
    const u = await h.makeUser("s1", { balance: "5" });
    const k = await h.makeKey("s1", u.id);
    await invalidateGatewayConfig("all");
    const res = await chat(k.key, M.gpt.slug, "runaway [[runaway:2000]]", { stream: true, max_tokens: 200 });
    expect(res.status).toBe(200);
    const blocks = sseBlocks(await res.text());
    const words = blocks.filter((b) => b.data.startsWith("{") && JSON.parse(b.data).choices?.[0]?.delta?.content?.includes("word")).length;
    expect(words).toBeGreaterThanOrEqual(245);
    expect(words).toBeLessThanOrEqual(260); // cut at 1.25 x 200 reserved tokens (per event), long before the 2000 the upstream wanted to send
    const tail = blocks.slice(-3);
    expect(JSON.parse(tail[0].data).choices[0].finish_reason).toBe("length");
    expect(JSON.parse(tail[1].data).error).toMatchObject({ code: "insufficient_balance", type: "billing_error" });
    expect(tail[2].data).toBe("[DONE]");
    const log = await h.logOf(res);
    expect(log).toMatchObject({ status: "CLIENT_ERROR", httpStatus: 402, errorCode: "insufficient_balance", stream: true });
    expect(log.outputTokens).toBeGreaterThanOrEqual(200);
    expect(Number(log.price)).toBeGreaterThan(0);
    const bal = await h.balanceOf(u.id);
    expect(bal.equals(new Decimal(5).minus(log.price.toString()))).toBe(true); // metered
  });

  it("without any client / model limit the stream is cut at the hold of the default cap", async () => {
    const u = await h.makeUser("s2", { balance: "50" });
    const k = await h.makeKey("s2", u.id);
    await invalidateGatewayConfig("all");
    const res = await chat(k.key, M.unk.slug, "runaway [[runaway:30000]]", { stream: true });
    const blocks = sseBlocks(await res.text());
    const words = blocks.filter((b) => b.data.startsWith("{") && JSON.parse(b.data).choices?.[0]?.delta?.content?.includes("word")).length;
    expect(words).toBeGreaterThan(8000);
    expect(words).toBeLessThan(25000); // 1.5 x 16384 reserved tokens ~ 5 chars per word / 4 chars per token estimate
    expect(blocks.some((b) => b.data.includes("insufficient_balance"))).toBe(true);
    expect((await h.logOf(res)).errorCode).toBe("insufficient_balance");
  });

  it("a stream that ends exactly at its cap is not cut", async () => {
    const u = await h.makeUser("s3", { balance: "5" });
    const k = await h.makeKey("s3", u.id);
    await invalidateGatewayConfig("all");
    const res = await chat(k.key, M.gpt.slug, "exactly [[words:150]]", { stream: true, max_tokens: 150 });
    const text = await res.text();
    expect(text).not.toContain("insufficient_balance");
    expect(sseBlocks(text).at(-1)?.data).toBe("[DONE]");
    expect((await h.logOf(res)).status).toBe("SUCCESS");
  });

  it("Anthropic stream: `event: error` with the billing error", async () => {
    const u = await h.makeUser("s4", { balance: "5" });
    const k = await h.makeKey("s4", u.id);
    await invalidateGatewayConfig("all");
    const res = await h.call("/v1/messages", null, { model: M.nat.slug, max_tokens: 100, stream: true, messages: [{ role: "user", content: "runaway [[runaway:1500]]" }] }, { headers: { "x-api-key": k.key, "anthropic-version": "2023-06-01" } });
    const blocks = sseBlocks(await res.text());
    const err = blocks.find((b) => b.event === "error");
    expect(err).toBeTruthy();
    expect(JSON.parse(err!.data)).toMatchObject({ type: "error", error: { type: "billing_error" } });
    expect(blocks.at(-1)?.event).toBe("error");
    expect((await h.logOf(res)).errorCode).toBe("insufficient_balance");
  });

  it("Anthropic client over an OpenAI-style upstream (translated stream) ends with the Anthropic error event", async () => {
    const u = await h.makeUser("s5", { balance: "5" });
    const k = await h.makeKey("s5", u.id);
    // the "oa" provider only speaks OpenAI chat: /v1/messages is translated
    await invalidateGatewayConfig("all");
    const res = await h.call("/v1/messages", null, { model: M.gpt.slug, max_tokens: 100, stream: true, messages: [{ role: "user", content: "runaway [[runaway:1500]]" }] }, { headers: { "x-api-key": k.key, "anthropic-version": "2023-06-01" } });
    expect(res.status).toBe(200);
    const blocks = sseBlocks(await res.text());
    expect(blocks.at(-1)?.event).toBe("error");
    expect(JSON.parse(blocks.at(-1)!.data).error.type).toBe("billing_error");
  });

  it("OpenAI client over an Anthropic-only upstream (translated stream) ends with final chunk + error + [DONE]", async () => {
    const u = await h.makeUser("s6", { balance: "5" });
    const k = await h.makeKey("s6", u.id);
    await invalidateGatewayConfig("all");
    const res = await chat(k.key, M.anth.slug, "runaway [[runaway:1500]]", { stream: true, max_tokens: 100 });
    const blocks = sseBlocks(await res.text());
    const tail = blocks.slice(-3);
    expect(JSON.parse(tail[0].data).choices[0].finish_reason).toBe("length");
    expect(JSON.parse(tail[1].data).error.code).toBe("insufficient_balance");
    expect(tail[2].data).toBe("[DONE]");
  });

  it("Gemini stream: SSE error object, and a closed JSON array without ?alt=sse", async () => {
    const u = await h.makeUser("s7", { balance: "5" });
    const k = await h.makeKey("s7", u.id);
    await invalidateGatewayConfig("all");
    const body = { contents: [{ role: "user", parts: [{ text: "runaway [[runaway:1500]]" }] }], generationConfig: { maxOutputTokens: 100 } };
    const sse = await h.call(`/v1beta/models/${M.nat.slug}:streamGenerateContent?alt=sse`, k.key, body);
    const blocks = sseBlocks(await sse.text());
    const last = JSON.parse(blocks.at(-1)!.data);
    expect(last.error).toMatchObject({ code: 402, status: "FAILED_PRECONDITION" });

    const arr = await h.call(`/v1beta/models/${M.nat.slug}:streamGenerateContent`, k.key, body);
    const parsed = JSON.parse(await arr.text()) as Array<Record<string, unknown>>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.at(-1)).toHaveProperty("error");
  });

  it("Responses stream: typed `error` event", async () => {
    const u = await h.makeUser("s8", { balance: "5" });
    const k = await h.makeKey("s8", u.id);
    await invalidateGatewayConfig("all");
    const res = await h.call("/v1/responses", k.key, { model: M.gpt.slug, stream: true, max_output_tokens: 100, input: "runaway [[runaway:1500]]" });
    const blocks = sseBlocks(await res.text());
    const err = blocks.find((b) => b.event === "error");
    expect(err).toBeTruthy();
    expect(JSON.parse(err!.data)).toMatchObject({ type: "error", code: "insufficient_balance" });
  });

  // ------------------------------------------------------------------ spend limits
  it("the key spend limit and the monthly spend limit are enforced against the hold, not only after the fact", async () => {
    const u = await h.makeUser("lim", { balance: "10", monthlySpendLimit: "0.5" });
    const k = await h.makeKey("lim", u.id, { spendLimit: "0.001" });
    const k2 = await h.makeKey("lim2", u.id);
    await invalidateGatewayConfig("all");
    // key limit $0.001: 100 output tokens fit ($0.0002), 1000 do not ($0.002)
    const fits = await chat(k.key, M.gpt.slug, "fits", { max_tokens: 100 });
    expect(fits.status).toBe(200);
    await fits.text();
    const over = await chat(k.key, M.gpt.slug, "over", { max_tokens: 1000 });
    expect(over.status).toBe(402);
    expect((await over.json()).error.code).toBe("spend_limit_reached");
    const big = await chat(k2.key, M.gpt.slug, "big", { max_tokens: 16000 }); // $0.032 << $0.5 monthly
    expect(big.status).toBe(200);
    await big.text();

    const m = await h.makeUser("lim3", { balance: "10", monthlySpendLimit: "0.0005" });
    const km = await h.makeKey("lim3", m.id);
    await invalidateGatewayConfig("all");
    const monthlyOver = await chat(km.key, M.gpt.slug, "over the month", { max_tokens: 1000 }); // $0.002 > $0.0005
    expect(monthlyOver.status).toBe(402);
    const body = await monthlyOver.json();
    expect(body.error.code).toBe("spend_limit_reached");
    expect(body.error.message).toMatch(/monthly/);
    const monthlyFits = await chat(km.key, M.gpt.slug, "within the month", { max_tokens: 100 });
    expect(monthlyFits.status).toBe(200);
    await monthlyFits.text();
  });

  // ------------------------------------------------------------------ video
  it("video: the upfront charge is held, rejected without contacting the upstream when unaffordable", async () => {
    const poor = await h.makeUser("v1", { balance: "0.25" });
    const kp = await h.makeKey("v1", poor.id);
    const rich = await h.makeUser("v2", { balance: "1" });
    const kr = await h.makeKey("v2", rich.id);
    await invalidateGatewayConfig("all");
    const before = await upstreamCalls("vid1");
    const no = await h.call("/v1/videos", kp.key, { model: M.vid.slug, prompt: "a calm lake", seconds: "4" });
    expect(no.status).toBe(402); // 4 s x $0.1 = $0.40 > $0.25
    expect(await upstreamCalls("vid1")).toBe(before);

    const res = await Promise.all(Array.from({ length: 3 }, (_, i) => h.call("/v1/videos", kr.key, { model: M.vid.slug, prompt: `lake ${i}`, seconds: "4" })));
    const ok = res.filter((r) => r.status === 200);
    expect(ok.length).toBe(2); // $0.40 each out of $1.00
    expect(res.filter((r) => r.status === 402).length).toBe(1);
    await sleep(50);
    expect((await h.balanceOf(rich.id)).toString()).toBe("0.2");
    expect((await upstreamCalls("vid1")) - before).toBe(2);
  });

  // ------------------------------------------------------------------ official price per request
  it("writes officialPrice with the same usage at official prices (savings are exact)", async () => {
    const u = await h.makeUser("o1", { balance: "10" });
    const k = await h.makeKey("o1", u.id);
    await invalidateGatewayConfig("all");
    const res = await chat(k.key, M.gpt.slug, "savings [[usage:in=1000,out=500]]", { max_tokens: 600 });
    await res.text();
    const log = await h.logOf(res);
    expect(log.price.toString()).toBe("0.002"); // 1000 x $1/M + 500 x $2/M
    expect(log.officialPrice.toString()).toBe("0.006"); // 1000 x $3/M + 500 x $6/M
  });

  it("official prices are not multiplied by the customer / group multiplier", async () => {
    const u = await h.makeUser("o2", { balance: "10", priceMultiplier: "0.5" });
    const k = await h.makeKey("o2", u.id);
    await invalidateGatewayConfig("all");
    const res = await chat(k.key, M.gpt.slug, "mult [[usage:in=1000,out=500]]", { max_tokens: 600 });
    await res.text();
    const log = await h.logOf(res);
    expect(log.price.toString()).toBe("0.001");
    expect(log.officialPrice.toString()).toBe("0.006");
  });

  it("a unit without an official price counts as the customer price (savings 0 for it)", async () => {
    const u = await h.makeUser("o3", { balance: "10", priceMultiplier: "0.5" });
    const k = await h.makeKey("o3", u.id);
    await invalidateGatewayConfig("all");
    const res = await chat(k.key, M.partial.slug, "partial [[usage:in=1000,out=500]]", { max_tokens: 600 });
    await res.text();
    const log = await h.logOf(res);
    // input: official $3/M -> 0.003 ; output: no official price -> what the customer pays: 500 x $2/M x 0.5 = 0.0005
    expect(log.price.toString()).toBe("0.001");
    expect(log.officialPrice.toString()).toBe("0.0035");
  });

  it("a model with no official prices at all has officialPrice == price", async () => {
    const u = await h.makeUser("o4", { balance: "10", priceMultiplier: "0.8" });
    const k = await h.makeKey("o4", u.id);
    await invalidateGatewayConfig("all");
    const res = await chat(k.key, M.noOff.slug, "none [[usage:in=1000,out=500]]", { max_tokens: 600 });
    await res.text();
    const log = await h.logOf(res);
    expect(log.officialPrice.toString()).toBe(log.price.toString());
    expect(Number(log.price)).toBeGreaterThan(0);
  });

  it("flat per-image official price", async () => {
    const u = await h.makeUser("o5", { balance: "10" });
    const k = await h.makeKey("o5", u.id);
    await invalidateGatewayConfig("all");
    const res = await h.call("/v1/images/generations", k.key, { model: M.img.slug, prompt: "a cat", n: 2 });
    expect(res.status).toBe(200);
    await res.text();
    const log = await h.logOf(res);
    expect(log.price.toString()).toBe("0.08");
    expect(log.officialPrice.toString()).toBe("0.1");
  });

  it("failed requests have officialPrice 0", async () => {
    const u = await h.makeUser("o6", { balance: "10" });
    const k = await h.makeKey("o6", u.id);
    await invalidateGatewayConfig("all");
    const res = await chat(k.key, "no-such-model-" + h.sfx, "x");
    expect(res.status).toBe(404);
    expect((await h.logOf(res)).officialPrice.toString()).toBe("0");
  });

  it("holds are gone once everything is flushed", async () => {
    await flushMeter();
    const rows = await db.user.count({ where: { id: { in: h.ids.users } } });
    expect(rows).toBeGreaterThan(5);
    for (const id of h.ids.users) expect(memoryObligations(id).holds.toString()).toBe("0");
  });
});
