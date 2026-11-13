import { describe, expect, it } from "vitest";
import { GeminiStreamPassthrough, OpenAIStreamPassthrough, ResponsesStreamPassthrough } from "@/gateway/stream-processors";
import { GeminiJsonArrayStream } from "@/gateway/stream-gemini-array";
import { StreamSession, eventLabel, type FinishInfo, type StreamOptions } from "@/gateway/stream";
import { isPreambleEvent } from "@/gateway/stream-start";
import { SseParser } from "@/gateway/sse";
import type { StreamProcessor } from "@/gateway/processor";
import { ClientAbortError, UpstreamTimeoutError } from "@/gateway/upstream";
import { AnthropicToChatStream } from "@/gateway/translate";

const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Upstream body that emits `chunks` (strings) with `gapMs` between them; honours an AbortController. */
function upstream(chunks: string[], opts: { gapMs?: number; hang?: boolean; ac?: AbortController; failAfter?: boolean } = {}) {
  const ac = opts.ac ?? new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (ac.signal.aborted) return controller.error(ac.signal.reason);
      const next = chunks.shift();
      if (next === undefined) {
        if (opts.failAfter) return controller.error(new Error("socket hang up (ECONNRESET)"));
        if (opts.hang) {
          await new Promise<void>((resolve) => ac.signal.addEventListener("abort", () => resolve(), { once: true }));
          return controller.error(ac.signal.reason);
        }
        return controller.close();
      }
      if (opts.gapMs) await sleep(opts.gapMs);
      controller.enqueue(enc.encode(next));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, ac, wasCancelled: () => cancelled };
}

