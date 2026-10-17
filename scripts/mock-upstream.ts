/**
 * Mock upstream: a fake OpenAI / Anthropic / Gemini server for local dev, tests and load tests.
 *
 *   pnpm mock:upstream            # listens on :4010 (MOCK_UPSTREAM_PORT overrides)
 *
 * Programmatic use (tests):
 *   const mock = await startMockUpstream(0);   // ephemeral port
 *   ... mock.port ...
 *   await mock.close();
 *
 * Fault injection (by the upstream credential the gateway presents):
 *   key contains "fail429" -> 429 + retry-after: 2     "fail500" -> 500     "fail529" -> 529 (overloaded)
 *   key contains "bad"     -> 401 invalid key          "slow"    -> +1500ms before responding / first byte
 * Delay knobs: header `x-mock-delay-ms`, body field `mock_delay_ms`, or marker `[[delay:N]]` in the last user
 * text. Non-stream: wait N ms before responding. Stream: wait N ms before EVERY SSE chunk (holds slots open).
 * Usage override marker (in the last user text / prompt / input): `[[usage:in=1000,out=500,cached=200,cw=50]]`.
 * `[[notool]]` suppresses the automatic tool call. Introspection (no auth): /__mock/stats, /__mock/reset,
 * /__mock/last?path=/v1/messages, /healthz.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
type Surface = "openai" | "anthropic" | "gemini";

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const pick = (o: Obj, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
};

const rid = () => randomUUID().replace(/-/g, "").slice(0, 20);
const nowSec = () => Math.floor(Date.now() / 1000);
const words = (s: string) => s.split(/\s+/).filter(Boolean);
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Split a string into `n` roughly-equal non-empty pieces (used to stream tool-call arguments). */
function splitPieces(s: string, n = 3): string[] {
  const size = Math.max(1, Math.ceil(s.length / n));
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** Deterministic pseudo-embedding in [-1, 1]. */
function embed(text: string, dims = 8): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < dims; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    out.push(Number(((h / 0xffffffff) * 2 - 1).toFixed(6)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// state & stats
// ---------------------------------------------------------------------------------------------------------------------

interface Counter {
  total: number;
  inflight: number;
  maxInflight: number;
}
interface LastRequest {
  path: string;
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  multipart: { fields: Record<string, string>; files: { name: string; filename: string; size: number }[] } | null;
  at: string;
}
interface MockState {
  total: number;
  inflight: number;
  maxInflight: number;
  byKey: Map<string, Counter>;
  byPath: Map<string, number>;
  last: Map<string, LastRequest>;
  responses: Map<string, Obj>;
}

function createState(): MockState {
  return {
    total: 0,
    inflight: 0,
    maxInflight: 0,
    byKey: new Map(),
    byPath: new Map(),
    last: new Map(),
    responses: new Map(),
  };
}

function track(state: MockState, key: string, path: string): () => void {
  state.total++;
  state.inflight++;
  state.maxInflight = Math.max(state.maxInflight, state.inflight);
  let c = state.byKey.get(key);
  if (!c) state.byKey.set(key, (c = { total: 0, inflight: 0, maxInflight: 0 }));
  c.total++;
  c.inflight++;
  c.maxInflight = Math.max(c.maxInflight, c.inflight);
  state.byPath.set(path, (state.byPath.get(path) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    state.inflight = Math.max(0, state.inflight - 1);
    const cur = state.byKey.get(key);
    if (cur) cur.inflight = Math.max(0, cur.inflight - 1);
  };
}

function resetState(state: MockState): void {
  state.total = 0;
  state.maxInflight = state.inflight; // requests still in flight keep being counted
  const keep = new Map<string, Counter>();
  for (const [k, c] of state.byKey) if (c.inflight > 0) keep.set(k, { total: 0, inflight: c.inflight, maxInflight: c.inflight });
  state.byKey = keep;
  state.byPath = new Map();
  state.last = new Map();
  state.responses = new Map();
}

// ---------------------------------------------------------------------------------------------------------------------
// request context
// ---------------------------------------------------------------------------------------------------------------------

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  path: string;
  surface: Surface;
  closed: boolean;
  waiters: Set<() => void>;
  state: MockState;
}

/** Cancellable sleep. Resolves false when the client went away (so callers can bail out). */
function sleep(ctx: Ctx, ms: number): Promise<boolean> {
  if (ctx.closed) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const wake = () => {
      clearTimeout(t);
      ctx.waiters.delete(wake);
      resolve(false);
    };
    const t = setTimeout(() => {
      ctx.waiters.delete(wake);
      resolve(true);
    }, ms);
    ctx.waiters.add(wake);
  });
}

function surfaceOf(path: string): Surface {
  if (path === "/v1/messages" || path.startsWith("/v1/messages/")) return "anthropic";
  if (path === "/v1beta/models" || path.startsWith("/v1beta/models/")) return "gemini";
  return "openai";
}

const isIntrospection = (path: string) => path.startsWith("/__mock/") || path === "/healthz";

// ---------------------------------------------------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------------------------------------------------

type ErrKind = "auth" | "rate_limit" | "server" | "overloaded" | "invalid_request" | "not_found";
const ERR_STATUS: Record<ErrKind, number> = {
  auth: 401,
  rate_limit: 429,
  server: 500,
  overloaded: 529,
  invalid_request: 400,
  not_found: 404,
};
const OPENAI_ERR: Record<ErrKind, [string, string]> = {
  auth: ["invalid_request_error", "invalid_api_key"],
  rate_limit: ["rate_limit_error", "rate_limit_exceeded"],
  server: ["server_error", "internal_server_error"],
  overloaded: ["server_error", "overloaded"],
  invalid_request: ["invalid_request_error", "invalid_request"],
  not_found: ["invalid_request_error", "not_found"],
};
const ANTHROPIC_ERR: Record<ErrKind, string> = {
  auth: "authentication_error",
  rate_limit: "rate_limit_error",
  server: "api_error",
  overloaded: "overloaded_error",
  invalid_request: "invalid_request_error",
  not_found: "not_found_error",
};
const GEMINI_ERR: Record<ErrKind, string> = {
  auth: "UNAUTHENTICATED",
  rate_limit: "RESOURCE_EXHAUSTED",
  server: "INTERNAL",
  overloaded: "UNAVAILABLE",
  invalid_request: "INVALID_ARGUMENT",
  not_found: "NOT_FOUND",
};

function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const res = ctx.res;
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

function sendError(ctx: Ctx, kind: ErrKind, message: string, extraHeaders: Record<string, string> = {}): void {
  const status = ERR_STATUS[kind];
  const headers = { ...extraHeaders };
  let body: Obj;
  if (ctx.surface === "anthropic") {
    body = { type: "error", error: { type: ANTHROPIC_ERR[kind], message }, request_id: `req_mock_${rid()}` };
  } else if (ctx.surface === "gemini") {
    body = { error: { code: status, message, status: GEMINI_ERR[kind] } };
  } else {
    const [type, code] = OPENAI_ERR[kind];
    body = { error: { message, type, code, param: null } };
  }
  sendJson(ctx, status, body, headers);
}

function rateLimitHeaders(ctx: Ctx): Record<string, string> {
  const h: Record<string, string> = {
    "retry-after": "2",
    "x-ratelimit-limit-requests": "100",
    "x-ratelimit-remaining-requests": "0",
    "x-ratelimit-reset-requests": "2s",
  };
  if (ctx.surface === "anthropic") {
    h["anthropic-ratelimit-requests-limit"] = "100";
    h["anthropic-ratelimit-requests-remaining"] = "0";
    h["anthropic-ratelimit-requests-reset"] = new Date(Date.now() + 2000).toISOString();
  }
  return h;
}

/**
 * Write frames one by one, sleeping `delay` ms BEFORE each (so slots stay occupied when delay > 0).
 * Headers are sent with the first frame (like a real provider: time-to-first-byte == first delay).
 */
async function emitFrames(ctx: Ctx, frames: string[], delay: number, contentType: string): Promise<void> {
  const res = ctx.res;
  res.statusCode = 200;
  res.setHeader("content-type", contentType);
  res.setHeader("cache-control", "no-cache");
  res.setHeader("x-accel-buffering", "no");
  for (const frame of frames) {
    if (!(await sleep(ctx, delay))) return;
    if (res.destroyed || res.writableEnded) return;
    res.write(frame);
  }
  if (!res.destroyed && !res.writableEnded) res.end();
}

const SSE = "text/event-stream";
const dataFrame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const eventFrame = (name: string, o: unknown) => `event: ${name}\ndata: ${JSON.stringify(o)}\n\n`;

// ---------------------------------------------------------------------------------------------------------------------
// body parsing
// ---------------------------------------------------------------------------------------------------------------------

interface Multipart {
  fields: Record<string, string>;
  files: { name: string; filename: string; size: number }[];
}
interface Parsed {
  json: Obj | null;
  multipart: Multipart | null;
}

class BadBody extends Error {}

function parseMultipart(body: Buffer, contentType: string): Multipart {
  const out: Multipart = { fields: {}, files: [] };
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return out;
  const delim = Buffer.from("--" + (m[1] ?? m[2]).trim());
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    const start = pos + delim.length;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // closing delimiter
    const next = body.indexOf(delim, start);
    if (next < 0) break;
    const part = body.subarray(start + 2, Math.max(start + 2, next - 2)); // skip CRLF before headers / after content
    const headEnd = part.indexOf("\r\n\r\n");
    if (headEnd >= 0) {
      const head = part.subarray(0, headEnd).toString("utf8");
      const content = part.subarray(headEnd + 4);
      const name = /name="([^"]*)"/i.exec(head)?.[1] ?? "";
      const filename = /filename="([^"]*)"/i.exec(head)?.[1];
      if (filename !== undefined) out.files.push({ name, filename, size: content.length });
      else out.fields[name] = content.toString("utf8");
    }
    pos = next;
  }
  return out;
}

