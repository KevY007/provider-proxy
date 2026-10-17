import { describe, expect, it } from "vitest";
import { OpenAIStreamPassthrough } from "@/gateway/stream-processors";
import { InBandError, StreamSession, type FinishInfo } from "@/gateway/stream";
import { UpstreamTimeoutError } from "@/gateway/upstream";

const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Upstream body that emits `chunks` (strings) with `gapMs` between them; honours an AbortController. */
function upstream(chunks: string[], opts: { gapMs?: number; hang?: boolean; ac?: AbortController } = {}) {
  const ac = opts.ac ?? new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (ac.signal.aborted) return controller.error(ac.signal.reason);
      const next = chunks.shift();
      if (next === undefined) {
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

function session(up: ReturnType<typeof upstream>, o: { idleTimeoutMs?: number } = {}) {
  const finished: FinishInfo[] = [];
  const processor = new OpenAIStreamPassthrough("public", true);
  const s = new StreamSession({
    body: up.body,
    processor,
    abort: (r) => up.ac.abort(r),
    signal: up.ac.signal,
    idleTimeoutMs: o.idleTimeoutMs ?? 5_000,
    onFinish: (i) => finished.push(i),
    errorEvent: (err) => `data: ${JSON.stringify({ error: { message: err instanceof InBandError ? "sanitized in-band" : "sanitized", code: "upstream_error" } })}\n\n`,
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
    const { s, finished, processor } = session(upstream([data({ error: { message: "secret-vendor overloaded", type: "server_error", code: 503 } }), data("[DONE]")]));
    await s.prime();
    expect(processor.error()).toMatchObject({ status: 503 });
    expect(s.isEmpty()).toBe(false);
    s.discard();
    expect(finished).toHaveLength(0); // discard() never reports a finish
  });

  it("replaces an in-band upstream error after the stream started with a sanitized error event", async () => {
    const { s, finished } = session(upstream([chunk("partial"), data({ error: { message: "secret-vendor exploded", type: "server_error" } })]));
    await s.prime();
    const text = await drain(s.toReadable());
    expect(text).toContain("partial");
    expect(text).toContain("sanitized in-band");
    expect(text).not.toContain("secret-vendor");
    expect(finished[0].reason).toBe("upstream_error");
  });

  it("flags a stream that ends without a terminal event as `truncated`", async () => {
    const { s, finished } = session(upstream([chunk("cut off")]));
    await s.prime();
    await drain(s.toReadable());
    expect(finished[0].reason).toBe("truncated");
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

  it("idle upstream -> aborted with UpstreamTimeoutError, client gets a sanitized error and `timeout` is reported", async () => {
    const up = upstream([chunk("x")], { hang: true });
    const { s, finished } = session(up, { idleTimeoutMs: 60 });
    await s.prime();
    const text = await drain(s.toReadable());
    expect(text).toContain("sanitized");
    expect(finished[0].reason).toBe("timeout");
    expect(up.ac.signal.reason).toBeInstanceOf(UpstreamTimeoutError);
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
    const s = new StreamSession({ body, processor: null, abort: (r) => ac.abort(r), signal: ac.signal, idleTimeoutMs: 1000, onFinish: (i) => finished.push(i) });
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
});
