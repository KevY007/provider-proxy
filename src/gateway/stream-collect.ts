import type { SseEvent } from "./sse";
import type { InboundFormat, JsonObject } from "./types";
import { isObject } from "./util";

/**
 * Assembles an upstream SSE stream back into the provider's own non-streaming JSON document (provider option
 * `streamUpstream`): a non-streaming request is sent upstream with `stream: true` - so a relay behind a proxy with a
 * read timeout (e.g. Cloudflare's 120 s) never sees a long silent request, and any failure before the end can be retried
 * invisibly, because the client has not received anything yet - and the result is handed to the normal JSON pipeline.
 * Supported: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages.
 */
export type CollectResult = { ok: true; json: JsonObject } | { ok: false; status: number; message: string };

export function canCollect(format: InboundFormat, op: string): boolean {
  return (format === "openai_chat" && op === "chat") || (format === "openai_responses" && op === "responses") || (format === "anthropic_messages" && op === "messages");
}

export class SseCollector {
  private err: { status: number; message: string } | null = null;
  private done = false;
  // chat
  private base: JsonObject = {};
  private choices = new Map<number, { role: string; content: string; refusal: string; reasoning: string; tools: Map<number, JsonObject>; finish: string | null }>();
  private usage: JsonObject | null = null;
  // responses
  private final: JsonObject | null = null;
  // anthropic
  private msg: JsonObject | null = null;
  private blocks: JsonObject[] = [];

  constructor(private readonly format: InboundFormat) {}