function parseBody(raw: Buffer, contentType: string): Parsed {
  if (/multipart\/form-data/i.test(contentType)) return { json: null, multipart: parseMultipart(raw, contentType) };
  if (raw.length === 0) return { json: {}, multipart: null };
  let v: unknown;
  try {
    v = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new BadBody("We could not parse the JSON body of your request.");
  }
  if (!isObj(v)) throw new BadBody("The request body must be a JSON object.");
  return { json: v, multipart: null };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------------------------------
// request understanding (markers, text extraction, tool detection, usage)
// ---------------------------------------------------------------------------------------------------------------------

interface Markers {
  in?: number;
  out?: number;
  cached?: number;
  cw?: number;
  delay?: number;
  notool: boolean;
}

function parseMarkers(src: string): Markers {
  const mk: Markers = { notool: /\[\[notool\]\]/.test(src) };
  const u = /\[\[usage:([^\]]*)\]\]/.exec(src);
  if (u) {
    for (const pair of u[1].split(",")) {
      const [k, v] = pair.split("=").map((s) => s.trim());
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      if (k === "in") mk.in = Math.floor(n);
      else if (k === "out") mk.out = Math.floor(n);
      else if (k === "cached") mk.cached = Math.floor(n);
      else if (k === "cw") mk.cw = Math.floor(n);
    }
  }
  const d = /\[\[delay:(\d+)\]\]/.exec(src);
  if (d) mk.delay = Number(d[1]);
  return mk;
}

const stripMarkers = (s: string) => s.replace(/\[\[[^\]]*\]\]/g, "").replace(/\s+/g, " ").trim();

interface Extracted {
  /** every piece of request text (for the chars/4 prompt-token estimate) */
  texts: string[];
  lastUserText: string;
  toolName: string | null;
  toolChoiceNone: boolean;
  lastIsToolResult: boolean;
}

const emptyExtracted = (): Extracted => ({
  texts: [],
  lastUserText: "",
  toolName: null,
  toolChoiceNone: false,
  lastIsToolResult: false,
});

/** string | [{type:"text"|"input_text"|"output_text", text}|string] -> string[] */
function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  const out: string[] = [];
  for (const p of asArr(content)) {
    if (typeof p === "string") out.push(p);
    else if (isObj(p) && typeof p.text === "string") out.push(p.text);
  }
  return out;
}

function extractOpenAIChat(b: Obj): Extracted {
  const ex = emptyExtracted();
  const messages = asArr(b.messages);
  for (const m of messages) {
    if (!isObj(m)) continue;
    const t = textParts(m.content);
    ex.texts.push(...t);
    for (const tc of asArr(m.tool_calls)) {
      if (isObj(tc) && isObj(tc.function) && typeof tc.function.arguments === "string") ex.texts.push(tc.function.arguments);
    }
    if (m.role === "user") ex.lastUserText = t.join(" ");
  }
  const last = messages[messages.length - 1];
  ex.lastIsToolResult = isObj(last) && (last.role === "tool" || last.role === "function");
  const tools = asArr(b.tools);
  if (tools.length) {
    const t0 = tools[0];
    ex.toolName = (isObj(t0) && (isObj(t0.function) ? asStr(t0.function.name) : asStr(t0.name))) || "tool";
  }
  const tc = b.tool_choice;
  if (tc === "none") ex.toolChoiceNone = true;
  else if (isObj(tc) && isObj(tc.function) && asStr(tc.function.name)) ex.toolName = asStr(tc.function.name) ?? ex.toolName;
  return ex;
}

