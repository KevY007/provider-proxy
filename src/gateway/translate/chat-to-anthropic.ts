import { GatewayError } from "../errors";
import { TextAcc, type StreamProcessor } from "../processor";
import { sseEvent, SSE_DONE, type SseEvent } from "../sse";
import type { Json, JsonObject, Usage } from "../types";
import { emptyUsage } from "../types";
import { mergeUsage, usageFromAnthropic } from "../usage";
import { isObject, safeJsonParse } from "../util";

/**
 * Inbound OpenAI chat/completions  ->  upstream Anthropic Messages.
 *   chatRequestToMessages   : request body
 *   messagesResponseToChat  : non-stream response
 *   AnthropicToChatStream   : SSE event translation (Anthropic events -> OpenAI chunks)
 */

export function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(url);
  if (!m) return null;
  if (!m[2]) return { mediaType: m[1], data: Buffer.from(decodeURIComponent(m[3]), "utf8").toString("base64") };
  return { mediaType: m[1], data: m[3] };
}

function textFromContent(content: Json): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : isObject(p) && (p.type === "text" || p.type === undefined) && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function withCache(block: JsonObject, part: Json): JsonObject {
  if (isObject(part) && isObject(part.cache_control)) block.cache_control = part.cache_control;
  return block;
}

function imageBlock(url: string): JsonObject {
  const parsed = parseDataUrl(url);
  if (parsed) return { type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } };
  return { type: "image", source: { type: "url", url } };
}

function userBlocks(content: Json): JsonObject[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: JsonObject[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) out.push({ type: "text", text: part });
      continue;
    }
    if (!isObject(part)) continue;
    switch (part.type) {
      case "text":
      case "input_text":
        if (typeof part.text === "string" && part.text) out.push(withCache({ type: "text", text: part.text }, part));
        break;
      case "image_url":
      case "input_image": {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        if (typeof url === "string" && url) out.push(withCache(imageBlock(url), part));
        break;
      }
      case "file": {
        const data = part.file?.file_data;
        const parsed = typeof data === "string" ? parseDataUrl(data) : null;
        if (parsed) out.push(withCache({ type: "document", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } }, part));
        else throw new GatewayError("invalid_request", "File inputs must be inline base64 data URLs for this model.");
        break;
      }
      case "input_audio":
        throw new GatewayError("invalid_request", "Audio input is not supported for this model.");
      default:
        break;
    }
  }
  return out;
}

function assistantBlocks(m: JsonObject): JsonObject[] {
  const out: JsonObject[] = [];
  const text = textFromContent(m.content);
  if (text) out.push({ type: "text", text });
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      if (!isObject(tc) || !isObject(tc.function)) continue;
      const args = typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {});
      const input = safeJsonParse<Json>(args || "{}");
      out.push({ type: "tool_use", id: String(tc.id ?? `toolu_${out.length}`), name: String(tc.function.name ?? ""), input: isObject(input) ? input : {} });
    }
  } else if (isObject(m.function_call)) {
    const input = safeJsonParse<Json>(String(m.function_call.arguments ?? "{}"));
    out.push({ type: "tool_use", id: `toolu_fc_${out.length}`, name: String(m.function_call.name ?? ""), input: isObject(input) ? input : {} });
  }
  return out;
}

function toolResultContent(content: Json): string | JsonObject[] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const blocks = userBlocks(content).filter((b) => b.type === "text" || b.type === "image");
    if (blocks.length) return blocks;
  }
  return content === null || content === undefined ? "" : JSON.stringify(content);
}

const REASONING_BUDGET: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };

export interface ToMessagesOptions {
  upstreamModel: string;
  /** Anthropic requires max_tokens: used when the client sent none. */
  defaultMaxTokens: number;
}

