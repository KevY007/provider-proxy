/**
 * Unlimited, streamed bodies (PLAN 5c): huge multipart uploads and huge JSON prompts go through the gateway with
 *   - no size limit (maxRequestBodyMb = 0),
 *   - the bytes arriving at the upstream IDENTICAL to what the client sent, except the `model` value (sha-256 compared),
 *   - bounded memory: multipart is spooled to disk and streamed, JSON is spooled, parsed once and forwarded by splicing.
 * Data is generated on the fly (nothing is written to the repo). Default sizes keep `pnpm test` quick; the full
 * 1 GB multipart + 200 MB JSON run is opt-in:  GW_CHAOS_HEAVY=1 pnpm vitest run tests/gateway/bigbody.test.ts
 */
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk, sleep } from "./harness";
import { startGatewayServer, type GatewayServer } from "./http-adapter";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { db } from "@/lib/db";

const HEAVY = !!process.env.GW_CHAOS_HEAVY;
const MULTIPART_MB = Number(process.env.GW_BIG_MULTIPART_MB ?? (HEAVY ? 1024 : 96));
const JSON_MB = Number(process.env.GW_BIG_JSON_MB ?? (HEAVY ? 200 : 24));
const MB = 1024 * 1024;

const h = createHarness("big");
let gw: GatewayServer;
let key = "";
const slug: Record<string, string> = {};

/** 1 MB of incompressible filler, repeated: cheap to generate, hashed once per use. */
const FILLER = randomBytes(MB);

interface Sent {
  status: number;
  body: string;
  sentBytes: number;
  expectedSha: string;
  expectedBytes: number;
  peakRssMb: number;
  baselineRssMb: number;
  seconds: number;
}

/**
 * POST a body that is produced piece by piece: `pieces()` yields [bytes the client sends, bytes the UPSTREAM must
 * receive]. Both sides are hashed so the test can assert byte identity at the upstream.
 */
async function postGenerated(path: string, headers: Record<string, string>, pieces: () => Generator<[Buffer, Buffer]>, total: number): Promise<Sent> {
  const expected = createHash("sha256");
  let expectedBytes = 0;
  let sentBytes = 0;
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 25);
  const t0 = Date.now();
  try {
    const req = http.request(`${gw.url}${path}`, { method: "POST", headers: { ...headers, "content-length": String(total) } });
    const done = new Promise<{ status: number; body: string }>((resolve, reject) => {
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      });
      req.on("error", reject);
    });
    for (const [send, expect_] of pieces()) {
      expected.update(expect_);
      expectedBytes += expect_.length;
      sentBytes += send.length;
      if (!req.write(send)) await once(req, "drain");
    }
    req.end();
    const res = await done;
    return { ...res, sentBytes, expectedSha: expected.digest("hex"), expectedBytes, peakRssMb: (peak - baseline) / MB, baselineRssMb: baseline / MB, seconds: (Date.now() - t0) / 1000 };
  } finally {
    clearInterval(sampler);
  }
}

const spoolFiles = () => readdirSync(tmpdir()).filter((f) => f.startsWith("pp-spool-"));

async function lastMock(path: string) {
  return (await (await fetch(`${h.base}/__mock/last?path=${encodeURIComponent(path)}`)).json()) as { bodySha256: string; bodyBytes: number };
}