  push(ev: SseEvent): void {
    if (ev.comment || this.err) return;
    const data = ev.data?.trim() ?? "";
    if (!data) return;
    if (data === "[DONE]") {
      this.done = true;
      return;
    }
    let j: unknown;
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObject(j)) return;
    const type = typeof j.type === "string" ? j.type : (ev.event ?? "");
    if (isObject(j.error) || type === "error") {
      this.err = errorOf(isObject(j.error) ? j.error : j);
      return;
    }
    if (this.format === "openai_chat") this.chat(j);
    else if (this.format === "openai_responses") this.responses(type, j);
    else if (this.format === "anthropic_messages") this.anthropic(type, j);
  }

  result(): CollectResult {
    if (this.err) return { ok: false, ...this.err };
    if (this.format === "openai_chat") {
      const choices = [...this.choices.entries()].sort((a, b) => a[0] - b[0]);
      if (!choices.length || choices.some(([, c]) => !c.finish)) return { ok: false, status: 502, message: "upstream stream ended before the response was complete" };
      return {
        ok: true,
        json: {
          id: this.base.id ?? null,
          object: "chat.completion",
          created: this.base.created ?? Math.floor(Date.now() / 1000),
          model: this.base.model ?? null,
          ...(this.base.system_fingerprint !== undefined ? { system_fingerprint: this.base.system_fingerprint } : {}),
          ...(this.base.service_tier !== undefined ? { service_tier: this.base.service_tier } : {}),
          choices: choices.map(([index, c]) => {
            const tools = [...c.tools.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
            const message: JsonObject = { role: c.role || "assistant", content: c.content || (tools.length ? null : "") };
            if (c.refusal) message.refusal = c.refusal;
            if (c.reasoning) message.reasoning_content = c.reasoning;
            if (tools.length) message.tool_calls = tools;
            return { index, message, finish_reason: c.finish, logprobs: null };
          }),
          ...(this.usage ? { usage: this.usage } : {}),
        },
      };
    }
    if (this.format === "openai_responses") {
      if (!this.final) return { ok: false, status: 502, message: "upstream stream ended before response.completed" };
      return { ok: true, json: this.final };
    }
    if (!this.msg || !this.done) return { ok: false, status: 502, message: "upstream stream ended before message_stop" };
    return { ok: true, json: { ...this.msg, content: this.blocks.filter(Boolean) } };
  }

  private chat(j: JsonObject): void {
    for (const k of ["id", "created", "model", "system_fingerprint", "service_tier"]) if (j[k] !== undefined && j[k] !== null) this.base[k] = j[k];
    if (isObject(j.usage)) this.usage = j.usage;
    for (const c of Array.isArray(j.choices) ? j.choices : []) {
      if (!isObject(c)) continue;
      const index = typeof c.index === "number" ? c.index : 0;
      let acc = this.choices.get(index);
      if (!acc) {
        acc = { role: "", content: "", refusal: "", reasoning: "", tools: new Map(), finish: null };
        this.choices.set(index, acc);
      }
      const d = isObject(c.delta) ? c.delta : {};
      if (typeof d.role === "string") acc.role = d.role;
      if (typeof d.content === "string") acc.content += d.content;
      if (typeof d.refusal === "string") acc.refusal += d.refusal;
      if (typeof d.reasoning_content === "string") acc.reasoning += d.reasoning_content;
      else if (typeof d.reasoning === "string") acc.reasoning += d.reasoning;
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        if (!isObject(tc)) continue;
        const ti = typeof tc.index === "number" ? tc.index : acc.tools.size;
        let t = acc.tools.get(ti);
        if (!t) {
          t = { id: null, type: "function", function: { name: "", arguments: "" } };
          acc.tools.set(ti, t);
        }
        if (typeof tc.id === "string") t.id = tc.id;
        if (typeof tc.type === "string") t.type = tc.type;
        const f = isObject(tc.function) ? tc.function : null;
        const tf = t.function as JsonObject;
        if (f && typeof f.name === "string") tf.name = String(tf.name) + f.name;
        if (f && typeof f.arguments === "string") tf.arguments = String(tf.arguments) + f.arguments;
      }
      if (typeof c.finish_reason === "string") acc.finish = c.finish_reason;
    }
  }

  private responses(type: string, j: JsonObject): void {
    if ((type === "response.completed" || type === "response.incomplete") && isObject(j.response)) {
      this.final = j.response;
      this.done = true;
    } else if (type === "response.failed") {
      const e = isObject(j.response) && isObject(j.response.error) ? j.response.error : {};
      this.err = errorOf(e);
    }
  }

  private anthropic(type: string, j: JsonObject): void {
    switch (type) {
      case "message_start":
        if (isObject(j.message)) this.msg = { ...j.message, content: [] };
        break;
      case "content_block_start": {
        const i = typeof j.index === "number" ? j.index : this.blocks.length;
        const b: JsonObject = isObject(j.content_block) ? { ...j.content_block } : { type: "text", text: "" };
        if (b.type === "tool_use" || b.type === "server_tool_use") b.__json = "";
        this.blocks[i] = b;
        break;
      }
      case "content_block_delta": {
        const b = typeof j.index === "number" ? this.blocks[j.index] : undefined;
        const d = isObject(j.delta) ? j.delta : null;
        if (!b || !d) break;
        if (d.type === "text_delta" && typeof d.text === "string") b.text = String(b.text ?? "") + d.text;
        else if (d.type === "input_json_delta" && typeof d.partial_json === "string") b.__json = String(b.__json ?? "") + d.partial_json;
        else if (d.type === "thinking_delta" && typeof d.thinking === "string") b.thinking = String(b.thinking ?? "") + d.thinking;
        else if (d.type === "signature_delta" && typeof d.signature === "string") b.signature = d.signature;
        else if (d.type === "citations_delta" && d.citation !== undefined) b.citations = [...(Array.isArray(b.citations) ? b.citations : []), d.citation];
        break;
      }
      case "content_block_stop": {
        const b = typeof j.index === "number" ? this.blocks[j.index] : undefined;
        if (b && typeof b.__json === "string") {
          try {
            b.input = b.__json ? JSON.parse(b.__json) : {};
          } catch {
            b.input = {};
          }
          delete b.__json;
        }
        break;
      }
      case "message_delta":
        if (this.msg) {
          const d = isObject(j.delta) ? j.delta : {};
          if (d.stop_reason !== undefined) this.msg.stop_reason = d.stop_reason;
          if (d.stop_sequence !== undefined) this.msg.stop_sequence = d.stop_sequence;
          if (isObject(j.usage)) this.msg.usage = { ...(isObject(this.msg.usage) ? this.msg.usage : {}), ...j.usage };
        }
        break;
      case "message_stop":
        this.done = true;
        break;
      default:
    }
  }
}

function errorOf(e: JsonObject): { status: number; message: string } {
  const message = typeof e.message === "string" ? e.message : typeof e.type === "string" ? e.type : "upstream error";
  const code = Number(e.code ?? e.status);
  const type = typeof e.type === "string" ? e.type : "";
  const status =
    code >= 400 && code < 600
      ? code
      : type === "overloaded_error"
        ? 529
        : type === "rate_limit_error" || type === "rate_limit_exceeded"
          ? 429
          : /unavailable/i.test(message)
            ? 503
            : 502;
  return { status, message };
}
