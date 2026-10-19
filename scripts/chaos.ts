/**
 * Heavy connection-fidelity run (PLAN 9d.6): N long SSE streams against a REAL server process / container, with a SIGTERM
 * drain in the middle.  Opt-in (it needs the dev database and, for the drain, Docker):
 *
 *   pnpm chaos --docker providerproxy:fidelity            # 1000 streams x 120 s, SIGTERM after 40 s   (the full run)
 *   pnpm chaos --docker providerproxy:fidelity --h2       # same over HTTP/2 cleartext (10 sessions x 100 streams)
 *   pnpm chaos --url http://127.0.0.1:3000 --streams 200 --seconds 30   # an already running server (no SIGTERM)
 *
 * Options: --streams N (1000) --seconds S (120: duration of every stream) --sigterm-after S (40, docker only)
 *          --heartbeat S (5: settings.streamHeartbeatSec used for the run) --h2
 *
 * What it checks (prints one CHAOSRESULT json line and exits non-zero on any violation):
 *   - every stream completes: HTTP 200, the terminal [DONE] event, no broken connection - i.e. NONE is truncated by the
 *     gateway, also while the container drains after SIGTERM;
 *   - silent gaps are bridged by `: keep-alive` heartbeats;
 *   - new connections are refused once the drain started, and the container exits (143) only after the last stream ended;
 *   - no RequestLog lost: exactly N rows, all SUCCESS, balance debit == sum of the logged prices (the metering buffer is
 *     flushed on exit).
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import http2 from "node:http2";
import { Agent, fetch as undiciFetch } from "undici";
import { startMockUpstream } from "./mock-upstream";
import { db } from "../src/lib/db";
import { encrypt, sha256 } from "../src/lib/crypto";
import { Decimal } from "../src/lib/money";
import { getRedis, publishConfigInvalidate } from "../src/lib/redis";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const N = Number(opt("streams", "1000"));
const SECONDS = Number(opt("seconds", "120"));
const SIGTERM_AFTER = Number(opt("sigterm-after", "40"));
const HEARTBEAT = Number(opt("heartbeat", "5"));
const IMAGE = opt("docker", "");
const EXTERNAL = opt("url", "");
const H2 = flag("h2");
const WORDS = 10;
const FRAMES = WORDS + 4; // role + words + finish + usage + [DONE]
const DELAY_MS = Math.max(1, Math.round((SECONDS * 1000) / FRAMES));

if (!IMAGE && !EXTERNAL) {
  console.error("usage: pnpm chaos --docker <image> | --url <http://host:port>  [--streams N] [--seconds S] [--sigterm-after S] [--heartbeat S] [--h2]");
  process.exit(2);
}

const sfx = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const slugName = `chaos-${sfx}`;
const imgSlugName = `chaos-img-${sfx}`;
const extraModelIds: string[] = [];
const apiKey = `sk-pp-chz${sfx}`.padEnd(46, "0");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[chaos +${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const T0 = Date.now();

interface Fixture {
  userId: string;
  providerId: string;
  modelId: string;
  groupId: string;
  keyIds: string[];
}

async function seed(mockBase: string): Promise<Fixture> {
  const g = await db.group.create({ data: { name: `chz-${sfx}`, slug: `chz-${sfx}`, priceMultiplier: "1" } });
  const u = await db.user.create({
    data: { email: `chz-${sfx}@test.local`, passwordHash: "x", status: "ACTIVE", emailVerifiedAt: new Date(), balance: "10000", groupId: g.id, maxConcurrency: 100_000 },
  });
  await db.apiKey.create({ data: { userId: u.id, name: "chaos", prefix: apiKey.slice(0, 12), keyHash: sha256(apiKey), maxConcurrency: 100_000 } });
  const p = await db.provider.create({
    data: { name: `chz-${sfx}`, slug: `chz-${sfx}`, preset: "custom", baseUrl: `${mockBase}/v1`, formats: ["openai_chat", "openai_images"], tags: ["mock"], timeoutMs: 600_000 },
  });
  const keyIds: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const k = await db.providerKey.create({ data: { providerId: p.id, label: `k${i}`, secretEncrypted: encrypt(`chz-key-${i}-${sfx}`), secretHint: "chaos", maxConcurrency: Math.ceil(N / 2) } });
    keyIds.push(k.id);
  }
  const m = await db.model.create({ data: { slug: slugName, displayName: "chaos", vendor: "chz", capabilities: ["chat"], inputPrice: "1", outputPrice: "2", maxOutput: 4096 } });
  await db.modelRoute.create({ data: { modelId: m.id, providerId: p.id, upstreamModel: "up", inputCost: "0.5", outputCost: "1" } });
  const mi = await db.model.create({ data: { slug: imgSlugName, displayName: "chaos img", vendor: "chz", capabilities: ["images"], inputPrice: "1", outputPrice: "2" } });
  await db.modelRoute.create({ data: { modelId: mi.id, providerId: p.id, upstreamModel: "up", inputCost: "0.5", outputCost: "1" } });
  extraModelIds.push(mi.id);
  await db.setting.upsert({ where: { key: "streamHeartbeatSec" }, create: { key: "streamHeartbeatSec", value: HEARTBEAT }, update: { value: HEARTBEAT } });
  return { userId: u.id, providerId: p.id, modelId: m.id, groupId: g.id, keyIds };
}

async function cleanup(f: Fixture | null): Promise<void> {
  if (!f) return;
  await db.requestLog.deleteMany({ where: { userId: f.userId } }).catch(() => undefined);
  await db.apiKey.deleteMany({ where: { userId: f.userId } }).catch(() => undefined);
  await db.modelRoute.deleteMany({ where: { modelId: { in: [f.modelId, ...extraModelIds] } } }).catch(() => undefined);
  await db.model.deleteMany({ where: { id: { in: [f.modelId, ...extraModelIds] } } }).catch(() => undefined);
  await db.provider.deleteMany({ where: { id: f.providerId } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: f.userId } }).catch(() => undefined);
  await db.group.deleteMany({ where: { id: f.groupId } }).catch(() => undefined);
  await db.setting.deleteMany({ where: { key: "streamHeartbeatSec" } }).catch(() => undefined);
  const r = getRedis();
  if (r) await publishConfigInvalidate("all").catch(() => undefined);
}

// ------------------------------------------------------------------ docker helpers
const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });

function startContainer(hostPort: number): string {
  const dbUrl = (process.env.DATABASE_URL ?? "").replace(/@(localhost|127\.0\.0\.1)/, "@host.docker.internal");
  const run = spawnSync(
    "docker",
    [
      "run", "-d", "--add-host", "host.docker.internal:host-gateway", "-p", `127.0.0.1:${hostPort}:8080`,
      "-e", `DATABASE_URL=${dbUrl}`, "-e", "ENCRYPTION_KEY", "-e", "SESSION_SECRET", "-e", "APP_URL=http://localhost:8080",
      "-e", "SHUTDOWN_DRAIN_SECONDS=300", IMAGE,
    ],
    { encoding: "utf8", env: process.env },
  );
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  return run.stdout.trim();
}

// ------------------------------------------------------------------ stream clients
interface StreamResult {
  ok: boolean;
  status: number;
  done: boolean;
  error: string | null;
  heartbeats: number;
  ms: number;
}

const agent = new Agent({ connections: N + 200, pipelining: 1, keepAliveTimeout: 60_000, headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 30_000 } });

async function h1Stream(base: string, i: number): Promise<StreamResult> {
  const t0 = Date.now();
  let status = 0;
  let text = "";
  try {
    const res = await undiciFetch(`${base}/v1/chat/completions`, {
      method: "POST",
      dispatcher: agent,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-mock-delay-ms": String(DELAY_MS), "x-mock-mode": "early-headers" },
      body: JSON.stringify({ model: slugName, stream: true, messages: [{ role: "user", content: `[[words:${WORDS}]] [[usage:in=100,out=50]] stream ${i}` }] }),
    });
    status = res.status;
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
  } catch (e) {
    return { ok: false, status, done: false, error: String(e), heartbeats: count(text), ms: Date.now() - t0 };
  }
  const done = text.includes("data: [DONE]");
  return { ok: status === 200 && done, status, done, error: null, heartbeats: count(text), ms: Date.now() - t0 };
}

const count = (t: string) => t.split(": keep-alive").length - 1;

function h2Stream(session: http2.ClientHttp2Session, i: number): Promise<StreamResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let status = 0;
    let text = "";
    const body = JSON.stringify({ model: slugName, stream: true, messages: [{ role: "user", content: `[[words:${WORDS}]] [[usage:in=100,out=50]] stream ${i}` }] });
    const req = session.request({
      ":method": "POST",
      ":path": "/v1/chat/completions",
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "x-mock-delay-ms": String(DELAY_MS),
      "x-mock-mode": "early-headers",
    });
    req.setEncoding("utf8");
    req.on("response", (h) => (status = Number(h[":status"])));
    req.on("data", (c: string) => (text += c));
    req.on("end", () => {
      const done = text.includes("data: [DONE]");
      resolve({ ok: status === 200 && done, status, done, error: null, heartbeats: count(text), ms: Date.now() - t0 });
    });
    req.on("error", (e) => resolve({ ok: false, status, done: false, error: String(e), heartbeats: count(text), ms: Date.now() - t0 }));
    req.end(body);
  });
}

// ------------------------------------------------------------------ scenario matrix (--scenarios)
interface Call {
  status: number;
  headers: Record<string, string>;
  text: string;
  error: string | null;
  ended: boolean;
  aborted: boolean;
  id: string | null;
  /** [ms since the request started, bytes] per received chunk */
  chunks: Array<[number, number]>;
}

