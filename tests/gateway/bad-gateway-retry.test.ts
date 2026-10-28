/**
 * A relay's transient 502 / 503 / 504: retried every badGatewayRetryEverySec for up to badGatewayRetrySec before the
 * client sees an error (nothing has been sent to the client yet, so the wait is invisible).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk } from "./harness";
import { invalidateGatewayConfig } from "@/gateway/cache";

const h = createHarness("bgw");

describe.skipIf(!dbOk)("502 retry window", () => {
  let key = "";
  let recovers = "";
  let dead = "";
  let cf522 = "";
  beforeAll(async () => {
    await h.start();
    // one key that answers 502 five times (more than the normal attempts), then recovers; one that never recovers
    const a = await h.makeProvider("a", { formats: ["openai_chat"], settings: { noCooldown: true, badGatewayRetrySec: 15, badGatewayRetryEverySec: 1 }, keys: [{ s: "flaky502x5" }] });
    recovers = (await h.makeModel("rec", { caps: ["chat"], providerId: a.id })).slug;
    const b = await h.makeProvider("b", { formats: ["openai_chat"], settings: { noCooldown: true, badGatewayRetrySec: 15, badGatewayRetryEverySec: 1 }, keys: [{ s: "flaky502x99" }] });
    dead = (await h.makeModel("dead", { caps: ["chat"], providerId: b.id })).slug;
    const c = await h.makeProvider("c", { formats: ["openai_chat"], settings: { noCooldown: true, badGatewayRetrySec: 15, badGatewayRetryEverySec: 1 }, keys: [{ s: "flaky522x4" }] });
    cf522 = (await h.makeModel("cf", { caps: ["chat"], providerId: c.id })).slug;
    await invalidateGatewayConfig("all");
    const u = await h.makeUser("u", { balance: "50" });
    key = (await h.makeKey("k", u.id)).key;
  });
  afterAll(() => h.cleanup());

  it("a 502 that clears within the window is retried and the client gets the answer", async () => {
    const t0 = Date.now();
    const res = await h.call("/v1/chat/completions", key, { model: recovers, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500); // waited between the retries
  }, 40_000);

  it("a Cloudflare 522 (relay unreachable) is retried the same way", async () => {
    const res = await h.call("/v1/chat/completions", key, { model: cf522, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
  }, 40_000);

  it("a 502 that does not clear gives up once the window is over", async () => {
    const t0 = Date.now();
    const res = await h.call("/v1/chat/completions", key, { model: dead, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(502);
    expect(Date.now() - t0).toBeLessThan(25_000);
  }, 40_000);
});

describe.skipIf(!dbOk)("502 retry window with two keys", () => {
  const h2 = createHarness("bgw2");
  let key = "";
  let slug = "";
  beforeAll(async () => {
    await h2.start();
    // both keys of the provider keep failing for a while: the rounds alternate between them until one recovers
    const p = await h2.makeProvider("p", { formats: ["openai_chat"], settings: { noCooldown: true, badGatewayRetrySec: 20, badGatewayRetryEverySec: 1 }, keys: [{ s: "flaky502x4a" }, { s: "flaky502x4b" }] });
    slug = (await h2.makeModel("m", { caps: ["chat"], providerId: p.id })).slug;
    await invalidateGatewayConfig("all");
    const u = await h2.makeUser("u", { balance: "50" });
    key = (await h2.makeKey("k", u.id)).key;
  });
  afterAll(() => h2.cleanup());

  it("takes turns between the keys and succeeds once one recovers", async () => {
    const res = await h2.call("/v1/chat/completions", key, { model: slug, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const log = await h2.logOf(res);
    const keysTried = new Set((log.attempts as Array<{ providerKeyId: string }>).map((a) => a.providerKeyId));
    expect(keysTried.size).toBe(2);
  }, 40_000);
});
