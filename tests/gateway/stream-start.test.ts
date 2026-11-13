/** Stream start detection (preamble events) and assembling a stream back into the provider's JSON. */
import { describe, expect, it } from "vitest";
import { holdCommitAfterMs, isPreambleEvent, newPreambleState, streamHoldSecFor } from "@/gateway/stream-start";
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
    // reasoning summaries stream for minutes before the answer: still the preamble
    expect(isPreambleEvent("openai_chat", ev({ choices: [{ index: 0, delta: { reasoning_content: "**Enumerating digit subsets**" } }] }))).toBe(true);
    expect(isPreambleEvent("openai_chat", ev({ choices: [{ index: 0, delta: { reasoning_content: "thinking", content: "117" } }] }))).toBe(false);
  });
  it("reasoning items / summaries / thinking deltas are preamble in Responses and Anthropic", () => {
    expect(isPreambleEvent("openai_responses", ev({ type: "response.output_item.added", item: { type: "reasoning" } }))).toBe(true);
    expect(isPreambleEvent("openai_responses", ev({ type: "response.output_item.done", item: { type: "reasoning" } }))).toBe(true);
    expect(isPreambleEvent("openai_responses", ev({ type: "response.reasoning_summary_text.delta", delta: "x" }))).toBe(true);
    expect(isPreambleEvent("openai_responses", ev({ type: "response.metadata" }))).toBe(true);
    expect(isPreambleEvent("openai_responses", ev({ type: "response.output_item.added", item: { type: "function_call" } }))).toBe(false);
    // a message item closing carries no text itself (its deltas commit; a relay's blank " " message must not)
    expect(isPreambleEvent("openai_responses", ev({ type: "response.output_item.done", item: { type: "message" } }))).toBe(true);
    expect(isPreambleEvent("anthropic_messages", ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } }))).toBe(true);
  });
  it("Responses: the text of a commentary-phase message is preamble once the stream's events are tracked; the answer and tool calls are output", () => {
    const state = newPreambleState();
    const pre = (data: unknown) => isPreambleEvent("openai_responses", ev(data), state);
    // a model that was given tools opens with one sentence about what it is going to do, then reasons for minutes
    expect(pre({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_c", role: "assistant", status: "in_progress", content: [], phase: "commentary" } })).toBe(true);
    expect(pre({ type: "response.content_part.added", item_id: "msg_c", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } })).toBe(true);
    expect(pre({ type: "response.output_text.delta", item_id: "msg_c", output_index: 0, content_index: 0, delta: "I'll match the reference proportions" })).toBe(true);
    expect(pre({ type: "response.output_text.done", item_id: "msg_c", output_index: 0, content_index: 0, text: "I'll match the reference proportions" })).toBe(true);
    expect(pre({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_c", status: "completed", phase: "commentary" } })).toBe(true);
    expect(pre({ type: "response.output_item.added", output_index: 1, item: { type: "reasoning", id: "rs_1" } })).toBe(true);
    // the answer itself (no phase, or final_answer) and a tool call still start the stream
    expect(pre({ type: "response.output_item.added", output_index: 2, item: { type: "message", id: "msg_a", phase: "final_answer" } })).toBe(true);
    expect(pre({ type: "response.output_text.delta", item_id: "msg_a", output_index: 2, delta: "<svg" })).toBe(false);
    expect(pre({ type: "response.output_text.delta", item_id: "msg_plain", output_index: 3, delta: "Hello" })).toBe(false);
    expect(pre({ type: "response.output_item.added", output_index: 4, item: { type: "function_call", id: "fc_1" } })).toBe(false);
    expect(pre({ type: "response.completed", response: { id: "r" } })).toBe(false);
    // a caller that keeps no state gets the stateless rule: any text delta is output
    expect(isPreambleEvent("openai_responses", ev({ type: "response.output_text.delta", item_id: "msg_c", delta: "I'll" }))).toBe(false);
    // another stream's state knows nothing about this one's items
    expect(isPreambleEvent("openai_responses", ev({ type: "response.output_text.delta", item_id: "msg_c", delta: "I'll" }), newPreambleState())).toBe(false);
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
    expect(err).toMatchObject({ ok: false, status: 503, message: "Service Unavailable" });
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

describe("holdCommitAfterMs", () => {
  it("counts the hold window from the request's arrival, never below one heartbeat", () => {
    expect(holdCommitAfterMs(15_000, 240, 1_000_000, 1_000_000)).toBe(240_000);
    // a retry 200 s in only gets what is left of the window
    expect(holdCommitAfterMs(15_000, 240, 1_000_000, 1_200_000)).toBe(40_000);
    expect(holdCommitAfterMs(15_000, 240, 1_000_000, 1_300_000)).toBe(15_000);
    expect(holdCommitAfterMs(15_000, 0, 1_000_000, 1_000_000)).toBe(15_000);
  });
});

describe("Responses: only content commits the stream", () => {
  const r = (o: Record<string, unknown>) => isPreambleEvent("openai_responses", ev(o));
  it("vendor events, blank deltas and lifecycle events hold", () => {
    expect(r({ type: "codex.rate_limits", rate_limits: {} })).toBe(true);
    expect(r({ type: "response.output_text.delta", delta: "" })).toBe(true);
    expect(r({ type: "response.output_text.delta", delta: " " })).toBe(true);
    expect(r({ type: "response.output_item.done", item: { type: "message" } })).toBe(true);
    expect(r({ type: "response.output_text.done", text: " " })).toBe(true);
    expect(r({ type: "response.content_part.done" })).toBe(true);
  });
  it("text, tool calls, images and the terminal events commit", () => {
    expect(r({ type: "response.output_text.delta", delta: "OK" })).toBe(false);
    expect(r({ type: "response.function_call_arguments.delta", delta: "{" })).toBe(false);
    expect(r({ type: "response.output_item.added", item: { type: "function_call" } })).toBe(false);
    expect(r({ type: "response.image_generation_call.partial_image", partial_image_b64: "x" })).toBe(false);
    expect(r({ type: "response.completed", response: {} })).toBe(false);
    expect(r({ type: "response.incomplete", response: {} })).toBe(false);
  });
});

describe("the start hold that applies to a request", () => {
  it("is the gateway setting unless the API key sets a shorter one; 0 on the key switches it off", () => {
    expect(streamHoldSecFor(240, null)).toBe(240);
    expect(streamHoldSecFor(240, undefined)).toBe(240);
    expect(streamHoldSecFor(240, 0)).toBe(0);
    expect(streamHoldSecFor(240, 30)).toBe(30);
    // a key never lengthens it: the setting is the operator's limit (clients give up on response headers after a while)
    expect(streamHoldSecFor(240, 600)).toBe(240);
    expect(streamHoldSecFor(0, 30)).toBe(0);
  });
});
