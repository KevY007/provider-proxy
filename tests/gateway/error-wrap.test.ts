import { describe, expect, it } from "vitest";
import { errorResponse } from "@/gateway/errors";
import { clientErrorFromUpstream, extractErrorMessage } from "@/gateway/shape";

const scrub = { upstreamModel: "gpt-6.1-sol", publicModel: "gpt-6-astra", providerName: "Acme Cloud", providerSlug: "acme", baseUrl: "https://api.acme-ai.net/v1", secret: "sk-live-supersecret" };

async function render(status: number, body: string, inbound: Parameters<typeof clientErrorFromUpstream>[2], upstream: Parameters<typeof clientErrorFromUpstream>[3], fmt: "openai" | "anthropic" | "gemini") {
  const err = clientErrorFromUpstream(status, body, inbound, upstream, scrub);
  const res = errorResponse(fmt, err, "req_1");
  const text = await res.text();
  return { err, status: res.status, text, json: JSON.parse(text) as { error: { message: string; type?: string; code?: string | number | null; param?: string | null; status?: string }; type?: string }
  };
}

describe("upstream 4xx bodies are always re-wrapped in the native shape", () => {
  it("plain text is wrapped (and scrubbed), never echoed as the whole body", async () => {
    const r = await render(400, "Bad request: model gpt-6.1-sol on Acme Cloud rejected sk-live-supersecret at https://api.acme-ai.net/v1/chat", "openai_chat", "openai_chat", "openai");
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ type: "invalid_request_error", code: "invalid_request", param: null });
    expect(r.json.error.message).toContain("gpt-6-astra");
    expect(r.text).not.toMatch(/gpt-6\.1-sol|Acme|acme-ai|supersecret|https?:/i);
    expect(r.err.internal).toContain("gpt-6.1-sol"); // the admin keeps the original
  });

  it("HTML error pages become a clean message", async () => {
    const r = await render(404, "<html><head><title>404</title></head><body><h1>Not Found</h1><p>nginx/1.2</p></body></html>", "openai_chat", "openai_chat", "openai");
    expect(r.status).toBe(404);
    expect(r.json.error.message).not.toMatch(/[<>]/);
    expect(r.json.error.message).toMatch(/Not Found/);
  });

  it("an empty body or JSON without a message gets a generic message, not the raw document", async () => {
    const empty = await render(400, "", "openai_chat", "openai_chat", "openai");
    expect(empty.json.error.message).toBe("The request was rejected as invalid.");
    const weird = await render(422, JSON.stringify({ status: "nope", trace: "secret stack at https://api.acme-ai.net/x" }), "openai_chat", "openai_chat", "openai");
    expect(weird.json.error.message).toBe("The request was rejected as invalid.");
    expect(weird.text).not.toMatch(/trace|stack|acme/i);
    const notFound = await render(404, "", "openai_chat", "openai_chat", "openai");
    expect(notFound.json.error.message).toBe("The requested resource was not found.");
  });

  it("an upstream OpenAI error document is rebuilt from whitelisted fields: type / code / param kept, extras dropped", async () => {
    const body = JSON.stringify({
      error: { message: "This model's maximum context length is 128000 tokens (gpt-6.1-sol).", type: "invalid_request_error", code: "context_length_exceeded", param: "messages[0].content", debug: "x-internal-host acme-7", request_id: "req_up_1" },
      request_id: "req_up_2",
    });
    const r = await render(400, body, "openai_chat", "openai_chat", "openai");
    expect(r.json).toEqual({ error: { message: "This model's maximum context length is 128000 tokens (gpt-6-astra).", type: "invalid_request_error", code: "context_length_exceeded", param: "messages[0].content" } });
  });

  it("unsafe type / code values are dropped", async () => {
    const r = await render(400, JSON.stringify({ error: { message: "bad", type: "x y z <script>", code: { nested: true }, param: "a b" } }), "openai_chat", "openai_chat", "openai");
    expect(r.json.error).toEqual({ message: "bad", type: "invalid_request_error", code: null, param: null });
  });

  it("Anthropic documents are rebuilt without foreign fields", async () => {
    const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: Field required (gpt-6.1-sol)" }, request_id: "req_up" });
    const r = await render(400, body, "anthropic_messages", "anthropic_messages", "anthropic");
    expect(r.json).toEqual({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: Field required (gpt-6-astra)" } });
  });

  it("Gemini error arrays are understood and rebuilt", async () => {
    const body = JSON.stringify([{ error: { code: 400, message: "Invalid JSON payload received for gpt-6.1-sol.", status: "INVALID_ARGUMENT", details: [{ "@type": "x", host: "api.acme-ai.net" }] } }]);
    const r = await render(400, body, "gemini", "gemini", "gemini");
    expect(r.json).toEqual({ error: { code: 400, message: "Invalid JSON payload received for gpt-6-astra.", status: "INVALID_ARGUMENT" } });
    expect(extractErrorMessage(body)).toMatch(/Invalid JSON payload/);
  });

  it("a cross-format body is wrapped in the inbound shape with the scrubbed message", async () => {
    const body = JSON.stringify({ error: { message: "Model gpt-6.1-sol not allowed on Acme Cloud", type: "invalid_request_error", code: "model_not_found" } });
    const r = await render(422, body, "anthropic_messages", "openai_chat", "anthropic");
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(r.text).not.toMatch(/gpt-6\.1-sol|Acme/);
    const g = await render(400, body, "gemini", "openai_chat", "gemini");
    expect(g.json.error).toMatchObject({ code: 400, status: "INVALID_ARGUMENT" });
  });

  it("control characters and absurd lengths are cleaned", async () => {
    const r = await render(400, "line1\u0000\u0007line2 " + "x".repeat(5000), "openai_chat", "openai_chat", "openai");
    expect(r.json.error.message).not.toMatch(/[\u0000-\u001f]/);
    expect(r.json.error.message.length).toBeLessThanOrEqual(400);
  });

  it("413 keeps its code", async () => {
    const r = await render(413, "too large", "openai_chat", "openai_chat", "openai");
    expect(r.status).toBe(413);
    expect(r.err.code).toBe("payload_too_large");
  });
});
