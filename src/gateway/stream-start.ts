import type { SseEvent } from "./sse";
import type { InboundFormat } from "./types";
import { isObject } from "./util";

/**
 * When does a stream really START? Upstreams open with bookkeeping events that carry no output: an OpenAI chat chunk
 * with only `role: "assistant"` (and empty content), the Responses API's `response.created` / `in_progress` /
 * `output_item.added`, Anthropic's `message_start` / `ping` / `content_block_start`. Some relays fail AFTER sending
 * them but before any output ("Service Unavailable" seconds later). Treating these events as a preamble lets the
 * pipeline hold the response back until real output (text, tool calls, reasoning, a usage-bearing end) arrives, so
 * such a failure is retried invisibly instead of reaching the client.
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
      return RESPONSES_PREAMBLE.has(type);
    }
    case "anthropic_messages": {
      const type = typeof j.type === "string" ? j.type : ev.event ?? "";
      return ANTHROPIC_PREAMBLE.has(type);
    }
    default:
      return false;
  }
}

const RESPONSES_PREAMBLE = new Set(["response.created", "response.in_progress", "response.queued", "response.output_item.added", "response.content_part.added"]);
const ANTHROPIC_PREAMBLE = new Set(["message_start", "ping", "content_block_start"]);

function chatChunkIsPreamble(j: Record<string, unknown>): boolean {
  if (isObject(j.usage)) return false;
  const choices = Array.isArray(j.choices) ? j.choices : [];
  for (const c of choices) {
    if (!isObject(c)) continue;
    if (c.finish_reason) return false;
    const d = isObject(c.delta) ? c.delta : {};
    for (const [k, v] of Object.entries(d)) {
      if (k === "role") continue;
      if (v === null || v === undefined || v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      return false; // content / tool_calls / refusal / reasoning text: real output
    }
  }
  return true;
}
