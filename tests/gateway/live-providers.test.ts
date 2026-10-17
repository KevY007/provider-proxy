/**
 * fal.ai + Replicate image drivers and the OpenAI-compatible video API, end to end against the mock upstream
 * (scripts/mock-upstream.ts: /fal, /fal-queue, /replicate/v1, /v1/videos) and the real (dev) database.
 * Fixtures are created with a random suffix and removed afterwards. Skipped when the database is unreachable.
 */
process.env.GW_TEST_PERSIST = "1";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockUpstream } from "../../scripts/mock-upstream";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { handle } from "@/gateway/handle";
import { checkProviderKey } from "@/gateway/health";
import { flushMeter } from "@/gateway/meter-writer";
import { parsePath } from "@/gateway/path";
import { computeAmount, costTable, sellTable } from "@/gateway/pricing";
import { falImageSize, nearestAspectRatio } from "@/gateway/providers/image-common";
import { PROVIDER_PRESETS } from "@/gateway/providers/presets";
import { __resetSlotsForTests } from "@/gateway/slots";
import { emptyUsage } from "@/gateway/types";
import { sweepVideoJobs } from "@/gateway/video";
import { encrypt, sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";

const dbOk = await db.$queryRaw`SELECT 1`.then(
  () => true,
  () => false,
);

// ------------------------------------------------------------------ pure
describe("video / image helpers (pure)", () => {
  it("routes the /v1/videos surface", () => {
    expect(parsePath("/v1/videos", "POST")).toMatchObject({ op: "videos_create", format: "openai_videos", capability: "video" });
    expect(parsePath("/v1/videos", "GET")).toMatchObject({ op: "videos_list" });
    expect(parsePath("/v1/videos/video_abc", "GET")).toMatchObject({ op: "videos_get", videoId: "video_abc" });
    expect(parsePath("/v1/videos/video_abc", "DELETE")).toMatchObject({ op: "videos_delete", videoId: "video_abc" });
    expect(parsePath("/v1/videos/video_abc/content", "GET")).toMatchObject({ op: "videos_content", videoId: "video_abc" });
    expect(() => parsePath("/v1/videos/video_abc", "POST")).toThrow();
    expect(() => parsePath("/v1/videos/a/b/c", "GET")).toThrow();
  });

  it("bills video by the second (price, cost and multiplier)", () => {
    const sell = sellTable({ inputPrice: 0, outputPrice: 0, perSecondPrice: "0.13" });
    const cost = costTable({ inputCost: 0, outputCost: 0, perSecondCost: "0.10" });
    const u = { ...emptyUsage(), videoSeconds: 8 };
    expect(computeAmount(u, sell).toString()).toBe("1.04");
    expect(computeAmount(u, cost).toString()).toBe("0.8");
    expect(computeAmount(u, sell, { multiplier: "0.5" }).toString()).toBe("0.52");
    expect(computeAmount(emptyUsage(), sell).toString()).toBe("0");
  });

  it("maps OpenAI sizes onto fal image_size / Replicate aspect_ratio", () => {
    expect(falImageSize({ w: 1024, h: 1024 })).toBe("square_hd");
    expect(falImageSize({ w: 1536, h: 1024 })).toEqual({ width: 1536, height: 1024 });
    expect(nearestAspectRatio(1024, 1024)).toBe("1:1");
    expect(nearestAspectRatio(1536, 1024)).toBe("3:2");
    expect(nearestAspectRatio(1024, 1792)).toBe("9:16");
    expect(nearestAspectRatio(1792, 1024)).toBe("16:9");
  });

  it("ships fal and replicate presets with the images format and the OpenAI preset serves videos", () => {
    const fal = PROVIDER_PRESETS.find((p) => p.id === "fal");
    const rep = PROVIDER_PRESETS.find((p) => p.id === "replicate");
    expect(fal?.formats).toContain("openai_images");
    expect(rep?.formats).toContain("openai_images");
    expect(PROVIDER_PRESETS.find((p) => p.id === "openai")?.formats).toContain("openai_videos");
  });
});

// ------------------------------------------------------------------ fixtures
const sfx = String(Math.floor(Math.random() * 1e8)).padStart(8, "0"); // digits only: mock keys containing "bad"/"slow"/"fail" trigger faults
const name = (s: string) => `lpt-${s}-${sfx}`;
const secret = (s: string) => `lpt-key-${s}-${sfx}`;
const apiKey = (tag: string) => `sk-pp-lpt${tag}${sfx}`.padEnd(46, "0");

const ids = { users: [] as string[], keys: [] as string[], providers: [] as string[], models: [] as string[], groups: [] as string[], logs: [] as string[] };
let mock: Awaited<ReturnType<typeof startMockUpstream>>;
let base = "";
let groupId = "";

interface Fx {
  userId: string;
  key: string;
  keyId: string;
}
const fx: Record<string, Fx> = {};
const P: Record<string, { id: string; keys: string[] }> = {};
const M: Record<string, string> = {};

async function makeUser(tag: string, balance = "20") {
  const u = await db.user.create({ data: { email: `${name(tag)}@test.local`, passwordHash: "x", status: "ACTIVE", emailVerifiedAt: new Date(), balance, groupId } });
  ids.users.push(u.id);
  const key = apiKey(tag);
  const k = await db.apiKey.create({ data: { userId: u.id, name: name(tag), prefix: key.slice(0, 12), keyHash: sha256(key) } });
  ids.keys.push(k.id);
  fx[tag] = { userId: u.id, key, keyId: k.id };
  return fx[tag];
}

async function makeProvider(tag: string, o: { preset: string; formats: string[]; baseUrl: string; settings?: object; keys: Array<{ s: string; priority?: number }> }) {
  const p = await db.provider.create({
    data: { name: name(tag), slug: name(tag), preset: o.preset, baseUrl: o.baseUrl, authStyle: "BEARER", formats: o.formats, tags: ["mock"], settings: o.settings ?? {}, timeoutMs: 30_000 },
  });
  ids.providers.push(p.id);
  const keys: string[] = [];
  for (const k of o.keys) {
    const pk = await db.providerKey.create({ data: { providerId: p.id, label: `${tag}-${k.s}`, secretEncrypted: encrypt(secret(k.s)), secretHint: "test", priority: k.priority ?? 0 } });
    keys.push(pk.id);
  }
  return { id: p.id, keys };
}

async function makeModel(tag: string, o: { caps: string[]; providerId: string; upstream: string; image?: boolean; perSecond?: boolean; route?: Record<string, unknown> }) {
  const slug = name(tag);
  const m = await db.model.create({
    data: {
      slug,
      displayName: slug,
      vendor: "lpt",
      capabilities: o.caps,
      inputPrice: "0",
      outputPrice: "0",
      imagePrice: o.image ? "0.05" : null,
      perSecondPrice: o.perSecond ? "0.2" : null,
    },
  });
  ids.models.push(m.id);
  await db.modelRoute.create({
    data: { modelId: m.id, providerId: o.providerId, upstreamModel: o.upstream, imageCost: o.image ? "0.02" : null, perSecondCost: o.perSecond ? "0.1" : null, ...o.route },
  });
  return slug;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(path: string, key: string | null, body?: unknown, o: { method?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const isForm = body instanceof FormData;
  const headers: Record<string, string> = { ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}), ...o.headers };
  const res = await handle(
    new Request(`http://gateway.test${path}`, { method: o.method ?? (body === undefined ? "GET" : "POST"), headers, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) }),
  );
  const id = res.headers.get("x-request-id");
  expect(id, "every response carries x-request-id").toBeTruthy();
  ids.logs.push(id!);
  return res;
}

