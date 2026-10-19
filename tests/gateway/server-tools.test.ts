/**
 * Server-tool metering (live report bug 5) and server-generated files (bug 1):
 *  - Anthropic `usage.server_tool_use` (web searches, code execution container time) and OpenAI Responses
 *    `web_search_call` / `file_search_call` output items are priced per unit: price (Model.toolPrices x multiplier),
 *    cost (ModelRoute.toolCosts), official (Model.officialToolPrices), and recorded in RequestLog.toolUsage,
 *  - files created upstream (code execution outputs, code-interpreter container files) are registered for the calling
 *    customer, pinned to the upstream account that served the request, downloadable through the Files endpoints and
 *    invisible to everybody else - for streamed and non-streamed responses.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk } from "./harness";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { db } from "@/lib/db";

const h = createHarness("stl");
const slug: Record<string, string> = {};
let alice = { userId: "", key: "" };
let bob = { userId: "", key: "" };
const anth = { "anthropic-version": "2023-06-01", "anthropic-beta": "files-api-2025-04-14" };

const TOOL_PRICES = { web_search_request: "0.012", code_execution_hour: "0.06", web_search_call: "0.012", file_search_call: "0.003" };
const TOOL_COSTS = { web_search_request: "0.01", code_execution_hour: "0.05", web_search_call: "0.01", file_search_call: "0.0025" };
const OFFICIAL_TOOLS = { web_search_request: "0.01", code_execution_hour: "0.05", web_search_call: "0.01", file_search_call: "0.0025" };

const msg = (model: string, text: string, extra: Record<string, unknown> = {}) => ({ model, max_tokens: 200, messages: [{ role: "user", content: text }], ...extra });

describe.skipIf(!dbOk)("server tools: metering + generated files", () => {
  beforeAll(async () => {
    await h.start();
    const a = await h.makeUser("alice", { balance: "100" });
    const b = await h.makeUser("bob", { balance: "100" });
    alice = { userId: a.id, key: (await h.makeKey("alice", a.id)).key };
    bob = { userId: b.id, key: (await h.makeKey("bob", b.id)).key };
    const an = await h.makeProvider("an", { formats: ["anthropic_messages", "anthropic_files"], authStyle: "X_API_KEY", baseUrl: h.base, keys: [{ s: "an1" }, { s: "an2" }, { s: "an3" }] });
    const oa = await h.makeProvider("oa", { formats: ["openai_chat", "openai_responses", "openai_files"], keys: [{ s: "oa1" }, { s: "oa2" }, { s: "oa3" }] });
    const pricing = { toolPrices: TOOL_PRICES, officialToolPrices: OFFICIAL_TOOLS };
    slug.an = (await h.makeModel("an", { caps: ["chat"], providerId: an.id, maxOutput: 4096, upstream: "claude-sonnet-5-5", model: pricing, route: { toolCosts: TOOL_COSTS } })).slug;
    slug.oa = (await h.makeModel("oa", { caps: ["chat", "responses"], providerId: oa.id, maxOutput: 4096, model: pricing, route: { toolCosts: TOOL_COSTS } })).slug;
    await invalidateGatewayConfig("all");
  }, 60_000);

  afterAll(async () => {
    await db.upstreamObject.deleteMany({ where: { userId: { in: [alice.userId, bob.userId] } } }).catch(() => undefined);
    await h.cleanup();
  }, 60_000);

  // ------------------------------------------------------------------ metering
  describe("Anthropic /v1/messages", () => {
    it("web searches are metered per search (price, cost, official) - non-stream", async () => {
      const res = await h.call("/v1/messages", alice.key, msg(slug.an, "find things [[ws:2]] [[usage:in=1000,out=500]]", { tools: [{ type: "web_search_20260209", name: "web_search" }] }), { headers: anth });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { usage: { server_tool_use: { web_search_requests: number } } };
      expect(body.usage.server_tool_use.web_search_requests).toBe(2);
      const log = await h.logOf(res);
      expect(log.status).toBe("SUCCESS");
      expect(log.toolUsage).toMatchObject({ web_search_request: 2 });
      // tokens: 1000 in x $3 + 500 out x $15 per 1M = 0.0105 ; tools: 2 x 0.012
      expect(Number(log.price)).toBeCloseTo(0.0105 + 0.024, 9);
      // cost: 1000 x 1.5 + 500 x 7.5 per 1M = 0.00525 ; tools 2 x 0.01
      expect(Number(log.cost)).toBeCloseTo(0.00525 + 0.02, 9);
      expect(Number(log.profit)).toBeCloseTo(Number(log.price) - Number(log.cost), 9);
      // official: no official token prices on the test model -> tokens fall back to what the customer pays; tools at the official unit price
      expect(Number(log.officialPrice)).toBeCloseTo(0.0105 + 0.02, 9);
    });

    it("the same in a stream (usage arrives in message_delta)", async () => {
      const res = await h.call("/v1/messages", alice.key, msg(slug.an, "find things [[ws:3]] [[usage:in=1000,out=500]]", { stream: true, tools: [{ type: "web_search_20260209", name: "web_search" }] }), { headers: anth });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("web_search_tool_result");
      const log = await h.logOf(res);
      expect(log.status).toBe("SUCCESS");
      expect(log.toolUsage).toMatchObject({ web_search_request: 3 });
      expect(Number(log.price)).toBeCloseTo(0.0105 + 3 * 0.012, 9);
      expect(Number(log.cost)).toBeCloseTo(0.00525 + 3 * 0.01, 9);
    });

    it("the group / customer multiplier applies to the tool price as to everything the customer pays", async () => {
      const u = await h.makeUser("mult", { balance: "100", priceMultiplier: "2" });
      const k = (await h.makeKey("mult", u.id)).key;
      const res = await h.call("/v1/messages", k, msg(slug.an, "x [[ws:1]] [[usage:in=1000,out=500]]"), { headers: anth });
      const log = await h.logOf(res);
      expect(Number(log.price)).toBeCloseTo((0.0105 + 0.012) * 2, 9);
      expect(Number(log.cost)).toBeCloseTo(0.00525 + 0.01, 9); // our cost never carries the multiplier
    });

    it("code execution is billed by container time (5 minute minimum) when used on its own ...", async () => {
      const res = await h.call("/v1/messages", alice.key, msg(slug.an, "make a pdf [[codeexec]] [[usage:in=100,out=50]]", { tools: [{ type: "code_execution_20260521", name: "code_execution" }] }), { headers: anth });
      expect(res.status).toBe(200);
      const log = await h.logOf(res);
      expect(log.toolUsage).toMatchObject({ code_execution_request: 1 });
      const hours = (log.toolUsage as Record<string, number>).code_execution_hour;
      expect(hours).toBeCloseTo(5 / 60, 9);
      expect(Number(log.cost)).toBeCloseTo((100 * 1.5 + 50 * 7.5) / 1e6 + hours * 0.05, 9);
      expect(Number(log.price)).toBeCloseTo((100 * 3 + 50 * 15) / 1e6 + hours * 0.06, 9);
    });

    it("... and is free next to web search / web fetch (dynamic filtering), like upstream", async () => {
      const res = await h.call("/v1/messages", alice.key, msg(slug.an, "search and compute [[ws:1]] [[codeexec]] [[usage:in=100,out=50]]", { tools: [{ type: "web_search_20260209", name: "web_search" }] }), { headers: anth });
      const log = await h.logOf(res);
      expect(log.toolUsage).toMatchObject({ web_search_request: 1 });
      expect((log.toolUsage as Record<string, number>).code_execution_hour).toBeUndefined();
      // declared web tool + code execution tool in the request: still free
      const res2 = await h.call("/v1/messages", alice.key, msg(slug.an, "compute [[codeexec]] [[usage:in=100,out=50]]", { tools: [{ type: "web_fetch_20260209", name: "web_fetch" }, { type: "code_execution_20260521", name: "code_execution" }] }), { headers: anth });
      const log2 = await h.logOf(res2);
      expect((log2.toolUsage as Record<string, number>).code_execution_hour).toBeUndefined();
    });

    it("a tool without a configured price is free (usage is still recorded); no tool usage -> empty toolUsage", async () => {
      const plain = await h.call("/v1/messages", alice.key, msg(slug.an, "hello [[usage:in=1000,out=500]]"), { headers: anth });
      const log = await h.logOf(plain);
      expect(log.toolUsage).toEqual({});
      expect(Number(log.price)).toBeCloseTo(0.0105, 9);
    });
  });

  describe("OpenAI /v1/responses", () => {
    it("web_search_call and file_search_call output items are metered per call (non-stream + stream)", async () => {
      const res = await h.call("/v1/responses", alice.key, { model: slug.oa, input: "look it up [[ws:2]] [[fs:1]] [[usage:in=1000,out=500]]", tools: [{ type: "web_search" }] });
      expect(res.status, await res.clone().text()).toBe(200);
      await res.json();
      const log = await h.logOf(res);
      expect(log.toolUsage).toMatchObject({ web_search_call: 2, file_search_call: 1 });
      expect(Number(log.price)).toBeCloseTo(0.0105 + 2 * 0.012 + 0.003, 9);
      expect(Number(log.cost)).toBeCloseTo(0.00525 + 2 * 0.01 + 0.0025, 9);

      const st = await h.call("/v1/responses", alice.key, { model: slug.oa, input: "look it up [[ws:1]] [[usage:in=1000,out=500]]", stream: true, tools: [{ type: "web_search" }] });
      await st.text();
      const log2 = await h.logOf(st);
      expect(log2.toolUsage).toMatchObject({ web_search_call: 1 });
      expect(Number(log2.price)).toBeCloseTo(0.0105 + 0.012, 9);
    });
  });

  // ------------------------------------------------------------------ generated files
  describe("files created upstream are downloadable through the gateway", () => {
    const fileIdOf = (body: { content: Array<{ type: string; content?: { content?: Array<{ file_id?: string }> } }> }) =>
      body.content.find((b) => b.type === "bash_code_execution_tool_result")!.content!.content![0].file_id!;

    it("non-stream: owned by the caller + pinned to the serving key; metadata, content and listing work; other customers get 404", async () => {
      const res = await h.call("/v1/messages", alice.key, msg(slug.an, "make a pdf [[codeexec]]", { tools: [{ type: "code_execution_20260521", name: "code_execution" }] }), { headers: anth });
      expect(res.status).toBe(200);
      const fileId = fileIdOf(await res.json());
      const log = await h.logOf(res);
      const row = await db.upstreamObject.findFirstOrThrow({ where: { kind: "file", upstreamId: fileId } });
      expect(row.userId).toBe(alice.userId);
      expect(row.providerKeyId).toBe(log.providerKeyId); // the account that served the request holds the file

      const meta = await h.call(`/v1/files/${fileId}`, alice.key, undefined, { headers: anth });
      expect(meta.status, await meta.clone().text()).toBe(200);
      expect(((await meta.json()) as { id: string }).id).toBe(fileId);
      const content = await h.call(`/v1/files/${fileId}/content`, alice.key, undefined, { headers: anth });
      expect(content.status).toBe(200);
      const bytes = Buffer.from(await content.arrayBuffer());
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");

      const list = (await (await h.call("/v1/files", alice.key, undefined, { headers: anth })).json()) as { data: Array<{ id: string }> };
      expect(list.data.map((f) => f.id)).toContain(fileId);

      for (const path of [`/v1/files/${fileId}`, `/v1/files/${fileId}/content`]) {
        const other = await h.call(path, bob.key, undefined, { headers: anth });
        expect(other.status, path).toBe(404);
      }
      const bobList = (await (await h.call("/v1/files", bob.key, undefined, { headers: anth })).json()) as { data: Array<{ id: string }> };
      expect(bobList.data.map((f) => f.id)).not.toContain(fileId);
    });

    it("stream: the file id seen in content_block_start becomes downloadable (also while the stream is still running)", async () => {
      const res = await h.call("/v1/messages", alice.key, msg(slug.an, "make a pdf [[codeexec]] [[delay:60]]", { stream: true, tools: [{ type: "code_execution_20260521", name: "code_execution" }] }), { headers: anth });
      expect(res.status).toBe(200);
      const text = await res.text();
      const m = /"file_id":"(file_011mock[^"]+)"/.exec(text);
      expect(m, "the stream carries the generated file id").toBeTruthy();
      const fileId = m![1];
      await h.logOf(res);
      const content = await h.call(`/v1/files/${fileId}/content`, alice.key, undefined, { headers: anth });
      expect(content.status).toBe(200);
      expect(Buffer.from(await content.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
      expect((await h.call(`/v1/files/${fileId}/content`, bob.key, undefined, { headers: anth })).status).toBe(404);
    });

    it("OpenAI Responses code interpreter: the container file is registered and downloadable via /v1/containers/...; foreign -> 404", async () => {
      const res = await h.call("/v1/responses", alice.key, { model: slug.oa, input: "make a pdf [[codeexec]]", tools: [{ type: "code_interpreter", container: { type: "auto" } }] });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { output: Array<{ type: string; content?: Array<{ annotations?: Array<{ container_id: string; file_id: string }> }> }> };
      const cite = body.output.find((o) => o.type === "message")!.content![0].annotations![0];
      const path = `/v1/containers/${cite.container_id}/files/${cite.file_id}`;
      const meta = await h.call(path, alice.key);
      expect(meta.status, await meta.clone().text()).toBe(200);
      const content = await h.call(`${path}/content`, alice.key);
      expect(content.status).toBe(200);
      expect(Buffer.from(await content.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
      expect((await h.call(`${path}/content`, bob.key)).status).toBe(404);
      expect((await h.call(path, bob.key)).status).toBe(404);

      // streamed: same
      const st = await h.call("/v1/responses", alice.key, { model: slug.oa, input: "make a pdf [[codeexec]]", stream: true, tools: [{ type: "code_interpreter", container: { type: "auto" } }] });
      const text = await st.text();
      const m = /"container_id":"(cntr_mock[^"]+)","file_id":"(cfile_mock[^"]+)"/.exec(text);
      expect(m).toBeTruthy();
      await h.logOf(st);
      expect((await h.call(`/v1/containers/${m![1]}/files/${m![2]}/content`, alice.key)).status).toBe(200);
    });

    it("an id that already belongs to somebody else is never taken over by a later response that mentions it", async () => {
      const row = await db.upstreamObject.findFirstOrThrow({ where: { kind: "file", userId: alice.userId } });
      const before = row.userId;
      const { registerGeneratedFiles } = await import("@/gateway/files");
      const fakeCtx = { auth: { user: { id: bob.userId }, key: { id: null } }, requestId: "x" } as never;
      const fakeCand = { route: { providerId: row.providerId }, key: { id: row.providerKeyId } } as never;
      await registerGeneratedFiles(fakeCtx, fakeCand, [{ kind: "file", id: row.upstreamId, fmt: "anthropic_files" }]);
      const after = await db.upstreamObject.findFirstOrThrow({ where: { kind: "file", upstreamId: row.upstreamId } });
      expect(after.userId).toBe(before);
    });
  });
});
