import { TextAcc, type StreamProcessor } from "./processor";
import type { SseEvent } from "./sse";
import type { Json, Usage } from "./types";
import { mergeUsage, usageFromAnthropic, usageFromGemini, usageFromOpenAI, usageFromResponses } from "./usage";
import { isObject, safeJsonParse } from "./util";
import { emptyUsage } from "./types";

/**
 * Same-format stream processors: forward the upstream events (masking the model name, stripping our injected
 * usage chunk) while extracting usage and text for metering.
 */
function emit(ev: SseEvent, obj: unknown): string {
  return (ev.event ? `event: ${ev.event}\n` : "") + `data: ${JSON.stringify(obj)}\n\n`;
}

function rawBlock(ev: SseEvent): string {
  return ev.raw + "\n\n";
}

abstract class Base implements StreamProcessor {
  protected _usage: Usage = emptyUsage();
  protected sawUsage = false;
  protected text = new TextAcc();
  protected done = false;
  protected err: { status: number; message: string; type?: string } | null = null;
  protected rid: string | null = null;

  abstract onEvent(ev: SseEvent): string[];
  onEnd(): string[] {
    return [];
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
  responseId(): string | null {
    return this.rid;
  }
  protected addUsage(u: Usage): void {
    this._usage = mergeUsage(this._usage, u);
    this.sawUsage = true;
  }
}

/** OpenAI chat/completions + legacy completions streams (also Google's OpenAI-compat endpoint). */
export class OpenAIStreamPassthrough extends Base {
  private finished = false;
  constructor(
    private readonly publicModel: string | null,
    /** The client asked for stream_options.include_usage itself. */
    private readonly clientWantsUsage: boolean,
  ) {
    super();
  }

  onEvent(ev: SseEvent): string[] {
    if (ev.comment) return [rawBlock(ev)];
    const data = ev.data;
    if (data.trim() === "[DONE]") {
      this.done = true;
      return ["data: [DONE]\n\n"];
    }
    const d = safeJsonParse<Json>(data);
    if (!isObject(d)) return [rawBlock(ev)];
    if (isObject(d.error)) {
      // never forward raw upstream errors: the stream session emits a sanitized error event instead
      this.err = { status: Number(d.error.code) >= 400 ? Number(d.error.code) : 502, message: String(d.error.message ?? "upstream error"), type: String(d.error.type ?? "") };
      return [];
    }
    let modified = false;
    if (isObject(d.usage)) this.addUsage(usageFromOpenAI(d.usage));
    if (Array.isArray(d.choices)) {
      for (const c of d.choices) {
        if (!isObject(c)) continue;
        if (typeof c.finish_reason === "string" && c.finish_reason) this.finished = true;
        const delta = isObject(c.delta) ? c.delta : null;
        if (delta) {
          if (typeof delta.content === "string") this.text.add(delta.content);
          if (typeof delta.reasoning_content === "string") this.text.add(delta.reasoning_content);
          if (Array.isArray(delta.tool_calls)) for (const tc of delta.tool_calls) if (isObject(tc) && isObject(tc.function) && typeof tc.function.arguments === "string") this.text.add(tc.function.arguments);
        } else if (typeof c.text === "string") this.text.add(c.text);
      }
    }
    if (d.usage !== undefined && !this.clientWantsUsage) {
      // we injected include_usage: hide it from a client that did not ask
      if (Array.isArray(d.choices) && d.choices.length === 0) return [];
      delete d.usage;
      modified = true;
    }
    if (this.publicModel && typeof d.model === "string" && d.model !== this.publicModel) {
      d.model = this.publicModel;
      modified = true;
    }
    return [modified ? emit(ev, d) : rawBlock(ev)];
  }

  override completed(): boolean {
    return this.done || this.finished;
  }
}

/** OpenAI Responses API streams (typed events). */
export class ResponsesStreamPassthrough extends Base {
  constructor(private readonly publicModel: string | null) {
    super();
  }

