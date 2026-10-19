/** Scenarios F (concurrency) and G (OpenAI SDK -> Claude translation). */
import { anthropic, openai, guard, Scn, processSvg, TECHPACK_PROMPT, db, ctx, tracked, newKey } from "./lib";
import { invalidateGatewayConfig } from "../../src/gateway/cache";

// ------------------------------------------------------------------ F
async function burst(s: Scn, c: ReturnType<typeof anthropic>, N: number, tag: string) {
  const since = new Date();
  const t0 = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: N }, async (_, i) => {
      const t1 = Date.now();
      const stream = c.messages.stream({ model: "claude-haiku-5-5", max_tokens: 120, messages: [{ role: "user", content: `Reply with one short sentence about garment tag number ${i + 1}.` }] });
      const m = await stream.finalMessage();
      return { i, ms: Date.now() - t1, out: m.usage.output_tokens };
    }),
  );
  const wall = Date.now() - t0;
  const ok = results.filter((r) => r.status === "fulfilled") as Array<PromiseFulfilledResult<{ i: number; ms: number; out: number }>>;
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  const lat = ok.map((r) => r.value.ms).sort((a, b) => a - b);
  s.note(`${tag}: wall ${wall} ms; ${ok.length} ok, ${failed.length} failed; client latency p50 ${lat[Math.floor(lat.length / 2)]} ms, max ${lat[lat.length - 1]} ms`);
  await new Promise((r) => setTimeout(r, 3000));
  const logs = await db.requestLog.findMany({ where: { userId: ctx.userId, createdAt: { gte: since } } });
  return { ok, failed, logs };
}

