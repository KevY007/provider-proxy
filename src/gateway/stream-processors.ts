import { generatedFilesOfAnthropicBlock, generatedFilesOfResponsesOutput, type GeneratedFile } from "./generated-files";
import { TextAcc, type StreamProcessor } from "./processor";
import type { SseEvent } from "./sse";
import type { Json, JsonObject, Usage } from "./types";
import { mergeUsage, usageFromAnthropic, usageFromGemini, usageFromOpenAI, usageFromResponsesObject } from "./usage";
import { isObject, safeJsonParse } from "./util";
import { openaiErrorType, parseInbandError, type InbandError } from "./inband-error";
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

/**
 * An upstream error event is forwarded VERBATIM (PLAN 9d.1b): the raw block goes out untouched unless scrubbing our
 * identity (provider name / host / key / upstream model) changes its message.
 */
function errorBlock(ev: SseEvent, d: JsonObject, scrub: ((t: string) => string) | null, modified = false): string {
  if (!scrub) return modified ? emit(ev, d) : rawBlock(ev);
  let changed = modified;
  const visit = (o: unknown, depth: number): void => {
    if (depth > 4 || !isObject(o)) return;
    for (const k of ["message", "detail"]) {
      const v = o[k];
      if (typeof v === "string") {
        const t = scrub(v);
        if (t !== v) {
          o[k] = t;
          changed = true;
        }
      }
    }
    if (isObject(o.error)) visit(o.error, depth + 1);
    if (isObject(o.response)) visit(o.response, depth + 1);
  };
  visit(d, 0);
  return changed ? emit(ev, d) : rawBlock(ev);
}

abstract class Base implements StreamProcessor {
  protected scrub: ((t: string) => string) | null = null;
  setScrub(fn: (t: string) => string): void {
    this.scrub = fn;
  }
  protected _usage: Usage = emptyUsage();
  protected sawUsage = false;
  protected text = new TextAcc();
  protected done = false;
  protected err: InbandError | null = null;
  protected rid: string | null = null;
  protected files: GeneratedFile[] = [];
  onGeneratedFiles?: (files: GeneratedFile[]) => void;

  generatedFiles(): GeneratedFile[] {
    return this.files;
  }
  /** Remember newly seen generated files and tell the pipeline (which registers them right away). */
  protected addGeneratedFiles(found: GeneratedFile[]): void {
    const fresh = found.filter((f) => !this.files.some((x) => x.kind === f.kind && x.id === f.id));
    if (!fresh.length) return;
    this.files.push(...fresh);
    try {
      this.onGeneratedFiles?.(fresh);
    } catch {
      /* registration is best effort here; the final pass retries */
    }
  }

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
  outputChars(): number {
    return this.text.length;
  }
  abortEvents(errorEvent: string): string[] {
    return [errorEvent];
  }
  breakEvents(errorEvent: string): string[] {
    return [errorEvent];
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
  private lastId: string | null = null;
  private lastModel: string | null = null;
  private lastCreated: number | null = null;
  private legacy = false;
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
      this.err = parseInbandError(d);
      return [errorBlock(ev, d, this.scrub, false)];
    }
    let modified = false;
    if (typeof d.id === "string") this.lastId = d.id;
    if (typeof d.model === "string") this.lastModel = d.model;
    if (typeof d.created === "number") this.lastCreated = d.created;
    if (d.object === "text_completion") this.legacy = true;
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

  /** Final chunk (finish_reason "length") + the native error event + [DONE]. */
  override abortEvents(errorEvent: string): string[] {
    const base = { id: this.lastId ?? "chatcmpl-cut", created: this.lastCreated ?? Math.floor(Date.now() / 1000), model: this.publicModel ?? this.lastModel ?? "unknown" };
    const chunk = this.legacy
      ? { ...base, object: "text_completion", choices: [{ index: 0, text: "", logprobs: null, finish_reason: "length" }] }
      : { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: "length" }] };
    return [`data: ${JSON.stringify(chunk)}\n\n`, errorEvent, "data: [DONE]\n\n"];
  }
}

/** OpenAI Responses API streams (typed events). */
export interface ResponsesStreamOptions {
  /** the client's max_output_tokens: echoed on `response` when the upstream reports null */
  maxOutputTokens?: number | null;
  /** the upstream ignores max_output_tokens: end the stream with response.incomplete once the visible output reaches it */
  enforceMaxOutputTokens?: boolean;
}

/** Visible output tokens, estimated from characters while streaming (the usual ~4 characters per token). */
const CHARS_PER_TOKEN = 4;

export class ResponsesStreamPassthrough extends Base {
  private lastResponse: JsonObject | null = null;
  private lastSeq = -1;
  private visibleChars = 0;
  private stopped = false;
  private thinking = new TextAcc(500_000);

  constructor(
    private readonly publicModel: string | null,
    private readonly opts: ResponsesStreamOptions = {},
  ) {
    super();
  }

  halted(): boolean {
    return this.stopped;
  }

  reasoningText(): string {
    return this.thinking.toString();
  }

  /** The client's output cap was reached (the upstream ignores it): end like OpenAI does, with response.incomplete. */
  private capEvent(): string {
    const max = this.opts.maxOutputTokens!;
    const response = { ...(this.lastResponse ?? {}), status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, max_output_tokens: max };
    return `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", sequence_number: this.lastSeq + 1, response })}\n\n`;
  }

