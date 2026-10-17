import type { StreamProcessor } from "./processor";
import { SseParser } from "./sse";
import { ClientAbortError, UpstreamTimeoutError } from "./upstream";

/**
 * Streaming engine: pulls the upstream body, parses SSE events, runs them through a StreamProcessor
 * (translate / mask / extract usage) and exposes a pull-based ReadableStream to the client, so:
 *   - back-pressure flows to the upstream (no unbounded buffering),
 *   - client disconnect (`cancel`) is observed and aborts the upstream immediately,
 *   - `onFinish` fires exactly once (completed / cancelled / upstream error / idle timeout / truncated).
 */
export type FinishReason = "completed" | "cancelled" | "upstream_error" | "timeout" | "truncated" | "budget";

export interface FinishInfo {
  reason: FinishReason;
  error?: unknown;
  /** ms from stream start to the first byte written to the client (null if none). */
  firstOutputMs: number | null;
  bytesOut: number;
}

export interface StreamOptions {
  body: ReadableStream<Uint8Array>;
  /** null => raw byte passthrough (audio, files). */
  processor: StreamProcessor | null;
  abort: (reason?: unknown) => void;
  signal: AbortSignal;
  idleTimeoutMs: number;
  onFinish: (info: FinishInfo) => void;
  /** Serialized SSE text emitted to the client when the upstream fails after the stream started. */
  errorEvent?: (err: unknown) => string;
  /** Called with every upstream text chunk (for logBodies); optional. */
  startedAt?: number;
  /**
   * Funds guard: checked after every upstream chunk. When `exceeded()` turns true the upstream is aborted, `events()`
   * (native error ending) is sent to the client and the stream finishes with reason "budget".
   */
  guard?: { exceeded(): boolean; events(): string[] };
}

/** Abort reason used when the funds guard cuts a stream. */
export class BudgetCutError extends Error {
  constructor() {
    super("stream cut: credit hold exhausted");
    this.name = "BudgetCutError";
  }
}

const enc = new TextEncoder();

/** Marker passed to errorEvent() for an error event the upstream sent inside an otherwise healthy stream. */
export class InBandError extends Error {
  constructor(readonly info: { status: number; message: string; type?: string }) {
    super(info.message);
    this.name = "InBandError";
  }
}

export class StreamSession {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private parser = new SseParser();
  private decoder = new TextDecoder();
  private pending: Uint8Array[] = [];
  private finished = false;
  private upstreamDone = false;
  private idle: NodeJS.Timeout | null = null;
  private firstOutputAt: number | null = null;
  private bytesOut = 0;
  private readonly t0: number;
  private primeError: unknown = null;
  private errorSent = false;
  private cutDone = false;
  /** true once at least one byte was produced for the client (before that, errors cause failover instead). */
  private started = false;

  constructor(private readonly o: StreamOptions) {
    this.reader = o.body.getReader();
    this.t0 = o.startedAt ?? Date.now();
  }

  private arm(): void {
    if (this.idle) this.idle.refresh();
    else {
      this.idle = setTimeout(() => this.o.abort(new UpstreamTimeoutError("idle")), this.o.idleTimeoutMs);
      this.idle.unref?.();
    }
  }