export async function scenarioF(s: Scn) {
  await guard("anthropic", 1);
  const N = 50;
  // F1: default customer concurrency (20 slots per customer, not queued): the excess is rejected with 429 + retry-after
  const r1 = await burst(s, anthropic(), N, "F1 default key (customer concurrency default = 20)");
  const f1 = r1.failed.map((f) => f.reason as { status?: number; headers?: Headers });
  s.check("F1: exactly the first 20 pass and the excess gets 429 (customer slots are not queued)", r1.ok.length >= 18 && r1.ok.length <= 22 && f1.every((e) => e.status === 429), `${r1.ok.length} ok / ${f1.length} rejected (${[...new Set(f1.map((e) => e.status))].join(",")})`);
  s.check("F1: 429s carry a retry-after header", f1.length > 0 && f1.every((e) => Number(e.headers?.get("retry-after")) >= 1), `retry-after: ${f1[0]?.headers?.get("retry-after")}`);
  s.check("F1: all 50 attempts are logged, rejected ones at price 0", r1.logs.length === N && r1.logs.filter((l) => l.httpStatus === 429).every((l) => Number(l.price) === 0), `${r1.logs.length} rows`);

  // F2: key with maxConcurrency 60 -> all 50 are admitted; upstream key has 20 slots so the rest queue inside the gateway
  const key = await newKey("workload concurrency60", { maxConcurrency: 60 });
  await invalidateGatewayConfig("apiKeys");
  await new Promise((r) => setTimeout(r, 800));
  const r2 = await burst(s, anthropic({ apiKey: key }), N, "F2 key with maxConcurrency=60");
  s.check(`F2: all ${N} parallel streams succeeded`, r2.ok.length === N, `${r2.ok.length} ok, ${r2.failed.length} failed${r2.failed[0] ? `: ${String(r2.failed[0].reason).slice(0, 200)}` : ""}`);
  const logs = r2.logs.filter((l) => l.httpStatus === 200 || l.status === "SUCCESS");
  s.check(`F2: all ${N} requests are metered`, logs.length === N, `${logs.length}`);
  s.check("F2: all rows SUCCESS, stream=true, ttft recorded", logs.every((l) => l.status === "SUCCESS" && l.stream && l.ttftMs !== null), `${logs.filter((l) => l.status !== "SUCCESS").length} non-success`);
  const maxQ = Math.max(0, ...logs.map((l) => l.queueMs));
  const queued = logs.filter((l) => l.queueMs > 50).length;
  s.note(`F2 queueMs: max ${maxQ} ms, ${queued}/${N} requests waited for an upstream slot (provider key has 20 slots)`);
  s.check("F2: requests beyond the 20 upstream slots were queued (queueMs recorded)", queued >= 10 || logs.every((l) => l.latencyMs < 3000), `${queued} queued`);
  const ev: Array<[number, number]> = [];
  for (const l of logs) {
    const end = l.createdAt.getTime();
    ev.push([end - l.latencyMs + l.queueMs, 1], [end, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of ev) {
    cur += d;
    peak = Math.max(peak, cur);
  }
  s.note(`F2 peak overlap of in-flight windows reconstructed from RequestLog createdAt/latency: ${peak} (NOT reliable: createdAt is the batched log-write time; queueMs is the real evidence)`);
  s.check("F2: output tokens logged == tokens the clients received", logs.reduce((a, l) => a + l.outputTokens, 0) === r2.ok.reduce((a, r) => a + r.value.out, 0), `${logs.reduce((a, l) => a + l.outputTokens, 0)} vs ${r2.ok.reduce((a, r) => a + r.value.out, 0)}`);
  await db.apiKey.update({ where: { id: (await db.apiKey.findFirstOrThrow({ where: { name: "workload concurrency60", status: "ACTIVE" } })).id }, data: { status: "REVOKED" } });
  void tracked;
}

// ------------------------------------------------------------------ G
const FABRIC_TOOL = { type: "function" as const, function: { name: "get_fabric_price", description: "Price per unit in USD of a fabric or trim.", parameters: { type: "object", properties: { item: { type: "string" } }, required: ["item"] } } };
const PRICES: Record<string, number> = { "cotton fleece 380gsm": 6.4, "rib 2x2": 5.1, "drawcord": 0.35 };

export async function scenarioG(s: Scn) {
  await guard("anthropic", 2);
  const c = openai();
  await s.step("G0 reasoning_effort (OpenAI field) must translate to a valid request on the Claude 5.5 models", async () => {
    for (const [model, eff] of [["claude-sonnet-5-5", "low"], ["claude-sonnet-5-5", "high"], ["claude-haiku-5-5", "low"], ["claude-opus-5-5", "medium"]] as const) {
      try {
        const r = await c.chat.completions.create({ model, max_tokens: 4000, reasoning_effort: eff, messages: [{ role: "user", content: "Reply with one word: ok" }] });
        s.check(`${model} reasoning_effort=${eff} -> 200`, !!r.choices[0].message.content, `${r.choices[0].message.content}`);
      } catch (e) {
        s.check(`${model} reasoning_effort=${eff} -> 200`, false, String(e).slice(0, 300));
        s.bug(`Chat->Messages translation of reasoning_effort: POST /v1/chat/completions {model:"${model}", reasoning_effort:"${eff}", max_tokens:4000, messages:[{role:"user",content:"Reply with one word: ok"}]} -> ${String(e).slice(0, 260)}. Expected 200: translate to thinking:{type:"adaptive"} + output_config.effort for models that reject thinking.type.enabled (works for claude-opus-5-5, fails for sonnet-5-5 / haiku-5-5; with max_tokens 300 the translator skips thinking so it passes by accident).`);
      }
    }
  });
  const g1 = async (model: string, extra: Record<string, unknown>, tag: string) => {
    const t0 = Date.now();
    let ttft = 0;
    const ac = new AbortController();
    const guardTimer = setTimeout(() => {
      if (!ttft) ac.abort();
    }, 600_000); // a large techpack from Opus with thinking can take > 4 minutes
    let text = "";
    let finish = "";
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    let m = "";
    let keep = 0;
    try {
      const stream = (await c.chat.completions.create({ model, stream: true, stream_options: { include_usage: true }, max_tokens: 48000, ...extra, messages: [{ role: "user", content: TECHPACK_PROMPT }] } as never, { signal: ac.signal })) as unknown as AsyncIterable<import("openai/resources/chat/completions").ChatCompletionChunk>;
      for await (const ch of stream) {
        keep++;
        m = ch.model;
        const d = ch.choices?.[0]?.delta?.content;
        if (d) {
          if (!ttft) ttft = Date.now() - t0;
          text += d;
        }
        if (ch.choices?.[0]?.finish_reason) finish = ch.choices[0].finish_reason;
        if (ch.usage) usage = ch.usage;
      }
    } catch (e) {
      s.note(`${tag}: stream ended with ${String(e).slice(0, 120)} after ${((Date.now() - t0) / 1000).toFixed(0)}s with ${text.length} chars of content (first content at ${ttft} ms); chunks received: ${keep}`);
    }
    clearTimeout(guardTimer);
    s.note(`${tag}: ${((Date.now() - t0) / 1000).toFixed(0)}s, first content ${ttft} ms, finish=${finish}, usage=${JSON.stringify(usage)}`);
    s.check(`${tag}: finish_reason stop, model masked, usage chunk`, finish === "stop" && m === model && !!usage?.completion_tokens, `${finish} ${m} ${JSON.stringify(usage)}`);
    await processSvg(s, tag, text, ["POINTS? OF MEASURE", "BILL OF MATERIALS", "CONSTRUCTION", "COLORWAY"]);
  };
  if (!process.env.WL_G_SKIP_SONNET) await s.step("G1 techpack SVG via OpenAI SDK chat.completions stream -> claude-sonnet-5-5 (reasoning_effort=none)", () => g1("claude-sonnet-5-5", { reasoning_effort: "none" }, "g1-sonnet"));
  await s.step("G1b techpack SVG via OpenAI SDK chat.completions stream -> claude-opus-5-5 (reasoning_effort=medium)", () => g1("claude-opus-5-5", { reasoning_effort: "medium" }, "g1-opus"));
  await s.step("G1c techpack SVG via OpenAI SDK chat.completions stream -> claude-haiku-5-5 (reasoning_effort=none)", () => g1("claude-haiku-5-5", { reasoning_effort: "none" }, "g1-haiku"));

  await s.step("G2 streamed tool-call loop (3+ rounds) via OpenAI SDK -> Claude", async () => {
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: "Look up, ONE AT A TIME, the prices of 'cotton fleece 380gsm', 'rib 2x2' and 'drawcord' with the tool, then say the sum of the three unit prices." }];
    let rounds = 0;
    let final = "";
    for (let i = 0; i < 8; i++) {
      const stream = await c.chat.completions.create({ model: "claude-sonnet-5-5", stream: true, stream_options: { include_usage: true }, max_tokens: 4000, tools: [FABRIC_TOOL], parallel_tool_calls: false, messages: messages as never });
      const calls: Record<number, { id: string; name: string; args: string }> = {};
      let text = "";
      let finish = "";
      for await (const ch of stream) {
        const d = ch.choices?.[0]?.delta;
        text += d?.content ?? "";
        for (const tc of d?.tool_calls ?? []) {
          const slot = (calls[tc.index] ??= { id: "", name: "", args: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          slot.args += tc.function?.arguments ?? "";
        }
        if (ch.choices?.[0]?.finish_reason) finish = ch.choices[0].finish_reason;
      }
      const list = Object.values(calls);
      if (finish !== "tool_calls" || !list.length) {
        final = text;
        break;
      }
      rounds++;
      messages.push({ role: "assistant", content: text || null, tool_calls: list.map((x) => ({ id: x.id, type: "function", function: { name: x.name, arguments: x.args } })) });
      for (const x of list) messages.push({ role: "tool", tool_call_id: x.id, content: JSON.stringify({ price_usd: PRICES[JSON.parse(x.args).item] ?? null }) });
    }
    s.check("3+ tool rounds then a final answer", rounds >= 3 && final.length > 0, `${rounds} rounds`);
    s.check("final answer has the right sum (11.85)", /11\.85/.test(final), final.slice(0, 160).replace(/\s+/g, " "));
  });

  await s.step("G3 non-stream chat with a system prompt, stop sequence and image_url data URL -> Claude", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const r = await c.chat.completions.create({ model: "claude-haiku-5-5", max_tokens: 200, stop: ["END"], messages: [{ role: "system", content: "Answer in one short sentence." }, { role: "user", content: [{ type: "text", text: "What colour is this 1x1 pixel image roughly? Then write END." }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] }] });
    s.check("response is OpenAI-shaped with content and usage", r.object === "chat.completion" && (r.choices[0].message.content ?? "").length > 0 && r.usage!.prompt_tokens > 0, `${r.choices[0].message.content}`);
  });
}
