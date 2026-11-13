import type { SseEvent } from "./sse";
import type { InboundFormat } from "./types";
import { isObject } from "./util";

/**
 * When does a stream really START? Upstreams open with bookkeeping events that carry no output: an OpenAI chat chunk
 * with only `role: "assistant"` (and empty content), the Responses API's `response.created` / `in_progress` /
 * `output_item.added`, Anthropic's `message_start` / `ping` / `content_block_start`. Some relays fail AFTER sending
 * them but before any output ("Service Unavailable" seconds later). Treating these events as a preamble lets the
 * pipeline hold the response back until real output (answer text, tool calls, a usage-bearing end) arrives, so such a
 * failure is retried invisibly instead of reaching the client. Reasoning counts as preamble too: a thinking model sends
 * reasoning items / summaries every few seconds for minutes before the answer (measured on a reseller: an Astra xhigh
 * request thought for 8+ minutes and failed in that phase), and they are buffered and released with the answer (or when
 * the hold window ends), so a retry never duplicates anything the client saw.
 *
 * So does commentary: a Responses model that was given tools opens with a message item of `phase: "commentary"` (one
 * sentence about what it is going to do) and only then reasons, for minutes, towards the answer or the tool call.
 * Measured on a reseller: such a stream committed on that sentence after ~11 s and then died in the reasoning phase, so
 * every failure reached the client (15 of 17 calls). Its text deltas do not say which item they belong to in a way a
 * single event shows, so the caller keeps a `PreambleState` per stream; without one any text delta is output.
 */
export interface PreambleState {
  /** ids of the Responses message items announced with `phase: "commentary"` */
  commentary: Set<string>;
}

export function newPreambleState(): PreambleState {
  return { commentary: new Set() };
}

export function isPreambleEvent(format: InboundFormat, ev: SseEvent, state?: PreambleState): boolean {
  if (ev.comment) return true;
  const data = ev.data?.trim() ?? "";
  if (!data || data === "[DONE]") return false;
  let j: unknown;
  try {
    j = JSON.parse(data);
  } catch {
    return false;
  }
  if (!isObject(j)) return false;
  if (j.error !== undefined) return false;
  switch (format) {
    case "openai_chat":
      return chatChunkIsPreamble(j);
    case "openai_responses": {
      const type = typeof j.type === "string" ? j.type : ev.event ?? "";
      if (state) {
        if (type === "response.output_item.added" && isObject(j.item) && j.item.type === "message" && j.item.phase === "commentary" && typeof j.item.id === "string") state.commentary.add(j.item.id);
        // the parts and text of a commentary message: not the answer yet
        if (typeof j.item_id === "string" && state.commentary.has(j.item_id)) return true;
      }
      return !responsesEventIsOutput(type, j);
    }
    case "anthropic_messages": {
      const type = typeof j.type === "string" ? j.type : ev.event ?? "";
      if (ANTHROPIC_PREAMBLE.has(type)) return true;
      if (type === "content_block_delta" && isObject(j.delta)) return j.delta.type === "thinking_delta" || j.delta.type === "signature_delta";
      // a block closing carries no output itself (a text block's deltas have committed the stream already)
      return type === "content_block_stop";
    }
    default:
      return false;
  }
}

/**
 * Responses API: only content counts as output - text / refusal / tool-argument / audio deltas with something in them,
 * a non-message, non-reasoning output item (a tool call starting), partial images, and the terminal events.
 * Everything else holds: lifecycle events, reasoning items and summaries, and vendor events a relay adds (one sends
 * `codex.rate_limits`, `response.metadata` and a blank " " text delta before failing - all of that must not commit).
 */
function responsesEventIsOutput(type: string, j: Record<string, unknown>): boolean {
  if (type === "response.completed" || type === "response.incomplete") return true;
  if (type.startsWith("response.reasoning")) return false;
  if (type === "response.output_item.added" || type === "response.output_item.done") return isObject(j.item) && j.item.type !== "reasoning" && j.item.type !== "message";
  if (type.includes("partial_image")) return true;
  if (type.endsWith(".delta")) {
    const d = j.delta;
    if (typeof d === "string") return d.trim() !== "";
    return d !== null && d !== undefined;
  }
  return false;
}
const ANTHROPIC_PREAMBLE = new Set(["message_start", "ping", "content_block_start"]);

function chatChunkIsPreamble(j: Record<string, unknown>): boolean {
  if (isObject(j.usage)) return false;
  const choices = Array.isArray(j.choices) ? j.choices : [];
  for (const c of choices) {
    if (!isObject(c)) continue;
    if (c.finish_reason) return false;
    const d = isObject(c.delta) ? c.delta : {};
    for (const [k, v] of Object.entries(d)) {
      // role, and reasoning summaries / text (reasoning_content, reasoning): not the answer yet
      if (k === "role" || k === "reasoning_content" || k === "reasoning" || k === "reasoning_details") continue;
      if (v === null || v === undefined || v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      return false; // content / tool_calls / refusal / reasoning text: real output
    }
  }
  return true;
}

/**
 * The start hold for one request, in seconds: the gateway setting, or the shorter one its API key asks for
 * (`ApiKey.streamHoldSec`). 0 = no hold: the response starts with the first upstream event and every event is sent as
 * it arrives, the way the model makers' own APIs stream; a failure then reaches the client as it happens instead of
 * being retried behind a held response.
 */
export function streamHoldSecFor(settingSec: number, keySec: number | null | undefined): number {
  const setting = Math.max(0, settingSec);
  return typeof keySec === "number" && keySec >= 0 ? Math.min(setting, keySec) : setting;
}

/**
 * How long a stream attempt may still be held before it is committed. The hold window counts from the moment the
 * request arrived, NOT per attempt: a retry late in the window must not restart it, or the client would wait
 * attempts x window for its first byte (HTTP clients give up on headers after a fixed time, e.g. Node's 300 s).
 * Never below one heartbeat interval (the minimum a committed stream needs before its first keep-alive anyway).
 */
export function holdCommitAfterMs(heartbeatMs: number, holdSec: number, requestStartedAt: number, now: number = Date.now()): number {
  return Math.max(heartbeatMs, holdSec * 1000 - (now - requestStartedAt));
}
