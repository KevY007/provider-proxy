import { describe, expect, it } from "vitest";
import { GatewayError } from "@/gateway/errors";
import { ipAllowed } from "@/gateway/ip";
import { encodeMultipart, parseMultipart } from "@/gateway/multipart";
import { buildUpstreamHeaders, buildUpstreamUrl, type AdapterProvider } from "@/gateway/providers/adapters";
import { PROVIDER_PRESETS, getPreset } from "@/gateway/providers/presets";
import type { StreamProcessor } from "@/gateway/processor";
import { SseParser, sseEvent } from "@/gateway/sse";
import { clientErrorFromUpstream, extractUsage, maskResponse, parseRetryAfter, scrubText } from "@/gateway/shape";
import { OpenAIStreamPassthrough, AnthropicStreamPassthrough, GeminiStreamPassthrough, ResponsesStreamPassthrough } from "@/gateway/stream-processors";
import { usageFromAnthropic, usageFromGemini, usageFromOpenAI } from "@/gateway/usage";
import { deepMerge, weightedShuffle } from "@/gateway/util";

describe("deepMerge (route paramOverrides)", () => {
  it("merges nested objects, replaces arrays and deletes fields set to null", () => {
    const body = { model: "x", temperature: 1, reasoning: { effort: "high", summary: "auto" }, stop: ["a"], metadata: { a: 1 } };
    deepMerge(body, { temperature: null, reasoning: { effort: "low" }, stop: ["b", "c"], extra: { deep: { v: 1 } }, metadata: null });
    expect(body).toEqual({ model: "x", reasoning: { effort: "low", summary: "auto" }, stop: ["b", "c"], extra: { deep: { v: 1 } } });
  });

  it("ignores prototype-pollution keys", () => {
    const body: Record<string, unknown> = {};
    deepMerge(body, JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("weightedShuffle", () => {
  it("returns a permutation and respects weights statistically", () => {
    expect(weightedShuffle(["a", "b", "c"], () => 1).sort()).toEqual(["a", "b", "c"]);
    let a = 0;
    for (let i = 0; i < 4000; i++) if (weightedShuffle(["a", "b"], (x) => (x === "a" ? 3 : 1))[0] === "a") a++;
    expect(a / 4000).toBeGreaterThan(0.7);
    expect(a / 4000).toBeLessThan(0.8);
  });
});

describe("ipAllowed", () => {
  it("allows everything for an empty list and matches exact IPs and CIDRs", () => {
    expect(ipAllowed("1.2.3.4", [])).toBe(true);
    expect(ipAllowed("1.2.3.4", ["1.2.3.4"])).toBe(true);
    expect(ipAllowed("1.2.3.5", ["1.2.3.4"])).toBe(false);
    expect(ipAllowed("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("192.168.1.77", ["192.168.1.64/26"])).toBe(true);
    expect(ipAllowed("192.168.1.130", ["192.168.1.64/26"])).toBe(false);
    expect(ipAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed("2001:dc8::1", ["2001:db8::/32"])).toBe(false);
    expect(ipAllowed("::ffff:10.0.0.9", ["10.0.0.0/24"])).toBe(true);
    expect(ipAllowed("unknown", ["10.0.0.0/8"])).toBe(false);
  });
});

describe("SseParser", () => {
  it("handles chunk boundaries, CRLF, comments, multi-line data and event names", () => {
    const p = new SseParser();
    const a = p.push('event: ping\ndata: {"a"');
    expect(a).toEqual([]);
    const b = p.push(':1}\n\n: keepalive\n\ndata: x\r\ndata: y\r\n\r\ndata: [DONE]\n\n');
    expect(b.map((e) => [e.event, e.data, e.comment])).toEqual([
      ["ping", '{"a":1}', false],
      [undefined, "", true],
      [undefined, "x\ny", false],
      [undefined, "[DONE]", false],
    ]);
  });

  it("flushes an unterminated final event at EOF and serialises events", () => {
    const p = new SseParser();
    p.push("data: tail");
    expect(p.end().map((e) => e.data)).toEqual(["tail"]);
    expect(sseEvent({ a: 1 }, "x")).toBe('event: x\ndata: {"a":1}\n\n');
  });
});

describe("usage normalisation", () => {
  it("OpenAI: prompt_tokens already includes cached; reasoning is a subset of completion", () => {
    const u = usageFromOpenAI({ prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 20 } });
    expect(u).toMatchObject({ inputTokens: 100, outputTokens: 50, cachedTokens: 30, reasoningTokens: 20 });
  });
  it("Anthropic: input_tokens excludes cache -> inputTokens is the total prompt", () => {
    const u = usageFromAnthropic({ input_tokens: 10, cache_read_input_tokens: 70, cache_creation_input_tokens: 20, output_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 8, ephemeral_5m_input_tokens: 12 } });
    expect(u).toMatchObject({ inputTokens: 100, cachedTokens: 70, cacheWriteTokens: 20, cacheWrite1hTokens: 8, outputTokens: 5 });
  });
  it("Gemini: thoughts are billed as output", () => {
    const u = usageFromGemini({ promptTokenCount: 40, cachedContentTokenCount: 10, candidatesTokenCount: 6, thoughtsTokenCount: 4 });
    expect(u).toMatchObject({ inputTokens: 40, cachedTokens: 10, outputTokens: 10, reasoningTokens: 4 });
  });
  it("extractUsage handles images, transcription duration and count_tokens", () => {
    expect(extractUsage("openai_images", "images_generations", { data: [{}, {}], usage: { input_tokens: 5, output_tokens: 7 } })).toMatchObject({ imageCount: 2, inputTokens: 5, outputTokens: 7 });
    expect(extractUsage("openai_audio", "audio_transcriptions", { text: "x", usage: { type: "duration", seconds: 12.5 } })?.audioSeconds).toBe(12.5);
    expect(extractUsage("anthropic_messages", "messages_count_tokens", { input_tokens: 99 })).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(extractUsage("openai_chat", "chat", { choices: [] })).toBeNull();
  });
});

describe("masking + scrubbing", () => {
  it("rewrites model names in all response shapes", () => {
    const a: Record<string, unknown> = { model: "gpt-secret" };
    const b: Record<string, unknown> = { modelVersion: "gemini-secret" };
    const c: Record<string, unknown> = { response: { model: "resp-secret" } };
    [a, b, c].forEach((x) => maskResponse(x, "public"));
    expect(a.model).toBe("public");
    expect(b.modelVersion).toBe("public");
    expect((c.response as { model: string }).model).toBe("public");
  });

  const scrub = { upstreamModel: "gpt-6.1-sol", publicModel: "gpt-6-astra", providerName: "Acme Cloud", providerSlug: "acme", baseUrl: "https://api.acme-ai.net/v1", secret: "sk-live-supersecret" };
  it("removes upstream model, provider name, host, URLs and keys from text", () => {
    const t = scrubText("The model gpt-6.1-sol on Acme Cloud (https://api.acme-ai.net/v1/chat) rejected key sk-live-supersecret; api.acme-ai.net is down", scrub);
    expect(t).not.toMatch(/gpt-6\.1-sol|Acme Cloud|acme-ai|supersecret|https?:/i);
    expect(t).toContain("gpt-6-astra");
  });

  it("passes a same-format upstream 4xx through (scrubbed) and re-wraps cross-format ones", () => {
    const body = JSON.stringify({ error: { message: "Model gpt-6.1-sol not allowed on Acme Cloud", type: "invalid_request_error", code: "model_not_found", param: "model" } });
    const same = clientErrorFromUpstream(400, body, "openai_chat", "openai_chat", scrub);
    expect(same.status).toBe(400);
    expect(same.opts.passthroughBody).toBeDefined();
    expect(same.opts.passthroughBody).not.toMatch(/gpt-6\.1-sol|Acme/);
    expect(JSON.parse(same.opts.passthroughBody!).error.type).toBe("invalid_request_error");
    expect(same.internal).toContain("gpt-6.1-sol"); // admin detail keeps the original

    const cross = clientErrorFromUpstream(422, body, "anthropic_messages", "openai_chat", scrub);
    expect(cross).toBeInstanceOf(GatewayError);
    expect(cross.opts.passthroughBody).toBeUndefined();
    expect(cross.status).toBe(422);
    expect(cross.message).not.toMatch(/gpt-6\.1-sol|Acme/);
  });

  it("parses retry-after in seconds, ms and HTTP-date forms", () => {
    expect(parseRetryAfter(new Headers({ "retry-after": "7" }))).toBe(7);
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "1500" }))).toBe(2);
    expect(parseRetryAfter(new Headers({ "retry-after": new Date(Date.now() + 10_000).toUTCString() }))).toBeGreaterThanOrEqual(9);
    expect(parseRetryAfter(new Headers())).toBeUndefined();
  });
});

describe("same-format stream processors", () => {
  const feed = (p: StreamProcessor, s: string) => new SseParser().push(new SseParser().push(s).flatMap((e) => p.onEvent(e)).join(""));

  it("OpenAI: masks the model, hides our injected usage chunk from clients that did not ask, keeps usage for metering", () => {
    const p = new OpenAIStreamPassthrough("public", false);
    const out = feed(
      p,
      'data: {"model":"up","choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"model":"up","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    );
    expect(out.map((e) => e.data)).toEqual(['{"model":"public","choices":[{"delta":{"content":"hi"}}]}', "[DONE]"]);
    expect(p.usage()).toMatchObject({ inputTokens: 4, outputTokens: 2 });
    expect(p.outputText()).toBe("hi");
    expect(p.completed()).toBe(true);
  });

  it("OpenAI: forwards the usage chunk to clients that asked for it", () => {
    const p = new OpenAIStreamPassthrough("public", true);
    const out = feed(p, 'data: {"model":"up","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n');
    expect(JSON.parse(out[0].data)).toMatchObject({ model: "public", usage: { prompt_tokens: 4 } });
  });

  it("OpenAI: strips usage that is embedded in a normal chunk when not requested", () => {
    const p = new OpenAIStreamPassthrough(null, false);
    const out = feed(p, 'data: {"model":"up","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');
    const j = JSON.parse(out[0].data);
    expect(j.usage).toBeUndefined();
    expect(j.model).toBe("up"); // masking disabled
  });

  it("Anthropic: masks message_start.model and tracks usage across message_start + message_delta", () => {
    const p = new AnthropicStreamPassthrough("public");
    feed(
      p,
      'event: message_start\ndata: {"type":"message_start","message":{"model":"up","usage":{"input_tokens":9,"cache_read_input_tokens":1,"output_tokens":1}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"yo"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    expect(p.usage()).toMatchObject({ inputTokens: 10, cachedTokens: 1, outputTokens: 12 });
    expect(p.completed()).toBe(true);
    const out = feed(new AnthropicStreamPassthrough("public"), 'event: message_start\ndata: {"type":"message_start","message":{"model":"up"}}\n\n');
    expect(JSON.parse(out[0].data).message.model).toBe("public");
    expect(out[0].event).toBe("message_start");
  });

  it("Gemini: masks modelVersion, last cumulative usageMetadata wins", () => {
    const p = new GeminiStreamPassthrough("public");
    const out = feed(
      p,
      'data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1},"modelVersion":"up"}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"b"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3},"modelVersion":"up"}\n\n',
    );
    expect(JSON.parse(out[1].data).modelVersion).toBe("public");
    expect(p.usage()).toMatchObject({ inputTokens: 5, outputTokens: 3 });
    expect(p.outputText()).toBe("ab");
    expect(p.completed()).toBe(true);
  });

  it("Responses: captures the response id, masks the model and reads usage from response.completed", () => {
    const p = new ResponsesStreamPassthrough("public");
    const out = feed(
      p,
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"up"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"up","usage":{"input_tokens":8,"output_tokens":3,"input_tokens_details":{"cached_tokens":2}}}}\n\n',
    );
    expect(p.responseId?.()).toBe("resp_1");
    expect(JSON.parse(out[0].data).response.model).toBe("public");
    expect(p.usage()).toMatchObject({ inputTokens: 8, cachedTokens: 2, outputTokens: 3 });
    expect(p.completed()).toBe(true);
  });
});

describe("multipart passthrough", () => {
  it("re-encodes a form with the upstream model swapped in and files intact", async () => {
    const fd = new FormData();
    fd.append("model", "public-model");
    fd.append("prompt", "a cat");
    fd.append("image", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }), "cat.png");
    const req = new Request("http://x", { method: "POST", body: fd });
    const raw = Buffer.from(await req.arrayBuffer());
    const form = await parseMultipart(raw, req.headers.get("content-type")!);
    expect(form.fields.map((f) => f.name)).toEqual(["model", "prompt"]);
    expect(form.files[0].filename).toBe("cat.png");

    const enc = encodeMultipart(form, { model: "up-model" });
    const back = await parseMultipart(enc.body, enc.contentType);
    expect(back.fields.find((f) => f.name === "model")?.value).toBe("up-model");
    expect(back.fields.find((f) => f.name === "prompt")?.value).toBe("a cat");
    expect([...(await back.spool.slice(back.files[0].start, back.files[0].end))]).toEqual([1, 2, 3, 4]);
    expect(back.files[0].size).toBe(4);
    expect(back.files[0].type).toBe("image/png");
  });
});