interface CallOpts {
  extra?: Record<string, string>;
  stream?: boolean;
  /** abort the client once this regex matches the received text (or after `abortMs`) */
  abortWhen?: RegExp;
  abortMs?: number;
}

const LIVE = flag("live") || flag("live-h2");
const chatBody = (stream: boolean) =>
  LIVE
    ? JSON.stringify({ model: "gpt-4o-mini", ...(stream ? { stream: true } : {}), max_tokens: 20, messages: [{ role: "user", content: "Reply with the integers from 1 to 30 separated by single spaces and nothing else." }] })
    : JSON.stringify({ model: slugName, ...(stream ? { stream: true } : {}), messages: [{ role: "user", content: `[[words:${WORDS}]] [[usage:in=100,out=50]] scenario` }] });

async function callH1(base: string, o: CallOpts): Promise<Call> {
  const tStart = Date.now();
  const ac = new AbortController();
  const out: Call = { status: 0, headers: {}, text: "", error: null, ended: false, aborted: false, id: null, chunks: [] };
  const timer = o.abortMs !== undefined && !o.abortWhen ? setTimeout(() => ((out.aborted = true), ac.abort()), o.abortMs) : null;
  try {
    const res = await undiciFetch(`${base}/v1/chat/completions`, {
      method: "POST",
      dispatcher: agent,
      signal: ac.signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...o.extra },
      body: chatBody(o.stream !== false),
    });
    out.status = res.status;
    res.headers.forEach((v, k) => (out.headers[k] = v));
    out.id = res.headers.get("x-request-id");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        out.ended = true;
        break;
      }
      out.text += dec.decode(value, { stream: true });
      out.chunks.push([Date.now() - tStart, value.length]);
      if (o.abortWhen?.test(out.text)) {
        out.aborted = true;
        ac.abort();
        break;
      }
    }
  } catch (e) {
    if (!out.aborted) out.error = String(e);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return out;
}

