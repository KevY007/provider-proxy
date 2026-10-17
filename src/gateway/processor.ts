import type { SseEvent } from "./sse";
import type { Usage } from "./types";

/**
 * A StreamProcessor sits between the upstream SSE stream and the client: it sees every parsed upstream event,
 * returns the serialized SSE text to forward (possibly translated / masked / none), and tracks usage + text so
 * the pipeline can meter the request. Implemented by the passthrough processors (stream-processors.ts) and the
 * protocol translators (translate/*).
 */
export interface StreamProcessor {
  /** Handle one upstream event; return zero or more serialized SSE blocks (each ending in a blank line). */
  onEvent(ev: SseEvent): string[];
  /** Upstream closed; return trailing blocks (e.g. translator finalisation). */
  onEnd(): string[];
  /** Usage reported by the upstream (null when it never sent any). */
  usage(): Usage | null;
  /** Accumulated assistant text (bounded) for the tokenizer fallback. */
  outputText(): string;
  /** True once the upstream signalled a natural end (done sentinel / terminal event). */
  completed(): boolean;
  /** Upstream error event seen in-band (used to fail over before the first byte is sent / to log mid-stream errors). */
  error(): { status: number; message: string; type?: string } | null;
  /** Response id created by this stream (Responses API stickiness). */
  responseId?(): string | null;
  /** Characters of assistant output accumulated so far (cheap; used by the funds guard to estimate accrued cost). */
  outputChars?(): number;
  /**
   * The stream is cut short by the gateway (funds exhausted): the blocks to send to the client instead of the
   * normal ending. `errorEvent` is the serialized native error event (already in the inbound format).
   */
  abortEvents?(errorEvent: string): string[];
  /** Identity scrubber for text the upstream wrote into an error event we forward (provider / host / key / upstream model). */
  setScrub?(fn: (text: string) => string): void;
}

/** Bounded text accumulator. */
export class TextAcc {
  private parts: string[] = [];
  private len = 0;
  constructor(private readonly max = 2_000_000) {}
  add(s: string): void {
    if (!s || this.len >= this.max) return;
    this.parts.push(s);
    this.len += s.length;
  }
  toString(): string {
    return this.parts.join("");
  }
  get length(): number {
    return this.len;
  }
}