function extractCompletions(b: Obj): Extracted {
  const ex = emptyExtracted();
  const p = b.prompt;
  const prompts = typeof p === "string" ? [p] : asArr(p).filter((x): x is string => typeof x === "string");
  ex.texts.push(...prompts);
  ex.lastUserText = prompts[prompts.length - 1] ?? "";
  return ex;
}

function extractResponses(b: Obj): Extracted {
  const ex = emptyExtracted();
  const instructions = asStr(b.instructions);
  if (instructions) ex.texts.push(instructions);
  const input = b.input;
  if (typeof input === "string") {
    ex.texts.push(input);
    ex.lastUserText = input;
  } else {
    const items = asArr(input);
    for (const it of items) {
      if (!isObj(it)) continue;
      if (it.type === "function_call_output") {
        const out = asStr(it.output);
        if (out) ex.texts.push(out);
        continue;
      }
      if (it.type === "function_call") {
        const a = asStr(it.arguments);
        if (a) ex.texts.push(a);
        continue;
      }
      const t = textParts(it.content);
      ex.texts.push(...t);
      if (it.role === "user" || it.role === undefined) ex.lastUserText = t.join(" ");
    }
    const last = items[items.length - 1];
    ex.lastIsToolResult = isObj(last) && last.type === "function_call_output";
  }
  const fn = asArr(b.tools).find((t) => isObj(t) && t.type === "function");
  if (isObj(fn)) ex.toolName = asStr(fn.name) ?? "tool";
  else if (asArr(b.tools).length) ex.toolName = null; // only hosted tools -> never fake a function call
  if (b.tool_choice === "none") ex.toolChoiceNone = true;
  else if (isObj(b.tool_choice) && asStr(b.tool_choice.name)) ex.toolName = asStr(b.tool_choice.name) ?? ex.toolName;
  return ex;
}

function extractAnthropic(b: Obj): Extracted {
  const ex = emptyExtracted();
  ex.texts.push(...textParts(b.system));
  const messages = asArr(b.messages);
  for (const m of messages) {
    if (!isObj(m)) continue;
    const userTexts: string[] = [];
    if (typeof m.content === "string") userTexts.push(m.content);
    for (const blk of asArr(m.content)) {
      if (!isObj(blk)) continue;
      if (blk.type === "text" && typeof blk.text === "string") userTexts.push(blk.text);
      else if (blk.type === "tool_result") ex.texts.push(...textParts(blk.content));
      else if (blk.type === "tool_use" && blk.input !== undefined) ex.texts.push(JSON.stringify(blk.input));
    }
    ex.texts.push(...userTexts);
    if (m.role === "user" && userTexts.length) ex.lastUserText = userTexts.join(" ");
  }
  const last = messages[messages.length - 1];
  ex.lastIsToolResult = isObj(last) && asArr(last.content).some((x) => isObj(x) && x.type === "tool_result");
  const tools = asArr(b.tools);
  if (tools.length) ex.toolName = (isObj(tools[0]) && asStr(tools[0].name)) || "tool";
  const tc = b.tool_choice;
  if (isObj(tc)) {
    if (tc.type === "none") ex.toolChoiceNone = true;
    else if (tc.type === "tool" && asStr(tc.name)) ex.toolName = asStr(tc.name) ?? ex.toolName;
  }
  return ex;
}

function extractGemini(b: Obj): Extracted {
  const ex = emptyExtracted();
  const sys = pick(b, "systemInstruction", "system_instruction");
  if (isObj(sys)) for (const p of asArr(sys.parts)) if (isObj(p) && typeof p.text === "string") ex.texts.push(p.text);
  const contents = asArr(b.contents);
  for (const c of contents) {
    if (!isObj(c)) continue;
    const t: string[] = [];
    for (const p of asArr(c.parts)) {
      if (!isObj(p)) continue;
      if (typeof p.text === "string") t.push(p.text);
      const fr = pick(p, "functionResponse", "function_response");
      if (isObj(fr)) ex.texts.push(JSON.stringify(fr.response ?? {}));
    }
    ex.texts.push(...t);
    if ((c.role === "user" || c.role === undefined) && t.length) ex.lastUserText = t.join(" ");
  }
  const last = contents[contents.length - 1];
  ex.lastIsToolResult =
    isObj(last) && asArr(last.parts).some((p) => isObj(p) && pick(p, "functionResponse", "function_response") !== undefined);
  for (const t of asArr(b.tools)) {
    if (!isObj(t)) continue;
    const decls = asArr(pick(t, "functionDeclarations", "function_declarations"));
    if (decls.length && !ex.toolName) ex.toolName = (isObj(decls[0]) && asStr(decls[0].name)) || "tool";
  }
  const cfg = pick(b, "toolConfig", "tool_config");
  const fcc = isObj(cfg) ? pick(cfg, "functionCallingConfig", "function_calling_config") : undefined;
  if (isObj(fcc)) {
    if (fcc.mode === "NONE") ex.toolChoiceNone = true;
    const allowed = asArr(pick(fcc, "allowedFunctionNames", "allowed_function_names"));
    if (fcc.mode === "ANY" && typeof allowed[0] === "string") ex.toolName = allowed[0];
  }
  return ex;
}

interface Usage {
  input: number; // total prompt tokens (inclusive of cached / cache-write)
  output: number;
  cached: number;
  cacheWrite: number;
}

function computeUsage(ex: Extracted, mk: Markers, replyWords: number, surface: Surface): Usage {
  const chars = ex.texts.reduce((a, t) => a + t.length, 0);
  const input = mk.in ?? Math.max(1, Math.ceil(chars / 4));
  const output = mk.out ?? Math.max(1, replyWords);
  const cached = Math.min(mk.cached ?? 0, input);
  const cacheWrite = surface === "anthropic" ? Math.min(mk.cw ?? 0, input - cached) : 0;
  return { input, output, cached, cacheWrite };
}

