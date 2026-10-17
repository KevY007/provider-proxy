import { describe, expect, it } from "vitest";
import { SseParser, type SseEvent } from "@/gateway/sse";
import type { StreamProcessor } from "@/gateway/processor";
import {
  AnthropicToChatStream,
  ChatToAnthropicStream,
  chatRequestToMessages,
  chatResponseToMessages,
  messagesRequestToChat,
  messagesResponseToChat,
  planTranslation,
} from "@/gateway/translate";
import { GatewayError } from "@/gateway/errors";

/** Feed an SSE text through a processor; returns the parsed output events. */
function run(p: StreamProcessor, input: string): SseEvent[] {
  const parser = new SseParser();
  const out: string[] = [];
  for (const ev of parser.push(input)) out.push(...p.onEvent(ev));
  out.push(...p.onEnd());
  return new SseParser().push(out.join(""));
}

const sse = (events: Array<[string | null, object | string]>) =>
  events.map(([name, data]) => `${name ? `event: ${name}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`).join("");

describe("planTranslation", () => {
  it("prefers native, then chat<->messages translation, otherwise null", () => {
    expect(planTranslation("openai_chat", new Set(["openai_chat", "anthropic_messages"]))).toEqual({ mode: "native", upstream: "openai_chat" });
    expect(planTranslation("openai_chat", new Set(["anthropic_messages"]))).toEqual({ mode: "chat_to_messages", upstream: "anthropic_messages" });
    expect(planTranslation("anthropic_messages", new Set(["openai_chat"]))).toEqual({ mode: "messages_to_chat", upstream: "openai_chat" });
    expect(planTranslation("anthropic_messages", ["gemini", "openai_chat"])).toEqual({ mode: "messages_to_chat", upstream: "openai_chat" });
    expect(planTranslation("gemini", new Set(["openai_chat"]))).toBeNull();
    expect(planTranslation("openai_responses", new Set(["openai_chat", "anthropic_messages"]))).toBeNull();
  });
});

describe("OpenAI chat request -> Anthropic messages", () => {
  const base = { upstreamModel: "claude-up", defaultMaxTokens: 4096 };

  it("maps system, multi-turn, images, tools, tool results, stop, temperature and max_tokens", () => {
    const req = chatRequestToMessages(
      {
        model: "public",
        temperature: 1.7,
        top_p: 0.9,
        max_tokens: 200,
        stop: "END",
        user: "u-1",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "developer", content: "Use metric units." },
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
              { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
            ],
          },
          { role: "assistant", content: "Let me check.", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
          { role: "tool", tool_call_id: "call_1", content: "sunny, 21C" },
          { role: "user", content: "Thanks" },
        ],
        tools: [{ type: "function", function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
        tool_choice: "required",
      },
      base,
    );
    expect(req.model).toBe("claude-up");
    expect(req.system).toBe("Be brief.\n\nUse metric units.");
    expect(req.max_tokens).toBe(200);
    expect(req.temperature).toBe(1); // clamped to Anthropic's 0..1
    expect(req.top_p).toBe(0.9);
    expect(req.stop_sequences).toEqual(["END"]);
    expect(req.metadata).toEqual({ user_id: "u-1" });
    expect(req.tool_choice).toEqual({ type: "any" });
    expect(req.tools).toEqual([{ name: "get_weather", description: "Weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }]);

    expect(req.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
    const [u1, a1, u2] = req.messages;
    expect(u1.content[0]).toEqual({ type: "text", text: "What is this?" });
    expect(u1.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
    expect(u1.content[2]).toEqual({ type: "image", source: { type: "url", url: "https://example.com/cat.jpg" } });
    expect(a1.content).toEqual([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
    ]);
    // tool result and the follow-up user text share one user turn, tool_result first
    expect(u2.content).toEqual([
      { type: "tool_result", tool_use_id: "call_1", content: "sunny, 21C" },
      { type: "text", text: "Thanks" },
    ]);
  });

  it("defaults max_tokens (Anthropic requires it) and maps tool_choice variants", () => {
    const tools = [{ type: "function", function: { name: "f", parameters: { type: "object" } } }];
    const m = [{ role: "user", content: "hi" }];
    expect(chatRequestToMessages({ messages: m }, base).max_tokens).toBe(4096);
    expect(chatRequestToMessages({ messages: m, max_completion_tokens: 77 }, base).max_tokens).toBe(77);
    expect(chatRequestToMessages({ messages: m, tools, tool_choice: "auto" }, base).tool_choice).toEqual({ type: "auto" });
    expect(chatRequestToMessages({ messages: m, tools, tool_choice: "none" }, base).tool_choice).toEqual({ type: "none" });
    expect(chatRequestToMessages({ messages: m, tools, tool_choice: { type: "function", function: { name: "f" } } }, base).tool_choice).toEqual({ type: "tool", name: "f" });
    expect(chatRequestToMessages({ messages: m, tools, parallel_tool_calls: false }, base).tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("rejects n>1 and requests without messages", () => {
    expect(() => chatRequestToMessages({ messages: [{ role: "user", content: "x" }], n: 2 }, base)).toThrow(GatewayError);
    expect(() => chatRequestToMessages({}, base)).toThrow(GatewayError);
    expect(() => chatRequestToMessages({ messages: [{ role: "system", content: "only system" }] }, base)).toThrow(GatewayError);
  });
});

describe("Anthropic response -> OpenAI chat.completion", () => {
  it("converts text, tool_use, stop reason and usage (cache tokens folded into the prompt total)", () => {
    const { body, usage } = messagesResponseToChat(
      {
        id: "msg_01ABC",
        type: "message",
        role: "assistant",
        model: "claude-up",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 20 },
      },
      "public-model",
    );
    expect(body.model).toBe("public-model");
    expect(body.object).toBe("chat.completion");
    const choice = body.choices[0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.content).toBe("Checking.");
    expect(choice.message.tool_calls).toEqual([{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }]);
    expect(body.usage.prompt_tokens).toBe(150);
    expect(body.usage.completion_tokens).toBe(20);
    expect(body.usage.prompt_tokens_details.cached_tokens).toBe(40);
    expect(usage).toMatchObject({ inputTokens: 150, cachedTokens: 40, cacheWriteTokens: 10, outputTokens: 20 });
  });

  it.each([
    ["end_turn", "stop"],
    ["max_tokens", "length"],
    ["stop_sequence", "stop"],
    ["tool_use", "tool_calls"],
  ])("maps stop_reason %s -> finish_reason %s", (stop, finish) => {
    const { body } = messagesResponseToChat({ id: "msg_x", content: [{ type: "text", text: "a" }], stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } }, "m");
    expect(body.choices[0].finish_reason).toBe(finish);
  });
});

describe("Anthropic messages request -> OpenAI chat", () => {
  it("maps system blocks, images, tool_use/tool_result, stop sequences, tools and tool_choice", () => {
    const req = messagesRequestToChat(
      {
        model: "public",
        max_tokens: 300,
        temperature: 0.2,
        stop_sequences: ["STOP"],
        stream: true,
        system: [{ type: "text", text: "You are terse." }],
        metadata: { user_id: "abc" },
        messages: [
          { role: "user", content: [{ type: "text", text: "Weather?" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QQ==" } }] },
          { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "toolu_9", name: "get_weather", input: { city: "Rome" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: [{ type: "text", text: "rainy" }] }, { type: "text", text: "and tomorrow?" }] },
        ],
        tools: [{ name: "get_weather", description: "d", input_schema: { type: "object", properties: {} } }],
        tool_choice: { type: "tool", name: "get_weather", disable_parallel_tool_use: true },
      },
      { upstreamModel: "gpt-up" },
    );
    expect(req.model).toBe("gpt-up");
    expect(req.max_tokens).toBe(300);
    expect(req.stop).toEqual(["STOP"]);
    expect(req.user).toBe("abc");
    expect(req.stream).toBe(true);
    expect(req.stream_options).toEqual({ include_usage: true });
    expect(req.messages[0]).toEqual({ role: "system", content: "You are terse." });
    expect(req.messages[1].content).toEqual([
      { type: "text", text: "Weather?" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QQ==" } },
    ]);
    expect(req.messages[2]).toEqual({ role: "assistant", content: "Looking.", tool_calls: [{ id: "toolu_9", type: "function", function: { name: "get_weather", arguments: '{"city":"Rome"}' } }] });
    expect(req.messages[3]).toEqual({ role: "tool", tool_call_id: "toolu_9", content: "rainy" });
    expect(req.messages[4]).toEqual({ role: "user", content: "and tomorrow?" });
    expect(req.tools).toEqual([{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object", properties: {} } } }]);
    expect(req.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
    expect(req.parallel_tool_calls).toBe(false);
  });

  it("uses max_completion_tokens when asked and maps any/auto tool_choice", () => {
    const m = [{ role: "user", content: "x" }];
    const tools = [{ name: "f", input_schema: { type: "object" } }];
    expect(messagesRequestToChat({ messages: m, max_tokens: 5 }, { upstreamModel: "u", maxTokensParam: "max_completion_tokens" }).max_completion_tokens).toBe(5);
    expect(messagesRequestToChat({ messages: m, tools, tool_choice: { type: "any" } }, { upstreamModel: "u" }).tool_choice).toBe("required");
    expect(messagesRequestToChat({ messages: m, tools, tool_choice: { type: "auto" } }, { upstreamModel: "u" }).tool_choice).toBe("auto");
  });
});

describe("OpenAI response -> Anthropic message", () => {
  it("converts content, tool calls, finish reason and usage (cached tokens split out)", () => {
    const { body, usage } = chatResponseToMessages(
      {
        id: "chatcmpl-abc",
        choices: [
          {
            finish_reason: "tool_calls",
            message: { role: "assistant", content: "hm", tool_calls: [{ id: "call_5", type: "function", function: { name: "f", arguments: '{"a":1}' } }] },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } },
      },
      "public-model",
    );
    expect(body.type).toBe("message");
    expect(body.model).toBe("public-model");
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content).toEqual([
      { type: "text", text: "hm" },
      { type: "tool_use", id: "call_5", name: "f", input: { a: 1 } },
    ]);
    expect(body.usage).toMatchObject({ input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 });
    expect(usage.inputTokens).toBe(120);
  });
});

describe("stream: Anthropic events -> OpenAI chunks", () => {
  const textStream = sse([
    ["message_start", { type: "message_start", message: { id: "msg_1", role: "assistant", model: "claude-up", usage: { input_tokens: 25, cache_read_input_tokens: 5, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["ping", { type: "ping" }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }],
    ["message_stop", { type: "message_stop" }],
  ]);

  it("emits role, content deltas, finish chunk, optional usage chunk and [DONE]", () => {
    const p = new AnthropicToChatStream("public-model", true);
    const out = run(p, textStream);
    const data = out.map((e) => e.data);
    expect(data[data.length - 1]).toBe("[DONE]");
    const chunks = data.slice(0, -1).map((d) => JSON.parse(d));
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(chunks.every((c) => c.model === "public-model" && c.object === "chat.completion.chunk")).toBe(true);
    expect(chunks.filter((c) => c.choices[0]?.delta?.content).map((c) => c.choices[0].delta.content).join("")).toBe("Hello");
    const fin = chunks.find((c) => c.choices[0]?.finish_reason);
    expect(fin.choices[0].finish_reason).toBe("stop");
    const last = chunks[chunks.length - 1];
    expect(last.choices).toEqual([]);
    expect(last.usage).toMatchObject({ prompt_tokens: 30, completion_tokens: 7, total_tokens: 37, prompt_tokens_details: { cached_tokens: 5 } });
    expect(p.usage()).toMatchObject({ inputTokens: 30, cachedTokens: 5, outputTokens: 7 });
    expect(p.outputText()).toBe("Hello");
    expect(p.completed()).toBe(true);
  });

  it("omits the usage chunk when the client did not ask for it (usage still tracked)", () => {
    const p = new AnthropicToChatStream("m", false);
    const out = run(p, textStream);
    expect(out.some((e) => e.data !== "[DONE]" && JSON.parse(e.data).usage)).toBe(false);
    expect(p.usage()?.outputTokens).toBe(7);
  });

  it("streams tool_use blocks as tool_calls with argument deltas", () => {
    const p = new AnthropicToChatStream("m", false);
    const out = run(
      p,
      sse([
        ["message_start", { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 10, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_7", name: "get_weather", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } }],
        ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Paris"}' } }],
        ["content_block_stop", { type: "content_block_stop", index: 1 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } }],
        ["message_stop", { type: "message_stop" }],
      ]),
    );
    const chunks = out.filter((e) => e.data !== "[DONE]").map((e) => JSON.parse(e.data));
    const calls = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    expect(calls[0]).toEqual({ index: 0, id: "toolu_7", type: "function", function: { name: "get_weather", arguments: "" } });
    expect(calls.slice(1).map((c) => c.function.arguments).join("")).toBe('{"city":"Paris"}');
    expect(calls.slice(1).every((c) => c.index === 0)).toBe(true);
    expect(chunks.find((c) => c.choices[0]?.finish_reason).choices[0].finish_reason).toBe("tool_calls");
  });

  it("surfaces in-band error events", () => {
    const p = new AnthropicToChatStream("m", false);
    run(p, sse([["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]]));
    expect(p.error()).toMatchObject({ status: 529, type: "overloaded_error" });
  });
});

describe("stream: OpenAI chunks -> Anthropic events", () => {
  const chunk = (delta: object, finish: string | null = null, extra: object = {}) => ({
    id: "chatcmpl-9",
    object: "chat.completion.chunk",
    model: "gpt-up",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });

  it("builds the real Anthropic event sequence for text", () => {
    const p = new ChatToAnthropicStream("public-model");
    const out = run(
      p,
      sse([
        [null, chunk({ role: "assistant", content: "" })],
        [null, chunk({ content: "Hel" })],
        [null, chunk({ content: "lo" })],
        [null, chunk({}, "stop")],
        [null, { id: "chatcmpl-9", model: "gpt-up", choices: [], usage: { prompt_tokens: 40, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 10 } } }],
        [null, "[DONE]"],
      ]),
    );
    expect(out.map((e) => e.event)).toEqual(["message_start", "ping", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    const start = JSON.parse(out[0].data);
    expect(start.message.model).toBe("public-model");
    expect(start.message.role).toBe("assistant");
    const deltas = out.filter((e) => e.event === "content_block_delta").map((e) => JSON.parse(e.data).delta.text);
    expect(deltas.join("")).toBe("Hello");
    const md = JSON.parse(out.find((e) => e.event === "message_delta")!.data);
    expect(md.delta.stop_reason).toBe("end_turn");
    expect(md.usage).toMatchObject({ input_tokens: 30, cache_read_input_tokens: 10, output_tokens: 9 });
    expect(p.usage()).toMatchObject({ inputTokens: 40, cachedTokens: 10, outputTokens: 9 });
    expect(p.completed()).toBe(true);
  });

  it("converts streamed tool calls into tool_use blocks with input_json_delta", () => {
    const p = new ChatToAnthropicStream("m");
    const out = run(
      p,
      sse([
        [null, chunk({ role: "assistant", content: "Let me see." })],
        [null, chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] })],
        [null, chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] })],
        [null, chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] })],
        [null, chunk({}, "tool_calls")],
        [null, "[DONE]"],
      ]),
    );
    expect(out.map((e) => e.event)).toEqual([
      "message_start",
      "ping",
      "content_block_start", // text
      "content_block_delta",
      "content_block_stop",
      "content_block_start", // tool_use
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const toolStart = JSON.parse(out[5].data);
    expect(toolStart.index).toBe(1);
    expect(toolStart.content_block).toEqual({ type: "tool_use", id: "call_1", name: "get_weather", input: {} });
    const json = out
      .filter((e) => e.event === "content_block_delta")
      .map((e) => JSON.parse(e.data).delta)
      .filter((d) => d.type === "input_json_delta")
      .map((d) => d.partial_json)
      .join("");
    expect(json).toBe('{"city":"Paris"}');
    expect(JSON.parse(out[out.length - 2].data).delta.stop_reason).toBe("tool_use");
  });

  it("still terminates the stream cleanly when the upstream closes without [DONE]", () => {
    const p = new ChatToAnthropicStream("m");
    const out = run(p, sse([[null, chunk({ role: "assistant", content: "hi" })], [null, chunk({}, "stop")]]));
    expect(out[out.length - 1].event).toBe("message_stop");
  });
});
