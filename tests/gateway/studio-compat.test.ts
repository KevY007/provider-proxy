/**
 * What an OpenAI Responses client (a studio app) needs from the gateway in front of a relay that misbehaves:
 * errors before any output come back as real HTTP errors in OpenAI's shape (no retries of a deterministic 400),
 * transient relay failures are retried invisibly, prompt-cache hints can be stripped, unknown efforts and unserved
 * service tiers are refused up front, and a max_output_tokens the upstream ignores is enforced.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbOk, createHarness, sseBlocks } from "./harness";
import { parseInbandError } from "@/gateway/inband-error";
import { db } from "@/lib/db";
import { ResponsesStreamPassthrough } from "@/gateway/stream-processors";
import type { SseEvent } from "@/gateway/sse";

describe("parseInbandError", () => {
  it("reads flat, nested and response.failed shapes with a real status", () => {
    expect(parseInbandError({ type: "error", code: "invalid_value", message: "Invalid value: 'ultra'.", param: "reasoning.effort" })).toMatchObject({ status: 400, code: "invalid_value", param: "reasoning.effort" });
    expect(parseInbandError({ type: "error", error: { message: "prompt_cache_breakpoint is not supported on this model", type: "invalid_request_error" }, status: 400 })).toMatchObject({ status: 400, type: "invalid_request_error" });
    expect(parseInbandError({ code: "invalid_parameter", message: "prompt_cache_breakpoint is not supported on this model" }).status).toBe(400);
    expect(parseInbandError({ type: "error", error: { type: "server_error", message: "Our servers are currently overloaded." }, status: 503 }).status).toBe(503);
    expect(parseInbandError({ error: { message: "Service Unavailable", type: "upstream_error" } }).status).toBe(503);
    expect(parseInbandError({ type: "error", code: "upstream_error", message: "Upstream request failed" }).status).toBe(502);
    expect(parseInbandError({ code: "rate_limit_exceeded", message: "slow down" }).status).toBe(429);
  });
});

describe("ResponsesStreamPassthrough", () => {
  const ev = (data: unknown, event?: string): SseEvent => ({ event, data: JSON.stringify(data), raw: `data: ${JSON.stringify(data)}`, comment: false }) as SseEvent;
  it("rewrites a nested error event into OpenAI's top-level shape", () => {
    const p = new ResponsesStreamPassthrough(null);
    const [out] = p.onEvent(ev({ type: "error", error: { message: "boom", type: "server_error", code: "server_error" }, status: 503 }, "error"));
    const body = JSON.parse(/^data: (.*)$/m.exec(out)![1]);
    expect(body).toEqual({ type: "error", code: "server_error", message: "boom", param: null });
    expect(p.error()?.status).toBe(503);
  });
  it("drops empty text deltas and echoes the client's max_output_tokens", () => {
    const p = new ResponsesStreamPassthrough(null, { maxOutputTokens: 64000 });
    expect(p.onEvent(ev({ type: "response.output_text.delta", delta: "" }))).toEqual([]);
    const [out] = p.onEvent(ev({ type: "response.created", response: { id: "r1", max_output_tokens: null } }));
    expect(JSON.parse(/^data: (.*)$/m.exec(out)![1]).response.max_output_tokens).toBe(64000);
  });
});

const h = createHarness("stc");

describe.skipIf(!dbOk)("Studio compatibility through the gateway", () => {
  const M: Record<string, string> = {};
  let key = "";
  const calls = async (s: string) => ((await (await fetch(`${h.base}/__mock/stats`)).json()) as { byKey: Record<string, { total: number }> }).byKey[h.secret(s)]?.total ?? 0;
  const lastBody = async () => ((await (await fetch(`${h.base}/__mock/last?path=${encodeURIComponent("/v1/responses")}`)).json()) as { body: Record<string, unknown> }).body;
  const responses = (model: string, extra: Record<string, unknown> = {}, text = "hi") =>
    h.call("/v1/responses", key, { model, stream: true, input: [{ role: "user", content: [{ type: "input_text", text }] }], ...extra });
  const breakpointInput = [{ role: "user", content: [{ type: "input_text", text: "hi", prompt_cache_breakpoint: { mode: "explicit" } }] }];

  beforeAll(async () => {
    await h.start();
    const mk = async (t: string, settings: Record<string, unknown>) => {
      const p = await h.makeProvider(t, { formats: ["openai_responses"], settings: { noCooldown: true, ...settings }, keys: [{ s: `${t}1` }] });
      M[t] = (await h.makeModel(t, { caps: ["responses"], providerId: p.id })).slug;
    };
    await mk("ftfail", {});
    await mk("ftfails", { stripCacheHints: true }); // "ftfail" in the key: the same relay backend, hints stripped
    await mk("ceflaky", {});
    await mk("commentdrop", {});
    await mk("commentdroplive", {}); // the same relay fault on its own credential (the fault counts requests per credential)
    await mk("tier", { serviceTiers: ["auto", "default"] });
    await mk("cap", { enforceMaxOutputTokens: true });
    await mk("relabel", { relabelStreamErrors: true });
    // one relay key serving two models, one of them over its per-model rate limit
    const relay = await h.makeProvider("relay", { formats: ["openai_responses"], settings: { noCooldown: true }, keys: [{ s: "relay1" }] });
    M.limited = (await h.makeModel("limited", { caps: ["responses"], providerId: relay.id, upstream: "up-rpm429" })).slug;
    M.other = (await h.makeModel("other", { caps: ["responses"], providerId: relay.id })).slug;
    const nocount = await h.makeProvider("nocount", { formats: ["anthropic_messages"], baseUrl: h.base, authStyle: "X_API_KEY", settings: { anthropicBaseUrl: h.base, noCooldown: true }, keys: [{ s: "nocount1" }] });
    M.claude = (await h.makeModel("claude", { caps: ["chat"], providerId: nocount.id })).slug;
    const u = await h.makeUser("u", { balance: "50" });
    key = (await h.makeKey("k", u.id)).key;
  });
  afterAll(() => h.cleanup());

  it("an error before any output is the real HTTP status in OpenAI's shape, not retried", async () => {
    const res = await h.call("/v1/responses", key, { model: M.ftfail, stream: true, input: breakpointInput, prompt_cache_options: { ttl: "30m" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ message: "prompt_cache_breakpoint is not supported on this model", type: "invalid_request_error", code: "invalid_parameter", param: "prompt_cache_breakpoint" });
    expect(await calls("ftfail1")).toBe(1);
  });

  it("stripCacheHints: breakpoints and prompt_cache_options are removed, the request succeeds", async () => {
    const res = await h.call("/v1/responses", key, { model: M.ftfails, stream: true, input: breakpointInput, prompt_cache_options: { ttl: "30m" }, prompt_cache_key: "run-1" });
    expect(res.status).toBe(200);
    const blocks = sseBlocks(await res.text());
    expect(blocks.at(-1)?.event).toBe("response.completed");
    const sent = await lastBody();
    expect(JSON.stringify(sent)).not.toContain("prompt_cache_breakpoint");
    expect(sent.prompt_cache_options).toBeUndefined();
    expect(sent.prompt_cache_key).toBe("run-1");
  });

  it("a relay failing after its opening events (empty delta, created, vendor event) is retried invisibly", async () => {
    const res = await responses(M.ceflaky);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('"type":"error"');
    expect(text).not.toContain("codex.rate_limits");
    expect(sseBlocks(text).at(-1)?.event).toBe("response.completed");
    expect(await calls("ceflaky1")).toBe(2);
    // the request's own record shows both upstream attempts, in order, and nothing about who served them
    const row = await h.logOf(res);
    const look = (await (await h.call(`/v1/requests/${row.id}`, key)).json()) as { attempts: Array<Record<string, unknown>> };
    expect(look.attempts).toHaveLength(2);
    expect(look.attempts[0].http_status).toBeGreaterThanOrEqual(500);
    expect(look.attempts[1].http_status).toBe(200);
    for (const a of look.attempts) {
      expect(Object.keys(a).sort()).toEqual(["http_status", "latency_ms"]);
      expect(typeof a.latency_ms).toBe("number");
    }
  });

  it("a relay stream that dies after the model's opening commentary (a request with tools) is retried invisibly", async () => {
    const res = await responses(M.commentdrop);
    expect(res.status).toBe(200);
    const blocks = sseBlocks(await res.text());
    expect(blocks.at(-1)?.event).toBe("response.completed");
    // nothing of the attempt that died reached the client: one stream, one commentary message, then the answer
    expect(blocks.filter((b) => b.event === "response.created")).toHaveLength(1);
    const commentary = blocks.filter((b) => b.event === "response.output_item.added" && JSON.parse(b.data).item.phase === "commentary");
    expect(commentary).toHaveLength(1);
    expect(blocks.findIndex((b) => b.event === "response.output_item.added" && JSON.parse(b.data).item.phase === "commentary")).toBeLessThan(blocks.findIndex((b) => b.event === "response.completed"));
    expect(await calls("commentdrop1")).toBe(2);
    const row = await h.logOf(res);
    expect(row.status).toBe("SUCCESS");
    expect((row.attempts as unknown[]).length).toBe(2);
  });

  it("an unknown reasoning effort is a 400 invalid_value before anything is sent upstream", async () => {
    const before = await calls("tier1");
    const res = await responses(M.tier, { reasoning: { effort: "ultra" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ type: "invalid_request_error", param: "reasoning.effort", code: "invalid_value" });
    expect(await calls("tier1")).toBe(before);
  });

  it("a service tier no provider serves is refused with a 400; auto / default pass", async () => {
    const res = await responses(M.tier, { service_tier: "ultrafast" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ type: "invalid_request_error", param: "service_tier", code: "unsupported_value" });
    expect((await responses(M.tier, { service_tier: "default" })).status).toBe(200);
  });

  it("max_output_tokens is echoed, and enforced (response.incomplete) when the upstream ignores it", async () => {
    const echo = await responses(M.tier, { max_output_tokens: 64000 });
    const done = sseBlocks(await echo.text()).find((b) => b.event === "response.completed");
    expect(JSON.parse(done!.data).response.max_output_tokens).toBe(64000);

    const res = await responses(M.cap, { max_output_tokens: 8 }, "[[runaway:400]]");
    expect(res.status).toBe(200);
    const blocks = sseBlocks(await res.text());
    const last = blocks.at(-1)!;
    expect(last.event).toBe("response.incomplete");
    expect(JSON.parse(last.data).response).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, max_output_tokens: 8 });
    const deltas = blocks.filter((b) => b.event === "response.output_text.delta").length;
    expect(deltas).toBeLessThan(40);
    const row = await h.logOf(res);
    expect(row.status).toBe("SUCCESS");
  });

  it("a per-model 429 on a noCooldown relay cools only that model; the key keeps serving others", async () => {
    const r1 = await responses(M.limited);
    expect(r1.status).toBe(429);
    expect(r1.headers.get("retry-after")).toBeTruthy();
    const r2 = await responses(M.limited);
    expect(r2.status).toBe(429); // answered from the model cooldown
    const ok = await responses(M.other);
    expect(ok.status).toBe(200);
    expect(sseBlocks(await ok.text()).at(-1)?.event).toBe("response.completed");
  });

  it("billing visibility: x-pool / x-price-multiplier headers and GET /v1/requests/{id}", async () => {
    const res = await responses(M.tier);
    expect(res.status).toBe(200);
    const pool = res.headers.get("x-pool");
    expect(pool).toBeTruthy();
    expect(Number(res.headers.get("x-price-multiplier"))).toBe(1);
    await res.text();
    const row = await h.logOf(res);
    const look = await h.call(`/v1/requests/${row.id}`, key);
    expect(look.status).toBe(200);
    const body = (await look.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ object: "request", id: row.id, pool, model: M.tier, status: "success", http_status: 200 });
    expect(body.charged_usd).toBe(Number(row.price));
    expect(body.attempts).toEqual([{ http_status: 200, latency_ms: expect.any(Number) }]);
    expect((body.usage as Record<string, number>).output_tokens).toBe(row.outputTokens);
    // another customer's request id is not visible
    const u2 = await h.makeUser("u2", { balance: "5" });
    const other = (await h.makeKey("k2", u2.id)).key;
    expect((await h.call(`/v1/requests/${row.id}`, other)).status).toBe(404);
    expect(await db.requestLog.count({ where: { id: row.id } })).toBe(1);
  });

  it("a refused request never reports a price share of 0: x-price-multiplier is the pool's, or absent", async () => {
    const u3 = await h.makeUser("u3", { balance: "5" });
    const narrow = (await h.makeKey("k3", u3.id, { allowedModels: [M.other] })).key;
    // a model this key may not use: the pool is known, nothing is priced
    const refused = await h.call("/v1/responses", narrow, { model: M.tier, stream: true, input: "hi" });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-request-id")).toBeTruthy();
    expect(refused.headers.get("x-pool")).toBeTruthy();
    expect(Number(refused.headers.get("x-price-multiplier"))).toBe(1);
    // a request the gateway refuses before it knows the model: only the request id
    const unknown = await h.call("/v1/responses", narrow, { model: "no-such-model", stream: true, input: "hi" });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("x-request-id")).toBeTruthy();
    expect(unknown.headers.get("x-price-multiplier")).toBeNull();
  });

  describe("a key with the start hold switched off (streamHoldSec 0): standard live streaming", () => {
    const firstBytes = async (res: Response) => {
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += new TextDecoder().decode(value);
      }
      return { first, all: first + rest };
    };
    // a reasoning model: eight summary deltas before the answer, 60 ms between events
    const thinking = (model: string) => ({ model, stream: true, input: [{ role: "user", content: [{ type: "input_text", text: "[[summary:8]] [[delay:60]] hi" }] }] });

    it("the opening and reasoning events arrive while the model is still thinking", async () => {
      const u = await h.makeUser("ulive", { balance: "5" });
      const live = (await h.makeKey("klive", u.id, { streamHoldSec: 0 })).key;
      const a = await h.call("/v1/responses", live, thinking(M.tier));
      expect(a.status).toBe(200);
      const got = await firstBytes(a);
      expect(got.first).toContain("response.created");
      // the answer has not started yet: this is live progress (a held response's first bytes already carry its start)
      expect(got.first).not.toContain("response.output_text.delta");
      expect(got.all).toContain("response.reasoning_summary_text.delta");
      expect(sseBlocks(got.all).at(-1)?.event).toBe("response.completed");
    });

    it("a failure while the model is still thinking reaches the client as it happens: one attempt, an error event, no charge", async () => {
      const u = await h.makeUser("ulive2", { balance: "5" });
      const live = (await h.makeKey("klive2", u.id, { streamHoldSec: 0 })).key;
      const res = await h.call("/v1/responses", live, { model: M.commentdroplive, stream: true, input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] });
      expect(res.status).toBe(200);
      const blocks = sseBlocks(await res.text());
      expect(blocks[0].event).toBe("response.created");
      expect(blocks.at(-1)?.event).toBe("error");
      expect(JSON.parse(blocks.at(-1)!.data)).toMatchObject({ type: "error", code: "upstream_error" });
      expect(blocks.some((b) => b.event === "response.completed")).toBe(false);
      expect(await calls("commentdroplive1")).toBe(1); // not retried behind the client's back
      const row = await h.logOf(res);
      expect(row.status).toBe("UPSTREAM_ERROR");
      expect(Number(row.price)).toBe(0);
    });
  });

  it("relabelStreamErrors: the upstream's mid-stream server error reaches the client as upstream_error, logged and not charged as before", async () => {
    const res = await h.call("/v1/responses", key, { model: M.relabel, stream: true, input: "[[words:10]] hi" }, { headers: { "x-mock-mode": "error-after:7" } });
    expect(res.status).toBe(200);
    const last = sseBlocks(await res.text()).at(-1)!;
    expect(last.event).toBe("error");
    expect(JSON.parse(last.data)).toMatchObject({ type: "error", code: "upstream_error", message: "The server had an error while processing your request.", sequence_number: 99 });
    const row = await h.logOf(res);
    expect(row.status).toBe("UPSTREAM_ERROR");
    expect(Number(row.price)).toBe(0);
    // a provider without the setting passes the upstream's own code on
    const plain = await h.call("/v1/responses", key, { model: M.other, stream: true, input: "[[words:10]] hi" }, { headers: { "x-mock-mode": "error-after:7" } });
    expect(JSON.parse(sseBlocks(await plain.text()).at(-1)!.data).code).toBe("server_error");
  });

  it("count_tokens on a relay that does not offer it falls back to the local estimate", async () => {
    const res = await h.call("/v1/messages/count_tokens", null, { model: M.claude, messages: [{ role: "user", content: "count me please" }] }, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
  });
});