function callH2(session: http2.ClientHttp2Session, o: CallOpts): Promise<Call> {
  return new Promise((resolve) => {
    const tStart = Date.now();
    const out: Call = { status: 0, headers: {}, text: "", error: null, ended: false, aborted: false, id: null, chunks: [] };
    const req = session.request({ ":method": "POST", ":path": "/v1/chat/completions", authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...o.extra });
    const abort = () => {
      out.aborted = true;
      req.close(http2.constants.NGHTTP2_CANCEL);
      resolve(out);
    };
    if (o.abortMs !== undefined && !o.abortWhen) setTimeout(abort, o.abortMs);
    req.setEncoding("utf8");
    req.on("response", (h) => {
      out.status = Number(h[":status"]);
      for (const [k, v] of Object.entries(h)) if (!k.startsWith(":")) out.headers[k] = String(v);
      out.id = out.headers["x-request-id"] ?? null;
    });
    req.on("data", (c: string) => {
      out.text += c;
      out.chunks.push([Date.now() - tStart, c.length]);
      if (o.abortWhen?.test(out.text) && !out.aborted) abort();
    });
    req.on("end", () => {
      out.ended = true;
      resolve(out);
    });
    req.on("error", (e) => {
      if (!out.aborted) out.error = String(e);
      resolve(out);
    });
    req.end(chatBody(o.stream !== false));
  });
}

