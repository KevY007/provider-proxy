/**
 * Chat Completions -> Claude reasoning translation (live report bug 2).
 * Unit tests of the per-model rules (pure) + end-to-end through the gateway against the mock upstream, which validates
 * the `thinking` / `output_config` / sampling fields the way the real API does (a wrong shape for the model is a 400).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, dbOk, sseBlocks } from "./harness";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { AnthropicToChatStream, THINKING_BURN_NOTE, chatRequestToMessages, claudeProfile, messagesResponseToChat, planReasoning, readReasoningAsk } from "@/gateway/translate";
import { sseEvent, type SseEvent } from "@/gateway/sse";
import { db } from "@/lib/db";

const chat = (extra: Record<string, unknown> = {}) => ({ model: "m", messages: [{ role: "user", content: "hi" }], ...extra });
const to = (upstreamModel: string, body: Record<string, unknown>, maxTokens = 4096) => chatRequestToMessages(body, { upstreamModel, defaultMaxTokens: maxTokens });

describe("claudeProfile", () => {
  it("recognises the generations and how each one is configured", () => {
    expect(claudeProfile("claude-sonnet-5-5")).toMatchObject({ mode: "adaptive", defaultOn: true, off: "between_tools", sampling: false, forcedTool: false });
    expect(claudeProfile("claude-haiku-5-5")).toMatchObject({ mode: "adaptive", defaultOn: true, off: "disabled", sampling: false });
    expect(claudeProfile("claude-opus-5-5")).toMatchObject({ mode: "adaptive", defaultOn: true, off: "never", forcedTool: false });
    expect(claudeProfile("claude-fable-5-1")).toMatchObject({ mode: "adaptive", off: "never", forcedTool: false });
    expect(claudeProfile("claude-opus-4-8")).toMatchObject({ mode: "adaptive", defaultOn: false, off: "omit" });
    expect(claudeProfile("claude-sonnet-4-6")).toMatchObject({ mode: "adaptive", defaultOn: false, sampling: true });
    expect(claudeProfile("claude-haiku-4-5-20251001")).toMatchObject({ mode: "budget", efforts: [] });
    expect(claudeProfile("claude-opus-4-5")).toMatchObject({ mode: "budget", efforts: ["low", "medium", "high"] });
    expect(claudeProfile("claude-3-7-sonnet-20250219")).toMatchObject({ mode: "budget" });
    expect(claudeProfile("claude-3-5-haiku-latest")).toMatchObject({ mode: "none" });
    expect(claudeProfile("anthropic.claude-sonnet-5-5").mode).toBe("adaptive");
    expect(claudeProfile("some-relay-model")).toMatchObject({ known: false, mode: "budget" });
  });

  it("reads the client's ask: reasoning_effort, reasoning.effort, Claude-style thinking", () => {
    expect(readReasoningAsk(chat())).toEqual({ kind: "unspecified" });
    expect(readReasoningAsk(chat({ reasoning_effort: "none" }))).toEqual({ kind: "off" });
    expect(readReasoningAsk(chat({ reasoning_effort: "high" }))).toMatchObject({ kind: "on", effort: "high" });
    expect(readReasoningAsk(chat({ reasoning: { effort: "low" } }))).toMatchObject({ kind: "on", effort: "low" });
    expect(readReasoningAsk(chat({ thinking: { type: "enabled", budget_tokens: 1500 } }))).toMatchObject({ kind: "on", effort: "low", budget: 1500 });
    expect(readReasoningAsk(chat({ thinking: { type: "disabled" } }))).toEqual({ kind: "off" });
  });
});

describe("chat request -> Messages request: thinking per model", () => {
  const MODELS = ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-opus-4-8", "claude-sonnet-5"];

  it("reasoning_effort on the 5.x models -> adaptive thinking + output_config.effort, never budget_tokens (the 400 of the report)", () => {
    for (const model of MODELS) {
      for (const [eff, want] of [["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"]] as const) {
        const r = to(model, chat({ reasoning_effort: eff, max_tokens: 20_000 }));
        expect(r.thinking, `${model} ${eff}`).toEqual({ type: "adaptive", display: "summarized" });
        expect(r.output_config, `${model} ${eff}`).toEqual({ effort: want });
        expect(JSON.stringify(r)).not.toContain("budget_tokens");
      }
    }
  });

  it("no reasoning_effort -> thinking is NOT enabled, the way each model switches it off", () => {
    expect(to("claude-sonnet-5-5", chat()).thinking).toEqual({ type: "between_tools" });
    expect(to("claude-haiku-5-5", chat()).thinking).toEqual({ type: "disabled" });
    expect(to("claude-opus-5", chat()).thinking).toEqual({ type: "disabled" });
    expect(to("claude-sonnet-5", chat()).thinking).toEqual({ type: "disabled" });
    // models that cannot switch it off: lowest effort
    const o55 = to("claude-opus-5-5", chat());
    expect(o55.thinking).toBeUndefined();
    expect(o55.output_config).toEqual({ effort: "low" });
    expect(to("claude-fable-5-1", chat()).output_config).toEqual({ effort: "low" });
    // models that do not think unless asked: nothing is sent
    for (const m of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-sonnet-4-5"]) {
      const r = to(m, chat());
      expect(r.thinking, m).toBeUndefined();
      expect(r.output_config, m).toBeUndefined();
    }
    // 'none' is the same as not asking
    expect(to("claude-sonnet-5-5", chat({ reasoning_effort: "none" })).thinking).toEqual({ type: "between_tools" });
  });

  it("older models keep a token budget: below max_tokens, with headroom for the visible answer; effort only where it exists", () => {
    const r = to("claude-haiku-4-5-20251001", chat({ reasoning_effort: "high", max_tokens: 20_000 }));
    expect(r.thinking).toEqual({ type: "enabled", budget_tokens: 15_000 }); // 16384 wanted, max_tokens - 25% kept for the answer
    expect(r.output_config).toBeUndefined();
    const low = to("claude-sonnet-4-5", chat({ reasoning_effort: "low", max_completion_tokens: 8000 }));
    expect(low.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(low.max_tokens).toBe(8000);
    const o45 = to("claude-opus-4-5", chat({ reasoning_effort: "medium", max_tokens: 30_000 }));
    expect(o45.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(o45.output_config).toEqual({ effort: "medium" });
    const notes = { notes: [] as string[] };
    const tiny = chatRequestToMessages(chat({ reasoning_effort: "high", max_tokens: 1500 }), { upstreamModel: "claude-haiku-4-5", defaultMaxTokens: 4096, notes });
    expect(tiny.thinking).toBeUndefined(); // no room for a 1024 budget + answer: thinking stays off instead of a 400
    expect(notes.notes[0]).toMatch(/leaves no room/);
  });

  it("4.6 maps xhigh to its top level; 4.x models without effort ignore it", () => {
    expect(to("claude-opus-4-6", chat({ reasoning_effort: "xhigh" })).output_config).toEqual({ effort: "max" });
    expect(to("claude-sonnet-4-6", chat({ reasoning_effort: "medium" })).thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(to("claude-3-5-haiku-latest", chat({ reasoning_effort: "high" })).thinking).toBeUndefined();
  });

  it("max_completion_tokens is honoured (and wins over max_tokens); the default applies when neither is sent", () => {
    expect(to("claude-sonnet-5-5", chat({ max_completion_tokens: 777, max_tokens: 999 })).max_tokens).toBe(777);
    expect(to("claude-sonnet-5-5", chat({ max_tokens: 999 })).max_tokens).toBe(999);
    expect(to("claude-sonnet-5-5", chat(), 12_345).max_tokens).toBe(12_345);
  });

  it("sampling: dropped where the model rejects it, kept elsewhere; dropped whenever thinking is on", () => {
    expect(to("claude-sonnet-5-5", chat({ temperature: 0.2, top_p: 0.9 })).temperature).toBeUndefined();
    expect(to("claude-haiku-5-5", chat({ temperature: 0.2 })).temperature).toBeUndefined();
    const k = to("claude-haiku-4-5", chat({ temperature: 0.2, top_p: 0.9 }));
    expect(k).toMatchObject({ temperature: 0.2, top_p: 0.9 });
    expect(to("claude-sonnet-4-6", chat({ temperature: 0.2, reasoning_effort: "low" })).temperature).toBeUndefined();
  });

  it("forced tool_choice becomes auto + an instruction on models that reject it (any / tool = 400 there)", () => {
    const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }];
    const r = to("claude-sonnet-5-5", chat({ tools, tool_choice: "required" }));
    expect(r.tool_choice).toEqual({ type: "auto" });
    expect(r.system).toContain("calling one of the provided tools");
    const named = to("claude-opus-5-5", chat({ tools, tool_choice: { type: "function", function: { name: "get_weather" } } }));
    expect(named.tool_choice).toEqual({ type: "auto" });
    expect(named.system).toContain('"get_weather"');
    expect(to("claude-haiku-4-5", chat({ tools, tool_choice: "required" })).tool_choice).toEqual({ type: "any" });
    expect(to("claude-haiku-4-5", chat({ tools, tool_choice: { type: "function", function: { name: "get_weather" } } })).tool_choice).toEqual({ type: "tool", name: "get_weather" });
  });

  it("thinking_blocks of an earlier response are passed back first in the assistant turn", () => {
    const body = chat({
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          thinking_blocks: [{ type: "thinking", thinking: "hmm", signature: "sig1" }, { type: "redacted_thinking", data: "xyz" }, { type: "thinking", thinking: "no signature" }],
          tool_calls: [{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
        },
        { role: "tool", tool_call_id: "toolu_1", content: "sunny" },
      ],
    });
    const r = to("claude-haiku-4-5", body) as { messages: Array<{ role: string; content: Array<{ type: string }> }> };
    expect(r.messages[1].content.map((b) => b.type)).toEqual(["thinking", "redacted_thinking", "tool_use"]);
    expect(r.messages[1].content[0]).toMatchObject({ thinking: "hmm", signature: "sig1" });
  });

  it("budget-style thinking is not enabled when the history has an assistant tool call that cannot be replayed with its thinking block", () => {
    const body = chat({
      reasoning_effort: "medium",
      max_tokens: 20_000,
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: "sunny" },
      ],
    });
    const notes = { notes: [] as string[] };
    const r = chatRequestToMessages(body, { upstreamModel: "claude-haiku-4-5", defaultMaxTokens: 4096, notes });
    expect(r.thinking).toBeUndefined();
    expect(notes.notes[0]).toMatch(/thinking block/);
    // adaptive models do not need the replay
    expect(to("claude-sonnet-5-5", body).thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("planReasoning is deterministic and pure", () => {
    const p = claudeProfile("claude-sonnet-5-5");
    expect(planReasoning(p, { kind: "unspecified" }, 4000)).toEqual(planReasoning(p, { kind: "off" }, 4000));
  });
});

describe("Claude response -> chat response", () => {
  const msg = (content: unknown[], extra: Record<string, unknown> = {}) => ({ id: "msg_1", type: "message", role: "assistant", model: "up", content, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 300, output_tokens_details: { thinking_tokens: 250 } }, ...extra });

  it("thinking -> reasoning_content + thinking_blocks; reasoning tokens in the usage", () => {
    const { body, burned } = messagesResponseToChat(msg([{ type: "thinking", thinking: "let me think", signature: "sigA" }, { type: "text", text: "answer" }]) as never, "public");
    const m = (body.choices as Array<{ message: Record<string, unknown>; finish_reason: string }>)[0];
    expect(m.message.content).toBe("answer");
    expect(m.message.reasoning_content).toBe("let me think");
    expect(m.message.thinking_blocks).toEqual([{ type: "thinking", thinking: "let me think", signature: "sigA" }]);
    expect(body.usage).toMatchObject({ completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 250 } });
    expect(burned).toBe(false);
  });

  it("a response whose thinking used the whole budget is flagged (finish_reason length, empty content)", () => {
    const { body, burned } = messagesResponseToChat(msg([{ type: "thinking", thinking: "", signature: "s" }], { stop_reason: "max_tokens" }) as never, "public");
    const c = (body.choices as Array<{ message: { content: string }; finish_reason: string }>)[0];
    expect(c.finish_reason).toBe("length");
    expect(c.message.content).toBe("");
    expect(burned).toBe(true);
  });
});

describe("Claude stream -> chat stream", () => {
  const ev = (type: string, o: object): SseEvent => ({ event: type, data: JSON.stringify({ type, ...o }), raw: "" }) as SseEvent;
  it("thinking deltas surface as reasoning_content + thinking_blocks; a burned budget is noted", () => {
    const s = new AnthropicToChatStream("public", true);
    const out: string[] = [];
    for (const e of [
      ev("message_start", { message: { id: "msg_1", usage: { input_tokens: 5, output_tokens: 1 } } }),
      ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "pondering" } }),
      ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sigZ" } }),
      ev("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 400, output_tokens_details: { thinking_tokens: 400 } } }),
      ev("message_stop", {}),
    ]) out.push(...s.onEvent(e));
    const text = out.join("");
    expect(text).toContain('"reasoning_content":"pondering"');
    expect(text).toContain('"thinking_blocks":[{"type":"thinking","thinking":"pondering"}]');
    expect(text).toContain('"signature":"sigZ"');
    expect(text).toContain('"finish_reason":"length"');
    expect(text).toContain('"reasoning_tokens":400');
    expect(s.reasoningText()).toBe("pondering");
    expect(s.note()).toBe(THINKING_BURN_NOTE);
    void sseEvent;
  });
});

// ======================================================================================================================
// end to end: OpenAI SDK style requests through the gateway into the (API-faithful) mock
// ======================================================================================================================
const h = createHarness("rsn");
const slug: Record<string, string> = {};
let user = { userId: "", key: "" };
const UPSTREAMS = ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];

async function lastMessagesBody(): Promise<Record<string, unknown>> {
  const r = await fetch(`${h.base}/__mock/last?path=/v1/messages`);
  return ((await r.json()) as { body: Record<string, unknown> }).body;
}

describe.skipIf(!dbOk)("through the gateway", () => {
  beforeAll(async () => {
    await h.start();
    const u = await h.makeUser("u", { balance: "100" });
    user = { userId: u.id, key: (await h.makeKey("u", u.id)).key };
    const an = await h.makeProvider("an", { formats: ["anthropic_messages"], authStyle: "X_API_KEY", baseUrl: h.base, keys: [{ s: "an1" }] });
    for (const up of UPSTREAMS) slug[up] = (await h.makeModel(up.replace(/[^a-z0-9]/g, ""), { caps: ["chat"], providerId: an.id, upstream: up, maxOutput: 64_000 })).slug;
    await invalidateGatewayConfig("all");
  }, 60_000);

  afterAll(async () => {
    await h.cleanup();
  }, 60_000);

  const post = (model: string, extra: Record<string, unknown>) => h.call("/v1/chat/completions", user.key, { model: slug[model], messages: [{ role: "user", content: "Reply with one word: ok" }], ...extra });

  it("the matrix of the report: every model x every reasoning_effort x small/large max_tokens is accepted by the (strict) upstream", async () => {
    const failures: string[] = [];
    for (const model of UPSTREAMS) {
      for (const effort of [undefined, "none", "minimal", "low", "medium", "high", "xhigh"]) {
        for (const max of [4000, 48_000]) {
          const res = await post(model, { ...(effort ? { reasoning_effort: effort } : {}), max_tokens: max, temperature: 0.3 });
          if (res.status !== 200) failures.push(`${model} effort=${effort ?? "-"} max=${max}: ${res.status} ${await res.text()}`);
          else await res.text();
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it("sanity: the mock rejects the shapes the old translator sent (so the matrix above really proves something)", async () => {
    const direct = (body: Record<string, unknown>) =>
      fetch(`${h.base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "direct-key", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ messages: [{ role: "user", content: "x" }], max_tokens: 4000, ...body }) });
    const old = await direct({ model: "claude-sonnet-5-5", thinking: { type: "enabled", budget_tokens: 2048 } });
    expect(old.status).toBe(400);
    expect(JSON.stringify(await old.json())).toContain("thinking.type.adaptive");
    expect((await direct({ model: "claude-haiku-5-5", temperature: 0.3 })).status).toBe(400);
    expect((await direct({ model: "claude-sonnet-5-5", thinking: { type: "disabled" } })).status).toBe(400);
    expect((await direct({ model: "claude-haiku-4-5", thinking: { type: "adaptive" } })).status).toBe(400);
    expect((await direct({ model: "claude-sonnet-5-5", thinking: { type: "adaptive" }, output_config: { effort: "high" } })).status).toBe(200);
  });

  it("without reasoning_effort the upstream request carries no thinking (switched off per model)", async () => {
    for (const [model, want] of [["claude-sonnet-5-5", { type: "between_tools" }], ["claude-haiku-5-5", { type: "disabled" }], ["claude-sonnet-4-6", undefined], ["claude-haiku-4-5-20251001", undefined]] as const) {
      const res = await post(model, { max_tokens: 48_000 });
      expect(res.status).toBe(200);
      await res.text();
      expect((await lastMessagesBody()).thinking, model).toEqual(want);
    }
    // ... so a model that would think by default produces no thinking block (and no burned budget)
    const res = await post("claude-sonnet-5-5", { max_tokens: 48_000, messages: [{ role: "user", content: "write a lot [[think:40000]] [[usage:in=10,out=100]]" }] });
    const body = (await res.json()) as { choices: Array<{ message: Record<string, unknown>; finish_reason: string }> };
    expect(body.choices[0].message.reasoning_content).toBeUndefined();
    expect(body.choices[0].finish_reason).toBe("stop");
    const log = await h.logOf(res);
    expect(log.reasoningTokens).toBe(0);
  });

  it("with reasoning_effort the thinking is surfaced (reasoning_content, thinking_blocks) and the reasoning tokens are recorded", async () => {
    const res = await post("claude-sonnet-5-5", { reasoning_effort: "high", max_tokens: 20_000, messages: [{ role: "user", content: "think hard [[think:300]] [[usage:in=50,out=40]]" }] });
    expect(res.status).toBe(200);
    expect((await lastMessagesBody()).thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect((await lastMessagesBody()).output_config).toEqual({ effort: "high" });
    const body = (await res.json()) as { choices: Array<{ message: Record<string, unknown> }>; usage: { completion_tokens: number; completion_tokens_details: { reasoning_tokens: number } } };
    expect(body.choices[0].message.reasoning_content).toContain("simplest approach");
    expect(body.choices[0].message.thinking_blocks).toEqual([{ type: "thinking", thinking: expect.stringContaining("simplest"), signature: expect.stringMatching(/^sig_mock_/) }]);
    expect(body.usage.completion_tokens_details.reasoning_tokens).toBe(300);
    const log = await h.logOf(res);
    expect(log.reasoningTokens).toBe(300);
    expect(log.outputTokens).toBe(340);
    expect(log.usageEstimated).toBe(false);
  });

  it("reasoning tokens the upstream does not itemize are estimated from the thinking text and the log says so", async () => {
    const res = await post("claude-sonnet-5-5", { reasoning_effort: "low", max_tokens: 20_000, messages: [{ role: "user", content: "think [[think:300]] [[nothinkdetails]] [[usage:in=50,out=40]]" }] });
    await res.text();
    const log = await h.logOf(res);
    expect(log.reasoningTokens).toBeGreaterThan(0);
    expect(log.reasoningTokens).toBeLessThanOrEqual(log.outputTokens);
    expect(log.internalError ?? "").toContain("reasoning tokens estimated");
    expect(log.usageEstimated).toBe(false); // billing came from the upstream's output_tokens
  });

  it("streamed: reasoning_content deltas, the signed block, usage with reasoning tokens - and a clean SUCCESS", async () => {
    const res = await post("claude-haiku-5-5", { reasoning_effort: "medium", max_tokens: 20_000, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "think [[think:120]] [[usage:in=50,out=40]]" }] });
    expect(res.status).toBe(200);
    const chunks = sseBlocks(await res.text())
      .map((b) => b.data)
      .filter((d) => d && d !== "[DONE]")
      .map((d) => JSON.parse(d) as { choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>; usage?: { completion_tokens_details?: { reasoning_tokens: number } } });
    const deltas = chunks.flatMap((c) => c.choices.map((x) => x.delta));
    expect(deltas.some((d) => typeof d.reasoning_content === "string" && d.reasoning_content.length > 0)).toBe(true);
    expect(deltas.some((d) => JSON.stringify(d.thinking_blocks ?? []).includes("sig_mock_"))).toBe(true);
    expect(chunks.at(-1)?.usage?.completion_tokens_details?.reasoning_tokens).toBe(120);
    const log = await h.logOf(res);
    expect(log.status).toBe("SUCCESS");
    expect(log.reasoningTokens).toBe(120);
  });

  it("a thinking budget that is used up completely is not silent: finish_reason length, a header, reasoning tokens, a log note", async () => {
    const res = await post("claude-sonnet-5-5", { reasoning_effort: "high", max_tokens: 3000, messages: [{ role: "user", content: "write a long svg [[thinkburn]] [[usage:in=50,out=40]]" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-reasoning-budget-exhausted")).toBe("true");
    const body = (await res.json()) as { choices: Array<{ message: { content: string }; finish_reason: string }>; usage: { completion_tokens: number; completion_tokens_details: { reasoning_tokens: number } } };
    expect(body.choices[0].finish_reason).toBe("length");
    expect(body.choices[0].message.content).toBe("");
    expect(body.usage.completion_tokens_details.reasoning_tokens).toBe(body.usage.completion_tokens);
    const log = await h.logOf(res);
    expect(log.internalError ?? "").toContain("thinking used the whole output budget");

    // streamed
    const st = await post("claude-sonnet-5-5", { reasoning_effort: "high", max_tokens: 3000, stream: true, messages: [{ role: "user", content: "write a long svg [[thinkburn]]" }] });
    const text = await st.text();
    expect(text).toContain('"finish_reason":"length"');
    expect((await h.logOf(st)).internalError ?? "").toContain("thinking used the whole output budget");
  });

  it("a tool loop with reasoning: the signed thinking block of round 1 is passed back in round 2", async () => {
    const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
    const r1 = await post("claude-haiku-4-5-20251001", { reasoning_effort: "medium", max_tokens: 20_000, tools, messages: [{ role: "user", content: "weather in Paris? [[think:200]]" }] });
    // (haiku 4.5 thinks only when asked, with a budget: the mock produces a thinking block for `enabled`)
    const b1 = (await r1.json()) as { choices: Array<{ message: Record<string, unknown>; finish_reason: string }> };
    const m1 = b1.choices[0].message as { tool_calls: Array<{ id: string }>; thinking_blocks?: unknown[] };
    expect(b1.choices[0].finish_reason).toBe("tool_calls");
    expect(m1.thinking_blocks?.length).toBeGreaterThan(0);
    const r2 = await post("claude-haiku-4-5-20251001", {
      reasoning_effort: "medium",
      max_tokens: 20_000,
      tools,
      messages: [{ role: "user", content: "weather in Paris? [[think:200]]" }, b1.choices[0].message, { role: "tool", tool_call_id: m1.tool_calls[0].id, content: "sunny" }],
    });
    expect(r2.status, await r2.clone().text()).toBe(200);
    const sent = (await lastMessagesBody()) as { thinking: unknown; messages: Array<{ role: string; content: Array<{ type: string }> }> };
    expect(sent.thinking).toMatchObject({ type: "enabled" });
    expect(sent.messages[1].content[0].type).toBe("thinking");
    await db.requestLog.count();
  });
});