/** OpenAI chat/completions request -> Anthropic /v1/messages request. */
export function chatRequestToMessages(body: JsonObject, opts: ToMessagesOptions): JsonObject {
  if (typeof body.n === "number" && body.n > 1) throw new GatewayError("invalid_request", "n > 1 is not supported for this model.", { param: "n" });
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages) throw new GatewayError("invalid_request", "'messages' is required.", { param: "messages" });

  const systemParts: string[] = [];
  const systemBlocks: JsonObject[] = [];
  let systemHasCache = false;
  const out: Array<{ role: "user" | "assistant"; content: JsonObject[] }> = [];
  const push = (role: "user" | "assistant", blocks: JsonObject[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };

  for (const m of messages) {
    if (!isObject(m)) continue;
    switch (m.role) {
      case "system":
      case "developer": {
        const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: textFromContent(m.content) }];
        for (const p of parts) {
          const t = typeof p === "string" ? p : isObject(p) && typeof p.text === "string" ? p.text : "";
          if (!t) continue;
          systemParts.push(t);
          const b = withCache({ type: "text", text: t }, p);
          if (b.cache_control) systemHasCache = true;
          systemBlocks.push(b);
        }
        break;
      }
      case "user":
        push("user", userBlocks(m.content));
        break;
      case "assistant":
        push("assistant", assistantBlocks(m));
        break;
      case "tool":
        push("user", [{ type: "tool_result", tool_use_id: String(m.tool_call_id ?? ""), content: toolResultContent(m.content) }]);
        break;
      case "function":
        push("user", [{ type: "tool_result", tool_use_id: String(m.name ?? ""), content: toolResultContent(m.content) }]);
        break;
      default:
        break;
    }
  }
  // tool_result blocks must lead their user turn
  for (const msg of out) {
    if (msg.role !== "user") continue;
    const results = msg.content.filter((b) => b.type === "tool_result");
    if (results.length && results.length < msg.content.length) {
      msg.content = [...results, ...msg.content.filter((b) => b.type !== "tool_result")];
    }
  }
  if (!out.length) throw new GatewayError("invalid_request", "At least one user message is required.", { param: "messages" });

  const rf = isObject(body.response_format) ? body.response_format : null;
  if (rf?.type === "json_object") systemParts.push("Respond with a single valid JSON object and nothing else.");
  else if (rf?.type === "json_schema" && isObject(rf.json_schema)) {
    systemParts.push(`Respond with JSON only, conforming to this JSON schema: ${JSON.stringify(rf.json_schema.schema ?? rf.json_schema)}`);
  }

  const req: JsonObject = { model: opts.upstreamModel, messages: out };
  if (systemHasCache && !rf) req.system = systemBlocks;
  else if (systemParts.length) req.system = systemParts.join("\n\n");

  const maxTokens = Number(body.max_completion_tokens ?? body.max_tokens);
  req.max_tokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.trunc(maxTokens) : opts.defaultMaxTokens;

  if (typeof body.temperature === "number") req.temperature = Math.min(1, Math.max(0, body.temperature));
  if (typeof body.top_p === "number") req.top_p = body.top_p;
  if (body.stop !== undefined && body.stop !== null) {
    const stops = (Array.isArray(body.stop) ? body.stop : [body.stop]).filter((s: unknown) => typeof s === "string" && s.length > 0);
    if (stops.length) req.stop_sequences = stops;
  }
  if (typeof body.user === "string" && body.user) req.metadata = { user_id: body.user };
  if (body.stream === true) req.stream = true;

  if (Array.isArray(body.tools) && body.tools.length) {
    const tools: JsonObject[] = [];
    for (const t of body.tools) {
      if (!isObject(t) || t.type !== "function" || !isObject(t.function)) continue;
      const tool: JsonObject = {
        name: String(t.function.name),
        input_schema: isObject(t.function.parameters) ? t.function.parameters : { type: "object", properties: {} },
      };
      if (t.function.description) tool.description = String(t.function.description);
      withCache(tool, t);
      tools.push(tool);
    }
    if (tools.length) req.tools = tools;
  }
  const tc = body.tool_choice;
  if (req.tools && tc !== undefined && tc !== null) {
    if (tc === "auto") req.tool_choice = { type: "auto" };
    else if (tc === "required") req.tool_choice = { type: "any" };
    else if (tc === "none") req.tool_choice = { type: "none" };
    else if (isObject(tc) && tc.type === "function" && isObject(tc.function)) req.tool_choice = { type: "tool", name: String(tc.function.name) };
  }
  if (req.tools && body.parallel_tool_calls === false) {
    req.tool_choice = { ...(isObject(req.tool_choice) ? req.tool_choice : { type: "auto" }), disable_parallel_tool_use: true };
  }

  const effort = typeof body.reasoning_effort === "string" ? REASONING_BUDGET[body.reasoning_effort] : undefined;
  if (effort && req.max_tokens > effort + 256) {
    req.thinking = { type: "enabled", budget_tokens: effort };
    delete req.temperature;
    delete req.top_p;
  }
  return req;
}