async function logOf(res: Response) {
  const id = res.headers.get("x-request-id")!;
  for (let i = 0; i < 100; i++) {
    await flushMeter();
    const row = await db.requestLog.findUnique({ where: { id } });
    if (row) return row;
    await sleep(20);
  }
  return db.requestLog.findUniqueOrThrow({ where: { id } });
}

const balanceOf = async (userId: string) => {
  await flushMeter();
  return new Decimal((await db.user.findUniqueOrThrow({ where: { id: userId } })).balance.toString());
};
const dec = (v: { toString(): string }) => new Decimal(v.toString());
const mockLast = async (path: string) => (await fetch(`${base}/__mock/last?path=${encodeURIComponent(path)}`)).json() as Promise<{ headers: Record<string, string>; body: Record<string, unknown>; query: Record<string, string> }>;
const mockStats = async () => (await fetch(`${base}/__mock/stats`)).json() as Promise<{ byKey: Record<string, { total: number }>; byPath: Record<string, number> }>;

const imgSell = sellTable({ inputPrice: 0, outputPrice: 0, imagePrice: "0.05" });
const imgCost = costTable({ inputCost: 0, outputCost: 0, imageCost: "0.02" });
const vidSell = sellTable({ inputPrice: 0, outputPrice: 0, perSecondPrice: "0.2" });
const vidCost = costTable({ inputCost: 0, outputCost: 0, perSecondCost: "0.1" });

async function createVideo(who: string, model: string, extra: Record<string, unknown> = {}) {
  const res = await call("/v1/videos", fx[who].key, { model, prompt: "a calm lake at dawn", seconds: "8", size: "1280x720", ...extra });
  return { res, body: res.status === 200 ? await res.clone().json() : await res.clone().json().catch(() => null) };
}

