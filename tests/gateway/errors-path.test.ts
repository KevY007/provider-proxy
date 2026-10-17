import { describe, expect, it } from "vitest";
import { ERROR_DEFS, GatewayError, errorBody, errorResponse, streamErrorEvent, type GatewayErrorCode } from "@/gateway/errors";
import { guessErrorFormat, normalizePath, parsePath } from "@/gateway/path";

describe("error shapes", () => {
  it("renders OpenAI errors as {error:{message,type,code,param}}", () => {
    const body = errorBody("openai", new GatewayError("insufficient_balance"));
    expect(body).toEqual({ error: { message: ERROR_DEFS.insufficient_balance.message, type: "billing_error", code: "insufficient_balance", param: null } });
  });

  it("renders Anthropic errors as {type:'error',error:{type,message}} with the right error type per status", () => {
    const cases: Array<[GatewayErrorCode, string]> = [
      ["invalid_api_key", "authentication_error"],
      ["model_not_allowed", "permission_error"],
      ["model_not_found", "not_found_error"],
      ["invalid_request", "invalid_request_error"],
      ["rate_limited", "rate_limit_error"],
      ["payload_too_large", "request_too_large"],
      ["upstream_error", "api_error"],
      ["no_available_provider", "overloaded_error"],
      ["upstream_overloaded", "overloaded_error"],
      ["insufficient_balance", "billing_error"],
    ];
    for (const [code, type] of cases) {
      const b = errorBody("anthropic", new GatewayError(code), "req_1") as { type: string; error: { type: string; message: string }; request_id: string };
      expect(b.type).toBe("error");
      expect(b.error.type).toBe(type);
      expect(typeof b.error.message).toBe("string");
      expect(b.request_id).toBe("req_1");
    }
  });

  it("renders Gemini errors as {error:{code,message,status}}", () => {
    expect(errorBody("gemini", new GatewayError("invalid_api_key"))).toEqual({ error: { code: 401, message: ERROR_DEFS.invalid_api_key.message, status: "UNAUTHENTICATED" } });
    expect(errorBody("gemini", new GatewayError("rate_limited"))).toMatchObject({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } });
    expect(errorBody("gemini", new GatewayError("model_not_found"))).toMatchObject({ error: { code: 404, status: "NOT_FOUND" } });
    expect(errorBody("gemini", new GatewayError("upstream_timeout"))).toMatchObject({ error: { code: 504, status: "DEADLINE_EXCEEDED" } });
  });

  it("uses the documented HTTP status for every gateway code", () => {
    const expected: Record<string, number> = {
      invalid_api_key: 401,
      key_disabled: 401,
      key_expired: 401,
      ip_not_allowed: 403,
      account_suspended: 403,
      email_not_verified: 403,
      model_not_found: 404,
      model_not_allowed: 403,
      unsupported_endpoint: 400,
      insufficient_balance: 402,
      spend_limit_reached: 402,
      rate_limited: 429,
      no_available_provider: 503,
      upstream_timeout: 504,
      upstream_error: 502,
      invalid_request: 400,
      internal_error: 500,
    };
    for (const [code, status] of Object.entries(expected)) expect(ERROR_DEFS[code as GatewayErrorCode].status).toBe(status);
  });

  it("sets x-request-id, retry-after and passthrough headers on error responses", async () => {
    const err = new GatewayError("rate_limited", "slow down", { retryAfterSec: 3, headers: { "x-ratelimit-remaining-requests": "0" } });
    const res = errorResponse("openai", err, "rid_9");
    expect(res.status).toBe(429);
    expect(res.headers.get("x-request-id")).toBe("rid_9");
    expect(res.headers.get("retry-after")).toBe("3");
    expect(res.headers.get("x-ratelimit-remaining-requests")).toBe("0");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).error.message).toBe("slow down");
  });

  it("re-sends a pre-scrubbed same-format upstream body verbatim", async () => {
    const body = JSON.stringify({ error: { message: "bad param", type: "invalid_request_error", code: "x", param: "foo" } });
    const res = errorResponse("openai", new GatewayError("invalid_request", "bad param", { status: 422, passthroughBody: body }), "r");
    expect(res.status).toBe(422);
    expect(await res.text()).toBe(body);
  });

  it("never exposes internal detail in the customer body", async () => {
    const err = new GatewayError("upstream_error", undefined, { internal: "POST https://api.secret-vendor.com/v1/chat key=sk-live-123 -> 500" });
    const text = await errorResponse("openai", err, "r").text();
    expect(text).not.toContain("secret-vendor");
    expect(text).not.toContain("sk-live-123");
    expect(err.internal).toContain("secret-vendor");
  });

  it("serialises mid-stream errors per format", () => {
    const e = new GatewayError("upstream_timeout");
    expect(streamErrorEvent("anthropic", e)).toMatch(/^event: error\ndata: \{"type":"error"/);
    expect(streamErrorEvent("openai", e)).toMatch(/^data: \{"error":/);
  });
});