const STOP_TO_FINISH: Record<string, string> = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  pause_turn: "stop",
  refusal: "content_filter",
};

export function stopReasonToFinish(reason: unknown): string {
  return typeof reason === "string" ? (STOP_TO_FINISH[reason] ?? "stop") : "stop";
}

export function chatUsageFromNormalized(u: Usage): JsonObject {
  const out: JsonObject = {
    prompt_tokens: u.inputTokens,
    completion_tokens: u.outputTokens,
    total_tokens: u.inputTokens + u.outputTokens,
    prompt_tokens_details: { cached_tokens: u.cachedTokens },
  };
  if (u.cacheWriteTokens) out.prompt_tokens_details.cache_write_tokens = u.cacheWriteTokens;
  if (u.reasoningTokens) out.completion_tokens_details = { reasoning_tokens: u.reasoningTokens };
  return out;
}

/** Anthropic Messages response -> OpenAI chat.completion. */
export function messagesResponseToChat(msg: JsonObject, publicModel: string): { body: JsonObject; usage: Usage } {
  const blocks: Json[] = Array.isArray(msg.content) ? msg.content : [];
  let text = "";
  let reasoning = "";
  const toolCalls: JsonObject[] = [];
  for (const b of blocks) {
    if (!isObject(b)) continue;
    if (b.type === "text" && typeof b.text === "string") text += b.text;
    else if (b.type === "thinking" && typeof b.thinking === "string") reasoning += b.thinking;
    else if (b.type === "tool_use") {
      toolCalls.push({ id: String(b.id), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } });
    }
  }
  const usage = usageFromAnthropic(msg.usage);
  const message: JsonObject = { role: "assistant", content: text || (toolCalls.length ? null : ""), refusal: null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const idRaw = String(msg.id ?? "");
  return {
    usage,
    body: {
      id: `chatcmpl-${idRaw.replace(/^msg_/, "") || Math.random().toString(36).slice(2)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: publicModel,
      choices: [{ index: 0, message, logprobs: null, finish_reason: stopReasonToFinish(msg.stop_reason) }],
      usage: chatUsageFromNormalized(usage),
    },
  };
}

/** Anthropic SSE events -> OpenAI chat.completion.chunk SSE. */
export class AnthropicToChatStream implements StreamProcessor {
  private id = `chatcmpl-${Math.random().toString(36).slice(2, 14)}`;
  private created = Math.floor(Date.now() / 1000);
  private roleSent = false;
  private toolIndex = -1;
  private blocks = new Map<number, { type: string; tool?: number }>();
  private finish: string | null = null;
  private _usage: Usage = emptyUsage();
  private sawUsage = false;
  private text = new TextAcc();
  private done = false;
  private err: { status: number; message: string; type?: string } | null = null;

  private scrub: ((t: string) => string) | null = null;
  setScrub(fn: (t: string) => string): void {
    this.scrub = fn;
  }

  constructor(
    private readonly publicModel: string,
    private readonly includeUsage: boolean,
  ) {}

  private chunk(delta: JsonObject, finish: string | null = null): string {
    return sseEvent({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.publicModel,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  }

  private ensureRole(out: string[]): void {
    if (this.roleSent) return;
    this.roleSent = true;
    out.push(this.chunk({ role: "assistant", content: "" }));
  }

  onEvent(ev: SseEvent): string[] {
    if (ev.comment || !ev.data) return [];
    const d = safeJsonParse<Json>(ev.data);
    if (!isObject(d)) return [];
    const out: string[] = [];
    switch (d.type) {
      case "message_start": {
        const m = isObject(d.message) ? d.message : {};
        if (typeof m.id === "string") this.id = `chatcmpl-${m.id.replace(/^msg_/, "")}`;
        if (isObject(m.usage)) {
          this._usage = mergeUsage(this._usage, usageFromAnthropic(m.usage));
          this.sawUsage = true;
        }
        this.ensureRole(out);
        break;
      }
      case "content_block_start": {
        const idx = Number(d.index ?? 0);
        const cb = isObject(d.content_block) ? d.content_block : {};
        this.ensureRole(out);
        if (cb.type === "tool_use") {
          const t = ++this.toolIndex;
          this.blocks.set(idx, { type: "tool_use", tool: t });
          out.push(this.chunk({ tool_calls: [{ index: t, id: String(cb.id), type: "function", function: { name: String(cb.name), arguments: "" } }] }));
        } else {
          this.blocks.set(idx, { type: String(cb.type ?? "text") });
          if (cb.type === "text" && typeof cb.text === "string" && cb.text) {
            this.text.add(cb.text);
            out.push(this.chunk({ content: cb.text }));
          }
        }
        break;
      }
      case "content_block_delta": {
        const idx = Number(d.index ?? 0);
        const delta = isObject(d.delta) ? d.delta : {};
        const blk = this.blocks.get(idx);
        this.ensureRole(out);
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          this.text.add(delta.text);
          out.push(this.chunk({ content: delta.text }));
        } else if (delta.type === "input_json_delta" && blk?.tool !== undefined) {
          out.push(this.chunk({ tool_calls: [{ index: blk.tool, function: { arguments: String(delta.partial_json ?? "") } }] }));
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          out.push(this.chunk({ reasoning_content: delta.thinking }));
        }
        break;
      }
      case "message_delta": {
        if (isObject(d.usage)) {
          this._usage = mergeUsage(this._usage, usageFromAnthropic(d.usage));
          this.sawUsage = true;
        }
        const reason = isObject(d.delta) ? d.delta.stop_reason : undefined;
        if (reason !== undefined && reason !== null) {
          this.finish = stopReasonToFinish(reason);
          this.ensureRole(out);
          out.push(this.chunk({}, this.finish));
        }
        break;
      }
      case "message_stop": {
        if (this.finish === null) {
          this.ensureRole(out);
          out.push(this.chunk({}, "stop"));
          this.finish = "stop";
        }
        if (this.includeUsage) {
          out.push(
            sseEvent({
              id: this.id,
              object: "chat.completion.chunk",
              created: this.created,
              model: this.publicModel,
              choices: [],
              usage: chatUsageFromNormalized(this._usage),
            }),
          );
        }
        out.push(SSE_DONE);
        this.done = true;
        break;
      }
      case "error": {
        const e = isObject(d.error) ? d.error : {};
        const type = String(e.type ?? "api_error");
        const status = type === "overloaded_error" ? 529 : type === "rate_limit_error" ? 429 : type === "invalid_request_error" ? 400 : type === "authentication_error" ? 401 : 500;
        const message = String(e.message ?? "upstream error");
        this.err = { status, message, type };
        // forwarded as an OpenAI error chunk (same type / message)
        out.push(sseEvent({ error: { message: this.scrub ? this.scrub(message) : message, type, param: null, code: type } }));
        break;
      }
      default:
        break; // ping and unknown events
    }
    return out;
  }

  onEnd(): string[] {
    return [];
  }
  usage(): Usage | null {
    return this.sawUsage ? this._usage : null;
  }
  outputText(): string {
    return this.text.toString();
  }
  outputChars(): number {
    return this.text.length;
  }
  /** Funds exhausted: final chunk (finish_reason "length") + the native error event + [DONE]. */
  abortEvents(errorEvent: string): string[] {
    return [this.chunk({}, "length"), errorEvent, "data: [DONE]\n\n"];
  }
  completed(): boolean {
    return this.done;
  }
  error() {
    return this.err;
  }
}