async function runScenarios(base: string, mockPort: number, userId: string): Promise<{ rows: Array<Record<string, string>>; violations: string[] }> {
  const rows: Array<Record<string, string>> = [];
  const violations: string[] = [];
  const mockUrl = `http://127.0.0.1:${mockPort}`;
  const session = http2.connect(base);
  session.on("error", () => undefined);
  const protos: Array<["http/1.1" | "h2c", (o: CallOpts) => Promise<Call>]> = [
    ["http/1.1", (o) => callH1(base, o)],
    ["h2c", (o) => callH2(session, o)],
  ];
  const aborts = async (tag: string) => ((await (await fetch(`${mockUrl}/__mock/aborts?tag=${tag}`)).json()) as { aborts: Array<{ phase: string; at: number }> }).aborts;
  const logOf = async (id: string | null) => {
    if (!id) return "no request id";
    for (let i = 0; i < 40; i++) {
      const r = await db.requestLog.findUnique({ where: { id } });
      if (r) return `${r.status} http=${r.httpStatus} out=${r.outputTokens}${r.usageEstimated ? "(est)" : ""} price=$${Number(r.price).toFixed(6)}`;
      await sleep(250);
    }
    return "NOT LOGGED";
  };
  const check = (cond: boolean, msg: string) => {
    if (!cond) violations.push(msg);
  };
  const mode = (m: string) => ({ "x-mock-mode": `early-headers,${m}` });

  for (const [proto, call] of protos) {
    const row = (scenario: string, client: string, upstream: string, metering: string) => rows.push({ scenario, proto, client, upstream, metering });

    let r = await call({});
    check(r.status === 200 && r.ended && r.text.includes("[DONE]"), `${proto} complete stream`);
    check(r.headers["cache-control"] === "no-cache, no-transform" && r.headers["x-accel-buffering"] === "no" && !r.headers["content-encoding"] && !!r.headers["x-upstream-request-id"] && !r.headers["openai-organization"], `${proto} stream headers`);
    row("complete stream", `200 SSE, [DONE], x-upstream-request-id=${r.headers["x-upstream-request-id"]}, no content-encoding`, "answered normally", await logOf(r.id));

    r = await call({ stream: false, extra: { "x-mock-fail": "529" } });
    check(r.status === 529 && r.headers["retry-after"] === "7" && !!r.headers["x-upstream-request-id"] && !!JSON.parse(r.text).error && !/mock|127\.0\.0\.1|host\.docker/i.test(r.text), `${proto} 529 pre-commit: status ${r.status} retry-after ${r.headers["retry-after"]} rid ${r.headers["x-upstream-request-id"]} body ${r.text.slice(0, 200)}`);
    row("upstream 529 on every key", `HTTP ${r.status}, retry-after ${r.headers["retry-after"]}, native error body ${r.text.slice(0, 60)}`, "3 attempts, all 529", await logOf(r.id));

    r = await call({ extra: mode("rst-after:7") });
    check(!!r.error && !r.ended && !r.text.includes("[DONE]") && r.text.length > 0, `${proto} upstream RST mid-stream`);
    row("upstream TCP reset mid-stream", `200, ${r.text.length} bytes, then network error: ${r.error?.slice(0, 70)}`, "RST after 7 frames", await logOf(r.id));

    r = await call({ extra: mode("fin-after:7") });
    check(!!r.error && !r.ended && !r.text.includes("[DONE]"), `${proto} upstream FIN without terminator`);
    row("upstream closes early (clean FIN, no [DONE])", `200, ${r.text.length} bytes, then network error: ${r.error?.slice(0, 70)}`, "FIN after 7 frames, no terminator", await logOf(r.id));

    r = await call({ extra: mode("error-after:2") });
    check(r.ended && !r.error && /server had an error/.test(r.text) && !r.text.includes("[DONE]"), `${proto} in-stream error event`);
    row("upstream error event inside the stream", "200, the upstream's error event verbatim, then a normal end", "error event after 2 frames", await logOf(r.id));

    r = await call({ extra: mode("gzip") });
    check(r.status === 200 && r.ended && r.text.includes("[DONE]") && !r.headers["content-encoding"], `${proto} gzip upstream`);
    row("gzip-compressed upstream", "200, plain SSE, no content-encoding", "sent Content-Encoding: gzip despite identity", await logOf(r.id));

    const tag = `${proto}-abort-${Math.random().toString(36).slice(2, 8)}`;
    const t0 = Date.now();
    r = await call({ extra: { ...mode("none"), "x-mock-delay-ms": "150", "x-mock-tag": tag }, abortWhen: /word[\s\S]+word/ });
    const tAbort = Date.now();
    let seen: { phase: string; at: number } | undefined;
    for (let i = 0; i < 60 && !seen; i++) {
      seen = (await aborts(tag))[0];
      if (!seen) await sleep(10);
    }
    const lat = seen ? seen.at - tAbort : -1;
    check(!!seen && seen.phase === "streaming" && lat < 150, `${proto} client abort -> upstream abort (${lat} ms; chunks ${JSON.stringify(r.chunks.slice(0, 12))})`);
    row("client aborts mid-stream", `aborted after ${tAbort - t0} ms`, seen ? `request aborted ${lat} ms later (phase ${seen.phase})` : "NOT ABORTED", await logOf(r.id));

    const tag2 = `${proto}-wait-${Math.random().toString(36).slice(2, 8)}`;
    const t1 = Date.now();
    r = await call({ stream: false, extra: { "x-mock-delay-ms": "4000", "x-mock-tag": tag2 }, abortMs: 400 });
    const tAbort2 = Date.now();
    let seen2: { phase: string; at: number } | undefined;
    for (let i = 0; i < 600 && !seen2; i++) {
      seen2 = (await aborts(tag2))[0];
      if (!seen2) await sleep(10);
    }
    const lat2 = seen2 ? seen2.at - tAbort2 : -1;
    check(!!seen2 && seen2.phase === "waiting" && lat2 < 150, `${proto} client abort while upstream thinks (${lat2} ms)`);
    row("client aborts a non-stream request while the upstream is working", `aborted after ${tAbort2 - t1} ms`, seen2 ? `request aborted ${lat2} ms later (phase ${seen2.phase})` : "NOT ABORTED", "CANCELLED (logged by the gateway)");
  }
  session.close();
  void userId;
  return { rows, violations };
}