  /** The gateway's own error (OpenAI's `{"error": {...}}` document) as the fields of a Responses `error` stream event. */
  private errorFields(errorEvent: string, fallback: { code: string; message: string }): { type: "error"; code: unknown; message: unknown; param: null } {
    const m = /^data: (.*)$/m.exec(errorEvent);
    let e: Record<string, unknown> = {};
    try {
      const j = m ? JSON.parse(m[1]) : {};
      e = isObject(j) && isObject(j.error) ? j.error : {};
    } catch {
      /* fall through with defaults */
    }
    return { type: "error", code: e.code ?? fallback.code, message: e.message ?? fallback.message, param: null };
  }

  /** Funds exhausted: a typed Responses `error` event. */
  override abortEvents(errorEvent: string): string[] {
    const body = this.errorFields(errorEvent, { code: "insufficient_balance", message: "Insufficient balance." });
    return [`event: error\ndata: ${JSON.stringify(body)}\n\n`];
  }

  /** The upstream broke mid-answer: the same typed `error` event, numbered after the last event the client received. */
  override breakEvents(errorEvent: string): string[] {
    const body = { ...this.errorFields(errorEvent, { code: "upstream_error", message: "The model returned an error." }), sequence_number: this.lastSeq + 1 };
    return [`event: error\ndata: ${JSON.stringify(body)}\n\n`];
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
    if (typeof d.sequence_number === "number") this.lastSeq = Math.max(this.lastSeq, d.sequence_number);
    if (isObject(d.response)) {
      if (typeof d.response.id === "string" && !this.rid) this.rid = d.response.id;
      const max = this.opts.maxOutputTokens;
      if (typeof max === "number" && (d.response.max_output_tokens === null || d.response.max_output_tokens === undefined)) {
        d.response.max_output_tokens = max;
        modified = true;
      }
      if (this.publicModel && typeof d.response.model === "string" && d.response.model !== this.publicModel) {
        d.response.model = this.publicModel;
        modified = true;
      }
      // (the terminal events carry the whole response: usage AND the output items, i.e. the server tools that ran)
      if (isObject(d.response.usage) || Array.isArray(d.response.output)) {
        const u = usageFromResponsesObject(d.response);
        if (isObject(d.response.usage)) this.addUsage(u);
        else if (u.toolUsage && Object.keys(u.toolUsage).length) this.addUsage({ ...emptyUsage(), toolUsage: u.toolUsage });
      }
    }
    // an empty text delta carries nothing (one relay opens every stream with one, even before response.created)
    if (type === "response.output_text.delta" && d.delta === "") return [];
    if ((type === "response.created" || type === "response.in_progress") && isObject(d.response)) this.lastResponse = d.response;
    if ((type === "response.output_text.delta" || type === "response.function_call_arguments.delta") && typeof d.delta === "string") {
      this.text.add(d.delta);
      this.visibleChars += d.delta.length;
      const max = this.opts.maxOutputTokens;
      if (this.opts.enforceMaxOutputTokens && typeof max === "number" && max > 0 && !this.done && Math.ceil(this.visibleChars / CHARS_PER_TOKEN) >= max) {
        this.done = true;
        this.stopped = true;
        return [modified ? emit(ev, d) : rawBlock(ev), this.capEvent()];
      }
    }
    // streamed reasoning (summary or raw text) is output too, like Anthropic thinking: billed if the stream is cut early
    else if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && typeof d.delta === "string") {
      this.text.add(d.delta);
      this.thinking.add(d.delta);
    }
    else if (type === "response.completed" || type === "response.incomplete") {
      this.done = true;
      if (isObject(d.response)) this.addGeneratedFiles(generatedFilesOfResponsesOutput(d.response.output));
    }
    else if (type === "response.failed") {
      this.done = true;
      this.err = parseInbandError(isObject(d.response) ? d.response.error : null, "response failed");
      return [errorBlock(ev, d, this.scrub, modified)];
    } else if (type === "error") {
      this.err = parseInbandError(d);
      // OpenAI's shape: message / code / param at the top level. Some relays nest them under `error` (+ a `status`):
      // clients reading the standard shape would only see "stream error", so rewrite those.
      if (isObject(d.error) || typeof d.message !== "string") {
        const e = this.err;
        const flat = { type: "error", code: e.code ?? e.type ?? openaiErrorType(e.status), message: e.message, param: e.param ?? null, ...(typeof d.sequence_number === "number" ? { sequence_number: d.sequence_number } : {}) };
        return [errorBlock({ ...ev, event: ev.event ?? "error" }, flat, this.scrub, true)];
      }
      return [errorBlock(ev, d, this.scrub, modified)];
    }
    return [modified ? emit(ev, d) : rawBlock(ev)];
  }
}

/** Anthropic Messages streams. */
export class AnthropicStreamPassthrough extends Base {
  private thinking = new TextAcc(500_000);
  constructor(private readonly publicModel: string | null) {
    super();
  }

  reasoningText(): string {
    return this.thinking.toString();
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
      case "content_block_start":
        // server-tool result blocks arrive whole here; code execution results name the files they created
        this.addGeneratedFiles(generatedFilesOfAnthropicBlock(d.content_block));
        break;
      case "content_block_delta":
        if (isObject(d.delta)) {
          if (typeof d.delta.text === "string") this.text.add(d.delta.text);
          else if (typeof d.delta.partial_json === "string") this.text.add(d.delta.partial_json);
          else if (typeof d.delta.thinking === "string") {
            this.text.add(d.delta.thinking);
            this.thinking.add(d.delta.thinking);
          }
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
        return [errorBlock(ev, d, this.scrub, modified)];
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
      return [errorBlock(ev, d, this.scrub, false)];
    }
    let modified = false;
    if (isObject(d.promptFeedback) && d.promptFeedback.blockReason) this.finished = true; // blocked prompt: the stream legitimately ends without a finishReason
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
