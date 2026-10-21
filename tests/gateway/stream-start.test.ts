/** Stream start detection (preamble events) and assembling a stream back into the provider's JSON. */
import { describe, expect, it } from "vitest";
import { isPreambleEvent } from "@/gateway/stream-start";
import { SseCollector } from "@/gateway/stream-collect";
import { SseParser } from "@/gateway/sse";
import type { InboundFormat } from "@/gateway/types";

const ev = (data: unknown, event?: string) => {
  const raw = `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}`;
  return new SseParser().push(`${raw}\n\n`)[0];
};
const collect = (format: InboundFormat, frames: string) => {
  const c = new SseCollector(format);
  for (const e of new SseParser().push(frames)) c.push(e);
  return c.result();
};

describe("isPreambleEvent", () => {
  it("OpenAI chat: a role-only / empty chunk is preamble; text, tool calls, finish and usage are output", () => {
    expect(isPreambleEvent("openai_chat", ev({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }))).toBe(true);
    expect(isPreambleEvent("openai_chat", ev({ choices: [{ index: 0, delta: { content: "Hi" } }] }))).toBe(false);
    expect(isPreambleEvent("openai_chat", ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "f" } }] } }] }))).toBe(false);
    expect(isPreambleEvent("openai_chat", ev({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))).toBe(false);
    expect(isPreambleEvent("openai_chat", ev({ choices: [], usage: { prompt_tokens: 1 } }))).toBe(false);
    expect(isPreambleEvent("openai_chat", ev({ error: { message: "Service Unavailable" } }))).toBe(false);
    expect(isPreambleEvent("openai_chat", ev("[DONE]"))).toBe(false);
  });
  it("Responses and Anthropic: opening bookkeeping events are preamble, deltas are output", () => {
    for (const t of ["response.created", "response.in_progress", "response.output_item.added", "response.content_part.added"]) expect(isPreambleEvent("openai_responses", ev({ type: t }, t))).toBe(true);
    expect(isPreambleEvent("openai_responses", ev({ type: "response.output_text.delta", delta: "x" }, "response.output_text.delta"))).toBe(false);
    for (const t of ["message_start", "ping", "content_block_start"]) expect(isPreambleEvent("anthropic_messages", ev({ type: t }, t))).toBe(true);
    expect(isPreambleEvent("anthropic_messages", ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }, "content_block_delta"))).toBe(false);
  });
});

describe("SseCollector", () => {
  it("OpenAI chat: text, tool calls and usage", () => {
    const r = collect(
      "openai_chat",
      [
        { id: "c1", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
        { id: "c1", choices: [{ index: 0, delta: { content: "Hel" } }] },
        { id: "c1", choices: [{ index: 0, delta: { content: "lo" } }] },
        { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "get", arguments: '{"a"' } }] } }] },
        { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] },
        { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { id: "c1", choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
      ]
        .map((j) => `data: ${JSON.stringify(j)}\n\n`)
        .join("") + "data: [DONE]\n\n",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.json).toMatchObject({
      id: "c1",
      object: "chat.completion",
      model: "m",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "Hello", tool_calls: [{ id: "t1", type: "function", function: { name: "get", arguments: '{"a":1}' } }] } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
  });
  it("OpenAI chat: an in-band error or a stream without finish_reason is a failure", () => {
    const err = collect("openai_chat", `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\ndata: ${JSON.stringify({ error: { message: "Service Unavailable", type: "upstream_error" } })}\n\n`);
    expect(err).toEqual({ ok: false, status: 503, message: "Service Unavailable" });
    const cut = collect("openai_chat", `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "half" } }] })}\n\n`);
    expect(cut.ok).toBe(false);
  });
  it("Responses: the response.completed document; response.failed is a failure", () => {
    const done = collect("openai_responses", `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r1", status: "in_progress" } })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", output: [{ type: "message" }], usage: { input_tokens: 2 } } })}\n\n`);
    expect(done).toEqual({ ok: true, json: { id: "r1", status: "completed", output: [{ type: "message" }], usage: { input_tokens: 2 } } });
    const failed = collect("openai_responses", `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } })}\n\n`);
    expect(failed.ok).toBe(false);
  });
  it("Anthropic: text + tool_use blocks rebuilt, stop reason and usage merged", () => {
    const frames = [
      ["message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "c", content: [], usage: { input_tokens: 9, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu", name: "f", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":' } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"x"}' } }],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } }],
      ["message_stop", { type: "message_stop" }],
    ]
      .map(([e, j]) => `event: ${e}\ndata: ${JSON.stringify(j)}\n\n`)
      .join("");
    const r = collect("anthropic_messages", frames);
    expect(r).toEqual({
      ok: true,
      json: { id: "m1", type: "message", role: "assistant", model: "c", stop_reason: "tool_use", usage: { input_tokens: 9, output_tokens: 12 }, content: [{ type: "text", text: "Hi" }, { type: "tool_use", id: "tu", name: "f", input: { q: "x" } }] },
    });
  });
});