const markerSource = (ex: Extracted) => ex.lastUserText || ex.texts.join("\n");

interface Plan {
  markers: Markers;
  usage: Usage;
  /** assistant text (empty when `tool` is set) */
  text: string;
  tool: { name: string; args: string } | null;
}

function plan(ex: Extracted, surface: Surface, prefix = "Mock reply to:"): Plan {
  const markers = parseMarkers(markerSource(ex));
  const useTool = !!ex.toolName && !ex.toolChoiceNone && !ex.lastIsToolResult && !markers.notool;
  if (useTool) {
    const args = JSON.stringify({ city: "Paris" });
    return { markers, usage: computeUsage(ex, markers, words(args).length, surface), text: "", tool: { name: ex.toolName as string, args } };
  }
  const text = `${prefix} ${stripMarkers(ex.lastUserText).slice(0, 80)}`.trimEnd();
  return { markers, usage: computeUsage(ex, markers, words(text).length, surface), text, tool: null };
}

function textDeltas(text: string): string[] {
  return words(text).map((w, i) => (i === 0 ? w : " " + w));
}

function resolveDelay(req: http.IncomingMessage, body: Obj | null, mk: Markers): number {
  const h = req.headers["x-mock-delay-ms"];
  const hn = typeof h === "string" ? Number(h) : NaN;
  let d = 0;
  if (Number.isFinite(hn) && hn >= 0) d = hn;
  else if (body && asNum(body.mock_delay_ms) !== undefined && (asNum(body.mock_delay_ms) as number) >= 0) d = asNum(body.mock_delay_ms) as number;
  else if (mk.delay !== undefined) d = mk.delay;
  return Math.min(d, 120_000);
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenAI: chat / completions
// ---------------------------------------------------------------------------------------------------------------------

function openaiUsage(u: Usage): Obj {
  return {
    prompt_tokens: u.input,
    completion_tokens: u.output,
    total_tokens: u.input + u.output,
    prompt_tokens_details: { cached_tokens: u.cached, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
  };
}

async function handleChat(ctx: Ctx, b: Obj): Promise<void> {
  const model = asStr(b.model);
  if (!model) return sendError(ctx, "invalid_request", "you must provide a model parameter");
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return sendError(ctx, "invalid_request", "[] is too short - 'messages'");
  }
  const ex = extractOpenAIChat(b);
  const p = plan(ex, "openai");
  const delay = resolveDelay(ctx.req, b, p.markers);
  const id = `chatcmpl-mock-${rid()}`;
  const created = nowSec();
  const finish = p.tool ? "tool_calls" : "stop";

  if (b.stream !== true) {
    if (!(await sleep(ctx, delay))) return;
    const message: Obj = { role: "assistant", content: p.tool ? null : p.text, refusal: null };
    if (p.tool) {
      message.tool_calls = [{ id: "call_mock1", type: "function", function: { name: p.tool.name, arguments: p.tool.args } }];
    }
    return sendJson(ctx, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, logprobs: null, finish_reason: finish }],
      usage: openaiUsage(p.usage),
      system_fingerprint: "fp_mock",
    });
  }

  const includeUsage = isObj(b.stream_options) && b.stream_options.include_usage === true;
  const chunk = (delta: Obj, finish_reason: string | null): string =>
    dataFrame({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      system_fingerprint: "fp_mock",
      choices: [{ index: 0, delta, logprobs: null, finish_reason }],
      ...(includeUsage ? { usage: null } : {}),
    });
  const frames: string[] = [];
  if (p.tool) {
    frames.push(chunk({ role: "assistant", content: null }, null));
    const pieces = splitPieces(p.tool.args, 3);
    frames.push(
      chunk({ tool_calls: [{ index: 0, id: "call_mock1", type: "function", function: { name: p.tool.name, arguments: "" } }] }, null),
    );
    for (const piece of pieces) frames.push(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }, null));
  } else {
    frames.push(chunk({ role: "assistant", content: "" }, null));
    for (const d of textDeltas(p.text)) frames.push(chunk({ content: d }, null));
  }
  frames.push(chunk({}, finish));
  if (includeUsage) {
    frames.push(dataFrame({ id, object: "chat.completion.chunk", created, model, system_fingerprint: "fp_mock", choices: [], usage: openaiUsage(p.usage) }));
  }
  frames.push("data: [DONE]\n\n");
  await emitFrames(ctx, frames, delay, SSE);
}

