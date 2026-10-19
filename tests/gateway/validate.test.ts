/**
 * Request validation (QA finding #3): clear 400 `invalid_request` in the inbound format's native error shape, before
 * anything is reserved or sent upstream. Real database; skipped when unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbOk, createHarness } from "./harness";
import { invalidateGatewayConfig } from "@/gateway/cache";

const h = createHarness("val");
let key = "";
let model = "";
let embed = "";
let image = "";
let vid = "";
let speech = "";
let stt = "";
const total = async () => ((await (await fetch(`${h.base}/__mock/stats`)).json()) as { total: number }).total;

describe.skipIf(!dbOk)("request validation", () => {
  beforeAll(async () => {
    await h.start();
    const p = await h.makeProvider("all", {
      formats: ["openai_chat", "openai_completions", "openai_responses", "openai_embeddings", "openai_images", "openai_audio", "openai_moderations", "anthropic_messages", "gemini", "openai_videos"],
      settings: { anthropicBaseUrl: h.base, geminiBaseUrl: h.base },
      keys: [{ s: "k1" }],
    });
    model = (await h.makeModel("chat", { caps: ["chat", "completions", "responses", "moderation"], providerId: p.id, in: "1", out: "2" })).slug;
    embed = (await h.makeModel("emb", { caps: ["embeddings"], providerId: p.id, in: "0.1", out: "0" })).slug;
    image = (await h.makeModel("img", { caps: ["images"], providerId: p.id, in: "0", out: "0", image: "0.04" })).slug;
    vid = (await h.makeModel("vid", { caps: ["video"], providerId: p.id, in: "0", out: "0", perSecond: "0.1" })).slug;
    stt = (await h.makeModel("stt", { caps: ["audio_transcription"], providerId: p.id, in: "0", out: "0" })).slug;
    speech = (await h.makeModel("tts", { caps: ["audio_speech"], providerId: p.id, in: "0", out: "0" })).slug;
    const u = await h.makeUser("u", { balance: "5" });
    key = (await h.makeKey("u", u.id)).key;
    await invalidateGatewayConfig("all");
  }, 60_000);

  afterAll(async () => {
    await h.cleanup();
  }, 30_000);

  const openaiErr = async (res: Response, param: string, _message?: RegExp) => {
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: "invalid_request", type: "invalid_request_error", param });
    void _message;
  };

  it("chat completions: messages must be a non-empty array of objects", async () => {
    const before = await total();
    for (const body of [{ model }, { model, messages: [] }, { model, messages: "hi" }, { model, messages: ["hi"] }]) {
      const res = await h.call("/v1/chat/completions", key, body);
      expect(res.status).toBe(400);
      const e = (await res.json()).error;
      expect(e).toMatchObject({ code: "invalid_request", type: "invalid_request_error" });
      expect(e.message).toMatch(/messages/);
      expect(e.param).toMatch(/^messages/);
    }
    const log = await h.logOf(await h.call("/v1/chat/completions", key, { model, messages: [] }));
    expect(log).toMatchObject({ status: "CLIENT_ERROR", httpStatus: 400, errorCode: "invalid_request" });
    expect(await total()).toBe(before); // never sent upstream
  });

  it("numeric limits must be positive integers", async () => {
    for (const extra of [{ max_tokens: 0 }, { max_tokens: -5 }, { max_tokens: 1.5 }, { max_completion_tokens: "100" }, { n: 0 }]) {
      const res = await h.call("/v1/chat/completions", key, { model, messages: [{ role: "user", content: "x" }], ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it("completions / responses / embeddings / moderations / images / speech / videos require their input", async () => {
    await openaiErr(await h.call("/v1/completions", key, { model }), "prompt", /prompt/);
    await openaiErr(await h.call("/v1/responses", key, { model }), "input", /input/);
    await openaiErr(await h.call("/v1/responses", key, { model, input: "" }), "input", /input/);
    await openaiErr(await h.call("/v1/embeddings", key, { model: embed }), "input", /input/);
    await openaiErr(await h.call("/v1/embeddings", key, { model: embed, input: [] }), "input", /input/);
    await openaiErr(await h.call("/v1/moderations", key, { model }), "input", /input/);
    await openaiErr(await h.call("/v1/images/generations", key, { model: image }), "prompt", /prompt/);
    await openaiErr(await h.call("/v1/images/generations", key, { model: image, prompt: "  " }), "prompt", /prompt/);
    await openaiErr(await h.call("/v1/images/generations", key, { model: image, prompt: "a cat", n: 11 }), "n", /n/);
    await openaiErr(await h.call("/v1/audio/speech", key, { model: speech, voice: "alloy" }), "input", /input/);
    await openaiErr(await h.call("/v1/videos", key, { model: vid, seconds: "4" }), "prompt", /prompt/);
  });

  it("multipart endpoints require their file / prompt", async () => {
    const edit = new FormData();
    edit.set("model", image);
    edit.set("prompt", "x");
    await openaiErr(await h.call("/v1/images/edits", key, edit), "image", /image/);
    const sttForm = new FormData();
    sttForm.set("model", stt);
    await openaiErr(await h.call("/v1/audio/transcriptions", key, sttForm), "file", /file/);
  });

  it("Anthropic messages: Anthropic error shape; a missing max_tokens is fine (filled in), a bad one is not", async () => {
    const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
    const res = await h.call("/v1/messages", null, { model }, { headers });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(body.error.message).toMatch(/messages/);
    const bad = await h.call("/v1/messages", null, { model, max_tokens: -1, messages: [{ role: "user", content: "x" }] }, { headers });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toMatch(/max_tokens/);
    const ok = await h.call("/v1/messages", null, { model, messages: [{ role: "user", content: "x" }] }, { headers });
    expect(ok.status).toBe(200);
    await ok.text();
    expect((await h.call("/v1/messages/count_tokens", null, { model }, { headers })).status).toBe(400);
  });

  it("Gemini: Gemini error shape", async () => {
    for (const [path, body] of [
      [`/v1beta/models/${model}:generateContent`, {}],
      [`/v1beta/models/${model}:generateContent`, { contents: [] }],
      [`/v1beta/models/${model}:streamGenerateContent?alt=sse`, { contents: "hi" }],
      [`/v1beta/models/${embed}:embedContent`, {}],
      [`/v1beta/models/${embed}:batchEmbedContents`, { requests: [] }],
    ] as const) {
      const res = await h.call(path, key, body);
      expect(res.status, path).toBe(400);
      expect((await res.json()).error).toMatchObject({ code: 400, status: "INVALID_ARGUMENT" });
    }
    const bad = await h.call(`/v1beta/models/${model}:generateContent`, key, { contents: [{ role: "user", parts: [{ text: "x" }] }], generationConfig: { maxOutputTokens: 0 } });
    expect(bad.status).toBe(400);
  });

  it("valid requests still pass", async () => {
    const res = await h.call("/v1/chat/completions", key, { model, messages: [{ role: "user", content: "hello" }], max_tokens: 50 });
    expect(res.status).toBe(200);
    await res.text();
    const emb = await h.call("/v1/embeddings", key, { model: embed, input: "hello" });
    expect(emb.status).toBe(200);
    await emb.text();
  });
});
