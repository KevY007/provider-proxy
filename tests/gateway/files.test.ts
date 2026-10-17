/**
 * Files APIs passthrough (PLAN 5c): OpenAI /v1/files + /v1/uploads, Anthropic /v1/files, Gemini resumable upload +
 * /v1beta/files. A file lives on ONE upstream account (the mock enforces that per credential, like separate accounts):
 *   - everything the customer does with it is pinned to that account (file endpoints AND `file_id` / `fileUri`
 *     references inside chat / messages / generateContent bodies),
 *   - other customers get a native 404 (also for references inside model requests),
 *   - listings come from our own records, so they never include other customers' files.
 * Real sockets (tests/gateway/http-adapter.ts), mock upstream, dev database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk, sleep } from "./harness";
import { startGatewayServer, type GatewayServer } from "./http-adapter";
import { __resetCacheForTests, invalidateGatewayConfig } from "@/gateway/cache";
import { flushMeter } from "@/gateway/meter-writer";
import { db } from "@/lib/db";

const h = createHarness("fil");
let gw: GatewayServer;
const slug: Record<string, string> = {};
let alice = { userId: "", key: "" };
let bob = { userId: "", key: "" };

const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const anth = (k: string) => ({ "x-api-key": k, "anthropic-version": "2023-06-01", "anthropic-beta": "files-api-2025-04-14" });
const goog = (k: string) => ({ "x-goog-api-key": k });

function upload(bytes: Buffer, name = "notes.txt"): FormData {
  const fd = new FormData();
  fd.append("purpose", "assistants");
  fd.append("file", new Blob([new Uint8Array(bytes)], { type: "text/plain" }), name);
  return fd;
}

describe.skipIf(!dbOk)("Files APIs", () => {
  beforeAll(async () => {
    await h.start();
    gw = await startGatewayServer();
    const a = await h.makeUser("alice", { balance: "100" });
    const b = await h.makeUser("bob", { balance: "100" });
    alice = { userId: a.id, key: (await h.makeKey("alice", a.id)).key };
    bob = { userId: b.id, key: (await h.makeKey("bob", b.id)).key };
    const oa = await h.makeProvider("oa", { formats: ["openai_chat", "openai_files"], keys: [{ s: "oa1" }, { s: "oa2" }, { s: "oa3" }] });
    const an = await h.makeProvider("an", { formats: ["anthropic_messages", "anthropic_files"], authStyle: "X_API_KEY", baseUrl: h.base, keys: [{ s: "an1" }, { s: "an2" }, { s: "an3" }] });
    const ge = await h.makeProvider("ge", { formats: ["gemini", "gemini_files"], baseUrl: h.base, keys: [{ s: "ge1" }, { s: "ge2" }, { s: "ge3" }] });
    slug.oa = (await h.makeModel("oa", { caps: ["chat"], providerId: oa.id, maxOutput: 4096 })).slug;
    slug.an = (await h.makeModel("an", { caps: ["chat"], providerId: an.id, maxOutput: 4096 })).slug;
    slug.ge = (await h.makeModel("ge", { caps: ["chat"], providerId: ge.id, maxOutput: 4096 })).slug;
    await invalidateGatewayConfig("all");
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
    await db.upstreamObject.deleteMany({ where: { userId: { in: [alice.userId, bob.userId] } } }).catch(() => undefined);
    await h.cleanup();
  }, 60_000);

  // ------------------------------------------------------------------ OpenAI
  describe("OpenAI /v1/files + /v1/uploads", () => {
    const bytes = Buffer.from("hello files api ".repeat(50_000)); // 800 KB
    let fileId = "";

    it("uploads, shows and downloads a file; the owner row records the upstream account", async () => {
      const up = await fetch(`${gw.url}/v1/files`, { method: "POST", headers: bearer(alice.key), body: upload(bytes) });
      expect(up.status).toBe(200);
      expect(up.headers.get("x-upstream-request-id")).toMatch(/^req_mock_/);
      const f = (await up.json()) as { id: string; object: string; bytes: number; filename: string; purpose: string };
      expect(f).toMatchObject({ object: "file", bytes: bytes.length, filename: "notes.txt", purpose: "assistants" });
      fileId = f.id;
      const row = await db.upstreamObject.findFirstOrThrow({ where: { kind: "file", upstreamId: fileId } });
      expect(row.userId).toBe(alice.userId);
      expect(row.providerKeyId).toBeTruthy();

      const get = await fetch(`${gw.url}/v1/files/${fileId}`, { headers: bearer(alice.key) });
      expect(get.status).toBe(200);
      expect(((await get.json()) as { id: string }).id).toBe(fileId);

      const content = await fetch(`${gw.url}/v1/files/${fileId}/content`, { headers: bearer(alice.key) });
      expect(content.status).toBe(200);
      expect(content.headers.get("content-length")).toBe(String(bytes.length));
      expect(Buffer.from(await content.arrayBuffer()).equals(bytes)).toBe(true);

      const list = (await (await fetch(`${gw.url}/v1/files`, { headers: bearer(alice.key) })).json()) as { object: string; data: Array<{ id: string }> };
      expect(list.object).toBe("list");
      expect(list.data.map((x) => x.id)).toContain(fileId);
    });

    it("a request that references the file is pinned to the account that stores it (10 of 10 succeed over 3 keys)", async () => {
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`${gw.url}/v1/chat/completions`, {
          method: "POST",
          headers: { ...bearer(alice.key), "content-type": "application/json" },
          body: JSON.stringify({ model: slug.oa, messages: [{ role: "user", content: [{ type: "text", text: "summarise" }, { type: "file", file: { file_id: fileId } }] }] }),
        });
        expect(res.status, await res.clone().text()).toBe(200);
        await res.text();
      }
    });

    it("other customers get a native 404 for the file - on the file endpoints AND when they reference it in a request", async () => {
      for (const [path, method] of [
        [`/v1/files/${fileId}`, "GET"],
        [`/v1/files/${fileId}/content`, "GET"],
        [`/v1/files/${fileId}`, "DELETE"],
      ] as const) {
        const res = await fetch(`${gw.url}${path}`, { method, headers: bearer(bob.key) });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(((await res.json()) as { error: { message: string } }).error.message).toContain("No such File object");
      }
      const ref = await fetch(`${gw.url}/v1/chat/completions`, {
        method: "POST",
        headers: { ...bearer(bob.key), "content-type": "application/json" },
        body: JSON.stringify({ model: slug.oa, messages: [{ role: "user", content: [{ type: "file", file: { file_id: fileId } }] }] }),
      });
      expect(ref.status).toBe(404);
      const bobList = (await (await fetch(`${gw.url}/v1/files`, { headers: bearer(bob.key) })).json()) as { data: unknown[] };
      expect(bobList.data).toHaveLength(0);
      // ... and the file is untouched for its owner
      expect((await fetch(`${gw.url}/v1/files/${fileId}`, { headers: bearer(alice.key) })).status).toBe(200);
    });

    it("a file id nobody uploaded through the gateway is passed on and answered by the upstream (still native 404)", async () => {
      const res = await fetch(`${gw.url}/v1/files/file-doesnotexist`, { headers: bearer(alice.key) });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain("No such File object");
    });

    it("multipart uploads: create -> parts -> complete -> the resulting file is owned and usable", async () => {
      const create = await fetch(`${gw.url}/v1/uploads`, { method: "POST", headers: { ...bearer(alice.key), "content-type": "application/json" }, body: JSON.stringify({ filename: "big.bin", purpose: "assistants", bytes: 3000, mime_type: "application/octet-stream" }) });
      expect(create.status).toBe(200);
      const up = (await create.json()) as { id: string; status: string };
      expect(up.status).toBe("pending");

      const partIds: string[] = [];
      for (const n of [1000, 2000]) {
        const fd = new FormData();
        fd.append("data", new Blob([Buffer.alloc(n, 9)]), "part");
        const r = await fetch(`${gw.url}/v1/uploads/${up.id}/parts`, { method: "POST", headers: bearer(alice.key), body: fd });
        expect(r.status).toBe(200);
        partIds.push(((await r.json()) as { id: string }).id);
      }
      // another customer can neither add parts nor complete
      const fdBob = new FormData();
      fdBob.append("data", new Blob([Buffer.alloc(10)]), "part");
      expect((await fetch(`${gw.url}/v1/uploads/${up.id}/parts`, { method: "POST", headers: bearer(bob.key), body: fdBob })).status).toBe(404);
      expect((await fetch(`${gw.url}/v1/uploads/${up.id}/complete`, { method: "POST", headers: { ...bearer(bob.key), "content-type": "application/json" }, body: JSON.stringify({ part_ids: partIds }) })).status).toBe(404);

      const done = await fetch(`${gw.url}/v1/uploads/${up.id}/complete`, { method: "POST", headers: { ...bearer(alice.key), "content-type": "application/json" }, body: JSON.stringify({ part_ids: partIds }) });
      expect(done.status).toBe(200);
      const completed = (await done.json()) as { status: string; file: { id: string; bytes: number } };
      expect(completed.status).toBe("completed");
      expect(completed.file.bytes).toBe(3000);
      const get = await fetch(`${gw.url}/v1/files/${completed.file.id}`, { headers: bearer(alice.key) });
      expect(get.status).toBe(200);
      expect((await fetch(`${gw.url}/v1/files/${completed.file.id}`, { headers: bearer(bob.key) })).status).toBe(404);
    });

    it("deleting removes the file and our record", async () => {
      const up = await fetch(`${gw.url}/v1/files`, { method: "POST", headers: bearer(alice.key), body: upload(Buffer.from("temp")) });
      const id = ((await up.json()) as { id: string }).id;
      const del = await fetch(`${gw.url}/v1/files/${id}`, { method: "DELETE", headers: bearer(alice.key) });
      expect(del.status).toBe(200);
      expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);
      expect((await fetch(`${gw.url}/v1/files/${id}`, { headers: bearer(alice.key) })).status).toBe(404);
      expect(await db.upstreamObject.count({ where: { kind: "file", upstreamId: id } })).toBe(0);
    });

    it("file operations are free by default and logged per request", async () => {
      await flushMeter();
      const logs = await db.requestLog.findMany({ where: { userId: alice.userId, inboundFormat: "openai_files" } });
      expect(logs.length).toBeGreaterThan(5);
      expect(logs.every((l) => Number(l.price) === 0)).toBe(true);
      expect(logs.some((l) => l.endpoint === "/v1/files" && l.status === "SUCCESS")).toBe(true);
    });
  });

  // ------------------------------------------------------------------ Anthropic
  describe("Anthropic /v1/files", () => {
    let fileId = "";
    it("uploads (beta header forwarded), lists in the Anthropic shape, downloads and deletes", async () => {
      const fd = new FormData();
      fd.append("file", new Blob([Buffer.from("anthropic file")], { type: "text/plain" }), "a.txt");
      const up = await fetch(`${gw.url}/v1/files`, { method: "POST", headers: anth(alice.key), body: fd });
      expect(up.status).toBe(200);
      const f = (await up.json()) as { id: string; type: string; filename: string; size_bytes: number };
      expect(f).toMatchObject({ type: "file", filename: "a.txt", size_bytes: 14 });
      fileId = f.id;
      const list = (await (await fetch(`${gw.url}/v1/files`, { headers: anth(alice.key) })).json()) as { data: Array<{ id: string }>; has_more: boolean };
      expect(list.data.map((x) => x.id)).toContain(fileId);
      expect(list.has_more).toBe(false);
      const get = await fetch(`${gw.url}/v1/files/${fileId}`, { headers: anth(alice.key) });
      expect(get.status).toBe(200);
      const content = await fetch(`${gw.url}/v1/files/${fileId}/content`, { headers: anth(alice.key) });
      expect(await content.text()).toBe("anthropic file");
    });

    it("`source.file_id` in a Messages request is pinned to the account; a foreign id is a native Anthropic 404", async () => {
      const body = (id: string) => JSON.stringify({ model: slug.an, max_tokens: 50, messages: [{ role: "user", content: [{ type: "document", source: { type: "file", file_id: id } }, { type: "text", text: "go" }] }] });
      for (let i = 0; i < 8; i++) {
        const r = await fetch(`${gw.url}/v1/messages`, { method: "POST", headers: { ...anth(alice.key), "content-type": "application/json" }, body: body(fileId) });
        expect(r.status, await r.clone().text()).toBe(200);
        await r.text();
      }
      const foreign = await fetch(`${gw.url}/v1/messages`, { method: "POST", headers: { ...anth(bob.key), "content-type": "application/json" }, body: body(fileId) });
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toMatchObject({ type: "error", error: { type: "not_found_error" } });
      const foreignGet = await fetch(`${gw.url}/v1/files/${fileId}`, { headers: anth(bob.key) });
      expect(foreignGet.status).toBe(404);
      expect(await foreignGet.json()).toMatchObject({ type: "error", error: { type: "not_found_error" } });
      const del = await fetch(`${gw.url}/v1/files/${fileId}`, { method: "DELETE", headers: anth(alice.key) });
      expect(del.status).toBe(200);
    });
  });

  // ------------------------------------------------------------------ Gemini
  describe("Gemini resumable upload + /v1beta/files", () => {
    let name = "";
    let uri = "";
    it("start -> data+finalize: the session URL points at the gateway, the file is recorded", async () => {
      const payload = Buffer.from("gemini media bytes ".repeat(1000));
      const start = await fetch(`${gw.url}/upload/v1beta/files`, {
        method: "POST",
        headers: {
          ...goog(alice.key),
          "content-type": "application/json",
          "x-goog-upload-protocol": "resumable",
          "x-goog-upload-command": "start",
          "x-goog-upload-header-content-length": String(payload.length),
          "x-goog-upload-header-content-type": "text/plain",
        },
        body: JSON.stringify({ file: { display_name: "g.txt" } }),
      });
      expect(start.status).toBe(200);
      expect(start.headers.get("x-goog-upload-status")).toBe("active");
      const sessionUrl = start.headers.get("x-goog-upload-url")!;
      expect(sessionUrl.startsWith(gw.url)).toBe(true); // rewritten: the client talks to us, never to the upstream
      expect(sessionUrl).toContain("/upload/v1beta/files?upload_id=gup_");
      expect(sessionUrl).not.toContain(h.base);

      // another customer cannot use (or even see) the session
      const stolen = await fetch(sessionUrl, { method: "POST", headers: { ...goog(bob.key), "x-goog-upload-command": "upload, finalize", "x-goog-upload-offset": "0" }, body: payload });
      expect(stolen.status).toBe(404);

      const fin = await fetch(sessionUrl, { method: "POST", headers: { ...goog(alice.key), "x-goog-upload-command": "upload, finalize", "x-goog-upload-offset": "0" }, body: payload });
      expect(fin.status).toBe(200);
      expect(fin.headers.get("x-goog-upload-status")).toBe("final");
      const { file } = (await fin.json()) as { file: { name: string; uri: string; sizeBytes: string; displayName: string } };
      expect(file).toMatchObject({ sizeBytes: String(payload.length), displayName: "g.txt" });
      name = file.name;
      uri = file.uri;
      expect(await db.upstreamObject.count({ where: { kind: "file", upstreamId: name, userId: alice.userId } })).toBe(1);

      const get = await fetch(`${gw.url}/v1beta/${name}`, { headers: goog(alice.key) });
      expect(get.status).toBe(200);
      const list = (await (await fetch(`${gw.url}/v1beta/files`, { headers: goog(alice.key) })).json()) as { files: Array<{ name: string }> };
      expect(list.files.map((x) => x.name)).toContain(name);
    });

    it("`fileData.fileUri` is pinned to the account; a foreign one is a native Gemini 404", async () => {
      const body = (u: string) => JSON.stringify({ contents: [{ role: "user", parts: [{ fileData: { mimeType: "text/plain", fileUri: u } }, { text: "describe" }] }] });
      for (let i = 0; i < 8; i++) {
        const r = await fetch(`${gw.url}/v1beta/models/${slug.ge}:generateContent`, { method: "POST", headers: { ...goog(alice.key), "content-type": "application/json" }, body: body(uri) });
        expect(r.status, await r.clone().text()).toBe(200);
        await r.text();
      }
      const foreign = await fetch(`${gw.url}/v1beta/models/${slug.ge}:generateContent`, { method: "POST", headers: { ...goog(bob.key), "content-type": "application/json" }, body: body(uri) });
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toMatchObject({ error: { code: 404, status: "NOT_FOUND" } });
      expect((await fetch(`${gw.url}/v1beta/${name}`, { headers: goog(bob.key) })).status).toBe(404);
      const del = await fetch(`${gw.url}/v1beta/${name}`, { method: "DELETE", headers: goog(alice.key) });
      expect(del.status).toBe(200);
      expect((await fetch(`${gw.url}/v1beta/${name}`, { headers: goog(alice.key) })).status).toBe(404);
    });
  });

  it("new uploads of one customer prefer the account that already holds their files", async () => {
    __resetCacheForTests();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${gw.url}/v1/files`, { method: "POST", headers: bearer(alice.key), body: upload(Buffer.from(`f${i}`)) });
      expect(r.status).toBe(200);
      ids.push(((await r.json()) as { id: string }).id);
      await sleep(5);
    }
    const rows = await db.upstreamObject.findMany({ where: { kind: "file", upstreamId: { in: ids } } });
    expect(new Set(rows.map((r) => r.providerKeyId)).size).toBe(1);
  });
});