describe.skipIf(!dbOk)(`huge bodies (${MULTIPART_MB} MB multipart, ${JSON_MB} MB JSON${HEAVY ? ", heavy" : ""})`, () => {
  beforeAll(async () => {
    await h.start();
    gw = await startGatewayServer();
    const u = await h.makeUser("main", { balance: "1000" });
    key = (await h.makeKey("main", u.id, { maxConcurrency: 50 })).key;
    const oa = await h.makeProvider("oa", { formats: ["openai_chat", "openai_images", "openai_files"], keys: [{ s: "oa1" }] });
    slug.chat = (await h.makeModel("chat", { caps: ["chat"], providerId: oa.id, maxOutput: 4096 })).slug;
    slug.img = (await h.makeModel("img", { caps: ["images"], providerId: oa.id })).slug;
    await invalidateGatewayConfig("all");
    // warm up (module loading, tokenizer, connection pools) so the RSS baseline is honest
    await fetch(`${gw.url}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: slug.chat, messages: [{ role: "user", content: "warm" }] }) }).then((r) => r.text());
  }, 120_000);

  afterAll(async () => {
    await gw?.close();
    await h.cleanup();
  }, 120_000);

  it(`${MULTIPART_MB} MB multipart upload: file first, model last - identical at the upstream, memory bounded, spool cleaned`, async () => {
    const boundary = "----bigmp0123456789";
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="huge.png"\r\nContent-Type: image/png\r\n\r\n`);
    const mid = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nedit this\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n`);
    const tail = (model: string) => Buffer.from(`${model}\r\n--${boundary}--\r\n`);
    const total = head.length + MULTIPART_MB * MB + mid.length + tail(slug.img).length;
    const before = new Set(spoolFiles());

    function* pieces(): Generator<[Buffer, Buffer]> {
      yield [head, head];
      for (let i = 0; i < MULTIPART_MB; i++) yield [FILLER, FILLER];
      yield [mid, mid];
      yield [tail(slug.img), tail("up-img")]; // the gateway replaces the public model name by the upstream model
    }
    const r = await postGenerated(
      "/v1/images/edits",
      { authorization: `Bearer ${key}`, "content-type": `multipart/form-data; boundary=${boundary}`, "x-mock-hash-body": "1" },
      pieces,
      // the expected upstream size differs by the model name length, the client's by its own: declare the client's
      head.length + MULTIPART_MB * MB + mid.length + tail(slug.img).length,
    );
    expect(total).toBe(r.sentBytes);
    expect(r.status, r.body.slice(0, 300)).toBe(200);
    const last = await lastMock("/v1/images/edits");
    expect(last.bodyBytes).toBe(r.expectedBytes);
    expect(last.bodySha256, "bytes at the upstream == bytes sent, except the model").toBe(r.expectedSha);
    process.stdout.write(`BIGBODY multipart ${MULTIPART_MB} MB: ${r.seconds.toFixed(1)} s, peak RSS growth ${r.peakRssMb.toFixed(0)} MB (baseline ${r.baselineRssMb.toFixed(0)} MB)\n`);
    expect(r.peakRssMb, "multipart memory is bounded").toBeLessThan(300);
    await sleep(200);
    expect(spoolFiles().filter((f) => !before.has(f))).toEqual([]);
  }, 1_200_000);

  it(`${JSON_MB} MB JSON prompt: forwarded byte-identical except the model, bounded memory`, async () => {
    const pre = Buffer.from(`{"messages":[{"role":"user","content":"`);
    const post = (model: string) => Buffer.from(`"}],"model":"${model}","stream":false}`);
    const total = pre.length + JSON_MB * MB + post(slug.chat).length;
    // the "text" is base64-looking filler: printable, escape-free
    const textFiller = Buffer.from(FILLER.toString("base64").slice(0, MB), "latin1");
    const before = new Set(spoolFiles());

    function* pieces(): Generator<[Buffer, Buffer]> {
      yield [pre, pre];
      for (let i = 0; i < JSON_MB; i++) yield [textFiller, textFiller];
      yield [post(slug.chat), post("up-chat")];
    }
    const r = await postGenerated("/v1/chat/completions", { authorization: `Bearer ${key}`, "content-type": "application/json", "x-mock-hash-body": "1" }, pieces, total);
    expect(r.status, r.body.slice(0, 300)).toBe(200);
    expect(JSON.parse(r.body).choices[0].message.content).toBeTruthy();
    const last = await lastMock("/v1/chat/completions");
    expect(last.bodyBytes).toBe(r.expectedBytes);
    expect(last.bodySha256).toBe(r.expectedSha);
    process.stdout.write(`BIGBODY json ${JSON_MB} MB: ${r.seconds.toFixed(1)} s, peak RSS growth ${r.peakRssMb.toFixed(0)} MB (baseline ${r.baselineRssMb.toFixed(0)} MB)\n`);
    // the body is spooled to disk, read once, parsed, and forwarded by splicing: a small multiple of its size, never a per-copy blow-up
    expect(r.peakRssMb).toBeLessThan(JSON_MB * 3 + 120);
    await sleep(200);
    expect(spoolFiles().filter((f) => !before.has(f))).toEqual([]);
  }, 1_200_000);

  it("a body over maxRequestBodyMb is refused with a clear 413", async () => {
    await db.setting.upsert({ where: { key: "maxRequestBodyMb" }, create: { key: "maxRequestBodyMb", value: 1 }, update: { value: 1 } });
    try {
      // only this test file's gateway reads the setting: bypass the 30 s cache by resetting the config snapshot
      const { __resetCacheForTests } = await import("@/gateway/cache");
      const { invalidateSettingsCache } = await import("@/lib/settings");
      invalidateSettingsCache();
      __resetCacheForTests();
      const big = Buffer.alloc(3 * MB, 0x61);
      const res = await fetch(`${gw.url}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: Buffer.concat([Buffer.from(`{"model":"${slug.chat}","messages":[{"role":"user","content":"`), big, Buffer.from(`"}]}`)]),
      });
      expect(res.status).toBe(413);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/1MB limit/);
    } finally {
      await db.setting.deleteMany({ where: { key: "maxRequestBodyMb" } });
      const { __resetCacheForTests } = await import("@/gateway/cache");
      const { invalidateSettingsCache } = await import("@/lib/settings");
      invalidateSettingsCache();
      __resetCacheForTests();
    }
  }, 60_000);
});
