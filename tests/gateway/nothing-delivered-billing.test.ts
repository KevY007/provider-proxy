/**
 * A stream that ends (client cancel, upstream break) before the client received anything, with no usage reported by the
 * upstream, is not billed on an estimate: the upstream does not bill it either (reconciled against a relay's own usage report).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk } from "./harness";
import { getSettings, setSettings } from "@/lib/settings";
import { invalidateGatewayConfig } from "@/gateway/cache";

const h = createHarness("ndb");

describe.skipIf(!dbOk)("billing when nothing was delivered", () => {
  let key = "";
  let slug = "";
  let unbilledSlug = "";
  let openaiSlug = "";
  let respSlug = "";
  const before = { hold: 0, beat: 0 };

  beforeAll(async () => {
    await h.start();
    const s = await getSettings();
    before.hold = s.streamStartHoldSec;
    before.beat = s.streamHeartbeatSec;
    await setSettings({ streamStartHoldSec: 1, streamHeartbeatSec: 1 }); // commit the response after ~1 s of silence
    const p = await h.makeProvider("p", { formats: ["openai_chat"], keys: [{ s: "k1" }] });
    slug = (await h.makeModel("m", { caps: ["chat"], providerId: p.id })).slug;
    const relay = await h.makeProvider("relay", { formats: ["openai_chat"], settings: { unbilledStreamErrors: true, noCooldown: true }, keys: [{ s: "r1" }] });
    unbilledSlug = (await h.makeModel("u", { caps: ["chat"], providerId: relay.id })).slug;
    const oa = await h.makeProvider("oa", { formats: ["openai_chat"], preset: "openai", keys: [{ s: "o1" }] });
    openaiSlug = (await h.makeModel("o", { caps: ["chat"], providerId: oa.id })).slug;
    const rp = await h.makeProvider("rp", { formats: ["openai_responses"], settings: { badGatewayRetrySec: 0 }, keys: [{ s: "rp1" }] });
    respSlug = (await h.makeModel("r", { caps: ["chat", "responses"], providerId: rp.id })).slug;
    const u = await h.makeUser("u", { balance: "50" });
    key = (await h.makeKey("k", u.id)).key;
  });
  afterAll(async () => {
    await setSettings({ streamStartHoldSec: before.hold, streamHeartbeatSec: before.beat });
    await h.cleanup();
  });

  it("client cancels after the response was committed but before any output: price and cost 0", async () => {
    const ac = new AbortController();
    const res = await h.call(
      "/v1/chat/completions",
      key,
      { model: slug, stream: true, messages: [{ role: "user", content: "a long prompt ".repeat(200) }] },
      { headers: { "x-mock-delay-ms": "4000", "x-mock-mode": "early-headers" }, signal: ac.signal },
    );
    expect(res.status).toBe(200); // committed by the hold timeout, nothing sent yet but keep-alives
    const reader = res.body!.getReader();
    await reader.read(); // a heartbeat / comment at most
    ac.abort();
    await reader.cancel().catch(() => undefined);
    const log = await h.logOf(res);
    expect(log.status).toBe("CANCELLED");
    expect(log.outputTokens).toBe(0);
    expect(log.inputTokens).toBe(0);
    expect(Number(log.price)).toBe(0);
    expect(Number(log.cost)).toBe(0);
  }, 30_000);

  it("output that reached the client is still billed", async () => {
    const ac = new AbortController();
    const res = await h.call("/v1/chat/completions", key, { model: slug, stream: true, messages: [{ role: "user", content: "write [[words:400]]" }] }, { headers: { "x-mock-delay-ms": "5" }, signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    while (!/"content":"[^"]+"/.test(text)) {
      const r = await reader.read();
      if (r.done) break;
      text += dec.decode(r.value, { stream: true });
    }
    ac.abort();
    await reader.cancel().catch(() => undefined);
    const log = await h.logOf(res);
    expect(log.status).toBe("CANCELLED");
    expect(log.outputTokens).toBeGreaterThan(0);
    expect(Number(log.price)).toBeGreaterThan(0);
  });
  /** A chat stream the upstream ends with its own error event after some output reached the client. */
  const errorAfterOutput = async (model: string) => {
    const res = await h.call("/v1/chat/completions", key, { model, stream: true, messages: [{ role: "user", content: "write [[words:200]]" }] }, { headers: { "x-mock-mode": "error-after:8" } });
    const text = await res.text();
    expect(text).toMatch(/"content":"[^"]+"/); // output reached the client before the error
    return h.logOf(res);
  };
  /** A Responses stream the upstream breaks (`mode`) while only the reasoning summary had streamed; returns what the client read. */
  const brokenResponses = async (mode: string) => {
    // (slow enough that the response is committed by the start hold first, as in production, so the cut is not failed over)
    const res = await h.call("/v1/responses", key, { model: respSlug, stream: true, input: "think [[summary:200]]" }, { headers: { "x-mock-mode": `${mode},early-headers`, "x-mock-delay-ms": "20" } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    let broke = false;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        text += dec.decode(r.value, { stream: true });
      }
    } catch {
      broke = true; // the connection breaks the way the upstream's did
    }
    expect(text).toMatch(/reasoning_summary_text\.delta/);
    expect(text).not.toMatch(/output_text\.delta/); // cut before any answer text
    return { res, text, broke, log: await h.logOf(res) };
  };

  it("a stream the upstream ends with its own error event is not charged: the tokens and our cost stay on the row", async () => {
    const failed = await errorAfterOutput(slug);
    expect(failed.status).toBe("UPSTREAM_ERROR");
    expect(failed.outputTokens).toBeGreaterThan(0);
    expect(Number(failed.price)).toBe(0);
    expect(Number(failed.officialPrice)).toBe(0);
    expect(Number(failed.cost)).toBeGreaterThan(0); // the upstream may still bill what it produced: our loss, not the customer's
    expect(Number(failed.profit)).toBeCloseTo(-Number(failed.cost), 9);
    expect(failed.internalError).toMatch(/not charged/);
    expect(failed.errorMessage).toMatch(/You were not charged for this request\.$/); // what the customer reads in their log
    const relay = await errorAfterOutput(unbilledSlug); // unbilledStreamErrors: the upstream does not bill it either
    expect(relay.status).toBe("UPSTREAM_ERROR");
    expect(relay.outputTokens).toBeGreaterThan(0);
    expect(Number(relay.price)).toBe(0);
    expect(Number(relay.cost)).toBe(0);
    expect(Number(relay.profit)).toBe(0);
  }, 30_000);
  it("a Responses stream the upstream drops while only reasoning had streamed is not charged", async () => {
    const { log } = await brokenResponses("rst-after:120");
    expect(log.status).toBe("UPSTREAM_ERROR");
    expect(log.outputTokens).toBeGreaterThan(50); // ~115 summary deltas reached the client
    expect(log.inputTokens).toBeGreaterThan(0);
    expect(Number(log.price)).toBe(0);
    expect(Number(log.cost)).toBeGreaterThan(0);
    expect(log.internalError).toMatch(/not charged/);
  }, 30_000);
  it("a Responses stream the upstream closes without its final event is not charged, and the balance is untouched", async () => {
    const u = await h.makeUser("fin", { balance: "7" });
    const k = (await h.makeKey("fin", u.id)).key;
    const prev = key;
    key = k;
    try {
      const { res, log } = await brokenResponses("fin-after:120");
      expect(log.status).toBe("UPSTREAM_ERROR");
      expect(log.httpStatus).toBe(502);
      expect(log.internalError).toMatch(/connection broke after the response started/);
      expect(log.outputTokens).toBeGreaterThan(50);
      expect(Number(log.price)).toBe(0);
      expect((await h.balanceOf(u.id)).toString()).toBe("7");
      // what the customer reads back about the call
      const looked = await h.call(`/v1/requests/${res.headers.get("x-request-id")}`, k);
      expect(looked.status).toBe(200);
      const body = (await looked.json()) as { status: string; charged_usd: number; list_usd: number; usage: { output_tokens: number } };
      expect(body.status).toBe("upstream_error");
      expect(body.charged_usd).toBe(0);
      expect(body.list_usd).toBe(0);
      expect(body.usage.output_tokens).toBeGreaterThan(50);
    } finally {
      key = prev;
    }
  }, 30_000);
  it("billFailedRequests on: the input and the delivered output of a failed stream are charged", async () => {
    await setSettings({ billFailedRequests: true });
    await invalidateGatewayConfig("all");
    try {
      const billed = await errorAfterOutput(slug);
      expect(billed.status).toBe("UPSTREAM_ERROR");
      expect(billed.errorMessage).not.toMatch(/not charged/);
      expect(Number(billed.price)).toBeGreaterThan(0);
      expect(Number(billed.cost)).toBeGreaterThan(0);
      const relay = await errorAfterOutput(unbilledSlug);
      expect(Number(relay.price)).toBeGreaterThan(0);
      expect(Number(relay.cost)).toBe(0);
      expect(Number(relay.profit)).toBe(Number(relay.price));
      expect(relay.internalError).toMatch(/our cost 0/);
      const { log } = await brokenResponses("rst-after:120");
      expect(log.status).toBe("UPSTREAM_ERROR");
      expect(log.outputTokens).toBeGreaterThan(50);
      expect(Number(log.price)).toBeGreaterThan(0);
    } finally {
      await setSettings({ billFailedRequests: false });
      await invalidateGatewayConfig("all");
    }
  }, 60_000);
  it("OpenAI does not bill a cancelled stream: the customer pays the delivered output, our cost is 0", async () => {
    const cancelAfterText = async (model: string) => {
      const ac = new AbortController();
      const res = await h.call("/v1/chat/completions", key, { model, stream: true, messages: [{ role: "user", content: "write [[words:400]]" }] }, { headers: { "x-mock-delay-ms": "5" }, signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = "";
      while (!/"content":"[^"]+"/.test(text)) {
        const r = await reader.read();
        if (r.done) break;
        text += dec.decode(r.value, { stream: true });
      }
      ac.abort();
      await reader.cancel().catch(() => undefined);
      return h.logOf(res);
    };
    const oa = await cancelAfterText(openaiSlug);
    expect(oa.status).toBe("CANCELLED");
    expect(Number(oa.price)).toBeGreaterThan(0);
    expect(Number(oa.cost)).toBe(0);
    expect(Number(oa.profit)).toBe(Number(oa.price));
    const other = await cancelAfterText(slug); // a relay that may keep generating: our cost stays
    expect(Number(other.cost)).toBeGreaterThan(0);
  }, 30_000);
});