async function handleCompletions(ctx: Ctx, b: Obj): Promise<void> {
  const model = asStr(b.model);
  if (!model) return sendError(ctx, "invalid_request", "you must provide a model parameter");
  if (b.prompt === undefined) return sendError(ctx, "invalid_request", "'prompt' is a required property");
  const ex = extractCompletions(b);
  const p = plan(ex, "openai");
  const delay = resolveDelay(ctx.req, b, p.markers);
  const id = `cmpl-mock-${rid()}`;
  const created = nowSec();
  if (b.stream !== true) {
    if (!(await sleep(ctx, delay))) return;
    return sendJson(ctx, 200, {
      id,
      object: "text_completion",
      created,
      model,
      choices: [{ text: p.text, index: 0, logprobs: null, finish_reason: "stop" }],
      usage: openaiUsage(p.usage),
    });
  }
  const includeUsage = isObj(b.stream_options) && b.stream_options.include_usage === true;
  const chunk = (text: string, finish: string | null): string =>
    dataFrame({
      id,
      object: "text_completion",
      created,
      model,
      choices: [{ text, index: 0, logprobs: null, finish_reason: finish }],
      ...(includeUsage ? { usage: null } : {}),
    });
  const frames = textDeltas(p.text).map((d) => chunk(d, null));
  frames.push(chunk("", "stop"));
  if (includeUsage) frames.push(dataFrame({ id, object: "text_completion", created, model, choices: [], usage: openaiUsage(p.usage) }));
  frames.push("data: [DONE]\n\n");
  await emitFrames(ctx, frames, delay, SSE);
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenAI: responses
// ---------------------------------------------------------------------------------------------------------------------

function responsesUsage(u: Usage): Obj {
  return {
    input_tokens: u.input,
    input_tokens_details: { cached_tokens: u.cached },
    output_tokens: u.output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: u.input + u.output,
  };
}

function storeResponse(state: MockState, id: string, obj: Obj): void {
  state.responses.set(id, obj);
  if (state.responses.size > 5000) {
    const oldest = state.responses.keys().next().value;
    if (oldest !== undefined) state.responses.delete(oldest);
  }
}

async function handleResponses(ctx: Ctx, b: Obj): Promise<void> {
  const model = asStr(b.model);
  if (!model) return sendError(ctx, "invalid_request", "Missing required parameter: 'model'.");
  if (b.input === undefined) return sendError(ctx, "invalid_request", "Missing required parameter: 'input'.");
  const ex = extractResponses(b);
  const p = plan(ex, "openai");
  const delay = resolveDelay(ctx.req, b, p.markers);
  const id = `resp_mock_${rid()}`;
  const msgId = `msg_mock_${rid()}`;
  const fcId = "fc_mock1";
  const createdAt = nowSec();
  const base = (status: string, output: unknown[], usage: Obj | null): Obj => ({
    id,
    object: "response",
    created_at: createdAt,
    status,
    model,
    output,
    usage,
    previous_response_id: asStr(b.previous_response_id) ?? null,
    instructions: asStr(b.instructions) ?? null,
    parallel_tool_calls: true,
    store: b.store !== false,
    tools: asArr(b.tools),
    metadata: isObj(b.metadata) ? b.metadata : {},
    error: null,
  });
  const messageItem = (status: string, text: string): Obj => ({
    type: "message",
    id: msgId,
    status,
    role: "assistant",
    content: status === "in_progress" && !text ? [] : [{ type: "output_text", text, annotations: [] }],
  });
  const callItem = (status: string, args: string): Obj => ({
    type: "function_call",
    id: fcId,
    call_id: "call_mock1",
    name: p.tool?.name ?? "",
    arguments: args,
    status,
  });
  const finalOutput: Obj[] = [p.tool ? callItem("completed", p.tool.args) : messageItem("completed", p.text)];
  const finalResp = base("completed", finalOutput, responsesUsage(p.usage));
  const save = () => {
    if (b.store !== false) storeResponse(ctx.state, id, finalResp);
  };

  if (b.stream !== true) {
    if (!(await sleep(ctx, delay))) return;
    save();
    return sendJson(ctx, 200, finalResp);
  }

  let seq = 0;
  const ev = (type: string, data: Obj) => eventFrame(type, { type, sequence_number: seq++, ...data });
  const frames: string[] = [];
  frames.push(ev("response.created", { response: base("in_progress", [], null) }));
  frames.push(ev("response.in_progress", { response: base("in_progress", [], null) }));
  if (p.tool) {
    frames.push(ev("response.output_item.added", { output_index: 0, item: callItem("in_progress", "") }));
    for (const piece of splitPieces(p.tool.args, 3)) {
      frames.push(ev("response.function_call_arguments.delta", { item_id: fcId, output_index: 0, delta: piece }));
    }
    frames.push(ev("response.function_call_arguments.done", { item_id: fcId, output_index: 0, arguments: p.tool.args }));
    frames.push(ev("response.output_item.done", { output_index: 0, item: callItem("completed", p.tool.args) }));
  } else {
    frames.push(ev("response.output_item.added", { output_index: 0, item: messageItem("in_progress", "") }));
    frames.push(ev("response.content_part.added", { item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
    for (const d of textDeltas(p.text)) {
      frames.push(ev("response.output_text.delta", { item_id: msgId, output_index: 0, content_index: 0, delta: d }));
    }
    frames.push(ev("response.output_text.done", { item_id: msgId, output_index: 0, content_index: 0, text: p.text }));
    frames.push(ev("response.content_part.done", { item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: p.text, annotations: [] } }));
    frames.push(ev("response.output_item.done", { output_index: 0, item: messageItem("completed", p.text) }));
  }
  frames.push(ev("response.completed", { response: finalResp }));
  save();
  await emitFrames(ctx, frames, delay, SSE);
}

function handleResponsesAux(ctx: Ctx, method: string, id: string, sub: string | undefined): void {
  const found = ctx.state.responses.get(id);
  const notFound = () => sendError(ctx, "not_found", `Response with id '${id}' not found.`);
  if (sub === "input_items" && method === "GET") {
    if (!found) return notFound();
    return sendJson(ctx, 200, { object: "list", data: [], first_id: null, last_id: null, has_more: false });
  }
  if (sub === "cancel" && method === "POST") {
    if (!found) return notFound();
    return sendJson(ctx, 200, { ...found, status: "cancelled" });
  }
  if (!sub && method === "GET") return found ? sendJson(ctx, 200, found) : notFound();
  if (!sub && method === "DELETE") {
    if (!found) return notFound();
    ctx.state.responses.delete(id);
    return sendJson(ctx, 200, { id, object: "response", deleted: true });
  }
  sendError(ctx, "not_found", `Unknown request URL: ${method} ${ctx.path}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenAI: embeddings / images / audio / moderations / models
// ---------------------------------------------------------------------------------------------------------------------

function handleEmbeddings(ctx: Ctx, b: Obj): void {
  const model = asStr(b.model);
  if (!model) return sendError(ctx, "invalid_request", "you must provide a model parameter");
  const input = b.input;
  if (input === undefined || input === "" || (Array.isArray(input) && input.length === 0)) {
    return sendError(ctx, "invalid_request", "'input' is a required property");
  }
  let elements: string[];
  if (typeof input === "string") elements = [input];
  else if (Array.isArray(input) && input.every((x) => typeof x === "number")) elements = [input.join(" ")];
  else elements = asArr(input).map((x) => (typeof x === "string" ? x : Array.isArray(x) ? x.join(" ") : JSON.stringify(x)));
  const dims = Math.min(1536, Math.max(1, Math.floor(asNum(b.dimensions) ?? 8)));
  const mk = parseMarkers(elements.join("\n"));
  const tokens = mk.in ?? elements.reduce((a, t) => a + Math.max(1, Math.ceil(t.length / 4)), 0);
  sendJson(ctx, 200, {
    object: "list",
    data: elements.map((t, index) => ({ object: "embedding", index, embedding: embed(t, dims) })),
    model,
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  });
}

function toMultipart(p: Parsed): Multipart {
  if (p.multipart) return p.multipart;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.json ?? {})) fields[k] = typeof v === "string" ? v : JSON.stringify(v);
  return { fields, files: [] };
}

function handleImages(ctx: Ctx, p: Parsed): void {
  const mp = toMultipart(p);
  const model = mp.fields.model ?? asStr(p.json?.model) ?? "image-mock";
  const prompt = mp.fields.prompt ?? "";
  const n = Math.min(10, Math.max(1, Math.floor(Number(mp.fields.n ?? 1)) || 1));
  const mk = parseMarkers(prompt);
  const input = mk.in ?? Math.max(1, Math.ceil(prompt.length / 4));
  const output = mk.out ?? 100 * n;
  sendJson(ctx, 200, {
    created: nowSec(),
    model,
    data: Array.from({ length: n }, () => ({ b64_json: PNG_1X1 })),
    usage: {
      input_tokens: input,
      input_tokens_details: { text_tokens: input, image_tokens: 0 },
      output_tokens: output,
      total_tokens: input + output,
    },
  });
}

function handleSpeech(ctx: Ctx, b: Obj): void {
  const input = asStr(b.input);
  if (!input) return sendError(ctx, "invalid_request", "'input' is a required property");
  const size = Math.min(5_000_000, 100 + 10 * input.length);
  const buf = Buffer.alloc(size, 0x49);
  buf.write("ID3", 0, "latin1");
  const res = ctx.res;
  if (res.headersSent || res.destroyed) return;
  res.writeHead(200, { "content-type": "audio/mpeg", "content-length": size });
  res.end(buf);
}

function handleTranscription(ctx: Ctx, p: Parsed, translate: boolean): void {
  const mp = toMultipart(p);
  const bytes = mp.files.reduce((a, f) => a + f.size, 0);
  const given = Number(mp.fields.mock_duration);
  const seconds = Number.isFinite(given) && mp.fields.mock_duration !== undefined ? given : Math.max(1, Math.round(bytes / 16000));
  const fmt = mp.fields.response_format ?? "json";
  const text = translate ? "mock translation" : "mock transcription";
  if (fmt === "text" || fmt === "srt" || fmt === "vtt") {
    const res = ctx.res;
    if (res.headersSent || res.destroyed) return;
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return void res.end(text);
  }
  const body: Obj = { text, duration: seconds, usage: { type: "duration", seconds } };
  if (fmt === "verbose_json") {
    body.task = translate ? "translate" : "transcribe";
    body.language = "english";
    body.segments = [];
  }
  sendJson(ctx, 200, body);
}

function handleModeration(ctx: Ctx, b: Obj): void {
  const input = b.input;
  const count = Array.isArray(input) ? Math.max(1, input.length) : 1;
  sendJson(ctx, 200, {
    id: `modr-mock-${rid()}`,
    model: asStr(b.model) ?? "omni-moderation-latest",
    results: Array.from({ length: count }, () => ({ flagged: false, categories: {}, category_scores: {} })),
  });
}

const MOCK_MODELS = ["gpt-mock", "claude-mock", "embed-mock", "image-mock"];
function handleModels(ctx: Ctx, id?: string): void {
  const created = nowSec();
  if (id) {
    return sendJson(ctx, 200, { id, object: "model", created, owned_by: "mock" });
  }
  sendJson(ctx, 200, {
    object: "list",
    data: MOCK_MODELS.map((m) => ({ id: m, object: "model", created, owned_by: "mock" })),
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------------------------------------------------

function anthropicUsage(u: Usage, outputTokens = u.output): Obj {
  return {
    input_tokens: Math.max(0, u.input - u.cached - u.cacheWrite),
    cache_creation_input_tokens: u.cacheWrite,
    cache_read_input_tokens: u.cached,
    output_tokens: outputTokens,
  };
}

async function handleAnthropicMessages(ctx: Ctx, b: Obj): Promise<void> {
  const model = asStr(b.model);
  if (!model) return sendError(ctx, "invalid_request", "model: Field required");
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return sendError(ctx, "invalid_request", "messages: Field required");
  }
  if (asNum(b.max_tokens) === undefined || (asNum(b.max_tokens) as number) < 1) {
    return sendError(ctx, "invalid_request", "max_tokens: Field required");
  }
  const ex = extractAnthropic(b);
  const p = plan(ex, "anthropic");
  const delay = resolveDelay(ctx.req, b, p.markers);
  const id = `msg_mock_${rid()}`;
  const stopReason = p.tool ? "tool_use" : "end_turn";
  const toolInput = p.tool ? (JSON.parse(p.tool.args) as Obj) : {};

  if (b.stream !== true) {
    if (!(await sleep(ctx, delay))) return;
    const content = p.tool
      ? [{ type: "tool_use", id: "toolu_mock1", name: p.tool.name, input: toolInput }]
      : [{ type: "text", text: p.text }];
    return sendJson(
      ctx,
      200,
      {
        id,
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { ...anthropicUsage(p.usage), service_tier: "standard" },
      },
      { "request-id": `req_mock_${rid()}` },
    );
  }

  const frames: string[] = [];
  frames.push(
    eventFrame("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: anthropicUsage(p.usage, 1),
      },
    }),
  );
  if (p.tool) {
    frames.push(
      eventFrame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_mock1", name: p.tool.name, input: {} },
      }),
    );
    frames.push(eventFrame("ping", { type: "ping" }));
    for (const piece of splitPieces(p.tool.args, 3)) {
      frames.push(
        eventFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: piece } }),
      );
    }
  } else {
    frames.push(
      eventFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    );
    frames.push(eventFrame("ping", { type: "ping" }));
    for (const d of textDeltas(p.text)) {
      frames.push(eventFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: d } }));
    }
  }
  frames.push(eventFrame("content_block_stop", { type: "content_block_stop", index: 0 }));
  frames.push(
    eventFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: p.usage.output },
    }),
  );
  frames.push(eventFrame("message_stop", { type: "message_stop" }));
  await emitFrames(ctx, frames, delay, SSE);
}

function handleAnthropicCountTokens(ctx: Ctx, b: Obj): void {
  if (!asStr(b.model)) return sendError(ctx, "invalid_request", "model: Field required");
  if (!Array.isArray(b.messages) || b.messages.length === 0) return sendError(ctx, "invalid_request", "messages: Field required");
  const ex = extractAnthropic(b);
  const mk = parseMarkers(markerSource(ex));
  const chars = ex.texts.reduce((a, t) => a + t.length, 0);
  sendJson(ctx, 200, { input_tokens: mk.in ?? Math.max(1, Math.ceil(chars / 4)) });
}

// ---------------------------------------------------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------------------------------------------------

function geminiUsage(u: Usage): Obj {
  const m: Obj = { promptTokenCount: u.input, candidatesTokenCount: u.output, totalTokenCount: u.input + u.output };
  if (u.cached > 0) m.cachedContentTokenCount = u.cached;
  return m;
}

async function handleGemini(ctx: Ctx, model: string, method: string, b: Obj): Promise<void> {
  if (method === "countTokens") {
    const inner = pick(b, "generateContentRequest", "generate_content_request");
    const ex = extractGemini(isObj(inner) ? inner : b);
    const mk = parseMarkers(markerSource(ex));
    const chars = ex.texts.reduce((a, t) => a + t.length, 0);
    return sendJson(ctx, 200, { totalTokens: mk.in ?? Math.max(1, Math.ceil(chars / 4)) });
  }
  if (method === "embedContent" || method === "batchEmbedContents") {
    const textOf = (req: unknown): string => {
      if (!isObj(req) || !isObj(req.content)) return "";
      return asArr(req.content.parts)
        .map((x) => (isObj(x) && typeof x.text === "string" ? x.text : ""))
        .join(" ");
    };
    const dimsOf = (req: unknown): number => {
      const d = isObj(req) ? asNum(pick(req, "outputDimensionality", "output_dimensionality")) : undefined;
      return Math.min(1536, Math.max(1, Math.floor(d ?? 8)));
    };
    if (method === "embedContent") {
      return sendJson(ctx, 200, { embedding: { values: embed(textOf(b), dimsOf(b)) } });
    }
    const reqs = asArr(b.requests);
    if (reqs.length === 0) return sendError(ctx, "invalid_request", "requests: at least one request is required");
    return sendJson(ctx, 200, { embeddings: reqs.map((r) => ({ values: embed(textOf(r), dimsOf(r)) })) });
  }

  // generateContent / streamGenerateContent
  if (asArr(b.contents).length === 0) return sendError(ctx, "invalid_request", "contents is not specified");
  const ex = extractGemini(b);
  const p = plan(ex, "gemini");
  const delay = resolveDelay(ctx.req, b, p.markers);
  const responseId = `mockresp${rid()}`;
  const part: Obj = p.tool ? { functionCall: { name: p.tool.name, args: JSON.parse(p.tool.args) as Obj } } : { text: p.text };

  if (method === "generateContent") {
    if (!(await sleep(ctx, delay))) return;
    return sendJson(ctx, 200, {
      candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }],
      usageMetadata: geminiUsage(p.usage),
      modelVersion: model,
      responseId,
    });
  }

  // streamGenerateContent
  const chunks: Obj[] = [];
  if (p.tool) {
    chunks.push({
      candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }],
      usageMetadata: geminiUsage(p.usage),
      modelVersion: model,
      responseId,
    });
  } else {
    const deltas = textDeltas(p.text);
    deltas.forEach((d, i) => {
      const last = i === deltas.length - 1;
      chunks.push({
        candidates: [{ content: { role: "model", parts: [{ text: d }] }, ...(last ? { finishReason: "STOP" } : {}), index: 0 }],
        ...(last ? { usageMetadata: geminiUsage(p.usage) } : {}),
        modelVersion: model,
        responseId,
      });
    });
  }
  if (ctx.url.searchParams.get("alt") === "sse") {
    await emitFrames(ctx, chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`), delay, SSE);
  } else {
    // no alt=sse: Gemini streams a JSON array, element by element
    const frames = chunks.map((c, i) => (i === 0 ? "[\n" : ",\n") + JSON.stringify(c));
    frames.push("\n]");
    await emitFrames(ctx, frames, delay, "application/json");
  }
}

function handleGeminiModels(ctx: Ctx, model?: string): void {
  const entry = (m: string): Obj => ({
    name: `models/${m}`,
    version: "001",
    displayName: m,
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 8192,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens", "embedContent"],
  });
  if (model) return sendJson(ctx, 200, entry(model));
  sendJson(ctx, 200, { models: MOCK_MODELS.map(entry) });
}

// ---------------------------------------------------------------------------------------------------------------------
// auth & dispatch
// ---------------------------------------------------------------------------------------------------------------------

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  const m = typeof h === "string" ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m ? m[1].trim() : null;
}
const hdr = (req: http.IncomingMessage, name: string): string | null => {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : null;
};