describe.skipIf(!dbOk)("fal.ai + Replicate images and the video API (mock upstream + database)", () => {
  beforeAll(async () => {
    __resetSlotsForTests();
    mock = await startMockUpstream(0, "127.0.0.1");
    base = `http://127.0.0.1:${mock.port}`;
    const g = await db.group.create({ data: { name: name("g"), slug: name("g"), priceMultiplier: "1" } });
    ids.groups.push(g.id);
    groupId = g.id;

    P.fal = await makeProvider("fal", { preset: "fal", formats: ["openai_images"], baseUrl: `${base}/fal`, settings: { queueBaseUrl: `${base}/fal-queue`, falMode: "sync" }, keys: [{ s: "fal1" }] });
    P.falAuto = await makeProvider("falauto", { preset: "fal", formats: ["openai_images"], baseUrl: `${base}/fal`, settings: { queueBaseUrl: `${base}/fal-queue`, falMode: "auto" }, keys: [{ s: "fala" }] });
    P.falQueue = await makeProvider("falq", { preset: "fal", formats: ["openai_images"], baseUrl: `${base}/fal`, settings: { queueBaseUrl: `${base}/fal-queue`, falMode: "queue" }, keys: [{ s: "falq1" }] });
    P.falFo = await makeProvider("falfo", { preset: "fal", formats: ["openai_images"], baseUrl: `${base}/fal`, settings: { falMode: "sync" }, keys: [{ s: "fail429f", priority: 10 }, { s: "goodf" }] });
    P.falBad = await makeProvider("falbad", { preset: "fal", formats: ["openai_images"], baseUrl: `${base}/fal`, settings: { falMode: "sync" }, keys: [{ s: "badf" }] });
    P.rep = await makeProvider("rep", { preset: "replicate", formats: ["openai_images"], baseUrl: `${base}/replicate/v1`, settings: { replicateWait: 20 }, keys: [{ s: "rep1" }] });
    P.repPoll = await makeProvider("reppoll", { preset: "replicate", formats: ["openai_images"], baseUrl: `${base}/replicate/v1`, keys: [{ s: "rep2" }] });
    P.repFo = await makeProvider("repfo", { preset: "replicate", formats: ["openai_images"], baseUrl: `${base}/replicate/v1`, keys: [{ s: "fail500r", priority: 10 }, { s: "goodr" }] });
    P.vid = await makeProvider("vid", { preset: "openai", formats: ["openai_videos"], baseUrl: `${base}/v1`, keys: [{ s: "vidA", priority: 10 }, { s: "vidB" }] });
    P.falVid = await makeProvider("falvid", { preset: "fal", formats: ["openai_videos"], baseUrl: `${base}/fal`, settings: { queueBaseUrl: `${base}/fal-queue` }, keys: [{ s: "falv1" }] });
    P.vidNoPrice = await makeProvider("vidnp", { preset: "openai", formats: ["openai_videos"], baseUrl: `${base}/v1`, keys: [{ s: "vidnp1" }] });

    M.fal = await makeModel("fal", { caps: ["images"], providerId: P.fal.id, upstream: "fal-ai/flux/schnell", image: true, route: { paramOverrides: { enable_safety_checker: false } } });
    M.falAuto = await makeModel("falauto", { caps: ["images"], providerId: P.falAuto.id, upstream: "fal-ai/flux/schnell", image: true });
    M.falQueue = await makeModel("falq", { caps: ["images"], providerId: P.falQueue.id, upstream: "fal-ai/flux/schnell", image: true });
    M.falFo = await makeModel("falfo", { caps: ["images"], providerId: P.falFo.id, upstream: "fal-ai/flux/dev", image: true });
    M.falBad = await makeModel("falbad", { caps: ["images"], providerId: P.falBad.id, upstream: "fal-ai/flux/dev", image: true });
    M.rep = await makeModel("rep", { caps: ["images"], providerId: P.rep.id, upstream: "black-forest-labs/flux-schnell", image: true });
    M.repPoll = await makeModel("reppoll", { caps: ["images"], providerId: P.repPoll.id, upstream: "black-forest-labs/flux-poll", image: true });
    M.repPinned = await makeModel("reppin", { caps: ["images"], providerId: P.rep.id, upstream: "owner/model:abc123def456", image: true });
    M.repFo = await makeModel("repfo", { caps: ["images"], providerId: P.repFo.id, upstream: "black-forest-labs/flux-dev", image: true });
    M.vid = await makeModel("vid", { caps: ["video"], providerId: P.vid.id, upstream: "sora-mock", perSecond: true });
    M.falVid = await makeModel("falvid", { caps: ["video"], providerId: P.falVid.id, upstream: "fal-ai/kling-video/v2.1/master/text-to-video", perSecond: true });
    M.vidNoPrice = await makeModel("vidnp", { caps: ["video"], providerId: P.vidNoPrice.id, upstream: "sora-mock" });

    await makeUser("a");
    await makeUser("b");
    await makeUser("c", "0.5");
    await invalidateGatewayConfig("all");
  }, 60_000);

  afterAll(async () => {
    try {
      await flushMeter();
    } catch {
      /* ignore */
    }
    await db.videoJob.deleteMany({ where: { userId: { in: ids.users } } }).catch(() => undefined);
    await db.ledgerEntry.deleteMany({ where: { userId: { in: ids.users } } }).catch(() => undefined);
    await db.requestLog.deleteMany({ where: { OR: [{ id: { in: ids.logs } }, { userId: { in: ids.users } }] } }).catch(() => undefined);
    await db.apiKey.deleteMany({ where: { id: { in: ids.keys } } }).catch(() => undefined);
    await db.modelRoute.deleteMany({ where: { modelId: { in: ids.models } } }).catch(() => undefined);
    await db.model.deleteMany({ where: { id: { in: ids.models } } }).catch(() => undefined);
    await db.provider.deleteMany({ where: { id: { in: ids.providers } } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: { in: ids.users } } }).catch(() => undefined);
    await db.group.deleteMany({ where: { id: { in: ids.groups } } }).catch(() => undefined);
    await invalidateGatewayConfig("all");
    await mock?.close();
  }, 30_000);

  // ------------------------------------------------------------------ fal.ai
  it("fal: maps n/size/seed, authenticates with 'Key', bills per image and meters exactly", async () => {
    const before = await balanceOf(fx.a.userId);
    const res = await call("/v1/images/generations", fx.a.key, { model: M.fal, prompt: "a red fox", n: 2, size: "1024x1024", seed: 7, response_format: "url", extra_input: { guidance_scale: 3.5 } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__mock\/img\//);
    expect(typeof body.created).toBe("number");

    const last = await mockLast("/fal/fal-ai/flux/schnell");
    expect(last.headers.authorization).toBe(`Key ${secret("fal1")}`);
    expect(last.body).toMatchObject({ prompt: "a red fox", image_size: "square_hd", num_images: 2, seed: 7, guidance_scale: 3.5, enable_safety_checker: false }); // route paramOverrides applied
    expect(JSON.stringify(last.headers)).not.toContain(fx.a.key);

    const log = await logOf(res);
    expect(log).toMatchObject({ status: "SUCCESS", httpStatus: 200, imageCount: 2, endpoint: "/v1/images/generations", inboundFormat: "openai_images", upstreamModel: "fal-ai/flux/schnell" });
    const price = computeAmount({ ...emptyUsage(), imageCount: 2 }, imgSell);
    const cost = computeAmount({ ...emptyUsage(), imageCount: 2 }, imgCost);
    expect(price.toString()).toBe("0.1");
    expect(dec(log.price).equals(price)).toBe(true);
    expect(dec(log.cost).equals(cost)).toBe(true);
    expect(dec(log.profit).equals(price.minus(cost))).toBe(true);
    expect(before.minus(await balanceOf(fx.a.userId)).equals(price)).toBe(true);
  });

  it("fal: response_format=b64_json downloads and base64-encodes the image", async () => {
    const res = await call("/v1/images/generations", fx.a.key, { model: M.fal, prompt: "a blue whale", response_format: "b64_json", size: "1536x1024" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].url).toBeUndefined();
    const bytes = Buffer.from(body.data[0].b64_json, "base64");
    expect(bytes.subarray(0, 4).toString("hex")).toBe("89504e47"); // PNG
    expect((await mockLast("/fal/fal-ai/flux/schnell")).body.image_size).toEqual({ width: 1536, height: 1024 });
  });

  it("fal: validation errors become 400 invalid_request in OpenAI shape, without failover", async () => {
    const bad = await call("/v1/images/generations", fx.a.key, { model: M.fal, prompt: "x [[fal422]]" });
    expect(bad.status).toBe(400);
    const j = await bad.json();
    expect(j.error.type).toBe("invalid_request_error");
    expect(j.error.message).toContain("image_size is not valid");
    expect(JSON.stringify(j)).not.toContain("127.0.0.1");
    const log = await logOf(bad);
    expect(log.status).toBe("CLIENT_ERROR");
    expect((log.attempts as unknown[]).length).toBe(1);
    expect(dec(log.price).isZero()).toBe(true);

    const noPrompt = await call("/v1/images/generations", fx.a.key, { model: M.fal, n: 1 });
    expect(noPrompt.status).toBe(400);
    expect((await noPrompt.json()).error.param).toBe("prompt");
    const badN = await call("/v1/images/generations", fx.a.key, { model: M.fal, prompt: "x", n: 99 });
    expect(badN.status).toBe(400);
  });

  it("fal: auto mode falls back to the queue API when the sync endpoint times out", async () => {
    const res = await call("/v1/images/generations", fx.a.key, { model: M.falAuto, prompt: "queue me [[sync504]]", n: 3 });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(3);
    const q = await mockLast("/fal-queue/fal-ai/flux/schnell");
    expect(q.headers.authorization).toBe(`Key ${secret("fala")}`);
    expect(q.body).toMatchObject({ num_images: 3 });
    const stats = await mockStats();
    expect(Object.keys(stats.byPath).some((p) => p.includes("/requests/") && p.endsWith("/status"))).toBe(true);
    const log = await logOf(res);
    expect(log).toMatchObject({ status: "SUCCESS", imageCount: 3 });
  });

  it("fal: queue mode submits, polls and fetches the result", async () => {
    const res = await call("/v1/images/generations", fx.a.key, { model: M.falQueue, prompt: "long job" });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(1);
  });

  it("fal: a rate-limited key fails over to the next key; a bad key surfaces as an unavailable provider", async () => {
    const res = await call("/v1/images/generations", fx.a.key, { model: M.falFo, prompt: "failover" });
    expect(res.status).toBe(200);
    const log = await logOf(res);
    const attempts = log.attempts as Array<{ status: number }>;
    expect(attempts.map((a) => a.status)).toEqual([429, 200]);
    expect((await mockLast("/fal/fal-ai/flux/dev")).headers.authorization).toBe(`Key ${secret("goodf")}`);

    const bad = await call("/v1/images/generations", fx.a.key, { model: M.falBad, prompt: "nope" });
    expect([502, 503]).toContain(bad.status);
    const bj = await bad.json();
    expect(JSON.stringify(bj)).not.toContain("fal");
    expect(JSON.stringify(bj)).not.toContain(secret("badf"));
  });

  it("fal/replicate: only /v1/images/generations is supported (edits -> 400 unsupported_endpoint)", async () => {
    const form = new FormData();
    form.set("model", M.fal);
    form.set("prompt", "edit");
    form.set("image", new Blob([Buffer.from("x")], { type: "image/png" }), "a.png");
    const res = await call("/v1/images/edits", fx.a.key, form);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("unsupported_endpoint");
  });

  // ------------------------------------------------------------------ Replicate
  it("replicate: polls by default (no Prefer header) until the prediction succeeds", async () => {
    const res = await call("/v1/images/generations", fx.a.key, { model: M.repPoll, prompt: "default polling mode" });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(1);
    const last = await mockLast("/replicate/v1/models/black-forest-labs/flux-poll/predictions");
    expect(last.headers.authorization).toBe(`Bearer ${secret("rep2")}`);
    expect(last.headers.prefer).toBeUndefined();
    const stats = await mockStats();
    expect(Object.keys(stats.byPath).some((p) => p.startsWith("/replicate/v1/predictions/"))).toBe(true); // polled urls.get
  });

  it("replicate: Prefer: wait (replicateWait), aspect_ratio / num_outputs / seed mapping, Bearer auth, per-image billing", async () => {
    const before = await balanceOf(fx.a.userId);
    const res = await call("/v1/images/generations", fx.a.key, { model: M.rep, prompt: "a lighthouse", n: 2, size: "1536x1024", seed: 11, output_format: "jpeg", extra_input: { go_fast: true } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].url).toMatch(/__mock\/img\//);

    const last = await mockLast("/replicate/v1/models/black-forest-labs/flux-schnell/predictions");
    expect(last.headers.authorization).toBe(`Bearer ${secret("rep1")}`);
    expect(last.headers.prefer).toBe("wait=20");
    expect(last.body).toEqual({ input: { prompt: "a lighthouse", aspect_ratio: "3:2", num_outputs: 2, seed: 11, output_format: "jpg", go_fast: true } });

    const log = await logOf(res);
    expect(log).toMatchObject({ status: "SUCCESS", imageCount: 2, upstreamModel: "black-forest-labs/flux-schnell" });
    const price = computeAmount({ ...emptyUsage(), imageCount: 2 }, imgSell);
    expect(dec(log.price).equals(price)).toBe(true);
    expect(before.minus(await balanceOf(fx.a.userId)).equals(price)).toBe(true);
  });

  it("replicate: polls urls.get when the prediction does not finish inside Prefer: wait; b64_json works", async () => {
    const res = await call("/v1/images/generations", fx.a.key, { model: M.rep, prompt: "slow one [[slowpred]]", response_format: "b64_json" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Buffer.from(body.data[0].b64_json, "base64").subarray(0, 4).toString("hex")).toBe("89504e47");
    const stats = await mockStats();
    expect(Object.keys(stats.byPath).some((p) => p.startsWith("/replicate/v1/predictions/"))).toBe(true);
  });

  it("replicate: version-pinned owner/name:version goes through /v1/predictions", async () => {
    const res = await call("/v1/images/generations", fx.a.key, { model: M.repPinned, prompt: "pinned" });
    expect(res.status).toBe(200);
    const last = await mockLast("/replicate/v1/predictions");
    expect(last.body).toMatchObject({ version: "abc123def456", input: { prompt: "pinned" } });
  });

  it("replicate: a failed prediction surfaces as 502 (not retried), content-safety rejections as 400, 422 as 400", async () => {
    const failed = await call("/v1/images/generations", fx.a.key, { model: M.rep, prompt: "boom [[predfail]]" });
    expect(failed.status).toBe(502);
    expect((await failed.json()).error.code).toBe("upstream_error");
    const failedLog = await logOf(failed);
    expect(failedLog.status).toBe("UPSTREAM_ERROR");
    expect((failedLog.attempts as unknown[]).length).toBe(1); // a failed prediction is not retried (and paid for) again
    expect(dec(failedLog.price).isZero()).toBe(true);

    const nsfw = await call("/v1/images/generations", fx.a.key, { model: M.rep, prompt: "x [[prednsfw]]" });
    expect(nsfw.status).toBe(400);
    expect((await nsfw.json()).error.message).toContain("content safety");

    const bad = await call("/v1/images/generations", fx.a.key, { model: M.rep, prompt: "x [[pred422]]" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toContain("aspect_ratio");
  });

  it("replicate: a failing key (500) fails over to the next key", async () => {
    const res = await call("/v1/images/generations", fx.a.key, { model: M.repFo, prompt: "failover" });
    expect(res.status).toBe(200);
    expect(((await logOf(res)).attempts as Array<{ status: number }>).map((a) => a.status)).toEqual([500, 200]);
  });

  it("health: fal and replicate keys are probed with a cheap authenticated call", async () => {
    const ok1 = await checkProviderKey(P.fal.keys[0]);
    expect(ok1.ok).toBe(true);
    const ok2 = await checkProviderKey(P.rep.keys[0]);
    expect(ok2.ok).toBe(true);
    const bad1 = await checkProviderKey(P.falBad.keys[0]);
    expect(bad1.ok).toBe(false);
    expect(bad1.error).toContain("401");
  });

  // ------------------------------------------------------------------ videos
  it("video: create charges seconds x price at creation, masks the model, and stays sticky to the creating key", async () => {
    const before = await balanceOf(fx.a.userId);
    const { res, body } = await createVideo("a", M.vid, { seconds: 8 }); // number is normalised to the string enum upstream
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ object: "video", model: M.vid, status: "queued", seconds: "8", size: "1280x720" });
    expect(body.id).toMatch(/^video_[0-9a-f]{48}$/);
    expect(body.id).not.toContain("mock");

    const sent = await mockLast("/v1/videos");
    expect(sent.body).toMatchObject({ model: "sora-mock", prompt: "a calm lake at dawn", seconds: "8" });
    expect(sent.headers.authorization).toBe(`Bearer ${secret("vidA")}`);

    const log = await logOf(res);
    expect(log).toMatchObject({ status: "SUCCESS", endpoint: "/v1/videos", inboundFormat: "openai_videos", videoSeconds: 8, upstreamModel: "sora-mock" });
    const price = computeAmount({ ...emptyUsage(), videoSeconds: 8 }, vidSell);
    const cost = computeAmount({ ...emptyUsage(), videoSeconds: 8 }, vidCost);
    expect(price.toString()).toBe("1.6");
    expect(dec(log.price).equals(price)).toBe(true);
    expect(dec(log.cost).equals(cost)).toBe(true);
    expect(before.minus(await balanceOf(fx.a.userId)).equals(price)).toBe(true);

    const job = await db.videoJob.findUniqueOrThrow({ where: { id: body.id } });
    expect(job).toMatchObject({ userId: fx.a.userId, providerKeyId: P.vid.keys[0], status: "queued", refunded: false, requestId: log.id });
    expect(job.upstreamId).toMatch(/^video_mock_/);
    expect(dec(job.price).equals(price)).toBe(true);
  });

  it("video: status polls, content download (video/thumbnail/range) and ownership", async () => {
    const { body } = await createVideo("a", M.vid, { seconds: "4" });
    const id = body.id as string;

    const s1 = await (await call(`/v1/videos/${id}`, fx.a.key)).json();
    expect(s1).toMatchObject({ id, object: "video", model: M.vid, status: "in_progress", progress: 50 });
    const early = await call(`/v1/videos/${id}/content`, fx.a.key);
    expect([400, 404]).toContain(early.status); // not ready yet
    await early.arrayBuffer();

    const s2 = await (await call(`/v1/videos/${id}`, fx.a.key)).json();
    expect(s2).toMatchObject({ id, status: "completed", progress: 100 });
    expect(JSON.stringify(s2)).not.toContain("video_mock");

    const content = await call(`/v1/videos/${id}/content`, fx.a.key);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("video/mp4");
    const bytes = Buffer.from(await content.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(4, 12).toString()).toBe("ftypmp42");

    const thumb = await call(`/v1/videos/${id}/content?variant=thumbnail`, fx.a.key);
    expect(thumb.headers.get("content-type")).toBe("image/webp");
    await thumb.arrayBuffer();
    const upstreamId = (await db.videoJob.findUniqueOrThrow({ where: { id } })).upstreamId;
    expect((await mockLast(`/v1/videos/${upstreamId}/content`)).query).toEqual({ variant: "thumbnail" });

    const ranged = await call(`/v1/videos/${id}/content`, fx.a.key, undefined, { headers: { range: "bytes=0-99" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toMatch(/^bytes 0-99\//);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);

    const badVariant = await call(`/v1/videos/${id}/content?variant=bogus`, fx.a.key);
    expect(badVariant.status).toBe(400);

    // another customer cannot see it, whatever the endpoint
    for (const [path, method] of [
      [`/v1/videos/${id}`, "GET"],
      [`/v1/videos/${id}/content`, "GET"],
      [`/v1/videos/${id}`, "DELETE"],
    ] as const) {
      const r = await call(path, fx.b.key, undefined, { method });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect((await r.json()).error.code).toBe("not_found");
    }
    const unknown = await call("/v1/videos/video_does_not_exist", fx.a.key);
    expect(unknown.status).toBe(404);

    // the content download itself is free (already charged at creation)
    const clog = await logOf(content);
    expect(dec(clog.price).isZero()).toBe(true);
    expect(clog.endpoint).toBe("/v1/videos/{id}/content");
  });

  it("video: follows a CDN redirect of the content endpoint", async () => {
    const { body } = await createVideo("a", M.vid, { prompt: "served from a CDN [[vidredirect]]", seconds: "4" });
    await call(`/v1/videos/${body.id}`, fx.a.key);
    await call(`/v1/videos/${body.id}`, fx.a.key);
    const content = await call(`/v1/videos/${body.id}/content`, fx.a.key);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("video/mp4");
    expect((await content.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it("video: list returns only the caller's videos, newest first, with pagination", async () => {
    const { body: v1 } = await createVideo("b", M.vid, { seconds: "4" });
    const { body: v2 } = await createVideo("b", M.vid, { seconds: "4" });
    const all = await (await call("/v1/videos", fx.b.key)).json();
    expect(all.object).toBe("list");
    expect(all.data.map((v: { id: string }) => v.id)).toEqual([v2.id, v1.id]);
    expect(all.has_more).toBe(false);
    expect(all.data.every((v: { model: string }) => v.model === M.vid)).toBe(true);

    const page1 = await (await call("/v1/videos?limit=1", fx.b.key)).json();
    expect(page1.data).toHaveLength(1);
    expect(page1.has_more).toBe(true);
    const page2 = await (await call(`/v1/videos?limit=1&after=${page1.last_id}`, fx.b.key)).json();
    expect(page2.data[0].id).toBe(v1.id);
    expect(page2.has_more).toBe(false);

    const other = await (await call("/v1/videos", fx.c.key)).json();
    expect(other.data).toEqual([]);
    const badCursor = await call(`/v1/videos?after=${v1.id}`, fx.c.key);
    expect(badCursor.status).toBe(400);
  });

  it("video: a job that fails upstream is refunded exactly once (ledger REFUND), however often it is polled", async () => {
    const before = await balanceOf(fx.a.userId);
    const { body, res } = await createVideo("a", M.vid, { prompt: "something blocked [[vidfail]]", seconds: "4" });
    const price = computeAmount({ ...emptyUsage(), videoSeconds: 4 }, vidSell);
    expect(price.toString()).toBe("0.8");
    expect(before.minus(await balanceOf(fx.a.userId)).equals(price)).toBe(true);
    await logOf(res);

    expect((await (await call(`/v1/videos/${body.id}`, fx.a.key)).json()).status).toBe("in_progress");
    const failed = await (await call(`/v1/videos/${body.id}`, fx.a.key)).json();
    expect(failed).toMatchObject({ status: "failed", error: { code: "moderation_blocked" } });
    expect((await balanceOf(fx.a.userId)).equals(before)).toBe(true); // charge returned

    await call(`/v1/videos/${body.id}`, fx.a.key);
    await call(`/v1/videos/${body.id}`, fx.a.key);
    expect((await balanceOf(fx.a.userId)).equals(before)).toBe(true); // not refunded twice

    const ledger = await db.ledgerEntry.findMany({ where: { userId: fx.a.userId, type: "REFUND" } });
    expect(ledger).toHaveLength(1);
    expect(dec(ledger[0].amount).equals(price)).toBe(true);
    expect(ledger[0].metadata).toMatchObject({ videoId: body.id });
    const job = await db.videoJob.findUniqueOrThrow({ where: { id: body.id } });
    expect(job).toMatchObject({ status: "failed", refunded: true });

    const content = await call(`/v1/videos/${body.id}/content`, fx.a.key);
    expect(content.status).toBe(404);
    await content.arrayBuffer();
  });

  it("video: the cron sweep polls open jobs and refunds failures nobody asked about", async () => {
    const { body } = await createVideo("a", M.vid, { prompt: "blocked too [[vidfail]]", seconds: "4" });
    const before = await balanceOf(fx.a.userId);
    await db.videoJob.update({ where: { id: body.id }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    for (let i = 0; i < 3; i++) await sweepVideoJobs(100); // queued -> in_progress -> failed
    expect((await db.videoJob.findUniqueOrThrow({ where: { id: body.id } })).refunded).toBe(true);
    expect((await balanceOf(fx.a.userId)).minus(before).equals(computeAmount({ ...emptyUsage(), videoSeconds: 4 }, vidSell))).toBe(true);
  });

  it("video: status/content keep going to the key that created the job even when the key order changes", async () => {
    const { body } = await createVideo("a", M.vid, { seconds: "4" });
    await db.providerKey.update({ where: { id: P.vid.keys[1] }, data: { priority: 100 } }); // key B is now preferred for NEW jobs
    await invalidateGatewayConfig("all");
    const stats0 = await mockStats();
    await call(`/v1/videos/${body.id}`, fx.a.key);
    await call(`/v1/videos/${body.id}`, fx.a.key);
    const content = await call(`/v1/videos/${body.id}/content`, fx.a.key);
    await content.arrayBuffer();
    const stats1 = await mockStats();
    const delta = (k: string) => (stats1.byKey[secret(k)]?.total ?? 0) - (stats0.byKey[secret(k)]?.total ?? 0);
    expect(delta("vidA")).toBe(3);
    expect(delta("vidB")).toBe(0);
    const fresh = await createVideo("a", M.vid, { seconds: "4" });
    expect((await db.videoJob.findUniqueOrThrow({ where: { id: fresh.body.id } })).providerKeyId).toBe(P.vid.keys[1]);
    await db.providerKey.update({ where: { id: P.vid.keys[1] }, data: { priority: 0 } });
    await invalidateGatewayConfig("all");
  });

  it("video: DELETE removes the job upstream and for the customer", async () => {
    const { body } = await createVideo("a", M.vid, { seconds: "4" });
    const del = await call(`/v1/videos/${body.id}`, fx.a.key, undefined, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ id: body.id, object: "video.deleted", deleted: true });
    expect((await call(`/v1/videos/${body.id}`, fx.a.key)).status).toBe(404);
    const list = await (await call("/v1/videos", fx.a.key)).json();
    expect(list.data.some((v: { id: string }) => v.id === body.id)).toBe(false);
  });

  it("video: multipart create (input_reference) is accepted and forwarded", async () => {
    const form = new FormData();
    form.set("model", M.vid);
    form.set("prompt", "animate this picture");
    form.set("seconds", "4");
    form.set("size", "720x1280");
    form.set("input_reference", new Blob([Buffer.alloc(64, 1)], { type: "image/png" }), "ref.png");
    const res = await call("/v1/videos", fx.a.key, form);
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v).toMatchObject({ model: M.vid, size: "720x1280", seconds: "4" });
    const last = (await mockLast("/v1/videos")) as unknown as { multipart: { fields: Record<string, string>; files: Array<{ name: string; size: number }> } };
    expect(last.multipart.fields).toMatchObject({ model: "sora-mock", prompt: "animate this picture", seconds: "4" });
    expect(last.multipart.files[0]).toMatchObject({ name: "input_reference", size: 64 });
    const log = await logOf(res);
    expect(log.videoSeconds).toBe(4);
  });

  it("fal video: queue submit, status polling, CDN streaming without credentials, billed by the second", async () => {
    const before = await balanceOf(fx.a.userId);
    const { res, body } = await createVideo("a", M.falVid, { seconds: 5, size: "720x1280", extra_input: { cfg_scale: 0.5 } });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ object: "video", model: M.falVid, status: "queued", seconds: "5", size: "720x1280" });
    expect(body.id).toMatch(/^video_[0-9a-f]{48}$/);

    const q = await mockLast("/fal-queue/fal-ai/kling-video/v2.1/master/text-to-video");
    expect(q.headers.authorization).toBe(`Key ${secret("falv1")}`);
    expect(q.body).toEqual({ prompt: "a calm lake at dawn", duration: "5", aspect_ratio: "9:16", cfg_scale: 0.5 });

    const log = await logOf(res);
    expect(log).toMatchObject({ status: "SUCCESS", videoSeconds: 5, upstreamModel: "fal-ai/kling-video/v2.1/master/text-to-video" });
    const price = computeAmount({ ...emptyUsage(), videoSeconds: 5 }, vidSell);
    expect(price.toString()).toBe("1");
    expect(dec(log.price).equals(price)).toBe(true);
    expect(dec(log.cost).equals(computeAmount({ ...emptyUsage(), videoSeconds: 5 }, vidCost))).toBe(true);
    expect(before.minus(await balanceOf(fx.a.userId)).equals(price)).toBe(true);

    const job0 = await db.videoJob.findUniqueOrThrow({ where: { id: body.id } });
    expect((job0.meta as { statusUrl: string }).statusUrl).toContain("/requests/");

    const statuses: string[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await (await call(`/v1/videos/${body.id}`, fx.a.key)).json()).status);
    expect(statuses).toEqual(["queued", "in_progress", "completed"]);

    const job = await db.videoJob.findUniqueOrThrow({ where: { id: body.id } });
    const videoUrl = (job.meta as { videoUrl: string }).videoUrl;
    expect(videoUrl).toMatch(/__mock\/media\/fal-/);

    const content = await call(`/v1/videos/${body.id}/content`, fx.a.key);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("video/mp4");
    expect((await content.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    const mediaPath = new URL(videoUrl).pathname;
    expect((await mockLast(mediaPath)).headers.authorization).toBeUndefined(); // our fal key never goes to the CDN

    const ranged = await call(`/v1/videos/${body.id}/content`, fx.a.key, undefined, { headers: { range: "bytes=10-19" } });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(10);

    const thumb = await call(`/v1/videos/${body.id}/content?variant=thumbnail`, fx.b.key);
    expect(thumb.status).toBe(404); // other customer: not found
    await thumb.arrayBuffer();
    const thumbOwn = await call(`/v1/videos/${body.id}/content?variant=thumbnail`, fx.a.key);
    expect(thumbOwn.status).toBe(404); // fal results only have the video itself
    await thumbOwn.arrayBuffer();
  });

  it("fal video: a job that ends in an error is refunded once; DELETE cancels it in the fal queue", async () => {
    const before = await balanceOf(fx.a.userId);
    const { body } = await createVideo("a", M.falVid, { prompt: "blocked [[vidfail]]", seconds: 5 });
    expect(before.minus(await balanceOf(fx.a.userId)).toString()).toBe("1");
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) seen.push((await (await call(`/v1/videos/${body.id}`, fx.a.key)).json()).status);
    expect(seen.slice(0, 3)).toEqual(["queued", "in_progress", "failed"]);
    expect((await balanceOf(fx.a.userId)).equals(before)).toBe(true);
    expect(await db.ledgerEntry.count({ where: { userId: fx.a.userId, type: "REFUND", metadata: { path: ["videoId"], equals: body.id } } })).toBe(1);
    const failed = await (await call(`/v1/videos/${body.id}`, fx.a.key)).json();
    expect(failed.error).toMatchObject({ code: "generation_failed" });
    expect(JSON.stringify(failed)).not.toContain("Content policy"); // vendor detail stays internal

    const { body: second } = await createVideo("a", M.falVid, { seconds: 5 });
    const del = await call(`/v1/videos/${second.id}`, fx.a.key, undefined, { method: "DELETE" });
    expect(del.status).toBe(200);
    const job = await db.videoJob.findUniqueOrThrow({ where: { id: second.id } });
    const stats = await mockStats();
    expect(Object.keys(stats.byPath).some((p) => p.includes(`/requests/${job.upstreamId}/cancel`))).toBe(true);
    expect((await call(`/v1/videos/${second.id}`, fx.a.key)).status).toBe(404);
  });

  it("video: validation, capability, pricing and balance guards", async () => {
    const badSeconds = await call("/v1/videos", fx.a.key, { model: M.vid, prompt: "x", seconds: "abc" });
    expect(badSeconds.status).toBe(400);
    expect((await badSeconds.json()).error.param).toBe("seconds");
    const upstream400 = await call("/v1/videos", fx.a.key, { model: M.vid, prompt: "x", seconds: 5 }); // not 4/8/12: rejected upstream, passed through
    expect(upstream400.status).toBe(400);
    expect((await upstream400.json()).error.message).toContain("seconds");

    const notVideo = await call("/v1/videos", fx.a.key, { model: M.fal, prompt: "x" });
    expect(notVideo.status).toBe(400);
    expect((await notVideo.json()).error.code).toBe("unsupported_endpoint");

    const noPrice = await call("/v1/videos", fx.a.key, { model: M.vidNoPrice, prompt: "x" });
    expect(noPrice.status).toBe(503); // refuses to generate video it cannot bill
    await noPrice.arrayBuffer();

    const poor = await call("/v1/videos", fx.c.key, { model: M.vid, prompt: "x", seconds: "12" }); // 12s x $0.2 = $2.4 > $0.5
    expect(poor.status).toBe(402);
    expect((await poor.json()).error.code).toBe("insufficient_balance");

    const noKey = await call("/v1/videos", null, { model: M.vid, prompt: "x" });
    expect(noKey.status).toBe(401);
  });
});
