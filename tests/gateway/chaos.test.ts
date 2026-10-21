/**
 * Connection-fidelity / chaos suite (PLAN 9d.6): the gateway is a faithful 1:1 proxy.
 *   - client leaves  -> the upstream request is destroyed immediately (the mock observes it), usage is metered,
 *                       slots + credit holds are released
 *   - upstream fails -> the client gets exactly that failure: same status / headers / native error before the response
 *                       started, the verbatim error event inside a stream, a broken connection (no synthetic end) when the
 *                       upstream resets or closes early - for every API format, translated paths included
 *   - nothing is compressed, request ids are renamed, identity headers never leak, heartbeats keep silent streams alive
 * Everything runs over REAL sockets (tests/gateway/http-adapter.ts mirrors how Next serves a route handler) against the
 * mock upstream and the dev database; skipped when the database is unreachable.
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, dbOk, sleep } from "./harness";
import { startGatewayServer, type GatewayServer } from "./http-adapter";
import { __resetCacheForTests, getConfig, invalidateGatewayConfig } from "@/gateway/cache";
import { memoryObligations } from "@/gateway/holds";
import { flushMeter } from "@/gateway/meter-writer";
import { queuedCount, slotInUse } from "@/gateway/slots";
import { db } from "@/lib/db";


const h = createHarness("chz");

interface Fmt {
  id: string;
  /** model fixture */
  model: "oa" | "an" | "ge";
  path: (slug: string) => string;
  headers: (key: string) => Record<string, string>;
  body: (slug: string, prompt: string) => Record<string, unknown>;
  /** text that only appears in a COMPLETE stream (terminal event) */
  terminal: RegExp;
  /** how an in-stream error event looks to this client */
  errorEvent: RegExp;
  /** native error shape of a pre-commit failure */
  errorShape: (j: Record<string, any>) => boolean; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
const anth = (key: string) => ({ "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" });
const goog = (key: string) => ({ "x-goog-api-key": key, "content-type": "application/json" });

const FORMATS: Fmt[] = [
  {
    id: "openai chat",
    model: "oa",
    path: () => "/v1/chat/completions",
    headers: bearer,
    body: (m, p) => ({ model: m, stream: true, messages: [{ role: "user", content: p }] }),
    terminal: /\[DONE\]/,
    errorEvent: /"error"/,
    errorShape: (j) => typeof j.error?.message === "string" && "type" in j.error,
  },
  {
    id: "responses",
    model: "oa",
    path: () => "/v1/responses",
    headers: bearer,
    body: (m, p) => ({ model: m, stream: true, input: p }),
    terminal: /response\.completed/,
    errorEvent: /event: error/,
    errorShape: (j) => typeof j.error?.message === "string",
  },
  {
    id: "anthropic messages",
    model: "an",
    path: () => "/v1/messages",
    headers: anth,
    body: (m, p) => ({ model: m, stream: true, max_tokens: 200, messages: [{ role: "user", content: p }] }),
    terminal: /message_stop/,
    errorEvent: /event: error/,
    errorShape: (j) => j.type === "error" && typeof j.error?.message === "string",
  },
  {
    id: "gemini",
    model: "ge",
    path: (m) => `/v1beta/models/${m}:streamGenerateContent?alt=sse`,
    headers: goog,
    body: (_m, p) => ({ contents: [{ role: "user", parts: [{ text: p }] }] }),
    terminal: /finishReason/,
    errorEvent: /"UNAVAILABLE"/,
    errorShape: (j) => typeof j.error?.code === "number" && typeof j.error?.status === "string",
  },
  {
    id: "chat -> anthropic (translated)",
    model: "an",
    path: () => "/v1/chat/completions",
    headers: bearer,
    body: (m, p) => ({ model: m, stream: true, messages: [{ role: "user", content: p }] }),
    terminal: /\[DONE\]/,
    errorEvent: /"error"/,
    errorShape: (j) => typeof j.error?.message === "string" && "type" in j.error,
  },
  {
    id: "messages -> chat (translated)",
    model: "oa",
    path: () => "/v1/messages",
    headers: anth,
    body: (m, p) => ({ model: m, stream: true, max_tokens: 200, messages: [{ role: "user", content: p }] }),
    terminal: /message_stop/,
    errorEvent: /event: error/,
    errorShape: (j) => j.type === "error" && typeof j.error?.message === "string",
  },
];