describe("path parsing", () => {
  it("normalises doubled /v1 prefixes and slashes", () => {
    expect(normalizePath("/v1/v1/chat/completions")).toBe("/v1/chat/completions");
    expect(normalizePath("/v1/v1/v1/models")).toBe("/v1/models");
    expect(normalizePath("//v1//chat/completions/")).toBe("/v1/chat/completions");
    expect(normalizePath("/v1/v1beta/models")).toBe("/v1beta/models");
    expect(normalizePath("/v1beta/openai/chat/completions")).toBe("/v1/chat/completions");
  });

  it("maps every documented inbound path to a format + operation + capability", () => {
    const cases: Array<[string, string, string, string, string | null]> = [
      ["POST", "/v1/chat/completions", "openai_chat", "chat", "chat"],
      ["POST", "/v1/completions", "openai_completions", "completions", "completions"],
      ["POST", "/v1/responses", "openai_responses", "responses", "responses"],
      ["POST", "/v1/embeddings", "openai_embeddings", "embeddings", "embeddings"],
      ["POST", "/v1/images/generations", "openai_images", "images_generations", "images"],
      ["POST", "/v1/images/edits", "openai_images", "images_edits", "images"],
      ["POST", "/v1/images/variations", "openai_images", "images_variations", "images"],
      ["POST", "/v1/audio/speech", "openai_audio", "audio_speech", "audio_speech"],
      ["POST", "/v1/audio/transcriptions", "openai_audio", "audio_transcriptions", "audio_transcription"],
      ["POST", "/v1/audio/translations", "openai_audio", "audio_translations", "audio_transcription"],
      ["POST", "/v1/moderations", "openai_moderations", "moderations", "moderation"],
      ["POST", "/v1/messages", "anthropic_messages", "messages", "chat"],
      ["POST", "/v1/messages/count_tokens", "anthropic_messages", "messages_count_tokens", "chat"],
      ["GET", "/v1/models", "catalog", "models_list", null],
      ["GET", "/v1/models/gpt-x", "catalog", "model_get", null],
      ["GET", "/v1beta/models", "catalog", "gemini_models_list", null],
      ["GET", "/v1beta/models/gemini-x", "catalog", "gemini_model_get", null],
      ["GET", "/v1/responses/resp_1", "openai_responses", "responses_get", "responses"],
      ["DELETE", "/v1/responses/resp_1", "openai_responses", "responses_delete", "responses"],
      ["POST", "/v1/responses/resp_1/cancel", "openai_responses", "responses_cancel", "responses"],
      ["GET", "/v1/responses/resp_1/input_items", "openai_responses", "responses_input_items", "responses"],
    ];
    for (const [method, path, format, op, cap] of cases) {
      const p = parsePath(path, method);
      expect([p.format, p.op, p.capability], `${method} ${path}`).toEqual([format, op, cap]);
    }
  });

  it("parses Gemini model + action from the URL", () => {
    const g = parsePath("/v1beta/models/gemini-3.1-pro:streamGenerateContent", "POST");
    expect(g).toMatchObject({ format: "gemini", op: "gemini_stream", model: "gemini-3.1-pro", pathStream: true, errorFormat: "gemini", endpoint: "/v1beta/models:streamGenerateContent" });
    expect(parsePath("/v1beta/models/x:generateContent", "POST").pathStream).toBe(false);
    expect(parsePath("/v1beta/models/x:embedContent", "POST").capability).toBe("embeddings");
    expect(parsePath("/v1beta/models/x:countTokens", "POST").op).toBe("gemini_count_tokens");
    expect(parsePath("/v1beta/models/models%2Fy:generateContent", "POST").model).toBe("models/y");
  });

  it("flags multipart ops and uses the Anthropic error shape for /v1/messages", () => {
    expect(parsePath("/v1/images/edits", "POST").multipart).toBe(true);
    expect(parsePath("/v1/audio/transcriptions", "POST").multipart).toBe(true);
    expect(parsePath("/v1/images/generations", "POST").multipart).toBe(false);
    expect(parsePath("/v1/messages", "POST").errorFormat).toBe("anthropic");
    expect(parsePath("/v1/chat/completions", "POST").errorFormat).toBe("openai");
  });

  it("works through a doubled prefix", () => {
    expect(parsePath("/v1/v1/chat/completions", "POST").op).toBe("chat");
  });

  it("throws not_found for unknown paths and method_not_allowed for wrong verbs", () => {
    expect(() => parsePath("/v1/unknown", "POST")).toThrowError(expect.objectContaining({ code: "not_found", status: 404 }));
    expect(() => parsePath("/v1/chat/completions", "GET")).toThrowError(expect.objectContaining({ code: "method_not_allowed", status: 405 }));
    expect(() => parsePath("/v1/models", "POST")).toThrowError(expect.objectContaining({ code: "method_not_allowed" }));
    expect(() => parsePath("/v1beta/models/x:bogus", "POST")).toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(() => parsePath("/", "GET")).toThrowError(expect.objectContaining({ code: "not_found" }));
  });

  it("guesses the error format from the path even when parsing fails", () => {
    expect(guessErrorFormat("/v1beta/models/x:bogus")).toBe("gemini");
    expect(guessErrorFormat("/v1/messages/unknown")).toBe("anthropic");
    expect(guessErrorFormat("/v1/whatever")).toBe("openai");
  });
});