describe("provider adapters", () => {
  const mk = (over: Partial<AdapterProvider>): AdapterProvider => ({
    slug: "p",
    preset: "custom",
    baseUrl: "https://up.example/v1",
    authStyle: "BEARER",
    tags: [],
    extraHeaders: {},
    settings: {},
    ...over,
  });

  it("builds OpenAI-compatible URLs from a baseUrl that includes /v1", () => {
    const u = (op: Parameters<typeof buildUpstreamUrl>[0]["op"]) => buildUpstreamUrl({ provider: mk({}), format: "openai_chat", op, upstreamModel: "m", stream: false });
    expect(u("chat")).toBe("https://up.example/v1/chat/completions");
    expect(u("embeddings")).toBe("https://up.example/v1/embeddings");
    expect(u("images_generations")).toBe("https://up.example/v1/images/generations");
    expect(u("audio_transcriptions")).toBe("https://up.example/v1/audio/transcriptions");
    expect(buildUpstreamUrl({ provider: mk({}), format: "openai_responses", op: "responses_get", upstreamModel: "m", stream: false, responseId: "resp 1" })).toBe("https://up.example/v1/responses/resp%201");
  });

  it("uses settings.anthropicBaseUrl / geminiBaseUrl conventions", () => {
    const p = mk({ baseUrl: "https://relay.example/v1", settings: { anthropicBaseUrl: "https://relay.example", geminiBaseUrl: "https://relay.example/v1beta" } });
    expect(buildUpstreamUrl({ provider: p, format: "anthropic_messages", op: "messages", upstreamModel: "c", stream: true })).toBe("https://relay.example/v1/messages");
    expect(buildUpstreamUrl({ provider: p, format: "anthropic_messages", op: "messages_count_tokens", upstreamModel: "c", stream: false })).toBe("https://relay.example/v1/messages/count_tokens");
    expect(buildUpstreamUrl({ provider: p, format: "gemini", op: "gemini_generate", upstreamModel: "g", stream: false })).toBe("https://relay.example/v1beta/models/g:generateContent");
    expect(buildUpstreamUrl({ provider: p, format: "gemini", op: "gemini_stream", upstreamModel: "models/g", stream: true })).toBe("https://relay.example/v1beta/models/g:streamGenerateContent?alt=sse");
    const origin = mk({ baseUrl: "https://relay.example", settings: { geminiBaseUrl: "https://relay.example" } });
    expect(buildUpstreamUrl({ provider: origin, format: "gemini", op: "gemini_embed", upstreamModel: "e", stream: false })).toBe("https://relay.example/v1beta/models/e:embedContent");
    expect(buildUpstreamUrl({ provider: mk({ baseUrl: "https://api.anthropic.com" }), format: "anthropic_messages", op: "messages", upstreamModel: "c", stream: false })).toBe("https://api.anthropic.com/v1/messages");
  });

  it("serves OpenAI-format requests through Google's OpenAI-compatible endpoint", () => {
    const g = mk({ preset: "google", baseUrl: "https://generativelanguage.googleapis.com", authStyle: "X_GOOG_API_KEY" });
    expect(buildUpstreamUrl({ provider: g, format: "openai_chat", op: "chat", upstreamModel: "gemini-x", stream: false })).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(buildUpstreamUrl({ provider: g, format: "gemini", op: "gemini_generate", upstreamModel: "gemini-x", stream: false })).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
  });

  it("builds Azure deployment URLs with api-version and per-key deployment maps", () => {
    const az = mk({ preset: "azure", baseUrl: "https://res.openai.azure.com", authStyle: "AZURE_API_KEY", settings: { azureApiVersion: "2025-01-01" } });
    expect(buildUpstreamUrl({ provider: az, format: "openai_chat", op: "chat", upstreamModel: "gpt-4o", stream: false })).toBe("https://res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01");
    expect(buildUpstreamUrl({ provider: az, format: "openai_chat", op: "chat", upstreamModel: "gpt-4o", stream: false, keyExtra: { deployments: { "gpt-4o": "my-dep" } } })).toContain("/deployments/my-dep/");
  });

  it("appends ?key= for QUERY_KEY auth", () => {
    const q = mk({ authStyle: "QUERY_KEY" });
    expect(buildUpstreamUrl({ provider: q, format: "openai_chat", op: "chat", upstreamModel: "m", stream: false, secret: "s/1" })).toBe("https://up.example/v1/chat/completions?key=s%2F1");
  });

  it("sets the right auth header per style and surface; admin extraHeaders can never override auth", () => {
    const h = (p: Partial<AdapterProvider>, format: Parameters<typeof buildUpstreamHeaders>[0]["format"], inbound?: Headers) =>
      buildUpstreamHeaders({ provider: mk(p), format, secret: "SECRET", stream: false, inbound });
    expect(h({}, "openai_chat").authorization).toBe("Bearer SECRET");
    expect(h({ authStyle: "X_API_KEY" }, "anthropic_messages")["x-api-key"]).toBe("SECRET");
    expect(h({ authStyle: "X_API_KEY" }, "anthropic_messages").authorization).toBeUndefined();
    expect(h({ authStyle: "X_GOOG_API_KEY" }, "gemini")["x-goog-api-key"]).toBe("SECRET");
    expect(h({ authStyle: "AZURE_API_KEY" }, "openai_chat")["api-key"]).toBe("SECRET");
    // relays that declare BEARER get the native header for the surface too
    expect(h({}, "anthropic_messages")["x-api-key"]).toBe("SECRET");
    expect(h({}, "anthropic_messages").authorization).toBe("Bearer SECRET");
    expect(h({ extraHeaders: { authorization: "Bearer evil", "x-team": "a" } }, "openai_chat")).toMatchObject({ authorization: "Bearer SECRET", "x-team": "a" });
  });

  it("forwards anthropic-version/beta (default 2023-06-01 or provider setting) and x-mock-* only to mock providers", () => {
    const inbound = new Headers({ "anthropic-version": "2024-01-01", "anthropic-beta": "tools-2024", "x-mock-delay-ms": "50", authorization: "Bearer customer-key" });
    const a = buildUpstreamHeaders({ provider: mk({ authStyle: "X_API_KEY" }), format: "anthropic_messages", secret: "S", stream: true, inbound });
    expect(a["anthropic-version"]).toBe("2024-01-01");
    expect(a["anthropic-beta"]).toBe("tools-2024");
    expect(a.accept).toBe("text/event-stream");
    expect(a["x-mock-delay-ms"]).toBeUndefined();
    expect(JSON.stringify(a)).not.toContain("customer-key");
    expect(buildUpstreamHeaders({ provider: mk({ authStyle: "X_API_KEY", settings: { anthropicVersion: "2099-01-01" } }), format: "anthropic_messages", secret: "S", stream: false })["anthropic-version"]).toBe("2099-01-01");
    expect(buildUpstreamHeaders({ provider: mk({ authStyle: "X_API_KEY" }), format: "anthropic_messages", secret: "S", stream: false })["anthropic-version"]).toBe("2023-06-01");
    const m = buildUpstreamHeaders({ provider: mk({ tags: ["mock"] }), format: "openai_chat", secret: "S", stream: false, inbound });
    expect(m["x-mock-delay-ms"]).toBe("50");
  });
});