// ------------------------------------------------------------------ huge bodies through the real server (--bigbody MB [--bigjson MB])
async function runBigBodies(base: string, mockPort: number, containerId: string, multipartMb: number, jsonMb: number, imgSlug: string): Promise<{ rows: string[]; violations: string[] }> {
  const rows: string[] = [];
  const violations: string[] = [];
  const MB = 1024 * 1024;
  const filler = randomBytes(MB);
  const textFiller = Buffer.from(filler.toString("base64").slice(0, MB), "latin1");
  const mockUrl = `http://127.0.0.1:${mockPort}`;
  const boundary = "----chaosbig0123456789";
  const mpHead = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="huge.png"\r\nContent-Type: image/png\r\n\r\n`);
  const mpMid = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nedit\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n`);
  const mpTail = (m: string) => Buffer.from(`${m}\r\n--${boundary}--\r\n`);
  const jsonPre = Buffer.from(`{"messages":[{"role":"user","content":"`);
  const jsonPost = (m: string) => Buffer.from(`"}],"model":"${m}","stream":false}`);

  type Piece = [Buffer, Buffer]; // [sent by the client, expected at the upstream]
  const multipart = function* (): Generator<Piece> {
    yield [mpHead, mpHead];
    for (let i = 0; i < multipartMb; i++) yield [filler, filler];
    yield [mpMid, mpMid];
    yield [mpTail(imgSlug), mpTail("up")];
  };
  const json = function* (): Generator<Piece> {
    yield [jsonPre, jsonPre];
    for (let i = 0; i < jsonMb; i++) yield [textFiller, textFiller];
    yield [jsonPost(slugName), jsonPost("up")];
  };

  const memMb = (): number => {
    if (!containerId) return process.memoryUsage().rss / MB;
    const s = docker("stats", "--no-stream", "--format", "{{.MemUsage}}", containerId).stdout.trim().split("/")[0].trim();
    const m = /([\d.]+)\s*(KiB|MiB|GiB)/.exec(s);
    return m ? Number(m[1]) * (m[2] === "GiB" ? 1024 : m[2] === "KiB" ? 1 / 1024 : 1) : 0;
  };

  async function send(label: string, proto: "http/1.1" | "h2c", path: string, contentType: string, gen: () => Generator<Piece>, total: number, lastPath: string): Promise<void> {
    const expected = createHash("sha256");
    let expectedBytes = 0;
    const base0 = memMb();
    let peak = base0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        peak = Math.max(peak, memMb());
        await sleep(400);
      }
    })();
    const t0 = Date.now();
    const headers = { authorization: `Bearer ${apiKey}`, "content-type": contentType, "content-length": String(total), "x-mock-hash-body": "1" };
    let status = 0;
    let body = "";
    if (proto === "http/1.1") {
      const u = new URL(base);
      await new Promise<void>((resolve, reject) => {
        const req = http.request({ host: u.hostname, port: u.port, path, method: "POST", headers });
        req.on("response", (res) => {
          status = res.statusCode ?? 0;
          res.on("data", (c: Buffer) => (body += c.toString("utf8", 0, 200)));
          res.on("end", resolve);
        });
        req.on("error", reject);
        void (async () => {
          for (const [send_, exp] of gen()) {
            expected.update(exp);
            expectedBytes += exp.length;
            if (!req.write(send_)) await once(req, "drain");
          }
          req.end();
        })();
      });
    } else {
      const s = http2.connect(base);
      s.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        const req = s.request({ ":method": "POST", ":path": path, ...headers });
        req.setEncoding("utf8");
        req.on("response", (h) => (status = Number(h[":status"])));
        req.on("data", (c: string) => (body += c.slice(0, 200)));
        req.on("end", resolve);
        req.on("error", reject);
        void (async () => {
          for (const [send_, exp] of gen()) {
            expected.update(exp);
            expectedBytes += exp.length;
            if (!req.write(send_)) await once(req, "drain");
          }
          req.end();
        })();
      });
      s.close();
    }
    sampling = false;
    await sampler;
    const secs = (Date.now() - t0) / 1000;
    const last = (await (await fetch(`${mockUrl}/__mock/last?path=${encodeURIComponent(lastPath)}`)).json()) as { bodySha256?: string; bodyBytes?: number };
    const sha = expected.digest("hex");
    const ok = status === 200 && last.bodySha256 === sha && last.bodyBytes === expectedBytes;
    if (!ok) violations.push(`${label} over ${proto}: status ${status}, upstream sha ${last.bodySha256 === sha ? "equal" : "DIFFERENT"}, bytes ${last.bodyBytes}/${expectedBytes} ${body.slice(0, 120)}`);
    rows.push(`${label} over ${proto}: ${(total / MB).toFixed(0)} MB in ${secs.toFixed(1)} s (${(total / MB / secs).toFixed(0)} MB/s), upstream bytes identical except model: ${ok}, ${containerId ? "container" : "process"} memory ${base0.toFixed(0)} -> peak ${peak.toFixed(0)} MB (growth ${(peak - base0).toFixed(0)} MB)`);
  }

  const mpTotal = mpHead.length + multipartMb * MB + mpMid.length + mpTail(imgSlug).length;
  const jsonTotal = jsonPre.length + jsonMb * MB + jsonPost(slugName).length;
  for (const proto of ["http/1.1", "h2c"] as const) {
    if (multipartMb > 0) await send("multipart upload", proto, "/v1/images/edits", `multipart/form-data; boundary=${boundary}`, multipart, mpTotal, "/v1/images/edits");
    if (jsonMb > 0) await send("JSON prompt", proto, "/v1/chat/completions", "application/json", json, jsonTotal, "/v1/chat/completions");
  }
  return { rows, violations };
}