/** Credential in the style each surface expects, or null when absent / wrong style for the surface. */
function credentialFor(surface: Surface, req: http.IncomingMessage, url: URL): string | null {
  if (surface === "anthropic") return hdr(req, "x-api-key") ?? bearer(req);
  if (surface === "gemini") return hdr(req, "x-goog-api-key") ?? (url.searchParams.get("key") || null) ?? bearer(req);
  return bearer(req) ?? hdr(req, "api-key");
}

function authMessage(surface: Surface): string {
  if (surface === "anthropic") return "x-api-key header is required";
  if (surface === "gemini") return "API key not valid. Please pass a valid API key.";
  return "You didn't provide an API key. You need to provide your API key in an Authorization: Bearer header.";
}

const GEMINI_RE = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens|embedContent|batchEmbedContents)$/;
const RESPONSES_RE = /^\/v1\/responses\/([^/]+)(?:\/(cancel|input_items))?$/;

async function route(ctx: Ctx, raw: Buffer): Promise<void> {
  const { req, path, surface } = ctx;
  const method = (req.method ?? "GET").toUpperCase();

  // 404 for unknown paths before auth (so a typo is obvious)
  const gem = GEMINI_RE.exec(path);
  const resp = RESPONSES_RE.exec(path);
  const modelOne = /^\/v1\/models\/([^/]+)$/.exec(path);
  const gemModelOne = /^\/v1beta\/models\/([^/:]+)$/.exec(path);
  const postRoutes = new Set([
    "/v1/chat/completions",
    "/v1beta/openai/chat/completions",
    "/v1/completions",
    "/v1/responses",
    "/v1/embeddings",
    "/v1/images/generations",
    "/v1/images/edits",
    "/v1/images/variations",
    "/v1/audio/speech",
    "/v1/audio/transcriptions",
    "/v1/audio/translations",
    "/v1/moderations",
    "/v1/messages",
    "/v1/messages/count_tokens",
  ]);
  const known =
    (method === "POST" && (postRoutes.has(path) || !!gem)) ||
    (method === "GET" && (path === "/v1/models" || !!modelOne || path === "/v1beta/models" || !!gemModelOne)) ||
    !!resp;
  if (!known) return sendError(ctx, "not_found", `Unknown request URL: ${method} ${path}`);

  // --- auth (per-surface header style) ---
  const cred = credentialFor(surface, req, ctx.url);
  if (!cred) return sendError(ctx, "auth", authMessage(surface));
  const slow = cred.includes("slow");
  if (slow && !(await sleep(ctx, 1500))) return;
  if (cred.includes("bad")) return sendError(ctx, "auth", "Incorrect API key provided.");
  if (cred.includes("fail429")) return sendError(ctx, "rate_limit", "Rate limit reached for requests (mock fail429 key).", rateLimitHeaders(ctx));
  if (cred.includes("fail500")) return sendError(ctx, "server", "The server had an error while processing your request (mock fail500 key).");
  if (cred.includes("fail529")) return sendError(ctx, "overloaded", "Overloaded (mock fail529 key).");

  if (surface === "anthropic" && !hdr(req, "anthropic-version")) {
    return sendError(ctx, "invalid_request", "anthropic-version: header is required");
  }

  // --- GETs / bodiless ---
  if (method === "GET") {
    if (path === "/v1/models") return handleModels(ctx);
    if (modelOne) return handleModels(ctx, decodeURIComponent(modelOne[1]));
    if (path === "/v1beta/models") return handleGeminiModels(ctx);
    if (gemModelOne) return handleGeminiModels(ctx, decodeURIComponent(gemModelOne[1]));
  }
  if (resp) return handleResponsesAux(ctx, method, decodeURIComponent(resp[1]), resp[2]);

  // --- POSTs ---
  let parsed: Parsed;
  try {
    parsed = parseBody(raw, String(req.headers["content-type"] ?? ""));
  } catch (e) {
    return sendError(ctx, "invalid_request", e instanceof BadBody ? e.message : "Invalid request body");
  }
  const b = parsed.json ?? {};

  if (gem) return handleGemini(ctx, decodeURIComponent(gem[1]), gem[2], b);
  switch (path) {
    case "/v1/chat/completions":
    case "/v1beta/openai/chat/completions":
      return handleChat(ctx, b);
    case "/v1/completions":
      return handleCompletions(ctx, b);
    case "/v1/responses":
      return handleResponses(ctx, b);
    case "/v1/embeddings":
      return handleEmbeddings(ctx, b);
    case "/v1/images/generations":
    case "/v1/images/edits":
    case "/v1/images/variations":
      return handleImages(ctx, parsed);
    case "/v1/audio/speech":
      return handleSpeech(ctx, b);
    case "/v1/audio/transcriptions":
      return handleTranscription(ctx, parsed, false);
    case "/v1/audio/translations":
      return handleTranscription(ctx, parsed, true);
    case "/v1/moderations":
      return handleModeration(ctx, b);
    case "/v1/messages":
      return handleAnthropicMessages(ctx, b);
    case "/v1/messages/count_tokens":
      return handleAnthropicCountTokens(ctx, b);
    default:
      return sendError(ctx, "not_found", `Unknown request URL: ${method} ${path}`);
  }
}