  onEvent(ev: SseEvent): string[] {
    if (ev.comment) return [rawBlock(ev)];
    if (ev.data.trim() === "[DONE]") {
      this.done = true;
      return [rawBlock(ev)];
    }
    const d = safeJsonParse<Json>(ev.data);
    if (!isObject(d)) return [rawBlock(ev)];
    const type = String(d.type ?? ev.event ?? "");
    let modified = false;
    if (isObject(d.response)) {
      if (typeof d.response.id === "string" && !this.rid) this.rid = d.response.id;
      if (this.publicModel && typeof d.response.model === "string" && d.response.model !== this.publicModel) {
        d.response.model = this.publicModel;
        modified = true;
      }
      if (isObject(d.response.usage)) this.addUsage(usageFromResponses(d.response.usage));
    }
    if (type === "response.output_text.delta" && typeof d.delta === "string") this.text.add(d.delta);
    else if (type === "response.function_call_arguments.delta" && typeof d.delta === "string") this.text.add(d.delta);
    else if (type === "response.completed" || type === "response.incomplete") this.done = true;
    else if (type === "response.failed") {
      this.done = true;
      const e = isObject(d.response) && isObject(d.response.error) ? d.response.error : {};
      this.err = { status: 502, message: String(e.message ?? "response failed"), type: String(e.code ?? "") };
    } else if (type === "error") {
      this.err = { status: 502, message: String(d.message ?? "upstream error"), type: String(d.code ?? "") };
      return [];
    }
    if (type === "response.failed") return []; // sanitized error event is emitted by the stream session
    return [modified ? emit(ev, d) : rawBlock(ev)];
  }
}

/** Anthropic Messages streams. */
export class AnthropicStreamPassthrough extends Base {
  constructor(private readonly publicModel: string | null) {
    super();
  }

  onEvent(ev: SseEvent): string[] {
    if (ev.comment) return [rawBlock(ev)];
    const d = safeJsonParse<Json>(ev.data);
    if (!isObject(d)) return [rawBlock(ev)];
    let modified = false;
    switch (d.type) {
      case "message_start":
        if (isObject(d.message)) {
          if (isObject(d.message.usage)) this.addUsage(usageFromAnthropic(d.message.usage));
          if (this.publicModel && typeof d.message.model === "string" && d.message.model !== this.publicModel) {
            d.message.model = this.publicModel;
            modified = true;
          }
        }
        break;
      case "content_block_delta":
        if (isObject(d.delta)) {
          if (typeof d.delta.text === "string") this.text.add(d.delta.text);
          else if (typeof d.delta.partial_json === "string") this.text.add(d.delta.partial_json);
          else if (typeof d.delta.thinking === "string") this.text.add(d.delta.thinking);
        }
        break;
      case "message_delta":
        if (isObject(d.usage)) this.addUsage(usageFromAnthropic(d.usage));
        break;
      case "message_stop":
        this.done = true;
        break;
      case "error": {
        const e = isObject(d.error) ? d.error : {};
        const type = String(e.type ?? "api_error");
        const status = type === "overloaded_error" ? 529 : type === "rate_limit_error" ? 429 : type === "invalid_request_error" ? 400 : type === "authentication_error" ? 401 : 500;
        this.err = { status, message: String(e.message ?? "upstream error"), type };
        return [];
      }
      default:
        break;
    }
    return [modified ? emit(ev, d) : rawBlock(ev)];
  }
}

/** Gemini streamGenerateContent (alt=sse) streams. */
export class GeminiStreamPassthrough extends Base {
  private finished = false;
  constructor(private readonly publicModel: string | null) {
    super();
  }

  onEvent(ev: SseEvent): string[] {
    if (ev.comment) return [rawBlock(ev)];
    const d = safeJsonParse<Json>(ev.data);
    if (!isObject(d)) return [rawBlock(ev)];
    if (isObject(d.error)) {
      this.err = { status: Number(d.error.code) >= 400 ? Number(d.error.code) : 502, message: String(d.error.message ?? "upstream error"), type: String(d.error.status ?? "") };
      return [];
    }
    let modified = false;
    if (isObject(d.usageMetadata)) {
      // Gemini reports cumulative usage on every chunk: last one wins
      this._usage = usageFromGemini(d.usageMetadata);
      this.sawUsage = true;
    }
    if (Array.isArray(d.candidates)) {
      for (const c of d.candidates) {
        if (!isObject(c)) continue;
        if (c.finishReason) this.finished = true;
        const parts = isObject(c.content) && Array.isArray(c.content.parts) ? c.content.parts : [];
        for (const p of parts) if (isObject(p) && typeof p.text === "string") this.text.add(p.text);
      }
    }
    if (this.publicModel && typeof d.modelVersion === "string" && d.modelVersion !== this.publicModel) {
      d.modelVersion = this.publicModel;
      modified = true;
    }
    return [modified ? emit(ev, d) : rawBlock(ev)];
  }

  override completed(): boolean {
    return this.done || this.finished;
  }
}