// ------------------------------------------------------------------ live check (--live [--live-h2]): real OpenAI, a few cents of a cent
async function runLive(): Promise<number> {
  const violations: string[] = [];
  const provider = await db.provider.findUniqueOrThrow({ where: { slug: "openai" } });
  const savedSettings = provider.settings;
  const h2Upstream = flag("live-h2");
  let fixture: Fixture | null = null;
  let containerId = "";
  try {
    if (h2Upstream) await db.provider.update({ where: { id: provider.id }, data: { settings: { ...(savedSettings as object), http2: true } } });
    const g = await db.group.create({ data: { name: `chl-${sfx}`, slug: `chl-${sfx}`, priceMultiplier: "1" } });
    const u = await db.user.create({ data: { email: `chl-${sfx}@test.local`, passwordHash: "x", status: "ACTIVE", emailVerifiedAt: new Date(), balance: "1", groupId: g.id } });
    await db.apiKey.create({ data: { userId: u.id, name: "live-chaos", prefix: apiKey.slice(0, 12), keyHash: sha256(apiKey) } });
    fixture = { userId: u.id, providerId: "", modelId: "", groupId: g.id, keyIds: [] };

    let base = EXTERNAL.replace(/\/$/, "");
    if (IMAGE) {
      const hostPort = 18_000 + Math.floor(Math.random() * 2000);
      containerId = startContainer(hostPort);
      base = `http://127.0.0.1:${hostPort}`;
      for (let i = 0; i < 90; i++) {
        if (await fetch(`${base}/api/healthz`).then((r) => r.ok, () => false)) break;
        await sleep(1000);
      }
    }
    log(`live check against ${base} (upstream protocol: ${h2Upstream ? "HTTP/2 (provider.settings.http2)" : "HTTP/1.1"})`);
    const session = http2.connect(base);
    session.on("error", () => undefined);
    const logRow = async (id: string | null) => {
      for (let i = 0; i < 60; i++) {
        const r = id ? await db.requestLog.findUnique({ where: { id } }) : null;
        if (r) return r;
        await sleep(250);
      }
      return null;
    };
    for (const [proto, call] of [["http/1.1", (o: CallOpts) => callH1(base, o)], ["h2c", (o: CallOpts) => callH2(session, o)]] as const) {
      const full = await call({});
      const fr = await logRow(full.id);
      log(`[${proto}] complete stream: HTTP ${full.status}, ${full.text.includes("[DONE]") ? "[DONE]" : "NO [DONE]"}, x-upstream-request-id=${full.headers["x-upstream-request-id"] ?? "-"}, openai-organization=${full.headers["openai-organization"] ?? "-"}, content-encoding=${full.headers["content-encoding"] ?? "-"} -> ${fr?.status} out=${fr?.outputTokens} price=$${Number(fr?.price ?? 0).toFixed(6)}`);
      if (!(full.status === 200 && full.text.includes("[DONE]") && fr?.status === "SUCCESS")) violations.push(`${proto} live complete stream failed`);
      if (full.headers["openai-organization"] || full.headers["content-encoding"]) violations.push(`${proto} identity/encoding header leaked`);

      let cancelled = false;
      for (let attempt = 1; attempt <= 3 && !cancelled; attempt++) {
        const t0 = Date.now();
        const ab = await call({ abortWhen: /"content":" ?\d+"[\s\S]*"content":" ?\d+"[\s\S]*"content":" ?\d+"/ });
        const tAbort = Date.now();
        const row = await logRow(ab.id);
        cancelled = row?.status === "CANCELLED";
        log(`[${proto}] client abort (attempt ${attempt}): aborted ${tAbort - t0} ms after sending; gateway logged ${row?.status} ${Date.now() - tAbort} ms later, out=${row?.outputTokens}${row?.usageEstimated ? "(est)" : ""} price=$${Number(row?.price ?? 0).toFixed(6)}`);
      }
      if (!cancelled) violations.push(`${proto} live client abort was never logged CANCELLED`);
    }
    session.close();
    const spent = await db.requestLog.aggregate({ where: { userId: u.id }, _sum: { price: true, cost: true } });
    log(`live spend: customer price $${Number(spent._sum.price ?? 0).toFixed(6)}, our cost $${Number(spent._sum.cost ?? 0).toFixed(6)}`);
    console.log(`LIVERESULT ${JSON.stringify({ upstreamProtocol: h2Upstream ? "h2" : "http/1.1", violations })}`);
    return violations.length ? 1 : 0;
  } finally {
    if (containerId) docker("rm", "-f", containerId);
    await db.provider.update({ where: { id: provider.id }, data: { settings: savedSettings as object } }).catch(() => undefined);
    if (fixture) {
      await db.requestLog.deleteMany({ where: { userId: fixture.userId } }).catch(() => undefined);
      await db.apiKey.deleteMany({ where: { userId: fixture.userId } }).catch(() => undefined);
      await db.user.deleteMany({ where: { id: fixture.userId } }).catch(() => undefined);
      await db.group.deleteMany({ where: { id: fixture.groupId } }).catch(() => undefined);
    }
    await db.$disconnect().catch(() => undefined);
    getRedis()?.disconnect();
  }
}

