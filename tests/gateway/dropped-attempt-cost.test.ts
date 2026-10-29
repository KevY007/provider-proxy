/**
 * A stream the upstream closes before any output, retried by the gateway: an upstream that still bills such a stream
 * (billsDroppedStreams) has its reported input usage added to OUR cost. The customer pays only for the answer delivered.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk } from "./harness";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { billsDroppedStreams } from "@/gateway/providers/adapters";

const h = createHarness("dac");
const anth = { "anthropic-version": "2023-06-01" };
// 1M input, 0.1M output: route cost 1.5 / 7.5 per 1M -> 1.5 + 0.75 = 2.25; the dropped attempt reported 1M input -> 1.5
const BIG = "hi [[usage:in=1000000,out=100000]]";

describe("billsDroppedStreams default", () => {
  it("is on for the relay preset, off elsewhere, and a provider setting overrides it", () => {
    expect(billsDroppedStreams({ preset: "codex-everywhere", settings: {} })).toBe(true);
    expect(billsDroppedStreams({ preset: "anthropic", settings: {} })).toBe(false);
    expect(billsDroppedStreams({ preset: "custom", settings: { billsDroppedStreams: true } })).toBe(true);
    expect(billsDroppedStreams({ preset: "codex-everywhere", settings: { billsDroppedStreams: false } })).toBe(false);
  });
});

describe.skipIf(!dbOk)("dropped attempt cost", () => {
  let key = "";
  let billed = "";
  let free = "";
  beforeAll(async () => {
    await h.start();
    const a = await h.makeProvider("a", { formats: ["anthropic_messages"], authStyle: "X_API_KEY", baseUrl: h.base, settings: { billsDroppedStreams: true }, keys: [{ s: "dropstart-a" }] });
    billed = (await h.makeModel("billed", { caps: ["chat"], providerId: a.id })).slug;
    const b = await h.makeProvider("b", { formats: ["anthropic_messages"], authStyle: "X_API_KEY", baseUrl: h.base, keys: [{ s: "dropstart-b" }] });
    free = (await h.makeModel("free", { caps: ["chat"], providerId: b.id })).slug;
    await invalidateGatewayConfig("all");
    const u = await h.makeUser("u", { balance: "50" });
    key = (await h.makeKey("k", u.id)).key;
  });
  afterAll(() => h.cleanup());

  const call = (model: string) =>
    h.call("/v1/messages", null, { model, max_tokens: 200000, stream: true, messages: [{ role: "user", content: BIG }] }, { headers: { "x-api-key": key, ...anth } });

  it("adds the dropped attempt's input cost to our cost, not to the price", async () => {
    const res = await call(billed);
    expect(res.status).toBe(200);
    await res.text();
    const log = await h.logOf(res);
    expect((log.attempts as unknown[]).length).toBe(2);
    expect(Number(log.price)).toBeCloseTo(4.5, 6); // model price 3 / 15: only the delivered answer
    expect(Number(log.cost)).toBeCloseTo(2.25 + 1.5, 4); // delivered answer + the dropped attempt's 1M input (and its 1 start token)
    expect(Number(log.profit)).toBeCloseTo(4.5 - 3.75, 4);
    expect(log.internalError).toContain("dropped attempt");
  });

  it("an upstream that does not bill dropped streams adds nothing", async () => {
    const res = await call(free);
    expect(res.status).toBe(200);
    await res.text();
    const log = await h.logOf(res);
    expect((log.attempts as unknown[]).length).toBe(2);
    expect(Number(log.cost)).toBeCloseTo(2.25, 6);
  });
});
