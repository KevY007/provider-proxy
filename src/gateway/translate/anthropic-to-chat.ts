import { GatewayError } from "../errors";
import { TextAcc, type StreamProcessor } from "../processor";
import { sseEvent, type SseEvent } from "../sse";
import type { Json, JsonObject, Usage } from "../types";
import { emptyUsage } from "../types";
import { mergeUsage, usageFromOpenAI } from "../usage";
import { isObject, safeJsonParse } from "../util";

/**
 * Inbound Anthropic Messages  ->  upstream OpenAI chat/completions (or Google's OpenAI-compatible endpoint).
 *   messagesRequestToChat   : request body
 *   chatResponseToMessages  : non-stream response
 *   ChatToAnthropicStream   : SSE translation (OpenAI chunks -> Anthropic events)
 */

export interface ToChatOptions {
  upstreamModel: string;
  /** "max_tokens" (default, widely compatible) or "max_completion_tokens" (OpenAI/Azure reasoning models). */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
}

function blockText(content: Json): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b === "string" ? b : isObject(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

function imagePart(b: JsonObject): JsonObject | null {
  const s = b.source;
  if (!isObject(s)) return null;
  if (s.type === "base64" && typeof s.data === "string") {
    return { type: "image_url", image_url: { url: `data:${s.media_type ?? "image/png"};base64,${s.data}` } };
  }
  if (s.type === "url" && typeof s.url === "string") return { type: "image_url", image_url: { url: s.url } };
  return null;
}

function toolResultText(b: JsonObject): string {
  const c = b.content;
  let text = typeof c === "string" ? c : Array.isArray(c) ? blockText(c) : c === undefined || c === null ? "" : JSON.stringify(c);
  if (b.is_error === true) text = text ? `Error: ${text}` : "Error";
  return text;
}

/** Anthropic /v1/messages request -> OpenAI chat/completions request. */
export function messagesRequestToChat(body: JsonObject, opts: ToChatOptions): JsonObject {
  if (!Array.isArray(body.messages)) throw new GatewayError("invalid_request", "'messages' is required.", { param: "messages" });
  const messages: JsonObject[] = [];

  const sys = body.system;
  const sysText = typeof sys === "string" ? sys : Array.isArray(sys) ? blockText(sys) : "";
  if (sysText) messages.push({ role: "system", content: sysText });

  for (const m of body.messages) {
    if (!isObject(m)) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = m.content;
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === "assistant") {
      let text = "";
      const toolCalls: JsonObject[] = [];
      for (const b of content) {
        if (!isObject(b)) continue;
        if (b.type === "text" && typeof b.text === "string") text += (text ? "\n" : "") + b.text;
        else if (b.type === "tool_use") {
          toolCalls.push({ id: String(b.id), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } });
        }
        // thinking / redacted_thinking blocks are not replayable on other providers: dropped
      }
      const msg: JsonObject = { role: "assistant", content: text || (toolCalls.length ? null : "") };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (msg.content !== "" || toolCalls.length) messages.push(msg);
      continue;
    }

    // user turn: tool_result blocks become role:"tool" messages (first), the rest stays a user message
    const parts: JsonObject[] = [];
    const toolMsgs: JsonObject[] = [];
    for (const b of content) {
      if (!isObject(b)) continue;
      if (b.type === "tool_result") {
        toolMsgs.push({ role: "tool", tool_call_id: String(b.tool_use_id ?? ""), content: toolResultText(b) });
      } else if (b.type === "text" && typeof b.text === "string") {
        parts.push({ type: "text", text: b.text });
      } else if (b.type === "image") {
        const p = imagePart(b);
        if (p) parts.push(p);
      } else if (b.type === "document") {
        const s = b.source;
        if (isObject(s) && s.type === "base64" && typeof s.data === "string") {
          parts.push({ type: "file", file: { filename: String(b.title ?? "document.pdf"), file_data: `data:${s.media_type ?? "application/pdf"};base64,${s.data}` } });
        } else if (isObject(s) && s.type === "text" && typeof s.data === "string") {
          parts.push({ type: "text", text: s.data });
        }
      }
    }
    messages.push(...toolMsgs);
    if (parts.length) {
      const onlyText = parts.every((p) => p.type === "text");
      messages.push({ role: "user", content: onlyText ? parts.map((p) => p.text).join("\n") : parts });
    }
  }

  const req: JsonObject = { model: opts.upstreamModel, messages };
  if (typeof body.max_tokens === "number") req[opts.maxTokensParam ?? "max_tokens"] = Math.trunc(body.max_tokens);
  if (typeof body.temperature === "number") req.temperature = body.temperature;
  if (typeof body.top_p === "number") req.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) req.stop = body.stop_sequences.slice(0, 4);
  if (isObject(body.metadata) && typeof body.metadata.user_id === "string") req.user = body.metadata.user_id;
  if (body.stream === true) {
    req.stream = true;
    req.stream_options = { include_usage: true };
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    const tools: JsonObject[] = [];
    for (const t of body.tools) {
      if (!isObject(t) || typeof t.name !== "string") continue;
      if (t.type && t.type !== "custom" && t.type !== "function") continue; // server tools (web_search, computer...) have no OpenAI equivalent
      const fn: JsonObject = { name: t.name, parameters: isObject(t.input_schema) ? t.input_schema : { type: "object", properties: {} } };
      if (t.description) fn.description = String(t.description);
      tools.push({ type: "function", function: fn });
    }
    if (tools.length) req.tools = tools;
  }
  const tc = body.tool_choice;
  if (req.tools && isObject(tc)) {
    if (tc.type === "auto") req.tool_choice = "auto";
    else if (tc.type === "any") req.tool_choice = "required";
    else if (tc.type === "none") req.tool_choice = "none";
    else if (tc.type === "tool") req.tool_choice = { type: "function", function: { name: String(tc.name) } };
    if (tc.disable_parallel_tool_use === true) req.parallel_tool_calls = false;
  }
  return req;
}

