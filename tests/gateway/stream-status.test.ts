/**
 * Live report bug 3: streams that completed normally were logged CANCELLED / 499 `client_closed` when the client closed
 * the connection right after the terminal event (the official `openai` SDK stops reading at `[DONE]` and aborts at once).
 * Reproduced over real sockets (http-adapter) with the SDK's reading pattern; only a close BEFORE the upstream completed
 * may be CANCELLED.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk, sleep } from "./harness";
import { startGatewayServer, type GatewayServer } from "./http-adapter";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { flushMeter } from "@/gateway/meter-writer";
import { db } from "@/lib/db";

const h = createHarness("stc");
let gw: GatewayServer;
const slug: Record<string, string> = {};
let user = { userId: "", key: "" };

/**
 * Read an SSE response exactly like the OpenAI SDK: stop at `data: [DONE]`, then abort the request. The mock keeps its side
 * of the connection open for a moment after the last frame (`x-mock-linger-ms`), like a real provider that closes a little
 * after it sent the terminal event - that is the window in which the race happened.
 */
async function sdkStyleStream(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ id: string; text: string }> {
  const ac = new AbortController();
  const res = await fetch(`${gw.url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${user.key}`, "x-mock-linger-ms": "250", ...headers }, body: JSON.stringify({ ...body, stream: true }), signal: ac.signal });
  expect(res.status).toBe(200);
  const id = res.headers.get("x-request-id")!;
  h.ids.logs.push(id);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value);
    if (text.includes("data: [DONE]")) break; // <- the SDK stops here ...
  }
  ac.abort(); // ... and closes the connection right away
  await reader.cancel().catch(() => undefined);
  return { id, text };
}

async function statusOf(id: string): Promise<{ status: string; httpStatus: number; outputTokens: number }> {
  for (let i = 0; i < 100; i++) {
    await flushMeter();
    const row = await db.requestLog.findUnique({ where: { id } });
    if (row) return { status: row.status, httpStatus: row.httpStatus, outputTokens: row.outputTokens };
    await sleep(25);
  }
  throw new Error(`no RequestLog for ${id}`);
}

describe.skipIf(!dbOk)("stream status when the client leaves right after the end", () => {
  beforeAll(async () => {
    await h.start();
    gw = await startGatewayServer();
    const u = await h.makeUser("u", { balance: "100" });
    user = { userId: u.id, key: (await h.makeKey("u", u.id)).key };
    const oa = await h.makeProvider("oa", { formats: ["openai_chat", "openai_responses"], keys: [{ s: "oa1" }] });
    const an = await h.makeProvider("an", { formats: ["anthropic_messages"], authStyle: "X_API_KEY", baseUrl: h.base, keys: [{ s: "an1" }] });
    slug.oa = (await h.makeModel("oa", { caps: ["chat", "responses"], providerId: oa.id, maxOutput: 4096 })).slug;
    slug.an = (await h.makeModel("an", { caps: ["chat"], providerId: an.id, upstream: "claude-sonnet-5-5", maxOutput: 4096 })).slug;
    await invalidateGatewayConfig("all");
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
    await h.cleanup();
  }, 60_000);

  it("20 OpenAI chat streams read the SDK way (stop at [DONE], abort): 20 of 20 are SUCCESS 200 with usage", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const { id, text } = await sdkStyleStream("/v1/chat/completions", { model: slug.oa, max_tokens: 12, stream_options: { include_usage: true }, messages: [{ role: "user", content: `say hi ${i}` }] });
      expect(text).toContain("[DONE]");
      ids.push(id);
    }
    const rows = await Promise.all(ids.map(statusOf));
    expect(rows.map((r) => r.status)).toEqual(Array(20).fill("SUCCESS"));
    expect(rows.every((r) => r.httpStatus === 200 && r.outputTokens > 0)).toBe(true);
  }, 60_000);

  it("... also when the client did not ask for usage, and with a small delay between chunks", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { id } = await sdkStyleStream("/v1/chat/completions", { model: slug.oa, messages: [{ role: "user", content: `hello there ${i} [[delay:${i % 4}]]` }] });
      ids.push(id);
    }
    const rows = await Promise.all(ids.map(statusOf));
    expect(rows.map((r) => r.status)).toEqual(Array(10).fill("SUCCESS"));
  }, 60_000);

  it("translated chat -> Claude tool-call rounds (4 rounds): SUCCESS, not CANCELLED", async () => {
    const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { id, text } = await sdkStyleStream("/v1/chat/completions", { model: slug.an, max_tokens: 200, tools, stream_options: { include_usage: true }, messages: [{ role: "user", content: `weather in Paris ${i}?` }] });
      expect(text).toContain('"finish_reason":"tool_calls"');
      ids.push(id);
    }
    const rows = await Promise.all(ids.map(statusOf));
    expect(rows.map((r) => r.status)).toEqual(Array(4).fill("SUCCESS"));
  }, 60_000);

  it("Responses streams (terminal event response.completed) read the SDK way are SUCCESS too", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const ac = new AbortController();
      const res = await fetch(`${gw.url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${user.key}`, "x-mock-linger-ms": "250" }, body: JSON.stringify({ model: slug.oa, input: `hi ${i}`, stream: true }), signal: ac.signal });
      ids.push(res.headers.get("x-request-id")!);
      h.ids.logs.push(res.headers.get("x-request-id")!);
      const reader = res.body!.getReader();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        if (text.includes('"type":"response.completed"')) break;
      }
      ac.abort();
      await reader.cancel().catch(() => undefined);
    }
    const rows = await Promise.all(ids.map(statusOf));
    expect(rows.map((r) => r.status)).toEqual(Array(6).fill("SUCCESS"));
  }, 60_000);

  it("a client that leaves BEFORE the upstream completed is still CANCELLED (499) with the partial usage", async () => {
    const ac = new AbortController();
    const res = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${user.key}` },
      body: JSON.stringify({ model: slug.oa, stream: true, messages: [{ role: "user", content: "a long answer [[words:400]] [[delay:25]]" }] }),
      signal: ac.signal,
    });
    const id = res.headers.get("x-request-id")!;
    h.ids.logs.push(id);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    ac.abort();
    await reader.cancel().catch(() => undefined);
    const row = await statusOf(id);
    expect(row.status).toBe("CANCELLED");
    expect(row.httpStatus).toBe(499);
  }, 30_000);
});