/** Non-streaming variants of the formats (the request path the mock sees is `upstreamPath`). */
const NON_STREAM: Array<Fmt & { upstreamPath: () => string }> = [
  { ...FORMATS[0], id: "openai chat", body: (m, p) => ({ model: m, messages: [{ role: "user", content: p }] }), upstreamPath: () => "/v1/chat/completions" },
  { ...FORMATS[1], id: "responses", body: (m, p) => ({ model: m, input: p }), upstreamPath: () => "/v1/responses" },
  { ...FORMATS[2], id: "anthropic messages", body: (m, p) => ({ model: m, max_tokens: 200, messages: [{ role: "user", content: p }] }), upstreamPath: () => "/v1/messages" },
  { ...FORMATS[3], id: "gemini", path: (m) => `/v1beta/models/${m}:generateContent`, upstreamPath: () => "/v1beta/models/up-ge:generateContent" },
];

/** In-process override of settings.streamHeartbeatSec (the DB is shared with parallel test files); applied to every fresh config snapshot. */
let heartbeatOverride: number | null = null;
async function applyOverrides(): Promise<void> {
  __resetCacheForTests();
  if (heartbeatOverride !== null) {
    const st = (await getConfig()).settings;
    st.streamHeartbeatSec = heartbeatOverride;
    // these tests time the heartbeat itself: commit after one heartbeat interval instead of holding for real output
    st.streamStartHoldSec = 0;
  }
}
function setHeartbeatSeconds(sec: number | null): Promise<void> {
  heartbeatOverride = sec;
  return applyOverrides();
}

let gw: GatewayServer;
let userId = "";
let apiKey = "";
const slug: Record<string, string> = {};
const providerKeys: Record<string, string[]> = {};
const requestIds: string[] = [];

const prompt = (words = 14) => `[[words:${words}]] fidelity probe`;

/** One request over a real socket. Reads the body until the end or until the connection breaks. */
async function run(fmt: Fmt, o: { mode?: string; fail?: number; delayMs?: number; tag?: string; words?: number; stream?: boolean } = {}) {
  const headers: Record<string, string> = { ...fmt.headers(apiKey) };
  if (o.mode) headers["x-mock-mode"] = o.mode;
  if (o.fail) headers["x-mock-fail"] = String(o.fail);
  if (o.delayMs) headers["x-mock-delay-ms"] = String(o.delayMs);
  if (o.tag) headers["x-mock-tag"] = o.tag;
  const m = slug[fmt.model];
  const body = fmt.body(m, prompt(o.words));
  if (o.stream === false) delete body.stream;
  const t0 = Date.now();
  const timeline: Array<[number, string]> = [];
  const res = await fetch(`${gw.url}${fmt.path(m)}`, { method: "POST", headers, body: JSON.stringify(body) });
  const id = res.headers.get("x-request-id");
  if (id) requestIds.push(id);
  const chunks: string[] = [];
  let error: unknown = null;
  let ended = false;
  if (res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
        chunks.push(dec.decode(value));
        timeline.push([Date.now() - t0, chunks[chunks.length - 1].slice(0, 40).replace(/\n/g, "\\n")]);
      }
    } catch (e) {
      error = e;
    }
  }
  return { res, status: res.status, headers: res.headers, text: chunks.join(""), error, ended, id, timeline };
}

async function logOf(id: string | null) {
  expect(id).toBeTruthy();
  for (let i = 0; i < 200; i++) {
    await flushMeter();
    const row = await db.requestLog.findUnique({ where: { id: id! } });
    if (row) return row;
    await sleep(25);
  }
  return db.requestLog.findUniqueOrThrow({ where: { id: id! } });
}

async function mockAborts(tag: string): Promise<Array<{ phase: string; frames: number; at: number }>> {
  const j = (await (await fetch(`${h.base}/__mock/aborts?tag=${encodeURIComponent(tag)}`)).json()) as { aborts: Array<{ phase: string; frames: number; at: number }> };
  return j.aborts;
}

async function waitAbort(tag: string, timeoutMs = 2_000): Promise<{ phase: string; frames: number; at: number } | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const a = await mockAborts(tag);
    if (a.length) return a[0];
    await sleep(5);
  }
  return null;
}