const FINISH_TO_STOP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "refusal",
};

export function finishToStopReason(reason: unknown): string {
  return typeof reason === "string" ? (FINISH_TO_STOP[reason] ?? "end_turn") : "end_turn";
}

/** Normalised usage -> Anthropic usage object (input_tokens excludes cache reads/writes). */
export function anthropicUsageFromNormalized(u: Usage): JsonObject {
  const out: JsonObject = {
    input_tokens: Math.max(0, u.inputTokens - u.cachedTokens - u.cacheWriteTokens),
    output_tokens: u.outputTokens,
  };
  out.cache_creation_input_tokens = u.cacheWriteTokens;
  out.cache_read_input_tokens = u.cachedTokens;
  return out;
}

/** OpenAI chat.completion -> Anthropic message. */
export function chatResponseToMessages(chat: JsonObject, publicModel: string): { body: JsonObject; usage: Usage } {
  const choice = Array.isArray(chat.choices) && isObject(chat.choices[0]) ? chat.choices[0] : {};
  const msg = isObject(choice.message) ? choice.message : {};
  const content: JsonObject[] = [];
  const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? blockText(msg.content) : "";
  if (text) content.push({ type: "text", text });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (!isObject(tc) || !isObject(tc.function)) continue;
      const input = safeJsonParse<Json>(String(tc.function.arguments || "{}"));
      content.push({ type: "tool_use", id: String(tc.id), name: String(tc.function.name), input: isObject(input) ? input : {} });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const usage = usageFromOpenAI(chat.usage);
  const idRaw = String(chat.id ?? "");
  return {
    usage,
    body: {
      id: `msg_${idRaw.replace(/^chatcmpl-/, "") || Math.random().toString(36).slice(2)}`,
      type: "message",
      role: "assistant",
      model: publicModel,
      content,
      stop_reason: finishToStopReason(choice.finish_reason),
      stop_sequence: null,
      usage: anthropicUsageFromNormalized(usage),
    },
  };
}

/** OpenAI chat.completion.chunk SSE -> Anthropic Messages SSE events. */
export class ChatToAnthropicStream implements StreamProcessor {
  private id = `msg_${Math.random().toString(36).slice(2, 14)}`;
  private started = false;
  private nextIndex = 0;
  private open: { index: number; kind: "text" | "tool" } | null = null;
  private tools = new Map<number, number>(); // openai tool index -> anthropic block index
  private finish: string | null = null;
  private _usage: Usage = emptyUsage();
  private sawUsage = false;
  private text = new TextAcc();
  private done = false;
  private closed = false;
  private err: { status: number; message: string; type?: string } | null = null;