describe("provider presets", () => {
  it("covers every required provider with valid formats/auth and sample models", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    for (const id of ["openai", "anthropic", "google", "azure", "xai", "groq", "deepseek", "mistral", "together", "fireworks", "openrouter", "codex-everywhere", "custom"]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(getPreset("anthropic")).toMatchObject({ authStyle: "X_API_KEY", baseUrl: "https://api.anthropic.com", formats: ["anthropic_messages", "anthropic_files", "anthropic_batches"] });
    expect(getPreset("google")).toMatchObject({ authStyle: "X_GOOG_API_KEY" });
    expect(getPreset("azure")?.authStyle).toBe("AZURE_API_KEY");
    expect(getPreset("codex-everywhere")?.settings).toMatchObject({ anthropicBaseUrl: "https://codex-everywhere.com", geminiBaseUrl: "https://codex-everywhere.com/v1beta" });
    expect(getPreset("codex-everywhere")?.formats).toEqual(["openai_chat", "openai_responses", "openai_images", "anthropic_messages", "gemini", "openai_embeddings"]);
    expect(getPreset("nope")).toBeUndefined();
    for (const p of PROVIDER_PRESETS) {
      expect(p.baseUrl).toMatch(/^https:\/\//);
      expect(p.formats.length).toBeGreaterThan(0);
      expect(p.docsUrl === undefined || p.docsUrl.startsWith("https://")).toBe(true);
    }
  });
});