  private disarm(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  /** Feed one upstream chunk through the parser/processor, appending output to `pending`. */
  private ingest(chunk: Uint8Array | null): void {
    const p = this.o.processor;
    if (!p) {
      if (chunk) this.pending.push(chunk);
      return;
    }
    const events = chunk ? this.parser.push(this.decoder.decode(chunk, { stream: true })) : [...this.parser.push(this.decoder.decode()), ...this.parser.end()];
    for (const ev of events) {
      const out = p.onEvent(ev);
      for (const s of out) if (s) this.pending.push(enc.encode(s));
      // an in-band upstream error that arrives after the stream has started: tell the client with a sanitized event
      if (!this.errorSent && this.started && p.error()) {
        this.errorSent = true;
        const msg = this.o.errorEvent?.(new InBandError(p.error()!));
        if (msg) this.pending.push(enc.encode(msg));
      }
      if (out.length) this.started = true;
      if (chunk && this.checkGuard()) break; // checked per event: the cut lands on the event that used the funds up, not at the end of the network chunk
    }
    if (!chunk) for (const s of p.onEnd()) if (s) this.pending.push(enc.encode(s));
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
    this.started = true;
    try {
      this.o.abort(new BudgetCutError());
    } catch {
      /* already aborted */
    }
    this.reader.cancel().catch(() => undefined);
    return true;
  }

  /**
   * Read upstream until the first output exists (or an in-band error / EOF shows up), WITHOUT sending anything to
   * the client. Lets the pipeline fail over when the first event is an error. Throws on read errors.
   */
  async prime(): Promise<void> {
    this.arm();
    try {
      while (!this.pending.length && !this.upstreamDone) {
        if (this.o.processor?.error()) return;
        const { done, value } = await this.reader.read();
        if (done) {
          this.upstreamDone = true;
          this.ingest(null);
          break;
        }
        this.arm();
        this.ingest(value);
      }
    } catch (err) {
      this.primeError = err;
      this.disarm();
      throw err;
    }
  }

  private finish(reason: FinishReason, error?: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.disarm();
    try {
      this.o.onFinish({ reason, error, firstOutputMs: this.firstOutputAt === null ? null : this.firstOutputAt - this.t0, bytesOut: this.bytesOut });
    } catch {
      /* onFinish must not break the stream teardown */
    }
  }

  /** Abandon a primed-but-unused session (failover happened). Does not call onFinish. */
  discard(): void {
    this.finished = true;
    this.disarm();
    this.reader.cancel().catch(() => undefined);
  }

  toReadable(): ReadableStream<Uint8Array> {
    const pull = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
          try {
            for (;;) {
              if (this.pending.length) {
                const chunk = this.pending.length === 1 ? this.pending[0] : concat(this.pending);
                this.pending = [];
                if (this.firstOutputAt === null) this.firstOutputAt = Date.now();
                this.bytesOut += chunk.byteLength;
                controller.enqueue(chunk);
                return;
              }
              if (this.upstreamDone) {
                const p = this.o.processor;
                const err = p?.error();
                if (this.cutDone) this.finish("budget");
                else this.finish(err ? "upstream_error" : p && !p.completed() ? "truncated" : "completed", err ?? undefined);
                controller.close();
                return;
              }
              this.arm();
              const { done, value } = await this.reader.read();
              if (done) {
                this.upstreamDone = true;
                this.ingest(null);
                continue;
              }
              this.ingest(value);
            }
          } catch (err) {
            this.disarm();
            const reason = this.o.signal.reason;
            const cancelled = reason instanceof ClientAbortError || (this.o.signal.aborted && !(reason instanceof UpstreamTimeoutError));
            const timedOut = reason instanceof UpstreamTimeoutError || err instanceof UpstreamTimeoutError;
            if (cancelled && !timedOut) {
              this.finish("cancelled", err);
              try {
                controller.close();
              } catch {
                /* already closed */
              }
              return;
            }
            const ev = this.o.errorEvent?.(timedOut ? new UpstreamTimeoutError("idle") : err);
            if (ev) {
              try {
                controller.enqueue(enc.encode(ev));
              } catch {
                /* closed */
              }
            }
            this.finish(timedOut ? "timeout" : "upstream_error", err);
            try {
              controller.close();
            } catch {
              /* closed */
            }
          }
    };
    const cancel = (reason: unknown): void => {
      // client went away
      this.finish("cancelled", reason);
      this.o.abort(new ClientAbortError());
      this.reader.cancel().catch(() => undefined);
    };
    return new ReadableStream<Uint8Array>({ pull, cancel }, new CountQueuingStrategy({ highWaterMark: 4 }));
  }

  get primedError(): unknown {
    return this.primeError;
  }

  /** After prime(): upstream ended without producing any output. */
  isEmpty(): boolean {
    return this.pending.length === 0 && this.upstreamDone;
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