// ------------------------------------------------------------------ main
async function main(): Promise<number> {
  if (LIVE) return runLive();
  let fixture: Fixture | null = null;
  let containerId = "";
  const violations: string[] = [];
  const mockHost = IMAGE ? "host.docker.internal" : "127.0.0.1";
  const mock = await startMockUpstream(0, IMAGE ? "0.0.0.0" : "127.0.0.1");
  try {
    fixture = await seed(`http://${mockHost}:${mock.port}`);
    log(`fixture ready: ${N} streams x ${SECONDS}s (frame delay ${DELAY_MS} ms), heartbeat ${HEARTBEAT}s, mock on :${mock.port}`);

    let base = EXTERNAL.replace(/\/$/, "");
    if (IMAGE) {
      const hostPort = 18_000 + Math.floor(Math.random() * 2000);
      containerId = startContainer(hostPort);
      base = `http://127.0.0.1:${hostPort}`;
      log(`container ${containerId.slice(0, 12)} on ${base}`);
      for (let i = 0; i < 90; i++) {
        const ok = await fetch(`${base}/api/healthz`).then((r) => r.ok, () => false);
        if (ok) break;
        await sleep(1000);
        if (i === 89) throw new Error("container did not become healthy");
      }
    } else {
      await publishConfigInvalidate("all").catch(() => undefined);
      await sleep(500);
    }

    if (opt("bigbody", "") || opt("bigjson", "")) {
      const { rows, violations: v } = await runBigBodies(base, mock.port, containerId, Number(opt("bigbody", "0")), Number(opt("bigjson", "0")), imgSlugName);
      console.log("");
      for (const r of rows) console.log(r);
      console.log(`\nBIGBODIES ${JSON.stringify({ violations: v })}`);
      violations.push(...v);
      return violations.length ? 1 : 0;
    }
    if (flag("scenarios")) {
      const { rows, violations: v } = await runScenarios(base, mock.port, fixture.userId);
      console.log("");
      for (const r of rows) console.log(`[${r.proto}] ${r.scenario}\n    client:   ${r.client}\n    upstream: ${r.upstream}\n    metering: ${r.metering}`);
      console.log(`\nSCENARIOS ${JSON.stringify({ count: rows.length, violations: v })}`);
      violations.push(...v);
      return violations.length ? 1 : 0;
    }

    // ---- launch every stream
    const sessions: http2.ClientHttp2Session[] = [];
    if (H2) {
      const k = 10;
      for (let i = 0; i < k; i++) {
        const s = http2.connect(base);
        s.on("error", () => undefined);
        sessions.push(s);
      }
    }
    const results: Promise<StreamResult>[] = [];
    const tLaunch = Date.now();
    for (let i = 0; i < N; i++) {
      results.push(H2 ? h2Stream(sessions[i % sessions.length], i) : h1Stream(base, i));
      if (i % 100 === 99) await sleep(100);
    }
    log(`launched ${N} ${H2 ? "HTTP/2" : "HTTP/1.1"} streams in ${((Date.now() - tLaunch) / 1000).toFixed(1)}s`);

    // ---- mid-flight: stats, SIGTERM, refused connections
    let memAtPeak = "";
    let sigtermAt = 0;
    let refused = "n/a";
    if (IMAGE) {
      await sleep(Math.min(SIGTERM_AFTER, Math.max(5, SECONDS / 2)) * 1000);
      memAtPeak = docker("stats", "--no-stream", "--format", "{{.MemUsage}} / cpu {{.CPUPerc}}", containerId).stdout.trim();
      log(`container under load: ${memAtPeak}`);
      const k = docker("kill", "--signal=SIGTERM", containerId);
      if (k.status !== 0) throw new Error(`docker kill failed: ${k.stderr}`);
      sigtermAt = Date.now();
      log("SIGTERM sent");
      await sleep(1500);
      const probe = await fetch(`${base}/api/healthz`, { signal: AbortSignal.timeout(5000) }).then(
        (r) => `answered ${r.status}`,
        (e) => `refused (${(e as { cause?: { code?: string } }).cause?.code ?? String(e)})`,
      );
      refused = probe;
      log(`new connection after SIGTERM: ${probe}`);
      if (probe.startsWith("answered")) violations.push(`a NEW connection was served after SIGTERM (${probe})`);
    }

    const all = await Promise.all(results);
    const lastStreamEnd = Date.now();
    for (const s of sessions) s.close();
    const bad = all.filter((r) => !r.ok);
    const hb = all.map((r) => r.heartbeats);
    log(`streams finished: ${all.length - bad.length}/${N} complete`);
    if (bad.length) {
      violations.push(`${bad.length} stream(s) were truncated or failed`);
      const sample = bad.slice(0, 3).map((b) => `status=${b.status} done=${b.done} err=${b.error} after ${b.ms}ms`);
      log(`first failures: ${sample.join(" | ")}`);
    }

    // ---- container exit
    let exitCode: number | null = null;
    let exitAfterMs: number | null = null;
    let serverLogTail = "";
    if (IMAGE) {
      const w = spawnSync("docker", ["wait", containerId], { encoding: "utf8", timeout: 120_000 });
      exitCode = Number(w.stdout.trim());
      exitAfterMs = Date.now() - lastStreamEnd;
      serverLogTail = docker("logs", "--tail", "6", containerId).stdout.split("\n").filter((l) => /shutdown/.test(l)).join("\n");
      log(`container exited with ${exitCode} ${((Date.now() - sigtermAt) / 1000).toFixed(1)}s after SIGTERM (${(exitAfterMs / 1000).toFixed(1)}s after the last stream)`);
      if (exitCode !== 143) violations.push(`container exit code ${exitCode} (expected 143)`);
    }

    // ---- metering: nothing lost
    await sleep(IMAGE ? 500 : 3000);
    let logs = await db.requestLog.findMany({ where: { userId: fixture.userId }, select: { id: true, status: true, price: true } });
    for (let i = 0; i < 40 && logs.length < N; i++) {
      await sleep(500);
      logs = await db.requestLog.findMany({ where: { userId: fixture.userId }, select: { id: true, status: true, price: true } });
    }
    const notSuccess = logs.filter((l) => l.status !== "SUCCESS").length;
    const sum = logs.reduce((a, l) => a.plus(l.price.toString()), new Decimal(0));
    const user = await db.user.findUniqueOrThrow({ where: { id: fixture.userId } });
    const debit = new Decimal(10000).minus(user.balance.toString());
    if (logs.length !== N) violations.push(`${logs.length} RequestLog rows for ${N} requests`);
    if (notSuccess) violations.push(`${notSuccess} RequestLog rows are not SUCCESS`);
    if (!debit.equals(sum)) violations.push(`balance debit ${debit} != sum of logged prices ${sum}`);
    const minHb = Math.min(...hb);
    if (HEARTBEAT > 0 && DELAY_MS > HEARTBEAT * 1000 * 1.3 && minHb < 1) violations.push("some streams saw no heartbeat although the upstream was silent longer than the interval");

    const summary = {
      mode: IMAGE ? `docker ${IMAGE}` : `url ${EXTERNAL}`,
      protocol: H2 ? "h2c" : "http/1.1",
      streams: N,
      secondsPerStream: SECONDS,
      complete: all.length - bad.length,
      truncated: bad.length,
      streamSeconds: { min: Math.min(...all.map((r) => r.ms)) / 1000, avg: Number((all.reduce((a, r) => a + r.ms, 0) / all.length / 1000).toFixed(1)), max: Math.max(...all.map((r) => r.ms)) / 1000 },
      heartbeatsPerStream: { min: minHb, avg: Number((hb.reduce((a, b) => a + b, 0) / hb.length).toFixed(1)), max: Math.max(...hb) },
      newConnectionAfterSigterm: refused,
      containerExit: exitCode,
      exitAfterLastStreamMs: exitAfterMs,
      containerMemoryUnderLoad: memAtPeak || undefined,
      requestLogs: logs.length,
      notSuccess,
      balanceDebit: debit.toString(),
      sumOfPrices: sum.toString(),
      serverShutdownLog: serverLogTail || undefined,
      violations,
    };
    console.log(`CHAOSRESULT ${JSON.stringify(summary)}`);
    return violations.length ? 1 : 0;
  } finally {
    if (containerId) docker("rm", "-f", containerId);
    await mock.close();
    await cleanup(fixture);
    await db.$disconnect().catch(() => undefined);
    getRedis()?.disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
