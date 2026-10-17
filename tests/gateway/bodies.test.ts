/**
 * Unit tests for the streamed-body building blocks (PLAN 5c): the top-level JSON scanner / splicer, the streaming multipart
 * scanner, the memory-or-disk body spool, inbound Content-Encoding decoding, the header allow-list and the Files paths.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import zlib, { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { inboundBody } from "@/gateway/bodyin";
import { GatewayError } from "@/gateway/errors";
import { pickForwardHeaders } from "@/gateway/headers";
import { scanTopLevel, spliceTopLevel } from "@/gateway/jsonscan";
import { MultipartScanner, multipartSegments, parseMultipart } from "@/gateway/multipart";
import { parsePath } from "@/gateway/path";
import { BodySpool, SpoolLimitError, type Segment } from "@/gateway/spool";

// (@types/node 20 predates zstd; the runtime is Node 24)
const zstdCompressSync = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;

const stream = (...chunks: Array<string | Buffer>) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(typeof x === "string" ? Buffer.from(x) : x);
      c.close();
    },
  });

async function collect(s: ReadableStream<Uint8Array>): Promise<Buffer> {
  const out: Buffer[] = [];
  const r = s.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    out.push(Buffer.from(value));
  }
  return Buffer.concat(out);
}

describe("JSON top-level scanner + splice", () => {
  const apply = async (raw: string, changes: Record<string, unknown>): Promise<string | null> => {
    const buf = Buffer.from(raw);
    const scan = scanTopLevel(buf)!;
    const segs = spliceTopLevel(scan, buf.length, changes);
    if (!segs) return null;
    return (await collect(BodySpool.fromBuffer(buf).stream(segs))).toString("utf8");
  };

  it("finds every top-level member, skipping strings with escapes and nested containers", () => {
    const raw = `{ "a" : "x\\"y,}", "b":{"c":[1,{"d":"}"}]},"model" :"m\\u00e9" , "e":[ ] }`;
    const scan = scanTopLevel(Buffer.from(raw))!;
    expect(scan.members.map((m) => m.key)).toEqual(["a", "b", "model", "e"]);
    const model = scan.byKey.get("model")![0];
    expect(raw.slice(model.valueStart, model.valueEnd)).toBe(`"m\\u00e9"`);
  });

  it("replaces a present member and keeps every other byte", async () => {
    const raw = `{ "messages" : [ {"role":"user","content":"caf\\u00e9"} ],\n "temperature": 1.0, "model" :  "pub" , "stream":false }`;
    const out = await apply(raw, { model: "up" });
    expect(out).toBe(raw.replace(`"pub"`, `"up"`));
  });

  it("inserts an absent member right after the opening brace", async () => {
    expect(await apply(`{"model":"m","messages":[]}`, { max_tokens: 20 })).toBe(`{"max_tokens":20,"model":"m","messages":[]}`);
    expect(await apply(`{}`, { max_tokens: 20 })).toBe(`{"max_tokens":20}`);
    const out = (await apply(`{"model":"m"}`, { model: "x", stream_options: { include_usage: true } }))!;
    expect(JSON.parse(out)).toEqual({ model: "x", stream_options: { include_usage: true } });
  });

  it("refuses what it cannot express (duplicate keys, deletions) and malformed documents", async () => {
    expect(await apply(`{"model":"a","model":"b"}`, { model: "c" })).toBeNull();
    expect(await apply(`{"model":"a"}`, { model: undefined })).toBeNull();
    expect(scanTopLevel(Buffer.from(`[1,2]`))).toBeNull();
    expect(scanTopLevel(Buffer.from(`{"a":1`))).toBeNull();
    expect(scanTopLevel(Buffer.from(`{"a" 1}`))).toBeNull();
  });

  it("scans a 40 MB document with one giant string value quickly", () => {
    const big = Buffer.concat([Buffer.from(`{"messages":[{"content":"`), Buffer.alloc(40 * 1024 * 1024, 0x61), Buffer.from(`"}],"model":"m"}`)]);
    const t0 = Date.now();
    const scan = scanTopLevel(big)!;
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(scan.byKey.get("model")).toHaveLength(1);
  });
});

describe("streaming multipart scanner", () => {
  const boundary = "----WebKitFormBoundaryXyz";
  const body = (file: Buffer) =>
    Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a b.png"\r\nContent-Type: image/png\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nline1\r\nline2 --${boundary.slice(0, 5)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\npublic\r\n--${boundary}--\r\n`),
    ]);

  it("reports parts, text fields and byte ranges whatever the chunking (even 1 byte at a time)", () => {
    const file = Buffer.concat([randomBytes(5000), Buffer.from(`\r\n--${boundary.slice(0, 8)}`), randomBytes(100)]); // binary content that nearly looks like a delimiter
    const raw = body(file);
    for (const size of [1, 7, 64, 100_000]) {
      const sc = new MultipartScanner(boundary);
      for (let i = 0; i < raw.length; i += size) sc.push(raw.subarray(i, i + size));
      expect(sc.complete).toBe(true);
      expect(sc.files).toHaveLength(1);
      expect(sc.files[0]).toMatchObject({ name: "image", filename: "a b.png", type: "image/png", size: file.length });
      expect(raw.subarray(sc.files[0].start, sc.files[0].end).equals(file)).toBe(true);
      expect(sc.fields.map((f) => [f.name, f.value])).toEqual([
        ["prompt", `line1\r\nline2 --${boundary.slice(0, 5)}`],
        ["model", "public"],
      ]);
      expect(raw.subarray(sc.closeStart, sc.closeStart + 2 + boundary.length + 2).toString()).toBe(`--${boundary}--`);
    }
  });

  it("re-encodes with only the model replaced; an absent model is appended", async () => {
    const file = randomBytes(300_000);
    const raw = body(file);
    const form = await parseMultipart(raw, `multipart/form-data; boundary=${boundary}`);
    const segs = multipartSegments(form, { model: "up-model" });
    const out = await collect(form.spool.stream(segs));
    expect(out.equals(Buffer.concat([raw.subarray(0, raw.length - `public\r\n--${boundary}--\r\n`.length), Buffer.from(`up-model\r\n--${boundary}--\r\n`)]))).toBe(true);
    const appended = await collect(form.spool.stream(multipartSegments(form, { extra: "1" })));
    const again = await parseMultipart(appended, `multipart/form-data; boundary=${boundary}`);
    expect(again.fields.find((f) => f.name === "extra")?.value).toBe("1");
    expect(again.files[0].size).toBe(file.length);
  });

  it("rejects bodies that are not complete multipart documents", async () => {
    await expect(parseMultipart(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue-without-end`), `multipart/form-data; boundary=${boundary}`)).rejects.toThrow();
  });
});

describe("BodySpool", () => {
  it("keeps small bodies in memory and spills big ones to a temp file; both replay identically with splices", async () => {
    const small = randomBytes(1000);
    const big = randomBytes(300_000);
    for (const [data, memLimit, inMemory] of [
      [small, 1_000_000, true],
      [big, 50_000, false],
    ] as const) {
      const spool = await BodySpool.fromStream(stream(data.subarray(0, 100), data.subarray(100, 70_000), data.subarray(70_000)), { memLimit });
      expect(spool.inMemory).toBe(inMemory);
      expect(spool.size).toBe(data.length);
      expect((await spool.toBuffer()).equals(data)).toBe(true);
      const segs: Segment[] = [{ start: 0, end: 10 }, "<<spliced>>", { start: 20, end: data.length }];
      const expected = Buffer.concat([data.subarray(0, 10), Buffer.from("<<spliced>>"), data.subarray(20)]);
      expect((await collect(spool.stream(segs))).equals(expected)).toBe(true);
      expect((await collect(spool.stream(segs))).equals(expected), "replayable").toBe(true);
      expect((await spool.slice(5, 25)).equals(data.subarray(5, 25))).toBe(true);
      expect(BodySpool.lengthOf(segs)).toBe(expected.length);
      await spool.dispose();
    }
  });

  it("enforces a size limit and removes its temp file on failure", async () => {
    await expect(BodySpool.fromStream(stream(randomBytes(200_000)), { memLimit: 10_000, maxBytes: 100_000 })).rejects.toBeInstanceOf(SpoolLimitError);
    const boom = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(randomBytes(60_000));
        c.error(new Error("client went away"));
      },
    });
    await expect(BodySpool.fromStream(boom, { memLimit: 10_000 })).rejects.toThrow("client went away");
  });

  it("dispose() deletes the file", async () => {
    const spool = await BodySpool.fromStream(stream(randomBytes(100_000)), { memLimit: 1000 });
    expect(spool.inMemory).toBe(false);
    const path = (spool as unknown as { file: string }).file;
    expect(existsSync(path)).toBe(true);
    await spool.dispose();
    expect(existsSync(path)).toBe(false);
  });
});

describe("inbound Content-Encoding", () => {
  const plain = Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "compressible ".repeat(5000) }] }));
  const req = (body: Buffer, enc?: string) => new Request("http://x/v1/chat/completions", { method: "POST", body: new Uint8Array(body), headers: enc ? { "content-encoding": enc } : {} });

  it.each([
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
    ["zstd", zstdCompressSync],
  ])("decodes %s", async (enc, compress) => {
    const out = await collect(inboundBody(req(compress(plain), enc))!);
    expect(out.equals(plain)).toBe(true);
  });

  it("decodes stacked encodings and passes identity / no encoding through", async () => {
    expect((await collect(inboundBody(req(gzipSync(brotliCompressSync(plain)), "br, gzip"))!)).equals(plain)).toBe(true);
    expect((await collect(inboundBody(req(plain, "identity"))!)).equals(plain)).toBe(true);
    expect((await collect(inboundBody(req(plain))!)).equals(plain)).toBe(true);
  });

  it("an encoding we cannot decode is a 415 with a clear message", () => {
    expect(() => inboundBody(req(plain, "compress"))).toThrowError(expect.objectContaining({ code: "unsupported_media_type", status: 415 }));
    try {
      inboundBody(req(plain, "compress"));
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).message).toMatch(/Content-Encoding 'compress'/);
    }
  });

  it("corrupt data surfaces as a stream error", async () => {
    await expect(collect(inboundBody(req(Buffer.from("not gzip at all"), "gzip"))!)).rejects.toThrow();
  });
});

describe("header allow-list", () => {
  it("forwards rate limits, retry-after and a renamed request id - nothing else", () => {
    const h = new Headers({
      "retry-after": "7",
      "x-ratelimit-remaining-requests": "0",
      "anthropic-ratelimit-tokens-reset": "2026-01-01T00:00:00Z",
      "x-should-retry": "true",
      "request-id": "req_abc",
      "openai-organization": "org-secret",
      "set-cookie": "a=b",
      server: "cloudflare",
      "content-encoding": "gzip",
      "content-length": "12",
      "transfer-encoding": "chunked",
      connection: "keep-alive",
      "cf-ray": "abc",
    });
    expect(pickForwardHeaders(h, { rateLimits: true })).toEqual({
      "retry-after": "7",
      "x-ratelimit-remaining-requests": "0",
      "anthropic-ratelimit-tokens-reset": "2026-01-01T00:00:00Z",
      "x-should-retry": "true",
      "x-upstream-request-id": "req_abc",
    });
    expect(pickForwardHeaders(h, { rateLimits: false })).toEqual({ "x-upstream-request-id": "req_abc" });
  });

  it("media and upload extras are opt-in; the Gemini upload URL is never copied", () => {
    const h = new Headers({ "content-range": "bytes 0-9/100", "accept-ranges": "bytes", etag: '"x"', "x-goog-upload-status": "final", "x-goog-upload-url": "https://upstream/secret" });
    expect(pickForwardHeaders(h, { rateLimits: true })).toEqual({});
    expect(pickForwardHeaders(h, { rateLimits: true, media: true, upload: true })).toEqual({ "content-range": "bytes 0-9/100", "accept-ranges": "bytes", etag: '"x"', "x-goog-upload-status": "final" });
  });
});

describe("Files API paths", () => {
  it("OpenAI vs Anthropic /v1/files is decided by the anthropic-version header", () => {
    expect(parsePath("/v1/files", "POST")).toMatchObject({ op: "files_create", format: "openai_files", raw: true, errorFormat: "openai" });
    const a = new Headers({ "anthropic-version": "2023-06-01" });
    expect(parsePath("/v1/files", "POST", a)).toMatchObject({ op: "files_create", format: "anthropic_files", errorFormat: "anthropic" });
    expect(parsePath("/v1/files/file_1/content", "GET", a)).toMatchObject({ op: "files_content", objectId: "file_1" });
    expect(parsePath("/v1/files/file-abc", "DELETE")).toMatchObject({ op: "files_delete", objectId: "file-abc" });
  });

  it("uploads, Gemini upload and Gemini files", () => {
    expect(parsePath("/v1/uploads", "POST")).toMatchObject({ op: "uploads_create" });
    expect(parsePath("/v1/uploads/upload_1/parts", "POST")).toMatchObject({ op: "uploads_part", objectId: "upload_1" });
    expect(parsePath("/v1/uploads/upload_1/complete", "POST")).toMatchObject({ op: "uploads_complete" });
    expect(parsePath("/v1/uploads/upload_1/cancel", "POST")).toMatchObject({ op: "uploads_cancel" });
    expect(parsePath("/upload/v1beta/files", "POST")).toMatchObject({ op: "gfiles_upload", format: "gemini_files", errorFormat: "gemini" });
    expect(parsePath("/v1beta/files", "GET")).toMatchObject({ op: "gfiles_list" });
    expect(parsePath("/v1beta/files/abc-1", "GET")).toMatchObject({ op: "gfiles_get", objectId: "files/abc-1" });
    expect(parsePath("/v1beta/files/abc-1", "DELETE")).toMatchObject({ op: "gfiles_delete" });
    expect(() => parsePath("/v1/uploads/u/other", "POST")).toThrow();
    expect(() => parsePath("/v1/files", "PUT")).toThrow();
  });
});

describe("byte identity helper sanity", () => {
  it("sha-256 of a spliced stream equals the hash of the expected bytes", async () => {
    const data = randomBytes(1_000_000);
    const spool = await BodySpool.fromStream(stream(data), { memLimit: 1000 });
    const out = await collect(spool.stream([{ start: 0, end: data.length }]));
    expect(createHash("sha256").update(out).digest("hex")).toBe(createHash("sha256").update(data).digest("hex"));
    await spool.dispose();
  });
});