async function allReleased() {
  for (const ids of Object.values(providerKeys)) for (const id of ids) expect(await slotInUse("pkey", id)).toBe(0);
  expect(await slotInUse("user", userId)).toBe(0);
  const o = memoryObligations(userId);
  expect(o.holds.isZero(), "no credit hold left open").toBe(true);
}

describe.skipIf(!dbOk)("connection fidelity (real sockets)", () => {
  beforeAll(async () => {
    await h.start();
    gw = await startGatewayServer();
    const u = await h.makeUser("main", { balance: "100" });
    userId = u.id;
    apiKey = (await h.makeKey("main", u.id, { maxConcurrency: 500 })).key;
    const oa = await h.makeProvider("oa", { formats: ["openai_chat", "openai_responses", "openai_images", "openai_files"], keys: [{ s: "oa1" }, { s: "oa2" }] });
    const an = await h.makeProvider("an", { formats: ["anthropic_messages"], authStyle: "X_API_KEY", baseUrl: h.base, keys: [{ s: "an1" }, { s: "an2" }] });
    const ge = await h.makeProvider("ge", { formats: ["gemini"], baseUrl: h.base, keys: [{ s: "ge1" }, { s: "ge2" }] });
    providerKeys.oa = oa.keys;
    providerKeys.an = an.keys;
    providerKeys.ge = ge.keys;
    slug.oa = (await h.makeModel("oa", { caps: ["chat", "responses"], providerId: oa.id, maxOutput: 4096 })).slug;
    slug.img = (await h.makeModel("img", { caps: ["images"], providerId: oa.id })).slug;
    slug.an = (await h.makeModel("an", { caps: ["chat"], providerId: an.id, maxOutput: 4096 })).slug;
    slug.ge = (await h.makeModel("ge", { caps: ["chat"], providerId: ge.id, maxOutput: 4096 })).slug;
    await invalidateGatewayConfig("all");
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
    await h.cleanup();
  }, 60_000);

  beforeEach(async () => {
    await applyOverrides(); // forget upstream-key cooldowns of the previous scenario (+ in-process setting overrides)
  });

  // ------------------------------------------------------------------ 1. pre-commit upstream HTTP errors
  describe.each(FORMATS)("$id", (fmt) => {
    it.each([429, 500, 529])("upstream %i on every key -> the client gets that status, retry-after and the native error body", async (status) => {
      const r = await run(fmt, { fail: status });
      expect(r.status).toBe(status);
      expect(r.headers.get("retry-after")).toBe("7");
      expect(r.headers.get("x-upstream-request-id")).toMatch(/^req_mock_/);
      expect(r.headers.get("openai-organization")).toBeNull();
      expect(r.headers.get("x-powered-by")).toBeNull();
      expect(r.headers.get("content-encoding")).toBeNull();
      const j = JSON.parse(r.text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(fmt.errorShape(j), r.text).toBe(true);
      expect(r.text).not.toMatch(/mock|127\.0\.0\.1|fail/i);
      const log = await logOf(r.id);
      expect(log.status).toBe("UPSTREAM_ERROR");
      expect(log.httpStatus).toBe(status);
      // 429 puts a key on cooldown at once (2 keys -> 2 attempts); 5xx are retried up to maxAttempts
      expect((log.attempts as unknown[]).length).toBe(status === 429 ? 2 : 3);
      if (status === 429) expect(r.headers.get("x-ratelimit-remaining-requests")).toBe("0");
      await allReleased();
    });

    // ------------------------------------------------------------------ 2. success path: headers, no compression
    it("a good stream passes the allow-listed upstream headers, never the identity ones, and is not compressed", async () => {
      const r = await run(fmt, { words: 6 });
      expect(r.status).toBe(200);
      expect(r.ended).toBe(true);
      expect(r.text).toMatch(fmt.terminal);
      expect(r.headers.get("content-type")).toMatch(/text\/event-stream/);
      expect(r.headers.get("cache-control")).toBe("no-cache, no-transform");
      expect(r.headers.get("x-accel-buffering")).toBe("no");
      expect(r.headers.get("content-encoding")).toBeNull();
      expect(r.headers.get("x-upstream-request-id")).toMatch(/^req_mock_/);
      expect(r.headers.get("openai-organization")).toBeNull();
      expect(r.headers.get("openai-version")).toBeNull();
      expect(r.headers.get("x-powered-by")).toBeNull();
      expect((await logOf(r.id)).status).toBe("SUCCESS");
    });

    it("a gzip-compressed upstream stream reaches the client as plain, complete events (no content-encoding)", async () => {
      const r = await run(fmt, { mode: "gzip", words: 6 });
      expect(r.status).toBe(200);
      expect(r.ended).toBe(true);
      expect(r.text).toMatch(fmt.terminal);
      expect(r.text).not.toMatch(/\u001f\u008b/);
      expect(r.headers.get("content-encoding")).toBeNull();
      expect(r.headers.get("content-length")).toBeNull();
      expect((await logOf(r.id)).status).toBe("SUCCESS");
    });

    // ------------------------------------------------------------------ 3. upstream failures inside a stream
    it("an in-stream upstream error event reaches the client verbatim and the stream ends normally", async () => {
      const r = await run(fmt, { mode: "error-after:7", words: 10 }); // after real output: the opening bookkeeping events alone would fail over instead
      expect(r.status).toBe(200);
      expect(r.error).toBeNull();
      expect(r.ended).toBe(true);
      expect(r.text).toMatch(fmt.errorEvent);
      expect(r.text).not.toMatch(fmt.terminal);
      const upstreamMessage = fmt.model === "an" ? /Overloaded/i : fmt.model === "ge" ? /overloaded/i : /server had an error/i;
      expect(r.text).toMatch(upstreamMessage);
      const log = await logOf(r.id);
      expect(log.status).toBe("UPSTREAM_ERROR");
      expect(log.internalError).toContain("in-stream error event");
      await allReleased();
    });

    it.each(["rst-after:7", "fin-after:7"])("upstream %s -> the client connection breaks (no synthetic end, no error event)", async (mode) => {
      const r = await run(fmt, { mode, words: 12 });
      expect(r.status).toBe(200);
      expect(r.error, "the client must see a network error").toBeTruthy();
      expect(r.ended).toBe(false);
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.text).not.toMatch(fmt.terminal);
      expect(r.text).not.toMatch(fmt.errorEvent);
      const log = await logOf(r.id);
      expect(log.status).toBe("UPSTREAM_ERROR");
      expect(log.internalError).toMatch(/client connection dropped/);
      expect(log.outputTokens).toBeGreaterThan(0); // what was produced is metered
      await allReleased();
    });

    it.each(["drop-headers", "drop-pre-content"])("upstream %s before anything was produced -> failover, then a native 502 error", async (mode) => {
      const r = await run(fmt, { mode });
      expect(r.status).toBe(502);
      const j = JSON.parse(r.text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(fmt.errorShape(j), r.text).toBe(true);
      const log = await logOf(r.id);
      expect(log.status).toBe("UPSTREAM_ERROR");
      expect((log.attempts as unknown[]).length).toBe(3);
      await allReleased();
    });

    // ------------------------------------------------------------------ 4. the client leaves
    it("client abort mid-stream -> the upstream request is destroyed within 100 ms, usage metered as CANCELLED, slots + hold released", async () => {
      const tag = `abort-${fmt.id}-${Math.random().toString(36).slice(2, 8)}`;
      const ac = new AbortController();
      const headers = { ...fmt.headers(apiKey), "x-mock-delay-ms": "120", "x-mock-tag": tag };
      const m = slug[fmt.model];
      const res = await fetch(`${gw.url}${fmt.path(m)}`, { method: "POST", headers, body: JSON.stringify(fmt.body(m, prompt(30))), signal: ac.signal });
      const id = res.headers.get("x-request-id");
      requestIds.push(id!);
      const reader = res.body!.getReader();
      let got = "";
      const dec = new TextDecoder();
      while ((got.match(/word/g)?.length ?? 0) < 2) {
        const { done, value } = await reader.read();
        if (done) break;
        got += dec.decode(value);
      }
      const t0 = Date.now();
      ac.abort();
      reader.cancel().catch(() => undefined);
      const seen = await waitAbort(tag);
      expect(seen, "the mock must observe the aborted upstream request").not.toBeNull();
      const latency = seen!.at - t0;
      expect(latency).toBeLessThan(100);
      expect(seen!.phase).toBe("streaming");
      const log = await logOf(id);
      expect(log.status).toBe("CANCELLED");
      expect(log.outputTokens).toBeGreaterThan(0);
      expect(Number(log.price)).toBeGreaterThan(0); // partial usage is billed
      await sleep(30);
      await allReleased();
      process.stdout.write(`ABORT ${fmt.id}: upstream saw the abort ${latency} ms after the client left\n`);
    });
  });

  // ------------------------------------------------------------------ 5. non-stream requests
  describe.each(NON_STREAM)("non-stream $id", (fmt) => {
    const go = async (o: { mode?: string; delayMs?: number; tag?: string; signal?: AbortSignal } = {}) => {
      const headers: Record<string, string> = { ...fmt.headers(apiKey) };
      if (o.mode) headers["x-mock-mode"] = o.mode;
      if (o.delayMs) headers["x-mock-delay-ms"] = String(o.delayMs);
      if (o.tag) headers["x-mock-tag"] = o.tag;
      const m = slug[fmt.model];
      const res = await fetch(`${gw.url}${fmt.path(m)}`, { method: "POST", headers, body: JSON.stringify(fmt.body(m, prompt(6))), signal: o.signal });
      if (res.headers.get("x-request-id")) requestIds.push(res.headers.get("x-request-id")!);
      return res;
    };

    it("a gzip-compressed upstream body arrives as plain JSON without content-encoding / content-length of the compressed body", async () => {
      const res = await go({ mode: "gzip" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("x-upstream-request-id")).toBeTruthy();
      const j = (await res.json()) as Record<string, unknown>;
      expect(JSON.stringify(j)).toMatch(/word/);
      const last = (await (await fetch(`${h.base}/__mock/last?path=${encodeURIComponent(fmt.upstreamPath())}`)).json()) as { headers: Record<string, string> };
      expect(last.headers["accept-encoding"]).toBe("identity");
      expect((await logOf(res.headers.get("x-request-id"))).status).toBe("SUCCESS");
    });

    it("an upstream reset in the middle of the body -> failover, then a native 502 (nothing was sent to the client yet)", async () => {
      const res = await go({ mode: "rst-after:1" });
      expect(res.status).toBe(502);
      expect(fmt.errorShape((await res.json()) as Record<string, any>)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
      await allReleased();
    });

    it("client abort while the upstream is still thinking -> the upstream request is aborted at once, CANCELLED, slots released", async () => {
      const tag = `ns-${fmt.id}-${Math.random().toString(36).slice(2, 8)}`;
      const ac = new AbortController();
      const pending = go({ delayMs: 3000, tag, signal: ac.signal }).catch(() => null);
      await sleep(250);
      const t0 = Date.now();
      ac.abort();
      const seen = await waitAbort(tag);
      await pending;
      expect(seen).not.toBeNull();
      expect(seen!.phase).toBe("waiting");
      expect(seen!.at - t0).toBeLessThan(100);
      // the request log is written by the gateway when it notices; find it by the user's newest CANCELLED row
      await sleep(50);
      await flushMeter();
      const row = await db.requestLog.findFirst({ where: { userId, status: "CANCELLED", stream: false, createdAt: { gte: new Date(t0 - 10_000) } }, orderBy: { createdAt: "desc" } });
      expect(row).not.toBeNull();
      await allReleased();
    });
  });

  // ------------------------------------------------------------------ 6. queued requests
  it("a client that leaves while its request waits for an upstream slot never reaches the upstream and frees its place in the queue", async () => {
    const fmt = FORMATS[0];
    const q = await h.makeProvider("q", { formats: ["openai_chat"], keys: [{ s: "q1", maxConcurrency: 1 }] });
    const qSlug = (await h.makeModel("q", { caps: ["chat"], providerId: q.id, maxOutput: 4096 })).slug;
    await invalidateGatewayConfig("all");
    const call = (tag: string, delayMs: number, signal?: AbortSignal) =>
      fetch(`${gw.url}/v1/chat/completions`, {
        method: "POST",
        headers: { ...fmt.headers(apiKey), "x-mock-tag": tag, "x-mock-delay-ms": String(delayMs) },
        body: JSON.stringify({ model: qSlug, stream: true, messages: [{ role: "user", content: prompt(4) }] }),
        signal,
      });
    const holderTag = `holder-${Math.random().toString(36).slice(2, 8)}`;
    const holder = await call(holderTag, 400); // occupies the single slot for ~2.4 s
    const holderId = holder.headers.get("x-request-id")!;
    requestIds.push(holderId);
    const waiterTag = `waiter-${Math.random().toString(36).slice(2, 8)}`;
    const ac = new AbortController();
    const waiter = call(waiterTag, 400, ac.signal).catch((e) => e);
    await sleep(300);
    expect(queuedCount()).toBe(1);
    ac.abort();
    await waiter;
    await sleep(120);
    expect(queuedCount()).toBe(0);
    const mockStats = (await (await fetch(`${h.base}/__mock/stats`)).json()) as { byKey: Record<string, { total: number }> };
    expect(mockStats.byKey[h.secret("q1")]?.total, "only the holder reached the upstream").toBe(1);
    expect(await mockAborts(waiterTag)).toHaveLength(0);
    await holder.text();
    expect((await logOf(holderId)).status).toBe("SUCCESS");
    await sleep(100);
    expect(await slotInUse("pkey", q.keys[0])).toBe(0);
    await flushMeter();
    const cancelled = await db.requestLog.findFirst({ where: { userId, status: "CANCELLED", modelSlug: qSlug }, orderBy: { createdAt: "desc" } });
    expect(cancelled, "the waiter is logged as CANCELLED").not.toBeNull();
    expect((cancelled!.attempts as unknown[]).length).toBe(0);
  });

  // ------------------------------------------------------------------ 7. multipart + Files uploads
  describe("uploads", () => {
    const spoolFiles = () => new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("pp-spool-")));
    const auth = () => ({ authorization: `Bearer ${apiKey}` });

    it("client leaves in the middle of a multipart upload -> the spool file is removed, the upstream is never contacted, CANCELLED", async () => {
      const boundary = `----chaos${Math.random().toString(36).slice(2, 10)}`;
      const tag = `mp-${Math.random().toString(36).slice(2, 8)}`;
      const before = spoolFiles();
      const req = http.request(`${gw.url}/v1/images/edits`, {
        method: "POST",
        headers: { ...auth(), "content-type": `multipart/form-data; boundary=${boundary}`, "x-mock-tag": tag },
      });
      req.on("error", () => undefined);
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`);
      req.write(Buffer.alloc(12 * 1024 * 1024, 7)); // more than the 8 MB in-memory spool: goes to a temp file
      let during = new Set<string>();
      for (let i = 0; i < 40 && during.size === 0; i++) {
        await sleep(50);
        during = new Set([...spoolFiles()].filter((f) => !before.has(f)));
      }
      expect(during.size, "a spool file exists while the upload is in progress").toBeGreaterThan(0);
      req.destroy();
      let left = during;
      for (let i = 0; i < 60 && left.size > 0; i++) {
        await sleep(50);
        const now = spoolFiles();
        left = new Set([...during].filter((f) => now.has(f)));
      }
      expect(left.size, "spool file cleaned up after the client left").toBe(0);
      expect(await mockAborts(tag)).toHaveLength(0);
      const stats = (await (await fetch(`${h.base}/__mock/stats`)).json()) as { byPath: Record<string, number> };
      expect(stats.byPath["/v1/images/edits"] ?? 0).toBe(0);
      await flushMeter();
      const row = await db.requestLog.findFirst({ where: { userId, endpoint: "/v1/images/edits" }, orderBy: { createdAt: "desc" } });
      expect(row?.status).toBe("CANCELLED");
      await allReleased();
    });

    it("client leaves while the upstream is still working on a (spooled) multipart request -> upstream aborted at once", async () => {
      const tag = `mpw-${Math.random().toString(36).slice(2, 8)}`;
      const fd = new FormData();
      fd.append("image", new Blob([Buffer.alloc(9 * 1024 * 1024, 3)], { type: "image/png" }), "big.png");
      fd.append("prompt", "a cat");
      fd.append("model", slug.img);
      const ac = new AbortController();
      const pending = fetch(`${gw.url}/v1/images/edits`, { method: "POST", headers: { ...auth(), "x-mock-tag": tag, "x-mock-delay-ms": "3000" }, body: fd, signal: ac.signal }).catch(() => null);
      let attempts = 0;
      while (attempts++ < 100) {
        const stats = (await (await fetch(`${h.base}/__mock/stats`)).json()) as { byPath: Record<string, number> };
        if ((stats.byPath["/v1/images/edits"] ?? 0) > 0) break;
        await sleep(30);
      }
      await sleep(100);
      const t0 = Date.now();
      ac.abort();
      const seen = await waitAbort(tag);
      await pending;
      expect(seen).not.toBeNull();
      expect(seen!.phase).toBe("waiting");
      expect(seen!.at - t0).toBeLessThan(100);
      await sleep(50);
      await allReleased();
    });

    it("Files upload: the client leaving mid-upload destroys the upstream upload (streamed, not buffered)", async () => {
      const boundary = `----chaos${Math.random().toString(36).slice(2, 10)}`;
      const tag = `fu-${Math.random().toString(36).slice(2, 8)}`;
      const req = http.request(`${gw.url}/v1/files`, { method: "POST", headers: { ...auth(), "content-type": `multipart/form-data; boundary=${boundary}`, "x-mock-tag": tag } });
      req.on("error", () => undefined);
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nassistants\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      req.write(Buffer.alloc(256 * 1024, 1));
      await sleep(300);
      const t0 = Date.now();
      req.destroy();
      const seen = await waitAbort(tag);
      expect(seen, "the upstream upload must be aborted").not.toBeNull();
      expect(seen!.phase).toBe("uploading");
      expect(seen!.at - t0).toBeLessThan(150);
      await sleep(50);
      await allReleased();
    });

    it("Files download: the client leaving mid-download destroys the upstream download", async () => {
      const fd = new FormData();
      fd.append("purpose", "assistants");
      fd.append("file", new Blob([Buffer.alloc(3 * 1024 * 1024, 5)], { type: "application/octet-stream" }), "three.bin");
      const up = await fetch(`${gw.url}/v1/files`, { method: "POST", headers: auth(), body: fd });
      expect(up.status).toBe(200);
      const file = (await up.json()) as { id: string };
      requestIds.push(up.headers.get("x-request-id")!);
      const tag = `fd-${Math.random().toString(36).slice(2, 8)}`;
      const ac = new AbortController();
      const res = await fetch(`${gw.url}/v1/files/${file.id}/content`, { headers: { ...auth(), "x-mock-tag": tag, "x-mock-delay-ms": "60" }, signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(String(3 * 1024 * 1024));
      const reader = res.body!.getReader();
      await reader.read();
      await reader.read();
      const t0 = Date.now();
      ac.abort();
      reader.cancel().catch(() => undefined);
      const seen = await waitAbort(tag);
      expect(seen).not.toBeNull();
      expect(seen!.phase).toBe("streaming");
      expect(seen!.at - t0).toBeLessThan(100);
      requestIds.push(res.headers.get("x-request-id")!);
      expect((await logOf(res.headers.get("x-request-id"))).status).toBe("CANCELLED");
      await sleep(50);
      await allReleased();
    });
  });

  // ------------------------------------------------------------------ 8. request bodies
  it("a gzip-encoded request body is decoded before it is parsed and forwarded plain", async () => {
    const m = slug.oa;
    const raw = JSON.stringify({ model: m, messages: [{ role: "user", content: `${prompt(5)} zipped` }] });
    const res = await fetch(`${gw.url}/v1/chat/completions`, { method: "POST", headers: { ...bearer(apiKey), "content-encoding": "gzip" }, body: gzipSync(raw) });
    expect(res.status).toBe(200);
    requestIds.push(res.headers.get("x-request-id")!);
    await res.text();
    const last = (await (await fetch(`${h.base}/__mock/last?path=/v1/chat/completions`)).json()) as { headers: Record<string, string>; body: { model: string; messages: Array<{ content: string }> } };
    expect(last.headers["content-encoding"]).toBeUndefined();
    expect(last.body.messages[0].content).toContain("zipped");
    expect(last.body.model).toBe("up-oa");
  });

  it("an unsupported Content-Encoding is a clear 415, a corrupt gzip body a clear 400", async () => {
    const m = slug.oa;
    const body = JSON.stringify({ model: m, messages: [{ role: "user", content: "x" }] });
    const bad = await fetch(`${gw.url}/v1/chat/completions`, { method: "POST", headers: { ...bearer(apiKey), "content-encoding": "compress" }, body });
    expect(bad.status).toBe(415);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toMatch(/Content-Encoding/);
    requestIds.push(bad.headers.get("x-request-id")!);
    const corrupt = await fetch(`${gw.url}/v1/chat/completions`, { method: "POST", headers: { ...bearer(apiKey), "content-encoding": "gzip" }, body: Buffer.from("definitely not gzip") });
    expect(corrupt.status).toBe(400);
    requestIds.push(corrupt.headers.get("x-request-id")!);
  });

  it("the JSON body is forwarded byte-identical except for the model", async () => {
    const m = slug.oa;
    // odd spacing, key order, number formats and unicode escapes survive untouched
    const raw = `{ "messages" : [ {"role":"user","content":"caf\\u00e9 ${prompt(3)}"} ],\n  "temperature": 1.0, "model" :  "${m}" , "stream":false }`;
    const res = await fetch(`${gw.url}/v1/chat/completions`, { method: "POST", headers: bearer(apiKey), body: raw });
    expect(res.status).toBe(200);
    requestIds.push(res.headers.get("x-request-id")!);
    await res.text();
    const last = (await (await fetch(`${h.base}/__mock/last?path=/v1/chat/completions`)).json()) as { bodySha256: string };
    const expected = raw.replace(`"${m}"`, `"up-oa"`);
    expect(last.bodySha256).toBe(createHash("sha256").update(expected).digest("hex"));
  });

  // ------------------------------------------------------------------ 9. keep-alive: silence on a committed SSE stream
  describe("heartbeats", () => {
    beforeAll(async () => {
      await setHeartbeatSeconds(1);
    });
    afterAll(async () => {
      await setHeartbeatSeconds(null);
    });

    it("a silent committed stream gets `: keep-alive` comments, resumes, and is never cut by the gateway", async () => {
      // frames 2.2 s apart: two heartbeats fit in every gap
      const r = await run(FORMATS[0], { delayMs: 2200, words: 2, mode: "early-headers" });
      expect(r.status).toBe(200);
      expect(r.ended).toBe(true);
      expect(r.text).toMatch(/\[DONE\]/);
      const beats = r.text.split(": keep-alive\n\n").length - 1;
      expect(beats).toBeGreaterThanOrEqual(4);
      process.stdout.write(`TIMELINE ${JSON.stringify(r.timeline)}\n`);
      expect(r.text.indexOf(": keep-alive")).toBeLessThan(r.text.indexOf("chat.completion.chunk"));
      expect((await logOf(r.id)).status).toBe("SUCCESS");
    }, 30_000);

    it("a stalled upstream (never finishes) is kept alive with heartbeats until the client leaves; then everything is released", async () => {
      const tag = `stall-${Math.random().toString(36).slice(2, 8)}`;
      const ac = new AbortController();
      const m = slug.an;
      const res = await fetch(`${gw.url}/v1/messages`, { method: "POST", headers: { ...anth(apiKey), "x-mock-mode": "stall-after:4", "x-mock-tag": tag }, body: JSON.stringify({ model: m, stream: true, max_tokens: 100, messages: [{ role: "user", content: prompt(10) }] }), signal: ac.signal });
      requestIds.push(res.headers.get("x-request-id")!);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = "";
      const t0 = Date.now();
      while (Date.now() - t0 < 3800) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
      const beats = text.split(": keep-alive\n\n").length - 1;
      expect(beats).toBeGreaterThanOrEqual(2);
      expect(text).not.toMatch(/message_stop/);
      const tAbort = Date.now();
      ac.abort();
      reader.cancel().catch(() => undefined);
      const seen = await waitAbort(tag);
      expect(seen).not.toBeNull();
      expect(seen!.at - tAbort).toBeLessThan(100);
      await sleep(50);
      await allReleased();
    }, 30_000);
  });

  // ------------------------------------------------------------------ 10. nothing is lost
  it("every request above produced exactly one RequestLog", async () => {
    await flushMeter();
    const missing: string[] = [];
    for (const id of new Set(requestIds)) {
      let row = await db.requestLog.findUnique({ where: { id }, select: { id: true } });
      for (let i = 0; i < 40 && !row; i++) {
        await sleep(50);
        await flushMeter();
        row = await db.requestLog.findUnique({ where: { id }, select: { id: true } });
      }
      if (!row) missing.push(id);
    }
    expect(missing).toEqual([]);
    expect(requestIds.length).toBeGreaterThan(60);
  });
});
