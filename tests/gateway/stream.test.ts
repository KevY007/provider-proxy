import { describe, expect, it } from "vitest";
import { OpenAIStreamPassthrough } from "@/gateway/stream-processors";
import { StreamSession, type FinishInfo } from "@/gateway/stream";
import type { StreamProcessor } from "@/gateway/processor";
import { UpstreamTimeoutError } from "@/gateway/upstream";

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

function session(up: ReturnType<typeof upstream>, o: { idleTimeoutMs?: number; heartbeatMs?: number; processor?: StreamProcessor } = {}) {
  const finished: FinishInfo[] = [];
  const processor = o.processor ?? new OpenAIStreamPassthrough("public", true);
  const s = new StreamSession({
    body: up.body,
    processor,
    abort: (r) => up.ac.abort(r),
    signal: up.ac.signal,
    idleTimeoutMs: o.idleTimeoutMs,
    heartbeatMs: o.heartbeatMs,
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

  it("an upstream that ends without its terminal event -> the client stream is DESTROYED, no synthetic end", async () => {
    const { s, finished } = session(upstream([chunk("cut off")]));
    await s.prime();
    const { text, error } = await drainUntilError(s.toReadable());
    expect(error).toBeInstanceOf(Error);
    expect(text).toContain("cut off");
    expect(text).not.toContain("[DONE]");
    expect(finished[0]).toMatchObject({ reason: "truncated", destroyed: true });
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
