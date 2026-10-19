/**
 * Batch APIs (PLAN 5c): Anthropic Message Batches (/v1/messages/batches) and OpenAI Batch (/v1/batches).
 *  - every request of a batch is checked like a normal call; one bad request rejects the whole batch (native 400/403/404)
 *  - public model names are rewritten to the upstream model on the way in and masked on the way out
 *  - batches are owned + pinned (another customer gets a native 404), listings come from our records
 *  - one long-lived credit hold covers the batch (402 when it does not fit) and is released after metering
 *  - every result is metered exactly once at the batch price (results download, cron sweep, delete; repeated runs are no-ops)
 *  - results are passed through faithfully (status, no compression, client abort aborts the upstream download)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk, sleep } from "./harness";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { batchLogId, maskLine, sweepBatches, type BatchMeta } from "@/gateway/batches";
import { flushMeter } from "@/gateway/meter-writer";
import { db } from "@/lib/db";

const h = createHarness("bat");
const slug: Record<string, string> = {};
let alice = { userId: "", key: "" };
let bob = { userId: "", key: "" };
const anth = { "anthropic-version": "2023-06-01" };

const req = (id: string, model: string, text: string, extra: Record<string, unknown> = {}) => ({ custom_id: id, params: { model, max_tokens: 1000, messages: [{ role: "user", content: text }], ...extra } });

async function mockLast(path: string): Promise<{ body: Record<string, unknown>; headers: Record<string, string> }> {
  return (await (await fetch(`${h.base}/__mock/last?path=${encodeURIComponent(path)}`)).json()) as { body: Record<string, unknown>; headers: Record<string, string> };
}

async function rowsOf(batchId: string) {
  await flushMeter();
  return db.requestLog.findMany({ where: { batchId }, orderBy: { id: "asc" } });
}

async function createAnthropic(key: string, requests: unknown[], headers: Record<string, string> = {}) {
  return h.call("/v1/messages/batches", key, { requests }, { headers: { ...anth, ...headers } });
}

describe.skipIf(!dbOk)("Batch APIs", () => {
  beforeAll(async () => {
    await h.start();
    const a = await h.makeUser("alice", { balance: "100" });
    const b = await h.makeUser("bob", { balance: "100" });
    alice = { userId: a.id, key: (await h.makeKey("alice", a.id)).key };
    bob = { userId: b.id, key: (await h.makeKey("bob", b.id)).key };
    const an = await h.makeProvider("an", { formats: ["anthropic_messages", "anthropic_batches"], authStyle: "X_API_KEY", baseUrl: h.base, keys: [{ s: "an1" }] });
    const an2 = await h.makeProvider("anb", { formats: ["anthropic_messages", "anthropic_batches"], authStyle: "X_API_KEY", baseUrl: h.base, keys: [{ s: "anb1" }] });
    const nob = await h.makeProvider("nob", { formats: ["anthropic_messages"], authStyle: "X_API_KEY", baseUrl: h.base, keys: [{ s: "nob1" }] });
    const oa = await h.makeProvider("oa", { formats: ["openai_chat", "openai_files", "openai_batches"], keys: [{ s: "oa1" }] });
    slug.an = (await h.makeModel("an", { caps: ["chat"], providerId: an.id, maxOutput: 4096, upstream: "up-claude-a" })).slug;
    slug.an2 = (await h.makeModel("an2", { caps: ["chat"], providerId: an.id, maxOutput: 4096, upstream: "up-claude-b", in: "1", out: "5" })).slug;
    slug.other = (await h.makeModel("other", { caps: ["chat"], providerId: an2.id, maxOutput: 4096, upstream: "up-claude-c" })).slug;
    slug.nobatch = (await h.makeModel("nobatch", { caps: ["chat"], providerId: nob.id, maxOutput: 4096, upstream: "up-claude-d" })).slug;
    slug.oa = (await h.makeModel("oa", { caps: ["chat"], providerId: oa.id, maxOutput: 4096, upstream: "up-gpt-a" })).slug;
    await invalidateGatewayConfig("all");
  }, 60_000);

  afterAll(async () => {
    await db.upstreamObject.deleteMany({ where: { userId: { in: h.ids.users } } }).catch(() => undefined);
    await h.cleanup();
  }, 60_000);

  // ------------------------------------------------------------------ Anthropic: validation
  describe("Anthropic: create-time checks reject the whole batch", () => {
    it("unknown model -> native 404 naming the custom_id, nothing sent upstream", async () => {
      const res = await createAnthropic(alice.key, [req("ok-1", slug.an, "hi"), req("bad-2", "no-such-model", "hi")]);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { type: string; error: { type: string; message: string } };
      expect(body.type).toBe("error");
      expect(body.error.message).toContain("bad-2");
      expect(body.error.message).toContain("no-such-model");
    });

    it("a model the key may not use -> 403 for the whole batch", async () => {
      const k = await h.makeKey("restricted", alice.userId, { allowedModels: [slug.an] });
      const res = await createAnthropic(k.key, [req("a", slug.an, "hi"), req("b", slug.an2, "hi")]);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain('"b"');
    });

    it("a model without a batch-capable route -> 400; models on different providers cannot share a batch", async () => {
      const r1 = await createAnthropic(alice.key, [req("a", slug.nobatch, "hi")]);
      expect(r1.status).toBe(400);
      const r2 = await createAnthropic(alice.key, [req("a", slug.an, "hi"), req("b", slug.other, "hi")]);
      expect(r2.status).toBe(400);
      expect(((await r2.json()) as { error: { message: string } }).error.message).toMatch(/cannot be served together/);
    });

    it("missing / malformed requests -> 400", async () => {
      expect((await createAnthropic(alice.key, [])).status).toBe(400);
      expect((await createAnthropic(alice.key, [{ custom_id: "x" }])).status).toBe(400);
      expect((await createAnthropic(alice.key, [req("dup", slug.an, "a"), req("dup", slug.an, "b")])).status).toBe(400);
    });

    it("a file referenced inside a request must belong to the caller (another customer's file id -> 404)", async () => {
      const anProvider = (await db.model.findFirstOrThrow({ where: { slug: slug.an }, include: { routes: true } })).routes[0].providerId;
      const pk = await db.providerKey.findFirstOrThrow({ where: { providerId: anProvider } });
      const fileId = `file_bob_${h.sfx}`;
      await db.upstreamObject.create({ data: { kind: "file", upstreamId: fileId, providerId: anProvider, providerKeyId: pk.id, userId: bob.userId, meta: { fmt: "anthropic_files" } } });
      const doc = [{ type: "document", source: { type: "file", file_id: fileId } }, { type: "text", text: "summarize" }];
      const res = await createAnthropic(alice.key, [req("steal", slug.an, "x", { messages: [{ role: "user", content: doc }] })]);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { type: string; message: string } }).error.message).toContain(fileId);
      // the owner may use it
      const ok = await createAnthropic(bob.key, [req("mine", slug.an, "x", { messages: [{ role: "user", content: doc }] })]);
      expect(ok.status, await ok.clone().text()).toBe(200);
    });

    it("402 when the worst case of the batch does not fit the balance (upstream never contacted)", async () => {
      const poor = await h.makeUser("poor", { balance: "0.01" });
      const k = (await h.makeKey("poor", poor.id)).key;
      const before = (await (await fetch(`${h.base}/__mock/stats`)).json()) as { byPath: Record<string, number> };
      // 20 x 4096 output tokens x $15/M x 0.5 = ~$0.61 > $0.01
      const res = await createAnthropic(k, Array.from({ length: 20 }, (_, i) => req(`r${i}`, slug.an, "hi", { max_tokens: 4096 })));
      expect(res.status).toBe(402);
      expect(((await res.json()) as { error: { type: string } }).error).toBeTruthy();
      const after = (await (await fetch(`${h.base}/__mock/stats`)).json()) as { byPath: Record<string, number> };
      expect(after.byPath["/v1/messages/batches"] ?? 0).toBe(before.byPath["/v1/messages/batches"] ?? 0);
    });
  });

  // ------------------------------------------------------------------ Anthropic: lifecycle
  describe("Anthropic: lifecycle + metering", () => {
    let batchId = "";
    let balanceBefore = "";

    it("create: models rewritten upstream, batch recorded for the caller", async () => {
      const res = await createAnthropic(alice.key, [
        req("one", slug.an, "first [[usage:in=1000,out=500]]"),
        req("two", slug.an2, "second [[usage:in=1000,out=500]]"),
        req("three", slug.an, "third [[batcherr]]"),
      ]);
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { id: string; type: string; processing_status: string; results_url: string | null };
      expect(body.type).toBe("message_batch");
      expect(body.processing_status).toBe("in_progress");
      batchId = body.id;
      const last = await mockLast("/v1/messages/batches");
      const sent = (last.body.requests as Array<{ custom_id: string; params: { model: string } }>).map((r) => [r.custom_id, r.params.model]);
      expect(sent).toEqual([
        ["one", "up-claude-a"],
        ["two", "up-claude-b"],
        ["three", "up-claude-a"],
      ]);
      const row = await db.upstreamObject.findFirstOrThrow({ where: { kind: "batch", upstreamId: batchId } });
      expect(row.userId).toBe(alice.userId);
      const meta = row.meta as unknown as BatchMeta;
      expect(meta.models.map((m) => m.slug).sort()).toEqual([slug.an, slug.an2].sort());
      expect(meta.customIdModels).toBeTruthy();
      expect(Number(meta.holdAmount)).toBeGreaterThan(0);
    });

    it("another customer cannot see it (native 404), and it is not in their listing", async () => {
      const res = await h.call(`/v1/messages/batches/${batchId}`, bob.key, undefined, { headers: anth });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { type: string } }).error.type).toBe("not_found_error");
      const list = (await (await h.call("/v1/messages/batches", bob.key, undefined, { headers: anth })).json()) as { data: Array<{ id: string }> };
      expect(list.data.map((b) => b.id)).not.toContain(batchId);
      const res2 = await h.call(`/v1/messages/batches/${batchId}/results`, bob.key, undefined, { headers: anth });
      expect(res2.status).toBe(404);
    });

    it("get: ended, results_url points at the gateway; listing shows it", async () => {
      balanceBefore = (await h.balanceOf(alice.userId)).toString();
      const res = await h.call(`/v1/messages/batches/${batchId}`, alice.key, undefined, { headers: anth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { processing_status: string; results_url: string };
      expect(body.processing_status).toBe("ended");
      expect(body.results_url).toBe(`http://gateway.test/v1/messages/batches/${batchId}/results`);
      const list = (await (await h.call("/v1/messages/batches", alice.key, undefined, { headers: anth })).json()) as { data: Array<{ id: string; processing_status: string }> };
      expect(list.data.find((b) => b.id === batchId)?.processing_status).toBe("ended");
    });

    it("results: JSONL passthrough with the model masked; each result metered once at the batch price", async () => {
      const res = await h.call(`/v1/messages/batches/${batchId}/results`, alice.key, undefined, { headers: anth });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBeNull();
      const lines = (await res.text())
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { custom_id: string; result: { type: string; message?: { model: string } } });
      expect(lines.map((l) => l.custom_id)).toEqual(["one", "two", "three"]);
      expect(lines[0].result.message?.model).toBe(slug.an);
      expect(lines[1].result.message?.model).toBe(slug.an2);
      expect(lines[2].result.type).toBe("errored");

      let rows = await rowsOf(batchId);
      for (let i = 0; i < 100 && rows.length < 3; i++) {
        await sleep(30);
        rows = await rowsOf(batchId);
      }
      expect(rows).toHaveLength(3);
      const byCid = new Map(rows.map((r) => [r.id, r]));
      const one = byCid.get(batchLogId(batchId, "one"))!;
      const two = byCid.get(batchLogId(batchId, "two"))!;
      const three = byCid.get(batchLogId(batchId, "three"))!;
      // one: 1000 in x $3 + 500 out x $15 per 1M = 0.0105, batch price = 50% off
      expect(one.status).toBe("SUCCESS");
      expect(one.modelSlug).toBe(slug.an);
      expect(one.endpoint).toBe("/v1/messages/batches");
      expect(one.upstreamModel).toBe("up-claude-a");
      expect(Number(one.price)).toBeCloseTo(0.00525, 9);
      expect(Number(one.cost)).toBeCloseTo(0.002625, 9);
      expect(Number(one.officialPrice)).toBeCloseTo(0.00525, 9);
      // two: $1 / $5 model
      expect(two.modelSlug).toBe(slug.an2);
      expect(Number(two.price)).toBeCloseTo((1000 * 1 + 500 * 5) / 1e6 / 2, 9);
      expect(three.status).toBe("CLIENT_ERROR");
      expect(Number(three.price)).toBe(0);
      const after = await h.balanceOf(alice.userId);
      expect(Number(balanceBefore) - Number(after)).toBeCloseTo(Number(one.price) + Number(two.price), 9);
      // meteredAt is set right after the rows were flushed
      let row = await db.upstreamObject.findFirstOrThrow({ where: { kind: "batch", upstreamId: batchId } });
      for (let i = 0; i < 100 && !row.meteredAt; i++) {
        await sleep(20);
        row = await db.upstreamObject.findFirstOrThrow({ where: { kind: "batch", upstreamId: batchId } });
      }
      expect(row.meteredAt).not.toBeNull();
    });

    it("a second download + the cron sweep never meter again", async () => {
      const before = await h.balanceOf(alice.userId);
      const res = await h.call(`/v1/messages/batches/${batchId}/results`, alice.key, undefined, { headers: anth });
      await res.text();
      await sweepBatches();
      await sleep(100);
      expect(await rowsOf(batchId)).toHaveLength(3);
      expect((await h.balanceOf(alice.userId)).equals(before)).toBe(true);
    });

    it("delete: removes the batch (afterwards a native 404)", async () => {
      const res = await h.call(`/v1/messages/batches/${batchId}`, alice.key, undefined, { method: "DELETE", headers: anth });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { type: string }).type).toBe("message_batch_deleted");
      expect((await h.call(`/v1/messages/batches/${batchId}`, alice.key, undefined, { headers: anth })).status).toBe(404);
      expect(await rowsOf(batchId)).toHaveLength(3);
    });
  });

  describe("Anthropic: holds, sweep, cancel, faithful passthrough", () => {
    it("the hold blocks spending beyond the balance while a batch runs, and is released once it is metered", async () => {
      const u = await h.makeUser("holder", { balance: "1" });
      const k = (await h.makeKey("holder", u.id)).key;
      // ~ 100 x 4096 x $15/M x 0.5 = $3.07 > $1 ; use 30 requests: ~$0.92
      const big = Array.from({ length: 30 }, (_, i) => req(`h${i}`, slug.an, `x [[batchslow]] [[usage:in=10,out=5]]`, { max_tokens: 4096 }));
      const r1 = await createAnthropic(k, big);
      expect(r1.status, await r1.clone().text()).toBe(200);
      const id1 = ((await r1.json()) as { id: string }).id;
      // a second batch of the same size does not fit next to the first one's hold
      const r2 = await createAnthropic(k, big);
      expect(r2.status).toBe(402);
      // the sweep keeps it running (not ended) -> nothing metered, hold kept
      await sweepBatches();
      expect(await rowsOf(id1)).toHaveLength(0);
      // cancel -> the batch ends with canceled results -> the sweep meters them at $0 and releases the hold
      const c = await h.call(`/v1/messages/batches/${id1}/cancel`, k, undefined, { method: "POST", headers: anth });
      expect(c.status).toBe(200);
      expect(((await c.json()) as { processing_status: string }).processing_status).toBe("canceling");
      // the sweep sees it ended (the mock ends a canceled batch on the next poll) and meters it
      const sw = await sweepBatches();
      expect(sw.failed).toBe(0);
      const rows = await rowsOf(id1);
      expect(rows).toHaveLength(30);
      expect(rows.every((r) => r.status === "CANCELLED" && Number(r.price) === 0)).toBe(true);
      const r3 = await createAnthropic(k, big);
      expect(r3.status, await r3.clone().text()).toBe(200);
    });

    it("an upstream 4xx on create is passed through natively and releases the hold", async () => {
      const u = await h.makeUser("fail", { balance: "1" });
      const k = (await h.makeKey("fail", u.id)).key;
      const big = Array.from({ length: 30 }, (_, i) => req(`f${i}`, slug.an, "x", { max_tokens: 4096 }));
      const r1 = await createAnthropic(k, big, { "x-mock-fail": "400" });
      expect(r1.status).toBe(400);
      const b = (await r1.json()) as { type: string; error: { type: string } };
      expect(b.type).toBe("error");
      expect(b.error.type).toBe("invalid_request_error");
      const r2 = await createAnthropic(k, big, { "x-mock-delay-ms": "0" });
      expect(r2.status, await r2.clone().text()).toBe(200);
    });

    it("a client that aborts the results download aborts the upstream download", async () => {
      const r = await createAnthropic(alice.key, Array.from({ length: 6 }, (_, i) => req(`s${i}`, slug.an, "slow results")));
      const id = ((await r.json()) as { id: string }).id;
      await (await h.call(`/v1/messages/batches/${id}`, alice.key, undefined, { headers: anth })).text();
      const tag = `abort-${h.sfx}`;
      const ac = new AbortController();
      const res = await h.call(`/v1/messages/batches/${id}/results`, alice.key, undefined, { headers: { ...anth, "x-mock-delay-ms": "300", "x-mock-tag": tag }, signal: ac.signal });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      await reader.read();
      ac.abort();
      await reader.cancel().catch(() => undefined);
      let aborts: unknown[] = [];
      for (let i = 0; i < 50 && !aborts.length; i++) {
        await sleep(50);
        aborts = ((await (await fetch(`${h.base}/__mock/aborts?tag=${tag}`)).json()) as { aborts: unknown[] }).aborts;
      }
      expect(aborts.length).toBe(1);
    });
  });

  // ------------------------------------------------------------------ OpenAI
  describe("OpenAI /v1/batches", () => {
    let fileId = "";
    let batchId = "";

    it("create: the input file is rewritten with upstream models; the customer keeps seeing their own file id", async () => {
      const lines = [
        { custom_id: "c1", method: "POST", url: "/v1/chat/completions", body: { model: slug.oa, messages: [{ role: "user", content: "a [[usage:in=1000,out=500]]" }] } },
        { custom_id: "c2", method: "POST", url: "/v1/chat/completions", body: { model: slug.oa, messages: [{ role: "user", content: "b [[batcherr]]" }] } },
      ];
      const fd = new FormData();
      fd.append("purpose", "batch");
      fd.append("file", new Blob([lines.map((l) => JSON.stringify(l)).join("\n")], { type: "application/jsonl" }), "in.jsonl");
      const up = await h.call("/v1/files", alice.key, fd);
      expect(up.status, await up.clone().text()).toBe(200);
      fileId = ((await up.json()) as { id: string }).id;

      // somebody else's file id -> 404
      const foreign = await h.call("/v1/batches", bob.key, { input_file_id: fileId, endpoint: "/v1/chat/completions", completion_window: "24h" });
      expect(foreign.status).toBe(404);

      const res = await h.call("/v1/batches", alice.key, { input_file_id: fileId, endpoint: "/v1/chat/completions", completion_window: "24h" });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { id: string; object: string; input_file_id: string; model?: string };
      expect(body.object).toBe("batch");
      expect(body.input_file_id).toBe(fileId);
      if (body.model) expect(body.model).toBe(slug.oa);
      batchId = body.id;
      const last = await mockLast("/v1/batches");
      expect(last.body.input_file_id).not.toBe(fileId);
      const row = await db.upstreamObject.findFirstOrThrow({ where: { kind: "batch", upstreamId: batchId } });
      expect((row.meta as unknown as BatchMeta).rewrittenFileId).toBe(last.body.input_file_id);
    });

    it("unknown model in a line -> whole batch rejected", async () => {
      const fd = new FormData();
      fd.append("purpose", "batch");
      fd.append("file", new Blob([JSON.stringify({ custom_id: "z", method: "POST", url: "/v1/chat/completions", body: { model: "nope", messages: [] } })], { type: "application/jsonl" }), "bad.jsonl");
      const id = ((await (await h.call("/v1/files", alice.key, fd)).json()) as { id: string }).id;
      const res = await h.call("/v1/batches", alice.key, { input_file_id: id, endpoint: "/v1/chat/completions", completion_window: "24h" });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain('"z"');
    });

    it("get -> completed; output file downloadable with masked models; results metered once", async () => {
      const res = await h.call(`/v1/batches/${batchId}`, alice.key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; output_file_id: string; error_file_id: string };
      expect(body.status).toBe("completed");
      expect(body.output_file_id).toBeTruthy();
      const out = await h.call(`/v1/files/${body.output_file_id}/content`, alice.key);
      expect(out.status).toBe(200);
      const line = JSON.parse((await out.text()).trim().split("\n")[0]) as { custom_id: string; response: { body: { model: string } } };
      expect(line.custom_id).toBe("c1");
      expect(line.response.body.model).toBe(slug.oa);
      // bob cannot read the output file
      expect((await h.call(`/v1/files/${body.output_file_id}/content`, bob.key)).status).toBe(404);

      let rows = await rowsOf(batchId);
      for (let i = 0; i < 100 && rows.length < 2; i++) {
        await sleep(30);
        rows = await rowsOf(batchId);
      }
      expect(rows).toHaveLength(2);
      const c1 = rows.find((r) => r.id === batchLogId(batchId, "c1"))!;
      const c2 = rows.find((r) => r.id === batchLogId(batchId, "c2"))!;
      expect(c1.status).toBe("SUCCESS");
      expect(c1.endpoint).toBe("/v1/batches");
      expect(Number(c1.price)).toBeCloseTo(0.00525, 9);
      expect(c2.status).toBe("CLIENT_ERROR");
      expect(Number(c2.price)).toBe(0);
      await sweepBatches();
      expect(await rowsOf(batchId)).toHaveLength(2);
    });

    it("listing comes from our records (own batches only)", async () => {
      const mine = (await (await h.call("/v1/batches", alice.key)).json()) as { object: string; data: Array<{ id: string; input_file_id: string }> };
      expect(mine.object).toBe("list");
      expect(mine.data.find((b) => b.id === batchId)?.input_file_id).toBe(fileId);
      const theirs = (await (await h.call("/v1/batches", bob.key)).json()) as { data: Array<{ id: string }> };
      expect(theirs.data.map((b) => b.id)).not.toContain(batchId);
    });
  });

  it("maskLine only rewrites the model of masked models", () => {
    const meta = { fmt: "anthropic_batches", models: [{ slug: "pub", modelId: "m", routeId: "r", upstreamModel: "up", mask: true }], multiplier: "1", groupSlug: null, holdId: null, holdAmount: "0" } as BatchMeta;
    const line = JSON.stringify({ custom_id: "a", result: { type: "succeeded", message: { model: "up", content: [] } } });
    expect(JSON.parse(maskLine(line, meta)).result.message.model).toBe("pub");
    expect(maskLine("not json", meta)).toBe("not json");
    const unmasked = { ...meta, models: [{ ...meta.models[0], mask: false }] };
    expect(maskLine(line, unmasked)).toBe(line);
  });
});
