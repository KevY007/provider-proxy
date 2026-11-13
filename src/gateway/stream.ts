import type { StreamProcessor } from "./processor";
import { SseParser, type SseEvent } from "./sse";
import { ClientAbortError, UpstreamTimeoutError } from "./upstream";

/**
 * Streaming engine (PLAN 9d): pulls the upstream body, parses SSE events, runs them through a StreamProcessor
 * (translate / mask / extract usage) and exposes a pull-based ReadableStream to the client, so:
 *   - back-pressure flows to the upstream (no unbounded buffering),
 *   - client disconnect (`cancel`) is observed and aborts the upstream immediately (the upstream connection is destroyed),
 *   - `onFinish` fires exactly once,
 *   - the break of a leg is never masked as a normal end:
 *       upstream failure / premature end / stall mid-stream  -> with `breakEvents` (the default in the gateway): ONE
 *                                                               native error event of ours, then the stream ends - what
 *                                                               the model maker's own API does when it fails mid-answer;
 *                                                               without it: the client response is DESTROYED (the stream
 *                                                               errors; the HTTP layer drops the connection). Never a
 *                                                               synthetic [DONE] or terminal event;
 *       in-band upstream error event                          -> forwarded verbatim by the processor, then a normal end;
 *       a bug in our own processing after commit              -> upstream aborted + client destroyed (GATEWAY_ERROR);
 *   - our own business rule: the funds guard ends the stream with a native `insufficient_balance` error (credit hold
 *     used up);
 *   - while the upstream is silent on an SSE stream a `: keep-alive` comment line is sent every `heartbeatMs`;
 *   - the upstream's own SSE comment lines are replaced by that same line (their text can name the upstream).
 */
export type FinishReason = "completed" | "cancelled" | "upstream_error" | "timeout" | "truncated" | "budget" | "gateway_error";

export interface FinishInfo {
  reason: FinishReason;
  error?: unknown;
  /** The upstream sent an error EVENT (forwarded verbatim) and the stream ended normally. */
  inband?: boolean;
  /** The client response was destroyed (the client observes a network error). */
  destroyed?: boolean;
  /** The upstream leg broke and the client was told with an error event of ours (`breakEvents`), then the stream ended. */
  notified?: boolean;
  /** ms from stream start to the first content byte written to the client (null if none). */
  firstOutputMs: number | null;
  bytesOut: number;
  /**
   * Only for a stream that did not complete: which upstream event made it count as started and the last events the
   * upstream sent (event types only, never content) - what an admin needs to tell an upstream that died mid-answer
   * from one that never really began.
   */
  trace?: string;
}

export interface StreamOptions {
  body: ReadableStream<Uint8Array>;
  /** null => raw byte passthrough (audio, files). */
  processor: StreamProcessor | null;
  abort: (reason?: unknown) => void;
  signal: AbortSignal;
  /** Abort the upstream when it sends nothing for this long (0 / undefined = never). */
  idleTimeoutMs?: number;
  onFinish: (info: FinishInfo) => void;
  startedAt?: number;
  /** Send `: keep-alive` comments while the upstream is silent (SSE only; 0 / undefined = off). */
  heartbeatMs?: number;
  /**
   * Raw passthrough (no processor) with a known body length: a client that leaves once it has received this many bytes
   * got the complete body, which is a normal end (not a cancellation).
   */
  expectedBytes?: number;
  /**
   * Funds guard: checked after every upstream chunk. When `exceeded()` turns true the upstream is aborted, `events()`
   * (native error ending) is sent to the client and the stream finishes with reason "budget".
   */
  guard?: { exceeded(): boolean; events(): string[] };
  /**
   * The upstream leg broke after the response started (reset, closed without its terminal event, idle cutoff): the
   * blocks to send to the client before the stream is closed - a native error event. Unset, or nothing returned: the
   * client connection is dropped instead.
   */
  breakEvents?: (reason: "upstream_error" | "truncated" | "timeout") => string[];
  /**
   * Upstream events that carry no output yet (role-only chunk, `response.created`, `message_start` ...): they do not
   * count as the stream having started, so an error right after them still fails over (see stream-start.ts).
   */
  isPreamble?: (ev: SseEvent) => boolean;
}

