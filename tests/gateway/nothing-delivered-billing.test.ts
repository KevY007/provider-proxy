/**
 * A stream that ends (client cancel, upstream break) before the client received anything, with no usage reported by the
 * upstream, is not billed on an estimate: the upstream does not bill it either (reconciled against Codex Everywhere).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk } from "./harness";
import { getSettings, setSettings } from "@/lib/settings";

const h = createHarness("ndb");

describe.skipIf(!dbOk)("billing when nothing was delivered", () => {
  let key = "";
  let slug = "";
  const before = { hold: 0, beat: 0 };

  beforeAll(async () => {
    await h.start();
    const s = await getSettings();
    before.hold = s.streamStartHoldSec;
    before.beat = s.streamHeartbeatSec;
    await setSettings({ streamStartHoldSec: 1, streamHeartbeatSec: 1 }); // commit the response after ~1 s of silence
    const p = await h.makeProvider("p", { formats: ["openai_chat"], keys: [{ s: "k1" }] });
    slug = (await h.makeModel("m", { caps: ["chat"], providerId: p.id })).slug;
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
});
