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
 */
export function isPreambleEvent(format: InboundFormat, ev: SseEvent): boolean {
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
      if (RESPONSES_PREAMBLE.has(type) || type.startsWith("response.reasoning")) return true;
      // reasoning output items (added / done) carry no answer text
      if (type === "response.output_item.added") return !isObject(j.item) || j.item.type === "reasoning" || j.item.type === "message";
      if (type === "response.output_item.done") return isObject(j.item) && j.item.type === "reasoning";
      return false;
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

const RESPONSES_PREAMBLE = new Set(["response.created", "response.in_progress", "response.queued", "response.content_part.added", "response.metadata"]);
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
 * How long a stream attempt may still be held before it is committed. The hold window counts from the moment the
 * request arrived, NOT per attempt: a retry late in the window must not restart it, or the client would wait
 * attempts x window for its first byte (HTTP clients give up on headers after a fixed time, e.g. Node's 300 s).
 * Never below one heartbeat interval (the minimum a committed stream needs before its first keep-alive anyway).
 */
export function holdCommitAfterMs(heartbeatMs: number, holdSec: number, requestStartedAt: number, now: number = Date.now()): number {
  return Math.max(heartbeatMs, holdSec * 1000 - (now - requestStartedAt));
}