/** Abort reason used when the gateway ends a stream at the client's max_output_tokens (the upstream ignored it). */
export class OutputCapError extends Error {
  constructor() {
    super("stream ended: max_output_tokens reached");
    this.name = "OutputCapError";
  }
}

/** Abort reason used when the funds guard cuts a stream. */
export class BudgetCutError extends Error {
  constructor() {
    super("stream cut: credit hold exhausted");
    this.name = "BudgetCutError";
  }
}

/** The upstream ended (cleanly) before the stream reached its terminal event. */
export class UpstreamTruncatedError extends Error {
  constructor() {
    super("upstream closed the stream before it was complete");
    this.name = "UpstreamTruncatedError";
  }
}

/** A failure inside OUR stream processing (not the upstream's). */
export class GatewayStreamError extends Error {
  constructor(readonly cause: unknown) {
    super(`gateway stream processing failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "GatewayStreamError";
  }
}

/** Marker for an error event the upstream sent inside an otherwise healthy stream. */
export class InBandError extends Error {
  constructor(readonly info: { status: number; message: string; type?: string }) {
    super(info.message);
    this.name = "InBandError";
  }
}

/** Event type (and, for item / block events, the item type) of an SSE event: a label for diagnostics, never content. */
export function eventLabel(ev: SseEvent): string {
  if (ev.comment) return "comment";
  const head = ev.data.slice(0, 600);
  const type = ev.event ?? /^\s*\{\s*"type":\s*"([\w.]+)"/.exec(head)?.[1] ?? (ev.data.trim() === "[DONE]" ? "[DONE]" : ev.data ? "data" : "empty");
  const inner = /"(?:item|content_block|delta)":\s*\{[^{}]{0,300}?"type":\s*"([\w.]+)"/.exec(head)?.[1];
  return inner ? `${type}[${inner}]` : type;
}

const TRACE_TAIL = 6;

const enc = new TextEncoder();
export const HEARTBEAT_COMMENT = ": keep-alive\n\n";
const HEARTBEAT_BYTES = enc.encode(HEARTBEAT_COMMENT);

export class StreamSession {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private parser = new SseParser();
  private decoder = new TextDecoder();
  private pending: Uint8Array[] = [];
  private finished = false;
  private upstreamDone = false;
  private idle: NodeJS.Timeout | null = null;
  private hb: NodeJS.Timeout | null = null;
  private firstOutputAt: number | null = null;
  private bytesOut = 0;
  private readonly t0: number;
  private cutDone = false;
  private waiting = false;
  private ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  private inflight: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  private anyOutput = false;
  /** Real output (beyond preamble events) has been produced. */
  private started = false;
  /** An error event arrived before any real output (only preamble events, if anything, came first). */
  firstEventError = false;
  /** Diagnostics (see FinishInfo.trace): the event that started the stream and the last upstream events, with arrival times. */
  private startedBy: { ev: SseEvent; at: number } | null = null;
  private tail: Array<{ ev: SseEvent; at: number }> = [];
  private upstreamEvents = 0;

  constructor(private readonly o: StreamOptions) {
    this.reader = o.body.getReader();
    this.t0 = o.startedAt ?? Date.now();
  }

  // ------------------------------------------------------------------ timers
  private arm(): void {
    const ms = this.o.idleTimeoutMs ?? 0;
    if (ms <= 0) return;
    if (this.idle) this.idle.refresh();
    else {
      this.idle = setTimeout(() => this.o.abort(new UpstreamTimeoutError("idle")), ms);
      this.idle.unref?.();
    }
  }

  private disarm(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.hb) clearInterval(this.hb);
    this.hb = null;
  }

  private startHeartbeat(): void {
    const ms = this.o.heartbeatMs ?? 0;
    if (ms <= 0 || this.hb || this.finished) return;
    // one interval per session; a beat is only due when the UPSTREAM has been silent for `ms` (and we are waiting on it)
    this.hb = setInterval(
      () => {
        if (this.finished || !this.waiting || !this.ctrl) return;
        const now = Date.now();
        if (now - Math.max(this.lastBeat, this.lastUpstreamAt) < ms) return;
        if ((this.ctrl.desiredSize ?? 0) <= 0) return; // the client is not draining: nothing to keep alive
        try {
          this.ctrl.enqueue(HEARTBEAT_BYTES);
          this.lastBeat = now;
        } catch {
          /* closed */
        }
      },
      Math.max(5, Math.min(1000, Math.floor(ms / 4))),
    );
    this.hb.unref?.();
  }
  private lastBeat = 0;
  private lastUpstreamAt = Date.now();

  // ------------------------------------------------------------------ ingest
  /** Feed one upstream chunk through the parser/processor, appending output to `pending`. */
  private ingest(chunk: Uint8Array | null): void {
    const p = this.o.processor;
    if (!p) {
      if (chunk) this.pending.push(chunk);
      return;
    }
    const events = chunk ? this.parser.push(this.decoder.decode(chunk, { stream: true })) : [...this.parser.push(this.decoder.decode()), ...this.parser.end()];
    for (const ev of events) {
      const hadError = !!p.error();
      // An upstream's own comment lines never reach the client as written: relays put their name in them
      // (": <relay> keep-alive", ": <ROUTER> PROCESSING"). Where the processor would pass the block on, our neutral line
      // goes out in its place (the connection stays alive); where it drops comments - a translated stream, a response
      // that is not SSE - nothing is sent, as before.
      const processed = p.onEvent(ev);
      const out = ev.comment && processed.length ? [HEARTBEAT_COMMENT] : processed;
      this.upstreamEvents++;
      this.tail.push({ ev, at: Date.now() });
      if (this.tail.length > TRACE_TAIL) this.tail.shift();
      if (!hadError && p.error() && !this.started) this.firstEventError = true;
      if (!ev.comment && !p.error() && out.length) {
        this.anyOutput = true;
        // (only asked until the stream has started: nothing depends on the answer afterwards)
        if (!this.started && !this.o.isPreamble?.(ev)) {
          this.started = true;
          this.startedBy = { ev, at: Date.now() };
        }
      }
      for (const s of out) if (s) this.pending.push(enc.encode(s));
      if (p.halted?.()) {
        this.haltUpstream();
        break;
      }
      if (chunk && this.checkGuard()) break; // checked per event: the cut lands on the event that used the funds up, not at the end of the network chunk
    }
    if (!chunk) for (const s of p.onEnd()) if (s) this.pending.push(enc.encode(s));
  }

  /** The processor ended the stream (output cap reached): nothing more is read, the upstream is told to stop. */
  private haltUpstream(): void {
    if (this.upstreamDone) return;
    this.upstreamDone = true;
    try {
      this.o.abort(new OutputCapError());
    } catch {
      /* already aborted */
    }
    this.reader.cancel().catch(() => undefined);
  }

  /** Funds guard (see StreamOptions.guard): end the stream right here when the reserved amount is used up. Returns true when it cut. */
  private checkGuard(): boolean {
    const g = this.o.guard;
    if (!g || this.cutDone || this.finished) return false;
    let exceeded = false;
    try {
      exceeded = g.exceeded();
    } catch {
      return false;
    }
    if (!exceeded) return false;
    this.cutDone = true;
    this.upstreamDone = true;
    for (const s of g.events()) if (s) this.pending.push(enc.encode(s));
    try {
      this.o.abort(new BudgetCutError());
    } catch {
      /* already aborted */
    }
    this.reader.cancel().catch(() => undefined);
    return true;
  }

  /** One upstream read; the promise survives a prime() that gave up waiting (see `commitAfterMs`). */
  private nextRead(): Promise<ReadableStreamReadResult<Uint8Array>> {
    const p = this.inflight ?? this.reader.read();
    this.inflight = p;
    const clear = () => {
      if (this.inflight === p) this.inflight = null;
    };
    p.then(clear, clear);
    return p;
  }

  /**
   * Read upstream until real output exists (preamble events alone do not count; or an in-band error / EOF shows up),
   * WITHOUT sending anything to the client. Lets the pipeline fail over (invisibly, on the next key or a retry of the
   * same one) when the stream fails before producing anything. When this takes longer than `commitAfterMs` the
   * response is committed anyway (it answered 200 + SSE headers; from then on heartbeats keep the client connection
   * alive). Throws on read errors.
   */
  async prime(o: { commitAfterMs?: number } = {}): Promise<void> {
    this.arm();
    const commitAfter = o.commitAfterMs ?? 0;
    const deadline = commitAfter > 0 ? Date.now() + commitAfter : 0;
    const p = this.o.processor;
    const ready = () => (p ? this.started || !!p.error() : this.pending.length > 0);
    try {
      while (!ready() && !this.upstreamDone) {
        let timer: NodeJS.Timeout | undefined;
        const read = this.nextRead();
        const left = deadline ? Math.max(1, deadline - Date.now()) : 0;
        const raced = deadline ? await Promise.race([read, new Promise<"commit">((resolve) => (timer = setTimeout(() => resolve("commit"), left)))]) : await read;
        if (timer) clearTimeout(timer);
        if (raced === "commit") return;
        const { done, value } = raced;
        if (done) {
          this.upstreamDone = true;
          this.ingest(null);
          break;
        }
        this.arm();
        this.lastUpstreamAt = Date.now();
        this.ingest(value);
      }
    } catch (err) {
      this.disarm();
      throw err;
    }
  }

  private finish(reason: FinishReason, extra: { error?: unknown; inband?: boolean; destroyed?: boolean; notified?: boolean } = {}): void {
    if (this.finished) return;
    this.finished = true;
    this.disarm();
    try {
      this.o.onFinish({ reason, ...extra, firstOutputMs: this.firstOutputAt === null ? null : this.firstOutputAt - this.t0, bytesOut: this.bytesOut, ...(reason === "completed" ? {} : { trace: this.trace() }) });
    } catch {
      /* onFinish must not break the stream teardown */
    }
  }

  /** See FinishInfo.trace. */
  private trace(): string | undefined {
    if (!this.o.processor || !this.upstreamEvents) return undefined;
    const now = Date.now();
    const sec = (ms: number) => (ms / 1000).toFixed(1);
    const started = this.startedBy ? `started by ${eventLabel(this.startedBy.ev)} at +${sec(this.startedBy.at - this.t0)}s` : "no output event yet (only opening / reasoning events)";
    const last = this.tail.map((x) => `${eventLabel(x.ev)} -${sec(now - x.at)}s`).join(", ");
    return `${started}; ${this.upstreamEvents} upstream events, the last: ${last}`;
  }

  /** Abandon a primed-but-unused session (failover happened). Does not call onFinish. */
  discard(): void {
    this.finished = true;
    this.disarm();
    this.reader.cancel().catch(() => undefined);
  }

  /** Destroy the client response: the stream errors, the HTTP layer drops the connection (no clean end of any kind). */
  private destroyClient(c: ReadableStreamDefaultController<Uint8Array>, err: unknown): void {
    try {
      c.error(err);
    } catch {
      /* already closed / errored */
    }
  }

  /**
   * The upstream leg broke after the response started. With an error ending (`breakEvents`) the client gets it and the
   * stream is closed; otherwise the client response is destroyed.
   */
  private endBroken(c: ReadableStreamDefaultController<Uint8Array>, reason: "upstream_error" | "truncated" | "timeout", err: unknown): void {
    let blocks: string[] = [];
    try {
      blocks = (this.o.processor ? this.o.breakEvents?.(reason) : undefined)?.filter(Boolean) ?? [];
    } catch {
      blocks = [];
    }
    if (!blocks.length) {
      this.finish(reason, { error: err, destroyed: true });
      this.destroyClient(c, err);
      return;
    }
    const chunk = enc.encode(blocks.join(""));
    this.bytesOut += chunk.byteLength;
    this.finish(reason, { error: err, notified: true });
    try {
      c.enqueue(chunk);
      c.close();
    } catch {
      /* the client left in the meantime */
    }
  }

  toReadable(): ReadableStream<Uint8Array> {
    const start = (c: ReadableStreamDefaultController<Uint8Array>): void => {
      this.ctrl = c;
      this.startHeartbeat();
    };
    const pull = async (c: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
      if (this.finished) return;
      try {
        for (;;) {
          if (this.pending.length) {
            const chunk = this.pending.length === 1 ? this.pending[0] : concat(this.pending);
            this.pending = [];
            if (this.firstOutputAt === null) this.firstOutputAt = Date.now();
            this.bytesOut += chunk.byteLength;
            c.enqueue(chunk);
            return;
          }
          if (this.upstreamDone) {
            const p = this.o.processor;
            const err = p?.error();
            if (this.cutDone) {
              this.finish("budget");
            } else if (err) {
              // the upstream's own error event was forwarded verbatim; the stream ends the way the upstream ended it
              this.finish("upstream_error", { inband: true });
            } else if (p && !p.completed()) {
              // premature end: the upstream closed without its terminal event -> never a normal end for the client
              this.endBroken(c, "truncated", new UpstreamTruncatedError());
              return;
            } else this.finish("completed");
            try {
              c.close();
            } catch {
              /* closed */
            }
            return;
          }
          this.arm();
          this.waiting = true;
          let r: ReadableStreamReadResult<Uint8Array>;
          try {
            r = await this.nextRead();
          } finally {
            this.waiting = false;
          }
          if (this.finished) return;
          if (r.done) {
            this.upstreamDone = true;
            try {
              this.ingest(null);
            } catch (e) {
              throw new GatewayStreamError(e);
            }
            continue;
          }
          this.lastUpstreamAt = Date.now();
          try {
            this.ingest(r.value);
          } catch (e) {
            throw new GatewayStreamError(e);
          }
        }
      } catch (err) {
        this.disarm();
        if (this.finished) return; // client already left / budget cut: nothing left to tell
        if (err instanceof GatewayStreamError) {
          // our own bug after commit: stop the upstream, drop the client, make it visible (GATEWAY_ERROR)
          try {
            this.o.abort(err);
          } catch {
            /* already aborted */
          }
          this.reader.cancel().catch(() => undefined);
          this.finish("gateway_error", { error: err.cause, destroyed: true });
          this.destroyClient(c, err);
          return;
        }
        const reason = this.o.signal.reason;
        const timedOut = reason instanceof UpstreamTimeoutError || err instanceof UpstreamTimeoutError;
        const clientGone = reason instanceof ClientAbortError || err instanceof ClientAbortError || (this.o.signal.aborted && !timedOut && !(reason instanceof BudgetCutError));
        if (clientGone && !timedOut) {
          // (same rule as cancel(): the client may leave first, and the abort then lands on the idle read of the NEXT pull)
          this.finish(this.deliveredEverything() ? "completed" : "cancelled", { error: err });
          try {
            c.close();
          } catch {
            /* already closed */
          }
          return;
        }
        // the upstream leg broke (reset, drop, stall): tell the client (or break its leg the same way)
        this.endBroken(c, timedOut ? "timeout" : "upstream_error", err);
      }
    };
    const cancel = (reason: unknown): void => {
      // The client went away: stop everything now - the upstream connection is destroyed. But a client that leaves AFTER
      // the upstream's terminal event was handed to it (the OpenAI SDK stops reading at `[DONE]` and closes at once, long
      // before the next pull would have noticed the upstream's own end) received the complete response: that is a normal
      // end, not a cancellation. Only a close BEFORE the upstream completed is CANCELLED.
      this.finish(this.deliveredEverything() ? "completed" : "cancelled", { error: reason });
      this.o.abort(new ClientAbortError());
      this.reader.cancel().catch(() => undefined);
    };
    return new ReadableStream<Uint8Array>({ start, pull, cancel }, new CountQueuingStrategy({ highWaterMark: 4 }));
  }

  /**
   * True when the upstream finished (its terminal event was seen / all announced bytes were passed on) and nothing is
   * left to hand to the client: every byte of the response has been enqueued.
   */
  private deliveredEverything(): boolean {
    if (this.finished || this.cutDone || this.pending.length > 0) return false;
    const p = this.o.processor;
    if (p) return p.completed() && !p.error();
    if (this.upstreamDone) return true;
    const want = this.o.expectedBytes;
    return want !== undefined && want >= 0 && this.bytesOut >= want;
  }

  /** After prime(): upstream ended without producing any output (preamble events at most). */
  isEmpty(): boolean {
    if (!this.upstreamDone) return false;
    return this.o.processor ? !this.started && !this.o.processor.error() : this.pending.length === 0;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}