const data = (o: object | string) => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`;
const chunk = (content: string, finish: string | null = null) => data({ id: "c", model: "up", choices: [{ index: 0, delta: { content }, finish_reason: finish }] });

function session(up: ReturnType<typeof upstream>, o: { idleTimeoutMs?: number; heartbeatMs?: number; processor?: StreamProcessor; isPreamble?: StreamOptions["isPreamble"] } = {}) {
  const finished: FinishInfo[] = [];
  const processor = o.processor ?? new OpenAIStreamPassthrough("public", true);
  const s = new StreamSession({
    body: up.body,
    processor,
    abort: (r) => up.ac.abort(r),
    signal: up.ac.signal,
    idleTimeoutMs: o.idleTimeoutMs,
    heartbeatMs: o.heartbeatMs,
    isPreamble: o.isPreamble,
    onFinish: (i) => finished.push(i),
  });
  return { s, finished, processor };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const r = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await r.read();
    if (done) return out;
    out += dec.decode(value);
  }
}

/** Read until the stream ends or errors; returns what arrived and the error (if the stream was destroyed). */
async function drainUntilError(stream: ReadableStream<Uint8Array>): Promise<{ text: string; error: unknown }> {
  const r = stream.getReader();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await r.read();
      if (done) return { text, error: null };
      text += dec.decode(value);
    }
  } catch (error) {
    return { text, error };
  }
}

describe("StreamSession", () => {
  it("streams processed events and finishes `completed` with TTFT", async () => {
    const { s, finished, processor } = session(upstream([chunk("Hel"), chunk("lo", "stop"), data("[DONE]")], { gapMs: 5 }));
    await s.prime();
    const text = await drain(s.toReadable());
    expect(text).toContain('"model":"public"');
    expect(text).toContain("[DONE]");
    expect(processor.outputText()).toBe("Hello");
    expect(finished).toHaveLength(1);
    expect(finished[0].reason).toBe("completed");
    expect(finished[0].firstOutputMs).not.toBeNull();
  });

  it("parses events split across arbitrary chunk boundaries", async () => {
    const whole = chunk("Hi", "stop") + data("[DONE]");
    const pieces = whole.match(/[\s\S]{1,7}/g)!;
    const { s, finished, processor } = session(upstream(pieces));
    await s.prime();
    const text = await drain(s.toReadable());
    expect(text).toContain("[DONE]");
    expect(processor.outputText()).toBe("Hi");
    expect(finished[0].reason).toBe("completed");
  });

  it("prime() stops at a first-event error (nothing sent to the client) so the caller can fail over", async () => {
    const { s, finished, processor } = session(upstream([data({ error: { message: "overloaded", type: "server_error", code: 503 } }), data("[DONE]")]));
    await s.prime();
    expect(processor.error()).toMatchObject({ status: 503 });
    expect(s.isEmpty()).toBe(false);
    s.discard();
    expect(finished).toHaveLength(0); // discard() never reports a finish
  });

  it("forwards an in-band upstream error event VERBATIM and ends the stream the way the upstream ended it", async () => {
    const err = data({ error: { message: "the upstream exploded", type: "server_error", code: "boom" } });
    const { s, finished } = session(upstream([chunk("partial"), err]));
    await s.prime();
    const { text, error } = await drainUntilError(s.toReadable());
    expect(error).toBeNull(); // a normal end: the upstream's own terminal event was the error
    expect(text).toContain("partial");
    expect(text).toContain(err); // byte for byte
    expect(finished[0]).toMatchObject({ reason: "upstream_error", inband: true });
    expect(finished[0].destroyed).toBeUndefined();
  });

  it("an upstream's own comment lines reach the client as the neutral `: keep-alive` line: their text can name the upstream", async () => {
    const frames = [": acme-relay keep-alive\n\n", chunk("Hel"), ": keepalive\n: OPENROUTER PROCESSING\n\n", chunk("lo", "stop"), data("[DONE]")];
    for (const processor of [new OpenAIStreamPassthrough("public", true), new ResponsesStreamPassthrough(null)]) {
      const { s, finished } = session(upstream([...frames]), { processor });
      await s.prime();
      const text = await drain(s.toReadable());
      expect(text).not.toMatch(/acme|OPENROUTER|keepalive/);
      // one neutral line per upstream comment block, in its place in the stream
      expect(text.split(": keep-alive\n\n").length - 1).toBe(2);
      expect(text.indexOf(": keep-alive")).toBeLessThan(text.indexOf("Hel"));
      expect(text).toContain("[DONE]");
      expect(finished[0].reason).toBe("completed");
    }
  });

  it("a response that is not SSE (Gemini's JSON array) never gets a comment line, whatever the upstream sent", async () => {
    const part = (text: string, finishReason?: string) => data({ candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] });
    const { s, finished } = session(upstream([": acme-relay keep-alive\n\n", part("Hel"), ": keepalive\n\n", part("lo", "STOP")]), { processor: new GeminiJsonArrayStream(new GeminiStreamPassthrough(null)) });
    await s.prime();
    const text = await drain(s.toReadable());
    expect(text).not.toMatch(/keep-?alive|acme/);
    expect(JSON.parse(text)).toHaveLength(2);
    expect(finished[0].reason).toBe("completed");
  });

  it("an upstream that ends without its terminal event -> the client stream is DESTROYED, no synthetic end", async () => {
    const { s, finished } = session(upstream([chunk("cut off")]));
    await s.prime();
    const { text, error } = await drainUntilError(s.toReadable());
    expect(error).toBeInstanceOf(Error);
    expect(text).toContain("cut off");
    expect(text).not.toContain("[DONE]");
    expect(finished[0]).toMatchObject({ reason: "truncated", destroyed: true });
  });

  describe("trace of a stream that did not complete", () => {
    const rev = (type: string, extra: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
    const responses = (frames: string[]) => session(upstream(frames), { processor: new ResponsesStreamPassthrough(null), isPreamble: (e) => isPreambleEvent("openai_responses", e) });

    it("names the event that started the stream and the last upstream events: types only, never content", async () => {
      const { s, finished } = responses([
        ": keep-alive\n\n",
        rev("response.created", { response: { id: "r1" } }),
        rev("response.output_item.added", { item: { type: "reasoning", id: "rs1" } }),
        rev("response.reasoning_summary_text.delta", { delta: "secret plan" }),
        rev("response.output_text.delta", { delta: "secret answer" }),
        rev("response.output_item.done", { item: { id: "rs1", type: "reasoning" } }),
      ]);
      await s.prime();
      await drainUntilError(s.toReadable());
      expect(finished[0].reason).toBe("truncated");
      expect(finished[0].trace).toMatch(/^started by response\.output_text\.delta at \+\d+\.\ds; 6 upstream events, the last: comment -\d+\.\ds, response\.created -.*, response\.output_item\.done\[reasoning\] -\d+\.\ds$/);
      expect(finished[0].trace).not.toMatch(/secret/);
    });

    it("says so when only opening / reasoning events had arrived", async () => {
      const { s, finished } = responses([rev("response.created", { response: { id: "r1" } }), rev("response.reasoning_summary_text.delta", { delta: "x" })]);
      await drainUntilError(s.toReadable());
      expect(finished[0].reason).toBe("truncated");
      expect(finished[0].trace).toMatch(/^no output event yet \(only opening \/ reasoning events\); 2 upstream events, the last: response\.created -/);
    });

    it("a completed stream carries none", async () => {
      const { s, finished } = session(upstream([chunk("hi", "stop"), data("[DONE]")]));
      await drain(s.toReadable());
      expect(finished[0].reason).toBe("completed");
      expect(finished[0].trace).toBeUndefined();
    });

    it("eventLabel reads the type from the event line or the JSON, plus the item / block type", () => {
      const one = (raw: string) => new SseParser().push(`${raw}\n\n`)[0];
      expect(eventLabel(one(": ping"))).toBe("comment");
      expect(eventLabel(one(`event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"rs_1","type":"reasoning","encrypted_content":"abc"}}`))).toBe("response.output_item.done[reasoning]");
      expect(eventLabel(one(`data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`))).toBe("content_block_start[thinking]");
      expect(eventLabel(one(`data: {"id":"c","choices":[{"delta":{"content":"hello"}}]}`))).toBe("data");
      expect(eventLabel(one("data: [DONE]"))).toBe("[DONE]");
      expect(eventLabel(one("retry: 3000"))).toBe("empty");
    });
  });

  it("an upstream connection reset mid-stream destroys the client stream (no [DONE], no error event)", async () => {
    const up = upstream([chunk("one"), chunk("two")], { failAfter: true });
    const { s, finished } = session(up);
    await s.prime();
    const { text, error } = await drainUntilError(s.toReadable());
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/ECONNRESET/);
    expect(text).toContain("one");
    expect(text).not.toMatch(/\[DONE\]|"error"/);
    expect(finished[0]).toMatchObject({ reason: "upstream_error", destroyed: true });
  });

  it("client cancel -> `cancelled` and the upstream is aborted", async () => {
    const up = upstream([chunk("a"), chunk("b"), chunk("c")], { gapMs: 30 });
    const { s, finished } = session(up);
    await s.prime();
    const reader = s.toReadable().getReader();
    await reader.read();
    await reader.cancel();
    await sleep(20);
    expect(finished).toHaveLength(1);
    expect(finished[0].reason).toBe("cancelled");
    expect(up.ac.signal.aborted).toBe(true);
  });

  // ---- bug 3 (live workload report): a stream whose upstream completed and whose last byte was handed to the client
  // is SUCCESS even when the client closes right after (the OpenAI SDK stops reading at [DONE] and cancels at once)
  describe("client closes right after the terminal event", () => {
    async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
      let text = "";
      while (!text.includes(marker)) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
      return text;
    }

    it("OpenAI chunk stream: cancel() after [DONE] (upstream still open) -> `completed`, upstream aborted", async () => {
      const up = upstream([chunk("a"), chunk("b", "stop"), data("[DONE]")], { hang: true });
      const { s, finished } = session(up);
      await s.prime();
      const reader = s.toReadable().getReader();
      const text = await readUntil(reader, "[DONE]");
      expect(text).toContain("[DONE]");
      await reader.cancel(); // the SDK closes the response as soon as it saw [DONE]
      await sleep(20);
      expect(finished).toHaveLength(1);
      expect(finished[0].reason).toBe("completed");
      expect(up.ac.signal.aborted).toBe(true); // nothing keeps running upstream
    });

    it("repeated 40x with varying reading delays: never CANCELLED", async () => {
      for (let i = 0; i < 40; i++) {
        const up = upstream([chunk("a"), chunk("b", "stop"), data("[DONE]")], { gapMs: i % 3 });
        const { s, finished } = session(up);
        await s.prime();
        const reader = s.toReadable().getReader();
        await readUntil(reader, "[DONE]");
        if (i % 2) await sleep(i % 5);
        await reader.cancel();
        await sleep(5);
        expect(
          finished.map((f) => f.reason),
          `iteration ${i}`,
        ).toEqual(["completed"]);
      }
    });

    it("a close BEFORE the upstream completed is still CANCELLED (no finish_reason / [DONE] seen yet)", async () => {
      const up = upstream([chunk("a"), chunk("b")], { hang: true });
      const { s, finished } = session(up);
      await s.prime();
      const reader = s.toReadable().getReader();
      await reader.read();
      await reader.cancel();
      await sleep(20);
      expect(finished.map((f) => f.reason)).toEqual(["cancelled"]);
    });

    it("the client abort landing on the idle read of the next pull is `completed` too", async () => {
      const up = upstream([chunk("a"), chunk("b", "stop"), data("[DONE]")], { hang: true });
      const { s, finished } = session(up);
      await s.prime();
      const reader = s.toReadable().getReader();
      await readUntil(reader, "[DONE]");
      await sleep(10); // the next pull is now waiting on the (silent) upstream
      up.ac.abort(new ClientAbortError());
      await sleep(20);
      expect(finished.map((f) => f.reason)).toEqual(["completed"]);
      await reader.cancel().catch(() => undefined);
    });

    it("translated Claude -> chat stream with a tool call: cancel() after the final [DONE] -> `completed`", async () => {
      const ev = (type: string, o: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
      const frames = [
        ev("message_start", { message: { id: "msg_1", model: "up", usage: { input_tokens: 5, output_tokens: 1 } } }),
        ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } }),
        ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' } }),
        ev("content_block_stop", { index: 0 }),
        ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
        ev("message_stop", {}),
      ];
      const up = upstream(frames, { hang: true });
      const { s, finished, processor } = session(up, { processor: new AnthropicToChatStream("public", true) });
      await s.prime();
      const reader = s.toReadable().getReader();
      const text = await readUntil(reader, "[DONE]");
      expect(text).toContain('"finish_reason":"tool_calls"');
      await reader.cancel();
      await sleep(20);
      expect(finished.map((f) => f.reason)).toEqual(["completed"]);
      expect(processor.usage()).toMatchObject({ inputTokens: 5, outputTokens: 9 });
    });

    it("raw byte passthrough with a known length: leaving after the last announced byte is `completed`", async () => {
      const ac = new AbortController();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode("hello "));
          c.enqueue(enc.encode("world"));
          // the upstream connection stays open (it has not noticed the end yet)
        },
      });
      const finished: FinishInfo[] = [];
      const s = new StreamSession({ body, processor: null, abort: (r) => ac.abort(r), signal: ac.signal, expectedBytes: 11, onFinish: (i) => finished.push(i) });
      const reader = s.toReadable().getReader();
      let got = "";
      while (got.length < 11) got += dec.decode((await reader.read()).value);
      await reader.cancel();
      await sleep(10);
      expect(finished.map((f) => f.reason)).toEqual(["completed"]);

      // ... but leaving before the announced length is a cancellation
      const ac2 = new AbortController();
      const body2 = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(enc.encode("hello ")) });
      const finished2: FinishInfo[] = [];
      const s2 = new StreamSession({ body: body2, processor: null, abort: (r) => ac2.abort(r), signal: ac2.signal, expectedBytes: 11, onFinish: (i) => finished2.push(i) });
      const r2 = s2.toReadable().getReader();
      await r2.read();
      await r2.cancel();
      await sleep(10);
      expect(finished2.map((f) => f.reason)).toEqual(["cancelled"]);
    });
  });

  it("idle upstream (opt-in cutoff) -> aborted with UpstreamTimeoutError and the client stream is destroyed", async () => {
    const up = upstream([chunk("x")], { hang: true });
    const { s, finished } = session(up, { idleTimeoutMs: 60 });
    await s.prime();
    const { error } = await drainUntilError(s.toReadable());
    expect(error).toBeInstanceOf(UpstreamTimeoutError);
    expect(finished[0]).toMatchObject({ reason: "timeout", destroyed: true });
    expect(up.ac.signal.reason).toBeInstanceOf(UpstreamTimeoutError);
  });

  it("no idle cutoff by default: a silent upstream is never killed by the gateway", async () => {
    const up = upstream([chunk("x")], { hang: true });
    const { s, finished } = session(up);
    await s.prime();
    const r = s.toReadable().getReader();
    await r.read();
    await sleep(150);
    expect(up.ac.signal.aborted).toBe(false);
    expect(finished).toHaveLength(0);
    await r.cancel();
  });

  it("sends `: keep-alive` comments only while the upstream is silent, then stops", async () => {
    const up = upstream([chunk("a"), chunk("b", "stop"), data("[DONE]")], { gapMs: 220 });
    const { s, finished } = session(up, { heartbeatMs: 50 });
    await s.prime();
    const text = await drain(s.toReadable());
    const beats = text.split(": keep-alive\n\n").length - 1;
    expect(beats).toBeGreaterThanOrEqual(3);
    expect(text).toContain("[DONE]");
    expect(finished[0].reason).toBe("completed");
    const afterEnd = Date.now();
    await sleep(120);
    expect(Date.now() - afterEnd).toBeGreaterThan(100); // nothing left running: no timer keeps the process busy
  });

  it("no heartbeats without heartbeatMs", async () => {
    const { s } = session(upstream([chunk("a"), chunk("b", "stop"), data("[DONE]")], { gapMs: 80 }));
    await s.prime();
    expect(await drain(s.toReadable())).not.toContain("keep-alive");
  });

  it("prime() commits after `commitAfterMs` of upstream silence (heartbeats can then keep the client alive)", async () => {
    const up = upstream([chunk("late"), chunk("done", "stop"), data("[DONE]")], { gapMs: 200 });
    const { s } = session(up, { heartbeatMs: 40 });
    const t0 = Date.now();
    await s.prime({ commitAfterMs: 60 });
    expect(Date.now() - t0).toBeLessThan(180);
    expect(s.isEmpty()).toBe(false);
    const text = await drain(s.toReadable());
    expect(text).toContain("keep-alive");
    expect(text).toContain("late");
    expect(text).toContain("[DONE]");
  });

  it("a bug in our own processing after commit -> upstream aborted, client destroyed, `gateway_error`", async () => {
    let calls = 0;
    const inner = new OpenAIStreamPassthrough("public", true);
    const buggy: StreamProcessor = {
      onEvent: (ev) => {
        if (++calls === 2) throw new Error("processor bug");
        return inner.onEvent(ev);
      },
      onEnd: () => inner.onEnd(),
      usage: () => inner.usage(),
      outputText: () => inner.outputText(),
      completed: () => inner.completed(),
      error: () => inner.error(),
    };
    const up = upstream([chunk("a"), chunk("b"), chunk("c", "stop"), data("[DONE]")], { gapMs: 5 });
    const { s, finished } = session(up, { processor: buggy });
    await s.prime();
    const { error } = await drainUntilError(s.toReadable());
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/processor bug/);
    expect(finished[0]).toMatchObject({ reason: "gateway_error", destroyed: true });
    expect(up.ac.signal.aborted).toBe(true);
  });

  it("raw mode (audio / binary) forwards bytes untouched", async () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 3));
        c.enqueue(bytes.slice(3));
        c.close();
      },
    });
    const finished: FinishInfo[] = [];
    const ac = new AbortController();
    const s = new StreamSession({ body, processor: null, abort: (r) => ac.abort(r), signal: ac.signal, onFinish: (i) => finished.push(i) });
    const r = s.toReadable().getReader();
    const got: number[] = [];
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      got.push(...value);
    }
    expect(got).toEqual([...bytes]);
    expect(finished[0]).toMatchObject({ reason: "completed", bytesOut: 6 });
  });

  it("raw mode: an upstream error mid-body destroys the client stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array([9, 9]));
        c.error(new Error("terminated"));
      },
    });
    const finished: FinishInfo[] = [];
    const ac = new AbortController();
    const s = new StreamSession({ body, processor: null, abort: (r) => ac.abort(r), signal: ac.signal, onFinish: (i) => finished.push(i) });
    const { error } = await drainUntilError(s.toReadable());
    expect(error).toBeInstanceOf(Error);
    expect(finished[0]).toMatchObject({ reason: "upstream_error", destroyed: true });
  });
});