function introspect(state: MockState, res: http.ServerResponse, url: URL, path: string): boolean {
  const json = (status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  };
  if (path === "/healthz") {
    json(200, { ok: true });
    return true;
  }
  if (path === "/__mock/stats") {
    json(200, {
      total: state.total,
      inflight: state.inflight,
      maxInflight: state.maxInflight,
      byKey: Object.fromEntries(state.byKey),
      byPath: Object.fromEntries(state.byPath),
    });
    return true;
  }
  if (path === "/__mock/reset") {
    resetState(state);
    json(200, { ok: true });
    return true;
  }
  if (path === "/__mock/last") {
    const want = url.searchParams.get("path") ?? "";
    const rec = state.last.get(want);
    if (!rec) json(404, { error: `no request recorded for path '${want}'` });
    else json(200, rec);
    return true;
  }
  return false;
}

async function handle(state: MockState, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://mock.local");
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  req.on("error", () => undefined);
  res.on("error", () => undefined);

  if (isIntrospection(path)) {
    if (introspect(state, res, url, path)) return;
  }

  const surface = surfaceOf(path);
  const ctx: Ctx = { req, res, url, path, surface, closed: false, waiters: new Set(), state };
  const key = credentialFor(surface, req, url) ?? "(none)";
  const done = track(state, key, path);
  res.on("close", () => {
    ctx.closed = true;
    for (const w of [...ctx.waiters]) w();
    ctx.waiters.clear();
    done();
  });

  try {
    const raw = await readBody(req);
    if (ctx.closed) return;
    // record for /__mock/last (auth failures included, so tests can inspect what the gateway sent)
    let body: unknown = null;
    let multipart: LastRequest["multipart"] = null;
    try {
      const ct = String(req.headers["content-type"] ?? "");
      if (/multipart\/form-data/i.test(ct)) multipart = parseMultipart(raw, ct);
      else if (raw.length > 0) body = JSON.parse(raw.toString("utf8"));
    } catch {
      /* malformed JSON is reported to the caller below */
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : (v ?? "");
    state.last.set(path, {
      path,
      method: req.method ?? "GET",
      query: Object.fromEntries(url.searchParams),
      headers,
      body,
      multipart,
      at: new Date().toISOString(),
    });
    await route(ctx, raw);
  } catch (e) {
    if (!res.headersSent && !res.destroyed) {
      const msg = e instanceof Error ? e.message : "mock upstream error";
      try {
        sendError(ctx, "server", `mock upstream internal error: ${msg}`);
      } catch {
        res.destroy();
      }
    } else if (!res.destroyed) {
      res.destroy();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------------------------------------------

export async function startMockUpstream(
  port: number = Number(process.env.MOCK_UPSTREAM_PORT ?? 4010),
  host: string = "0.0.0.0",
): Promise<{ server: http.Server; port: number; close(): Promise<void> }> {
  const state = createState();
  const server = http.createServer((req, res) => {
    handle(state, req, res).catch(() => {
      if (!res.destroyed) res.destroy();
    });
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  server.requestTimeout = 0; // long streams must not be cut off
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host, backlog: 4096 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const actualPort = (server.address() as AddressInfo).port;
  return {
    server,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Auto-start only when executed as a script (tsx scripts/mock-upstream.ts), never when imported (vitest).
if (/mock-upstream\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  startMockUpstream()
    .then(({ port, close }) => {
      console.log(`[mock-upstream] listening on http://localhost:${port}  (OpenAI /v1, Anthropic /v1/messages, Gemini /v1beta)`);
      const stop = () => void close().finally(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((err) => {
      console.error("[mock-upstream] failed to start:", err);
      process.exit(1);
    });
}