  constructor(private readonly publicModel: string) {}

  private start(out: string[]): void {
    if (this.started) return;
    this.started = true;
    out.push(
      sseEvent(
        {
          type: "message_start",
          message: {
            id: this.id,
            type: "message",
            role: "assistant",
            model: this.publicModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 1 },
          },
        },
        "message_start",
      ),
    );
    out.push(sseEvent({ type: "ping" }, "ping"));
  }

  private closeBlock(out: string[]): void {
    if (!this.open) return;
    out.push(sseEvent({ type: "content_block_stop", index: this.open.index }, "content_block_stop"));
    this.open = null;
  }

  private openText(out: string[]): void {
    if (this.open?.kind === "text") return;
    this.closeBlock(out);
    const index = this.nextIndex++;
    this.open = { index, kind: "text" };
    out.push(sseEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, "content_block_start"));
  }

  onEvent(ev: SseEvent): string[] {
    if (ev.comment || !ev.data) return [];
    if (ev.data.trim() === "[DONE]") return this.finalize();
    const d = safeJsonParse<Json>(ev.data);
    if (!isObject(d)) return [];
    if (isObject(d.error)) {
      this.err = { status: Number(d.error.code) >= 400 ? Number(d.error.code) : 502, message: String(d.error.message ?? "upstream error"), type: String(d.error.type ?? "") };
      return [];
    }
    const out: string[] = [];
    if (typeof d.id === "string" && !this.started) this.id = `msg_${d.id.replace(/^chatcmpl-/, "")}`;
    if (isObject(d.usage)) {
      this._usage = mergeUsage(this._usage, usageFromOpenAI(d.usage));
      this.sawUsage = true;
    }
    const choice = Array.isArray(d.choices) && isObject(d.choices[0]) ? d.choices[0] : null;
    if (!choice) return out;
    this.start(out);
    const delta = isObject(choice.delta) ? choice.delta : {};

    if (typeof delta.content === "string" && delta.content) {
      this.openText(out);
      this.text.add(delta.content);
      out.push(sseEvent({ type: "content_block_delta", index: this.open!.index, delta: { type: "text_delta", text: delta.content } }, "content_block_delta"));
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!isObject(tc)) continue;
        const oi = typeof tc.index === "number" ? tc.index : 0;
        const fn = isObject(tc.function) ? tc.function : {};
        let bi = this.tools.get(oi);
        if (bi === undefined) {
          this.closeBlock(out);
          bi = this.nextIndex++;
          this.tools.set(oi, bi);
          this.open = { index: bi, kind: "tool" };
          out.push(
            sseEvent(
              { type: "content_block_start", index: bi, content_block: { type: "tool_use", id: String(tc.id ?? `toolu_${bi}`), name: String(fn.name ?? ""), input: {} } },
              "content_block_start",
            ),
          );
        }
        if (typeof fn.arguments === "string" && fn.arguments) {
          this.text.add(fn.arguments);
          out.push(sseEvent({ type: "content_block_delta", index: bi, delta: { type: "input_json_delta", partial_json: fn.arguments } }, "content_block_delta"));
        }
      }
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      this.finish = finishToStopReason(choice.finish_reason);
      this.closeBlock(out);
    }
    return out;
  }

  private finalize(): string[] {
    if (this.closed) return [];
    this.closed = true;
    const out: string[] = [];
    this.start(out);
    this.closeBlock(out);
    const usage = this.sawUsage ? this._usage : null;
    const u = usage ? anthropicUsageFromNormalized(usage) : { input_tokens: 0, output_tokens: Math.max(1, Math.ceil(this.text.length / 3.6)) };
    out.push(sseEvent({ type: "message_delta", delta: { stop_reason: this.finish ?? "end_turn", stop_sequence: null }, usage: u }, "message_delta"));
    out.push(sseEvent({ type: "message_stop" }, "message_stop"));
    this.done = true;
    return out;
  }

  onEnd(): string[] {
    // upstream closed without [DONE]: still terminate the Anthropic stream cleanly if it had started
    return this.started && !this.closed && !this.err ? this.finalize() : [];
  }
  usage(): Usage | null {
    return this.sawUsage ? this._usage : null;
  }
  outputText(): string {
    return this.text.toString();
  }
  completed(): boolean {
    return this.done;
  }
  error() {
    return this.err;
  }
}
